declare const require: (name: string) => any;
declare const process: any;

import { parseSource, walkAst } from './parser';
import { matchLiteralFragments } from './literal-index';
import { createSqliteCache } from './sqlite-cache';
import { sliceModules } from './normalize';

const { isBundlerRuntimeIdentifier, isBundlerRegistrationHint, isBundlerMetadata, findBundlerHints } = require('../bundler-patterns');

const fs = require('node:fs/promises');
const path = require('node:path');
const bufferModule = require('node:buffer');
const BufferCtor = bufferModule.Buffer;

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const LICENSE_PATTERN = /(?:^!|@license|@preserve|SPDX-License-Identifier)/i;
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);

export type FragmentGranularity = 'function' | 'statement-block';

export interface Phase0Fragment {
  sourceFile: string;
  granularity: FragmentGranularity;
  startByte: number;
  endByte: number;
  code: string;
  stringLiterals: string[];
  licenseComments: string[];
}

export interface Phase0SourceSummary {
  sourceFile: string;
  parser: 'oxc-parser' | '@babel/parser' | 'unavailable';
  byteLength: number;
  removedRuntimeIdentifiers: string[];
  strippedSource: string;
  bundleFormat: string;
  bundleFormatConfidence: number;
  bundleFormatHints: string[];
  bundleFormatEvidence: string[];
  fragments: number;
}

export interface Phase0Failure {
  sourceFile: string;
  message: string;
}

export interface Phase0Result {
  schemaVersion: 1;
  input: string;
  generatedAt: string;
  stats: {
    sourcesDiscovered: number;
    sourcesParsed: number;
    fragments: number;
    parseFailures: number;
    fetchFailures: number;
    unrecognizedFormats: number;
  };
  sources: Phase0SourceSummary[];
  parseFailures: Phase0Failure[];
  fetchFailures: Phase0Failure[];
  removedRuntimeIdentifiers: string[];
  fragments: Phase0Fragment[];
  warnings: string[];
}

export interface Phase0Options {
  concurrency?: number;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string, init?: any) => Promise<any>;
  outputPath?: string;
  onLog?: (message: string) => void;
}

interface SourceInput {
  sourceFile: string;
  code: string;
}

interface CommentRange {
  start: number;
  end: number;
  text: string;
}

interface StrippingResult {
  strippedSource: string;
  removedRuntimeIdentifiers: string[];
  excludedNodes: Set<any>;
}

function asPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function utf8Offset(source: string, utf16Offset: number): number {
  return BufferCtor.byteLength(source.slice(0, utf16Offset), 'utf8');
}

