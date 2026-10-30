declare const require: (name: string) => any;

import { parseSource, walkAst } from './parser';
import { createRegistryClient, mapBounded } from './registry';
import { compareSemver } from './semver';
import { createSqliteCache } from './sqlite-cache';
import {
  CorpusCache,
  LiteralIndexBuildStats,
  LiteralIndexFragment,
  LiteralIndexMatch,
  RegistryClient,
} from './types';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isBundlerBoilerplate } = require('../bundler-patterns');

const DEFAULT_TIER = 'topN';
const DEFAULT_PACKAGE_LIMIT = 2000;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 8;
const MAX_SOURCE_FILES_PER_PACKAGE = 120;
const MAX_SOURCE_BYTES_PER_PACKAGE = 12 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 3 * 1024 * 1024;
const JAVASCRIPT_FILE = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i;
const NON_PRODUCTION_PATH = /(?:^|[/\\])(?:test|tests|__tests__|spec|specs|example|examples|demo|docs?|benchmark|benchmarks|fixtures?|coverage)(?:[/\\]|$)/i;

const BOILERPLATE = [
  /^\[object (?:Object|Array|Function|Window|Global|Undefined|Null)\]$/i,
  /^(?:undefined|null|true|false|NaN|Infinity|function|object|unknown|anonymous)$/i,
  /^(?:application|text)\/(?:javascript|json|xml|html)$/i,
  /^\s*<\/?(?:!doctype|html|head|body|script|style|meta|link)\b[^>]*>\s*$/i,
  /^(?:cannot read properties of (?:undefined|null)|expected a function)$/i,
  /^(?:sourceMappingURL|sourceURL)=/i,
  /^[\s\d.,;:_+\-*/\\|!?()[\]{}<>="'`~@#$%^&]+$/,
  /^(?:data:image\/[^;,]+;base64,)[a-z\d+/=]+$/i,
];

export interface LiteralIndexPackageSpec {
  name: string;
  version?: string;
}

export interface LiteralIndexPackageSources {
  name: string;
  version: string;
  sources: string[];
}

export interface LiteralIndexBuildResult extends LiteralIndexBuildStats {
  packagesFailed: number;
  filesParseFailed: number;
  failures: Array<{ package: string; message: string }>;
}

export interface LiteralIndexBuildOptions {
  packages: LiteralIndexPackageSpec[];
  tier?: string;
  databasePath?: string;
  cache?: CorpusCache;
  registry?: RegistryClient;
  concurrency?: number;
  limit?: number;
  cleanupExtractedTarballs?: boolean;
  onProgress?: (message: string) => void;
}

export function normalizeIndexedLiteral(value: string): string | null {
  const normalized = String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (normalized.length < 8 || normalized.length > 512) return null;
  if (isBundlerBoilerplate(normalized) || BOILERPLATE.some((pattern) => pattern.test(normalized))) return null;
  return normalized.toLowerCase();
}

export async function extractIndexedStringLiterals(source: string): Promise<{ literals: string[]; parseFailed: boolean }> {
  const values = new Set<string>();
  try {
    const parsed = await parseSource(source);
    walkAst(parsed.program, (node) => {
      let value: unknown;
      if ((node.type === 'Literal' || node.type === 'StringLiteral') && typeof node.value === 'string') value = node.value;
      if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
        value = (node.quasis || []).map((quasi: any) => quasi.value?.cooked ?? quasi.value?.raw ?? '').join('');
      }
      if (typeof value !== 'string') return;
      const literal = normalizeIndexedLiteral(value);
      if (literal) values.add(literal);
    });
    return { literals: [...values].sort(), parseFailed: false };
  } catch (_) {
    return { literals: [], parseFailed: true };
  }
}

