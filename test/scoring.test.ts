import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createStaticServer } from './helpers/server';
import { analyzeBundles, shouldReportPossibleCandidate } from '../src/debun-plus/pipeline';
import { fingerprintBundle, fingerprintCode, mergeVectors } from '../src/debun-plus/features';
import { normalizeBundle } from '../src/debun-plus/normalize';
import { discriminateVersions, scoreVectors } from '../src/debun-plus/scoring';
import { createSqliteCache } from '../src/debun-plus/sqlite-cache';
import { prepareCorpusVariants, selectProductionSources } from '../src/debun-plus/corpus';
import type { BundleSource, CachedVersionCorpus, FingerprintVector } from '../src/debun-plus/types';

const root = process.cwd();
const fixture = (path: string) => resolve(root, 'test/fixtures', path);
let tempDirs: string[] = [];
let activeServer: ReturnType<typeof createStaticServer> | null = null;

async function source(path: string): Promise<string> { return readFile(fixture(path), 'utf8'); }

function spawnAndCollect(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  if (activeServer) await activeServer.close();
  activeServer = null;
  for (const directory of tempDirs) await rm(directory, { recursive: true, force: true });
  tempDirs = [];
});

describe('Phase 2 scorer trio and version fusion', () => {
  it('filters weak AST-index-only possible detections while keeping corroborated leads', () => {
    expect(shouldReportPossibleCandidate([{ source: 'ast-property', detail: 'broad index match' }], 0.2434)).toBe(false);
    expect(shouldReportPossibleCandidate([{ source: 'ast-property', detail: 'stronger index match' }], 0.25)).toBe(true);
    expect(shouldReportPossibleCandidate([
      { source: 'ast-property', detail: 'broad index match' },
      { source: 'license-banner', detail: 'explicit package banner' },
    ], 0.1)).toBe(true);
  });

  it('builds identifier-normalized AST windows, literal 4-grams, and property/key dictionaries', async () => {
    const left = await fingerprintCode(`function alpha(variable){const config={field:'package marker'};return variable.field + config.field}`);
    const renamed = await fingerprintCode(`function beta(input){const settings={field:'package marker'};return input.field + settings.field}`);
    expect(left.astHashes).toEqual(renamed.astHashes);
    expect(left.ngrams).toContain('pack');
    expect(left.identifiers).toContain('field');
    expect(left.identifiers).not.toContain('variable');
    expect(left.identifiers).not.toContain('alpha');
  });

  it('uses directional AST coverage and fuses the three scorer values with the specified weights', () => {
    const vector = (overrides: Partial<FingerprintVector>): FingerprintVector => ({
      ngrams: [], astHashes: [], identifiers: [], stringLiterals: [], properties: [], cssClasses: [], runtimeGlobals: [], metaFrameworkReads: [], ...overrides,
    });
    const target = vector({ astHashes: ['a', 'b'], ngrams: ['n1', 'n2'], identifiers: ['key', 'method'] });
    const corpus = vector({ astHashes: ['a', 'b', 'c'], ngrams: ['n1', 'n2'], identifiers: ['key', 'method'] });
    expect(scoreVectors(target, corpus)).toEqual({ ast: 1, ngram: 1, ident: 1, score: 1 });
  });

  it('returns a range for a close, version-ambiguous code fixture', async () => {
    const target = await fingerprintCode(await source('scoring/ambiguous-a.js'));
    const neighbor = await fingerprintCode(await source('scoring/ambiguous-b.js'));
    const result = discriminateVersions([
      { version: '1.4.2', target, corpus: target },
      { version: '1.4.1', target, corpus: neighbor },
    ]);
    expect(result.tier).toBe('range');
    expect(result.version).toMatch(/^\^1\.4\./);
    expect(result.margin).toBeLessThan(0.08);
  });

  it('infers a major-line range from weak but cross-version-consistent bundle evidence', () => {
    const target = {
      ngrams: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'],
      astHashes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      identifiers: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'],
      stringLiterals: [], properties: [], cssClasses: [], runtimeGlobals: [], metaFrameworkReads: [],
    };
    const partialMatch = {
      ...target,
      ngrams: ['n1'], astHashes: ['a'], identifiers: ['i1'],
    };
    const unrelated = {
      ...target,
      ngrams: ['other'], astHashes: ['other'], identifiers: ['other'],
    };
    const supported = discriminateVersions([
      { version: '1.2.3', target, corpus: partialMatch },
      { version: '1.2.2', target, corpus: partialMatch },
      { version: '2.0.0', target, corpus: unrelated },
    ]);
    expect(supported.topScore).toBeGreaterThanOrEqual(0.12);
    expect(supported.topScore).toBeLessThan(0.25);
    expect(supported.tier).toBe('range');
    expect(supported.version).toBe('^1.2.3');

    const crossMajorTie = discriminateVersions([
      { version: '1.2.3', target, corpus: partialMatch },
      { version: '2.0.0', target, corpus: partialMatch },
    ]);
    expect(crossMajorTie.tier).toBe('possible');
    expect(crossMajorTie.version).toBe('unknown');
  });

  it('does not pin when separate fragments favor different package versions', async () => {
    const fragmentA = await fingerprintCode('function renderTitle(item){ return item.title.toUpperCase(); }');
    const fragmentB = await fingerprintCode('function readRows(data){ if(!data) return []; return data.rows.map(row => row.id); }');
    const result = discriminateVersions([
      { version: '2.0.0', target: fragmentA, corpus: fragmentA },
      { version: '2.0.0', target: fragmentB, corpus: fragmentA },
      { version: '2.0.1', target: fragmentA, corpus: fragmentB },
      { version: '2.0.1', target: fragmentB, corpus: fragmentB },
    ]);
    expect(result.tier).toBe('range');
    expect(result.margin).toBeLessThan(0.08);
  });

  it('prefers shipped minified builds and uses two bounded Terser configurations when absent', async () => {
    const preferred = selectProductionSources([
      { name: 'package/lib/index.js', content: 'library source' },
      { name: 'package/dist/index.js', content: 'production build' },
      { name: 'package/dist/index.min.js', content: 'minified build' },
    ]);
    expect(preferred.map((item) => item.content)).toEqual(['minified build']);

    const configs: Record<string, unknown>[] = [];
    const variants = await prepareCorpusVariants([
      { name: 'package/src/index.js', content: 'function library(value) { return value.property + "literal package content"; }' },
    ], async (code, options) => { configs.push(options); return `${code}/* minified-${configs.length} */`; });
    expect(configs).toHaveLength(2);
    expect(variants).toHaveLength(3);
  });

  it('pins all three known package versions through the bundle analysis pipeline', async () => {
    const known: Array<{ name: string; version: string; code: string }> = [
      { name: 'jquery', version: '3.7.1', code: await source('scoring/jquery-3.7.1.min.js') },
      { name: 'lodash', version: '4.18.1', code: await source('scoring/lodash-4.18.1.min.js') },
      { name: 'preact', version: '10.26.8', code: await source('site/vendor/preact-10.26.8.min.js') },
    ];
    const sources: BundleSource[] = known.map((item) => ({ url: `https://fixture.test/${item.name}-${item.version}.js`, code: item.code }));
    const cache = createSqliteCache(':memory:');
    try {
      for (const item of known) {
        const normalized = await normalizeBundle({ code: item.code });
        const vectors = await fingerprintBundle(normalized, 12);
        cache.putVersion({
          name: item.name,
          version: item.version,
          dependencies: {}, peerDependencies: {}, optionalDependencies: {},
          vector: mergeVectors(vectors), moduleVectors: vectors,
        });
      }
      let tarballRequests = 0;
      const registry = {
        async getPackument(name: string) {
          const item = known.find((entry) => entry.name === name);
          return item ? { versions: { [item.version]: { name, version: item.version } } } : null;
        },
        async getTarball() { tarballRequests++; throw new Error('warm corpus cache should prevent tarball requests'); },
      };
      const result = await analyzeBundles(sources, {
        cache,
        registry,
        candidateNames: known.map((item) => ({ name: item.name, evidence: [{ source: 'script-url' as const, detail: 'known fixture', version: item.version }] })),
        maxCandidates: 8,
        maxFingerprintSlices: 36,
        maxVersionsPerPackage: 1,
      });
      for (const item of known) expect(result.packages.find((pkg) => pkg.name === item.name)).toMatchObject({ version: item.version, tier: 'exact' });
      expect(tarballRequests).toBe(0);
      expect(result.stats.cacheHits).toBeGreaterThanOrEqual(3);
    } finally { cache.close(); }
  });

  it('samples older npm releases so production bundles can resolve beyond latest versions', async () => {
    const code = 'function renderPackageCard(item){ return item.packageName + item.versionLabel + item.descriptionText; }';
    const bundle = { url: 'https://fixture.test/assets/app.js', code };
    const target = await fingerprintCode((await normalizeBundle(bundle)).code);
    const cache = createSqliteCache(':memory:');
    const releases = ['1.7.0', '1.6.0', '1.5.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0'];
    const versions = Object.fromEntries(releases.map((version) => [version, {
      name: 'history-lib', version, dist: { tarball: `https://registry.test/history-lib-${version}.tgz` },
    }]));
    cache.putPackument('history-lib', { name: 'history-lib', versions });
    for (const version of releases) {
      const vector = version === '1.0.0'
        ? target
        : { ...target, astHashes: ['unrelated-ast'], ngrams: ['unrelated'], identifiers: ['unrelated'] };
      cache.putVersion({
        fingerprintRevision: 2,
        name: 'history-lib', version,
        dependencies: {}, peerDependencies: {}, optionalDependencies: {},
        vector, moduleVectors: [vector],
      });
    }
    try {
      const result = await analyzeBundles([bundle], {
        cache,
        registry: {
          async getPackument() { throw new Error('cached packument expected'); },
          async getTarball() { throw new Error('cached version corpora expected'); },
        },
        candidateNames: [{ name: 'history-lib', evidence: [{ source: 'debun-pog', detail: 'versionless package lead' }] }],
        maxCandidates: 2,
        maxVersionsPerPackage: 4,
        maxTransitiveDepth: 0,
      });
      expect(result.packages.find((item) => item.name === 'history-lib')).toMatchObject({
        version: '1.0.0', tier: 'exact',
      });
    } finally {
      cache.close();
    }
  });

  it('completes a warm-cache page-deps CLI scan of the three-package fixture in under 60 seconds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'debun-scorer-cli-'));
    tempDirs.push(directory);
    const vendor = join(directory, 'vendor');
    await mkdir(vendor, { recursive: true });
    const packages = [
      { name: 'jquery', version: '3.7.1', source: fixture('scoring/jquery-3.7.1.min.js'), file: 'jquery-3.7.1.min.js' },
      { name: 'lodash', version: '4.18.1', source: fixture('scoring/lodash-4.18.1.min.js'), file: 'lodash-4.18.1.min.js' },
      { name: 'preact', version: '10.26.8', source: fixture('site/vendor/preact-10.26.8.min.js'), file: 'preact-10.26.8.min.js' },
    ];
    const htmlScripts: string[] = [];
    const warmSources: BundleSource[] = [];
    const cachePath = join(directory, 'warm-cache.sqlite');
    const cache = createSqliteCache(cachePath);
    try {
      for (const item of packages) {
        await copyFile(item.source, join(vendor, item.file));
        htmlScripts.push(`<script src="/vendor/${item.file}"></script>`);
        const code = await readFile(item.source, 'utf8');
        warmSources.push({ url: `http://fixture.test/vendor/${item.file}`, code });
        const vectors = await fingerprintBundle(await normalizeBundle({ code }), 86);
        const corpus: CachedVersionCorpus = {
          name: item.name, version: item.version, dependencies: {}, peerDependencies: {}, optionalDependencies: {},
          vector: mergeVectors(vectors), moduleVectors: vectors,
        };
        cache.putVersion(corpus);
        cache.putPackument(item.name, { versions: { [item.version]: { name: item.name, version: item.version } } });
      }
      // Warm metadata for other heuristic candidates too, so the CLI timing
      // checks the cache path and never depends on a live registry response.
      const knownByName = new Map(packages.map((item) => [item.name, item]));
      await analyzeBundles(warmSources, {
        cache,
        maxCandidates: 20,
        registry: {
          async getPackument(name: string) {
            const item = knownByName.get(name);
            return item ? { versions: { [item.version]: { name, version: item.version } } } : { name, versions: {} };
          },
          async getTarball() { throw new Error('warm cache preparation must not request tarballs'); },
        },
      });
      await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><title>Scorer fixture</title>${htmlScripts.join('')}</head><body><main>fixture site</main></body></html>`, 'utf8');
    } finally { cache.close(); }

    activeServer = createStaticServer(directory);
    const url = await activeServer.listen();
    const started = Date.now();
    const cli = await spawnAndCollect(process.execPath, [
      'bin/page-deps.js', url, '--no-color', '--no-debun', '--no-source-maps', '--no-root-manifest', '--plus-database', cachePath,
    ], root);
    const elapsed = Date.now() - started;
    expect(cli.code, cli.stderr || cli.stdout).toBe(0);
    expect(elapsed).toBeLessThan(60_000);
    for (const item of packages) expect(cli.stdout).toMatch(new RegExp(`${item.name}\\s+${item.version.replaceAll('.', '\\.')}\\s`));
    expect(cli.stdout).not.toContain('Warnings (1)');
  }, 65_000);
});