function getName(node: any): string | undefined {
  if (node?.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

function isFunctionLike(node: any): boolean {
  return !!node && FUNCTION_TYPES.has(node.type);
}

function collectRuntimeIdentifiers(node: any, into: Set<string>): void {
  walkAst(node, (child) => {
    if (child.type === 'Identifier' && isBundlerRuntimeIdentifier(child.name)) into.add(child.name);
  });
}

function statementHasStructuralRegistration(statement: any): boolean {
  if (statement?.type !== 'ExpressionStatement') return false;
  let found = false;
  walkAst(statement, (node) => {
    if (found || node.type !== 'CallExpression') return;
    const callee = node.callee;
    const property = callee?.type === 'MemberExpression'
      ? callee.property?.name || callee.property?.value
      : '';
    if (property !== 'push') return;
    for (const argument of node.arguments || []) {
      if (argument?.type === 'ArrayExpression' && (argument.elements || []).filter(isFunctionLike).length >= 2) found = true;
      if (argument?.type === 'ObjectExpression' && (argument.properties || []).filter((item: any) => isFunctionLike(item.value || item)).length >= 2) found = true;
    }
  });
  return found;
}

function statementHasBundlerRegistration(statement: any, source: string): boolean {
  if (statement?.type !== 'ExpressionStatement') return false;
  const text = source.slice(statement.start, statement.end);
  return statementHasStructuralRegistration(statement) || (isBundlerRegistrationHint(text) && /\.\s*push\s*\(/.test(text));
}

function statementHasModuleMetadata(statement: any, source: string): boolean {
  return statement?.type === 'ExpressionStatement' && isBundlerMetadata(source.slice(statement.start, statement.end));
}

/**
 * Mask generated helpers and pure bundle metadata without changing source offsets.
 * Module registration expressions are retained because they contain the libraries
 * whose code Phase 0 needs to slice.
 */
function stripScaffolding(parsed: any, source: string): StrippingResult {
  const removed = new Set<string>();
  const excludedNodes = new Set<any>();
  const ranges: Array<[number, number]> = [];
  const body = parsed.program?.body || [];

  for (const statement of body) {
    if (statement?.type === 'FunctionDeclaration' && isBundlerRuntimeIdentifier(statement.id?.name || '')) {
      removed.add(statement.id.name);
      excludedNodes.add(statement);
      ranges.push([statement.start, statement.end]);
      continue;
    }
    if (statement?.type === 'ClassDeclaration' && isBundlerRuntimeIdentifier(statement.id?.name || '')) {
      removed.add(statement.id.name);
      excludedNodes.add(statement);
      ranges.push([statement.start, statement.end]);
      continue;
    }
    if (statement?.type === 'VariableDeclaration') {
      const runtimeDeclarators = (statement.declarations || []).filter((declaration: any) => {
        const id = declaration.id;
        return id?.type === 'Identifier' && isBundlerRuntimeIdentifier(id.name);
      });
      for (const declaration of runtimeDeclarators) {
        removed.add(declaration.id.name);
        if (isFunctionLike(declaration.init)) excludedNodes.add(declaration.init);
      }
      // Module registries and helper declarations are scaffolding containers.
      // Their child functions are still visited and sliced independently.
      if (runtimeDeclarators.length === (statement.declarations || []).length && runtimeDeclarators.length > 0) {
        ranges.push([statement.start, statement.end]);
        excludedNodes.add(statement);
      }
      continue;
    }
    if (statementHasBundlerRegistration(statement, source)) {
      collectRuntimeIdentifiers(statement, removed);
      ranges.push([statement.start, statement.end]);
      excludedNodes.add(statement);
      continue;
    }
    if (statementHasModuleMetadata(statement, source)) {
      collectRuntimeIdentifiers(statement, removed);
      ranges.push([statement.start, statement.end]);
      excludedNodes.add(statement);
    }
  }

  // Runtime references used as bundle wrappers are retained in source when they
  // enclose module factories, but are recorded so downstream matching can ignore them.
  walkAst(parsed.program, (node) => {
    if (node.type !== 'Identifier' || !isBundlerRuntimeIdentifier(node.name)) return;
    const parentIsScaffold = body.some((statement: any) => statement.start <= node.start && statement.end >= node.end
      && (statement.type === 'ExpressionStatement' || statement.type === 'VariableDeclaration'));
    if (parentIsScaffold) removed.add(node.name);
  });

  let strippedSource = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    const original = strippedSource.slice(start, end);
    const masked = original.replace(/[^\r\n]/g, ' ');
    strippedSource = strippedSource.slice(0, start) + masked + strippedSource.slice(end);
  }
  return { strippedSource, removedRuntimeIdentifiers: [...removed].sort(), excludedNodes };
}

function collectLicenseRanges(source: string, parserComments: any[]): CommentRange[] {
  const ranges: CommentRange[] = [];
  for (const comment of parserComments || []) {
    const start = Number(comment.start);
    const end = Number(comment.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;
    const text = source.slice(start, end);
    if (text.startsWith('/*!') || LICENSE_PATTERN.test(comment.value || text)) {
      ranges.push({ start, end, text });
    }
  }
  // Parser plugins differ in how they report comments. Include license banners
  // directly from source as a fallback, preserving their exact spelling.
  if (ranges.length === 0) {
    const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      if (match[0].startsWith('/*!') || LICENSE_PATTERN.test(match[0])) {
        ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
      }
    }
  }
  return ranges;
}

function extractStrings(node: any): string[] {
  const values = new Set<string>();
  walkAst(node, (child) => {
    if (child.type === 'Literal' && typeof child.value === 'string') values.add(child.value);
    if (child.type === 'StringLiteral' && typeof child.value === 'string') values.add(child.value);
    if (child.type === 'TemplateLiteral' && child.expressions?.length === 0) {
      const value = child.quasis?.map((quasi: any) => quasi.value?.cooked ?? quasi.value?.raw ?? '').join('');
      if (value) values.add(value);
    }
  });
  return [...values];
}

function licenseCommentsForFragment(
  rangeStart: number,
  rangeEnd: number,
  ownerStart: number,
  source: string,
  all: CommentRange[],
): string[] {
  return all.filter((comment) => {
    if (comment.start >= rangeStart && comment.end <= rangeEnd) return true;
    if (comment.end > rangeStart) return false;
    // Keep a leading license banner with the first code fragment it introduces.
    return !source.slice(comment.end, ownerStart).trim();
  }).map((comment) => comment.text);
}

function meaningfulFragment(code: string): boolean {
  return code.trim().length >= 24;
}

function sliceSource(
  sourceFile: string,
  source: string,
  parsed: any,
  stripping: StrippingResult,
): Phase0Fragment[] {
  const licenses = collectLicenseRanges(source, parsed.comments || []);
  const candidates: Array<{ node: any; granularity: FragmentGranularity }> = [];
  const scaffoldFunctionBodyNodes = new Set<any>();
  walkAst(parsed.program, (node) => {
    if (!isFunctionLike(node)) return;
    if (!stripping.excludedNodes.has(node)) candidates.push({ node, granularity: 'function' });
    if (stripping.excludedNodes.has(node) && node.body?.type === 'BlockStatement') scaffoldFunctionBodyNodes.add(node.body);
  });

  walkAst(parsed.program, (node) => {
    if (node.type === 'BlockStatement' && !scaffoldFunctionBodyNodes.has(node)) {
      candidates.push({ node, granularity: 'statement-block' });
    }
  });

  // Top-level non-function statements are module-level statement blocks. This
  // captures ESM and unbundled code whose library code is not inside a function.
  for (const statement of parsed.program?.body || []) {
    if (stripping.excludedNodes.has(statement)
      || statementHasModuleMetadata(statement, source)
      || statementHasBundlerRegistration(statement, source)) continue;
    if (statement.type === 'FunctionDeclaration' && stripping.excludedNodes.has(statement)) continue;
    if (isFunctionLike(statement)) continue;
    candidates.push({ node: statement, granularity: 'statement-block' });
  }

  const seen = new Set<string>();
  const fragments: Phase0Fragment[] = [];
  for (const { node, granularity } of candidates) {
    if (!Number.isInteger(node?.start) || !Number.isInteger(node?.end) || node.end <= node.start) continue;
    if (stripping.excludedNodes.has(node)) continue;
    const code = source.slice(node.start, node.end);
    if (!meaningfulFragment(code)) continue;
    const key = `${granularity}:${node.start}:${node.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const owner = (parsed.program?.body || []).find((statement: any) => statement.start <= node.start && statement.end >= node.end);
    fragments.push({
      sourceFile,
      granularity,
      startByte: utf8Offset(source, node.start),
      endByte: utf8Offset(source, node.end),
      code,
      stringLiterals: extractStrings(node),
      licenseComments: licenseCommentsForFragment(node.start, node.end, owner?.start ?? node.start, source, licenses),
    });
  }
  return fragments.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte || a.granularity.localeCompare(b.granularity));
}

async function readDirectory(directory: string): Promise<string[]> {
  const result: string[] = [];
  const queue = [directory];
  while (queue.length) {
    const current = queue.pop() as string;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile() && JAVASCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(fullPath);
    }
  }
  return result.sort();
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, options: Phase0Options): Promise<{ text: string; contentType: string }> {
  const fetchImpl = options.fetchImpl || globalThis.fetch as any;
  const retries = Math.max(0, Number.isInteger(options.retries) ? options.retries as number : DEFAULT_RETRIES);
  const timeoutMs = asPositiveInteger(options.timeoutMs, 20_000);
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'debun-plus/1.0 (Phase 0 bundle collector)', accept: 'text/html,application/javascript,text/javascript,*/*;q=0.8' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      return {
        text: await response.text(),
        contentType: String(response.headers?.get?.('content-type') || '').toLowerCase(),
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      const base = Math.max(0, Number.isFinite(options.backoffMs) ? options.backoffMs as number : DEFAULT_BACKOFF_MS);
      await delay(base * (2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseHtmlScripts(html: string, pageUrl: string): { urls: string[]; inline: Array<{ sourceFile: string; code: string }> } {
  const urls = new Set<string>();
  const inline: Array<{ sourceFile: string; code: string }> = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  let inlineIndex = 0;
  while ((match = scriptPattern.exec(html))) {
    const attrs = match[1] || '';
    const typeMatch = attrs.match(/\btype\s*=\s*(["'])(.*?)\1/i);
    const scriptType = typeMatch?.[2].trim().toLowerCase();
    if (scriptType && !['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(scriptType)) continue;
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const src = srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3];
    if (src) {
      try {
        const resolved = new URL(src, pageUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') urls.add(resolved.href);
      } catch (_) {
        // Ignore malformed or non-network script URLs and continue with the page.
      }
    } else if (match[2].trim()) {
      inlineIndex++;
      inline.push({ sourceFile: `${pageUrl}#inline-${inlineIndex}`, code: match[2] });
    }
  }
  return { urls: [...urls], inline };
}

async function collectInput(input: string, options: Phase0Options): Promise<{ sources: SourceInput[]; failures: Phase0Failure[]; discovered: number }> {
  if (isHttpUrl(input)) {
    const page = await fetchWithRetry(input, options);
    const looksLikeHtml = /(?:text\/html|application\/xhtml\+xml)/.test(page.contentType)
      || /^\s*(?:<!doctype\s+html|<html\b)/i.test(page.text);
    if (!looksLikeHtml) {
      return { sources: [{ sourceFile: input, code: page.text }], failures: [], discovered: 1 };
    }
    const { urls, inline } = parseHtmlScripts(page.text, input);
    const outcomes = await mapLimit(urls, asPositiveInteger(options.concurrency, DEFAULT_CONCURRENCY), async (url) => {
      try {
        const result = await fetchWithRetry(url, options);
        return { source: { sourceFile: url, code: result.text } as SourceInput };
      } catch (error) {
        return { failure: { sourceFile: url, message: error instanceof Error ? error.message : String(error) } as Phase0Failure };
      }
    });
    const sources = [...inline, ...outcomes.flatMap((result) => result.source ? [result.source] : [])];
    const failures = outcomes.flatMap((result) => result.failure ? [result.failure] : []);
    return { sources, failures, discovered: urls.length + inline.length };
  }

  const absolute = path.resolve(input);
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) {
    const files = await readDirectory(absolute);
    const sources = await mapLimit(files, asPositiveInteger(options.concurrency, DEFAULT_CONCURRENCY), async (file) => ({
      sourceFile: file,
      code: await fs.readFile(file, 'utf8'),
    }));
    return { sources, failures: [], discovered: files.length };
  }
  if (stat.isFile()) {
    if (!JAVASCRIPT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      throw new Error(`Input file is not a supported JavaScript source file: ${absolute}`);
    }
    return { sources: [{ sourceFile: absolute, code: await fs.readFile(absolute, 'utf8') }], failures: [], discovered: 1 };
  }
  throw new Error(`Input is neither a URL, JavaScript file, nor directory: ${input}`);
}