export function parsePackageList(contents: string): LiteralIndexPackageSpec[] {
  const unique = new Map<string, LiteralIndexPackageSpec>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const lastAt = line.lastIndexOf('@');
    const isScoped = line.startsWith('@');
    const versionSeparator = lastAt > (isScoped ? line.indexOf('/') : 0) ? lastAt : -1;
    const name = (versionSeparator >= 0 ? line.slice(0, versionSeparator) : line).trim();
    const version = versionSeparator >= 0 ? line.slice(versionSeparator + 1).trim() : undefined;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || (versionSeparator >= 0 && !version)) continue;
    const spec = { name, ...(version ? { version } : {}) };
    unique.set(`${name.toLowerCase()}@${version || ''}`, spec);
  }
  return [...unique.values()];
}

export function readPackageList(filename: string): LiteralIndexPackageSpec[] {
  const contents = require('node:fs').readFileSync(filename, 'utf8');
  return parsePackageList(contents);
}

async function collectSourceFiles(downloaded: { packageRoot: string; files: string[] }): Promise<{ sources: string[]; skipped: number }> {
  const root = path.resolve(downloaded.packageRoot);
  const candidates = downloaded.files
    .filter((filename) => JAVASCRIPT_FILE.test(filename) && !NON_PRODUCTION_PATH.test(filename))
    .map((filename) => ({
      filename: path.resolve(filename),
      relative: path.relative(root, path.resolve(filename)),
    }))
    .filter((item) => item.relative && item.relative !== '..' && !item.relative.startsWith(`..${path.sep}`) && !path.isAbsolute(item.relative))
    .sort((a, b) => {
      const priority = (value: string) => /(?:^|[/\\])(?:dist|lib|build|esm|cjs)(?:[/\\]|$)/i.test(value) ? 0 : 1;
      return priority(a.relative) - priority(b.relative) || a.relative.localeCompare(b.relative);
    });
  const sources: string[] = [];
  let sourceBytes = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (sources.length >= MAX_SOURCE_FILES_PER_PACKAGE) { skipped++; continue; }
    let stat: any;
    try { stat = await fs.stat(candidate.filename); } catch (_) { skipped++; continue; }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SOURCE_FILE_BYTES || sourceBytes + stat.size > MAX_SOURCE_BYTES_PER_PACKAGE) {
      skipped++;
      continue;
    }
    try {
      sources.push(await fs.readFile(candidate.filename, 'utf8'));
      sourceBytes += stat.size;
    } catch (_) { skipped++; }
  }
  return { sources, skipped };
}

function requireIndexCache(cache: CorpusCache): Required<Pick<CorpusCache,
  'beginLiteralIndexBuild' | 'addLiteralIndexDocument' | 'publishLiteralIndex' | 'abortLiteralIndexBuild'>> {
  const methods = ['beginLiteralIndexBuild', 'addLiteralIndexDocument', 'publishLiteralIndex', 'abortLiteralIndexBuild'] as const;
  for (const method of methods) if (typeof cache[method] !== 'function') throw new Error('The configured cache does not support the string-literal index.');
  return cache as Required<Pick<CorpusCache, typeof methods[number]>>;
}