export async function runPhase0(input: string, options: Phase0Options = {}): Promise<Phase0Result> {
  if (!input?.trim()) throw new Error('Provide a URL, JavaScript file, or directory.');
  const onLog = options.onLog || (() => undefined);
  const collected = await collectInput(input.trim(), options);
  onLog(`Collected ${collected.sources.length} JavaScript source(s) from ${input}.`);

  const fragments: Phase0Fragment[] = [];
  const sources: Phase0SourceSummary[] = [];
  const parseFailures: Phase0Failure[] = [];
  const allRuntimeIdentifiers = new Set<string>();
  let parsedCount = 0;
  await mapLimit(collected.sources, asPositiveInteger(options.concurrency, DEFAULT_CONCURRENCY), async ({ sourceFile, code }) => {
    try {
      const parsed = await parseSource(code, sourceFile);
      const stripping = stripScaffolding(parsed, code);
      const sliced = sliceSource(sourceFile, code, parsed, stripping);
      const structure = await sliceModules(code, parsed);
      const sourceUrls = /^https?:\/\//i.test(sourceFile) ? [sourceFile] : [];
      const hints = findBundlerHints(code, sourceUrls).map((item: any) => item.name);
      const bundleFormat = structure.structuralRegistry
        ? 'recognized(module-registry)'
        : `unrecognized(${hints.length ? hints.join(',') : 'unknown'})`;
      fragments.push(...sliced);
      for (const name of stripping.removedRuntimeIdentifiers) allRuntimeIdentifiers.add(name);
      sources.push({
        sourceFile,
        parser: parsed.parser,
        byteLength: BufferCtor.byteLength(code, 'utf8'),
        removedRuntimeIdentifiers: stripping.removedRuntimeIdentifiers,
        strippedSource: stripping.strippedSource,
        bundleFormat,
        bundleFormatConfidence: Math.min(0.97, structure.confidence + (hints.length ? 0.03 : 0)),
        bundleFormatHints: hints,
        bundleFormatEvidence: structure.evidence,
        fragments: sliced.length,
      });
      parsedCount++;
    } catch (error) {
      parseFailures.push({ sourceFile, message: error instanceof Error ? error.message : String(error) });
    }
  });

  fragments.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.startByte - b.startByte || a.endByte - b.endByte);
  sources.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
  parseFailures.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
  const warnings = [
    ...(collected.sources.length === 0 ? [`No JavaScript sources were discovered for ${input.trim()}.`] : []),
    ...sources.filter((source) => source.fragments === 0).map((source) => `${source.sourceFile}: no meaningful fragments were produced (${source.bundleFormat}).`),
    ...parseFailures.map((failure) => `${failure.sourceFile}: parsing failed; source was skipped (${failure.message}).`),
  ];
  const result: Phase0Result = {
    schemaVersion: 1,
    input: input.trim(),
    generatedAt: new Date().toISOString(),
    stats: {
      sourcesDiscovered: collected.discovered,
      sourcesParsed: parsedCount,
      fragments: fragments.length,
      parseFailures: parseFailures.length,
      fetchFailures: collected.failures.length,
      unrecognizedFormats: sources.filter((source) => source.bundleFormat.startsWith('unrecognized(')).length,
    },
    sources,
    parseFailures,
    fetchFailures: collected.failures,
    removedRuntimeIdentifiers: [...allRuntimeIdentifiers].sort(),
    fragments,
    warnings,
  };

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