export async function buildLiteralIndexFromSources(
  packages: LiteralIndexPackageSources[],
  cache: CorpusCache,
  tier = DEFAULT_TIER,
): Promise<LiteralIndexBuildResult> {
  const store = requireIndexCache(cache);
  const buildId = `literal-index-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  store.beginLiteralIndexBuild(buildId, tier);
  let filesParseFailed = 0;
  try {
    for (const pkg of packages) {
      const literals = new Set<string>();
      for (const source of pkg.sources) {
        const extracted = await extractIndexedStringLiterals(source);
        if (extracted.parseFailed) filesParseFailed++;
        for (const literal of extracted.literals) literals.add(literal);
      }
      store.addLiteralIndexDocument(buildId, pkg.name, pkg.version, [...literals]);
    }
    const stats = store.publishLiteralIndex(buildId, tier);
    return { ...stats, packagesFailed: 0, filesParseFailed, failures: [] };
  } catch (error) {
    store.abortLiteralIndexBuild(buildId);
    throw error;
  }
}

function latestVersion(spec: LiteralIndexPackageSpec, metadata: any): string | null {
  if (spec.version) return metadata?.versions?.[spec.version] ? spec.version : null;
  const latestTag = metadata?.['dist-tags']?.latest;
  if (latestTag && metadata?.versions?.[latestTag]) return latestTag;
  return Object.values(metadata?.versions || {})
    .map((item: any) => String(item?.version || ''))
    .filter((version) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    .sort((a, b) => compareSemver(b, a))[0] || null;
}

export async function buildLiteralIndex(options: LiteralIndexBuildOptions): Promise<LiteralIndexBuildResult> {
  const tier = options.tier?.trim() || DEFAULT_TIER;
  const limit = Math.max(1, Math.floor(options.limit || DEFAULT_PACKAGE_LIMIT));
  const packages = options.packages.slice(0, limit);
  const ownsCache = !options.cache;
  const cache = options.cache || createSqliteCache(options.databasePath);
  const store = requireIndexCache(cache);
  const registry = options.registry || createRegistryClient({ cache, concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency || DEFAULT_CONCURRENCY))) });
  const ownsRegistry = !options.registry;
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency || DEFAULT_CONCURRENCY)));
  const buildId = `literal-index-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let filesParseFailed = 0;
  let completed = 0;
  const failures: Array<{ package: string; message: string }> = [];
  store.beginLiteralIndexBuild(buildId, tier);
  try {
    const results = await mapBounded(packages, concurrency, async (spec) => {
      const label = `${spec.name}${spec.version ? `@${spec.version}` : ''}`;
      try {
        const metadata = spec.version
          ? await (registry.getPackageMeta?.(spec.name) || registry.getPackument(spec.name))
          : await (registry.getPackageMeta?.(spec.name) || registry.getPackument(spec.name));
        const version = latestVersion(spec, metadata);
        if (!version) throw new Error(`No matching published version was found for ${label}.`);
        if (!registry.downloadTarball) throw new Error('The configured registry client cannot download package tarballs.');
        const downloaded = await registry.downloadTarball(spec.name, version);
        try {
          const scanned = await collectSourceFiles(downloaded);
          const literals = new Set<string>();
          for (const source of scanned.sources) {
            const extracted = await extractIndexedStringLiterals(source);
            if (extracted.parseFailed) filesParseFailed++;
            for (const literal of extracted.literals) literals.add(literal);
          }
          store.addLiteralIndexDocument(buildId, spec.name, version, [...literals]);
          options.onProgress?.(`Indexed ${label}: ${literals.size} literals from ${scanned.sources.length} JavaScript files${scanned.skipped ? ` (${scanned.skipped} files skipped)` : ''}.`);
        } finally {
          if (options.cleanupExtractedTarballs !== false && downloaded.directory) {
            await fs.rm(downloaded.directory, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ package: label, message });
        options.onProgress?.(`Skipped ${label}: ${message}`);
        return false;
      } finally {
        completed++;
        options.onProgress?.(`Package progress: ${completed}/${packages.length}.`);
      }
    });
    const succeeded = results.filter(Boolean).length;
    if (!succeeded) throw new Error(`Could not index any package from the ${packages.length}-package list.`);
    const stats = store.publishLiteralIndex(buildId, tier);
    return { ...stats, packagesFailed: failures.length, filesParseFailed, failures };
  } catch (error) {
    store.abortLiteralIndexBuild(buildId);
    throw error;
  } finally {
    if (ownsRegistry) registry.close?.();
    if (ownsCache) cache.close?.();
  }
}

export function matchLiteralFragments(
  fragments: LiteralIndexFragment[],
  cache: CorpusCache,
  tier = DEFAULT_TIER,
): LiteralIndexMatch[] {
  if (!cache.matchLiteralIndex) return [];
  const normalized = fragments.map((fragment) => ({
    sourceFile: fragment.sourceFile,
    stringLiterals: [...new Set(fragment.stringLiterals.map(normalizeIndexedLiteral).filter((value): value is string => Boolean(value)))],
  }));
  return cache.matchLiteralIndex(tier, normalized);
}

export function getDefaultLiteralIndexTier(): string { return DEFAULT_TIER; }