export async function runPhase0Cli(argv = process.argv): Promise<number> {
  const { Command } = require('commander');
  const program = new Command();
  program
    .name('debun-plus')
    .description('Collect JavaScript sources and produce Phase 0 content fragments.')
    .argument('<url-or-path>', 'HTTP(S) URL, JavaScript file, or directory')
    .option('-o, --output <file>', 'write the intermediate JSON file', 'fragments.json')
    .option('-c, --concurrency <n>', 'maximum concurrent collection and parse operations', (value: string) => Number.parseInt(value, 10), DEFAULT_CONCURRENCY)
    .option('--retries <n>', 'retry failed HTTP requests with exponential backoff', (value: string) => Number.parseInt(value, 10), DEFAULT_RETRIES)
    .option('--backoff-ms <n>', 'initial retry backoff in milliseconds', (value: string) => Number.parseInt(value, 10), DEFAULT_BACKOFF_MS)
    .option('--depth <n>', '0 keeps the Phase 0 single-page flow; 1..3 runs a bounded multi-page package scan', (value: string) => Number.parseInt(value, 10), 0)
    .option('--allow-domain <domain>', 'allow this additional domain and its subdomains (repeatable)', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--max-asset-mb <n>', 'maximum total JavaScript asset bytes during a multi-page scan', (value: string) => Number.parseFloat(value), 50)
    .option('--request-delay-ms <n>', 'minimum delay between requests to the same host in crawl mode', (value: string) => Number.parseInt(value, 10), 250)
    .option('--offline', 'use only cached registry metadata and version fingerprints in multi-page mode')
    .option('--database <sqlite-file>', 'registry and fingerprint cache for multi-page mode', 'storage/debun-plus.sqlite')
    .option('--max-candidates <n>', 'maximum candidate packages to compare in multi-page mode', (value: string) => Number.parseInt(value, 10), 20)
    .showHelpAfterError();
  try {
    await program.parseAsync(argv);
  } catch (error: any) {
    if (error?.code === 'commander.helpDisplayed' || error?.code === 'commander.version') return 0;
    process.stderr.write(`${error?.message || error}\n`);
    return error?.exitCode || 2;
  }

  const input = program.args[0] as string;
  const options = program.opts();
  try {
    if (!Number.isInteger(options.depth) || options.depth < 0 || options.depth > 3) {
      process.stderr.write('--depth must be an integer from 0 to 3.\n');
      return 2;
    }
    if (!Number.isFinite(options.maxAssetMb) || options.maxAssetMb <= 0) {
      process.stderr.write('--max-asset-mb must be a positive number.\n');
      return 2;
    }
    if (!Number.isInteger(options.requestDelayMs) || options.requestDelayMs < 0) {
      process.stderr.write('--request-delay-ms must be a non-negative integer.\n');
      return 2;
    }
    if (options.depth > 0) {
      const { runAnalysisCli } = require('./analysis-cli');
      const analysisArgs = [input, '--depth', String(options.depth), '--max-asset-mb', String(options.maxAssetMb), '--request-delay-ms', String(options.requestDelayMs), '--concurrency', String(options.concurrency), '--database', options.database, '--max-candidates', String(options.maxCandidates)];
      for (const domain of options.allowDomain) analysisArgs.push('--allow-domain', domain);
      if (options.offline) analysisArgs.push('--offline');
      if (program.getOptionValueSource?.('output') === 'cli') analysisArgs.push('--output', options.output);
      return await runAnalysisCli(analysisArgs);
    }
    const result = await runPhase0(input, {
      outputPath: options.output,
      concurrency: options.concurrency,
      retries: options.retries,
      backoffMs: options.backoffMs,
      onLog: (message) => console.log(message),
    });
    console.log(`Parsed sources: ${result.stats.sourcesParsed}/${result.stats.sourcesDiscovered}`);
    console.log(`Fragments: ${result.stats.fragments} (${result.fragments.filter((fragment) => fragment.granularity === 'function').length} function, ${result.fragments.filter((fragment) => fragment.granularity === 'statement-block').length} statement-block)`);
    console.log(`Parse failures: ${result.stats.parseFailures}; fetch failures: ${result.stats.fetchFailures}`);
    console.log(`Removed runtime identifiers: ${result.removedRuntimeIdentifiers.length}`);
    console.log(`Intermediate JSON: ${path.resolve(options.output)}`);
    const literalCache = createSqliteCache();
    try {
      const indexInfo = literalCache.getLiteralIndexInfo?.('topN');
      if (!indexInfo) {
        console.log('Phase 1 literal index: not built (run "debun-plus build-index --packages <list-file> --tier topN").');
      } else {
        const matches = matchLiteralFragments(result.fragments, literalCache, 'topN')
          .filter((match) => match.strong)
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        const bestByPackage = new Map<string, typeof matches[number]>();
        for (const match of matches) {
          const key = `${match.name.toLowerCase()}@${match.version}`;
          if (!bestByPackage.has(key)) bestByPackage.set(key, match);
        }
        const topMatches = [...bestByPackage.values()].slice(0, 20);
        console.log(`Phase 1 literal index: ${indexInfo.packagesIndexed} indexed packages; ${topMatches.length} strong package candidates.`);
        for (const match of topMatches) console.log(`  ${match.name}@${match.version}  score ${match.score.toFixed(3)}  ${match.matchedLiteralCount} literals`);
      }
    } finally {
      literalCache.close?.();
    }
    return result.stats.parseFailures || result.stats.fetchFailures ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Phase 0 failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
