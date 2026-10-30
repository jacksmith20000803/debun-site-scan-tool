'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeBundles,
  createSqliteCache,
  discriminateVersions,
  fingerprintCode,
  fingerprintCss,
  intersectConstraints,
  intrinsicCandidates,
  normalizeBundle,
  parseWithBabel,
  parseWithFallback,
  satisfies,
  withBoundedRegistry,
} = require('../dist/src/debun-plus');
const { analyze } = require('../src/analyze');
const { inferWithDebun } = require('../src/inference/debun');
const { createStaticServer } = require('./helpers/server');
const path = require('node:path');

function vector(overrides = {}) {
  return {
    ngrams: [], astHashes: [], identifiers: [], stringLiterals: [], properties: [],
    cssClasses: [], runtimeGlobals: [], metaFrameworkReads: [], ...overrides,
  };
}

test('legacy fingerprint inference stops when its worker exceeds the time budget', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    inferWithDebun([{ url: 'https://example.test/large.js', code: 'function app(){ return window.app; }' }], { timeoutMs: 1 }),
    /time budget/,
  );
  assert.ok(Date.now() - startedAt < 2000, `timed out worker took ${Date.now() - startedAt}ms to stop`);
});

class MemoryCache {
  versions = new Map();
  packuments = new Map();
  getVersion(name, version) { return this.versions.get(`${name}@${version}`) || null; }
  putVersion(value) { this.versions.set(`${value.name}@${value.version}`, value); }
  getPackument(name) { return this.packuments.get(name) || null; }
  putPackument(name, value) { this.packuments.set(name, value); }
  findCandidateNames() { return []; }
}

test('Phase 0 normalizes module tables into two slice sizes and preserves license comments', async () => {
  const source = `/*! React v18.3.1 | MIT License */\n(()=>{var modules={\n  101:function(module){module.exports={read:function(x){return x.name}}},\n  102:(module)=>{module.exports=function(y){return y.value}}\n}; function __webpack_require__(id){return modules[id]({})} })();`;
  const normalized = await normalizeBundle({ url: 'https://example.test/assets/app.js', code: source });
  assert.equal(normalized.coarseModules.length, 2);
  assert.ok(normalized.fineModules.length >= 2);
  assert.match(normalized.code, /React v18\.3\.1/);
  assert.equal(normalized.licenseComments.length, 1);
  assert.doesNotMatch(normalized.code, /__webpack_require__/);
  const moduleFeatures = await fingerprintCode(normalized.code);
  assert.ok(moduleFeatures.properties.some((property) => property.endsWith('.name')));
});

test('candidate generation finds embedded package paths, runtime globals, and version strings', () => {
  const hits = intrinsicCandidates(`/*! lodash 4.17.21 | MIT License */\nvar x=require('./node_modules/@demo/core/index.js'); jQuery.fn.jquery="3.7.1";`);
  assert.ok(hits.some((hit) => hit.name === '@demo/core' && hit.source === 'bundle-string'));
  assert.ok(hits.some((hit) => hit.name === 'lodash' && hit.version === '4.17.21'));
  assert.ok(hits.some((hit) => hit.name === 'jquery' && hit.version === '3.7.1' && hit.source === 'embedded-version'));
});

test('CSS class index extracts production selectors without parsing CSS as JavaScript', () => {
  const css = fingerprintCss('.MuiButton-root{display:flex}.ant-btn-primary{color:red}.btn-primary{color:blue}');
  assert.ok(css.cssClasses.includes('MuiButton-root'));
  assert.ok(css.cssClasses.includes('ant-btn-primary'));
  assert.ok(css.cssClasses.includes('btn-primary'));
});

test('Oxc parser failure falls back to the injected Babel parser', async () => {
  const result = await parseWithFallback(
    'const value: number = 1;',
    async () => { throw new Error('primary parse failed'); },
    parseWithBabel,
  );
  assert.equal(result.parser, '@babel/parser');
  assert.equal(result.program.type, 'Program');
});

test('fused version scoring emits exact only when score and margin pass thresholds', () => {
  const target = vector({ astHashes: ['a', 'b'], ngrams: ['x', 'y'], identifiers: ['foo', 'bar'] });
  const exact = discriminateVersions([
    { version: '1.2.0', target, corpus: target },
    { version: '1.1.0', target, corpus: vector({ astHashes: ['q'], ngrams: ['z'], identifiers: ['quux'] }) },
  ]);
  assert.equal(exact.tier, 'exact');
  assert.equal(exact.version, '1.2.0');
  const ambiguous = discriminateVersions([
    { version: '1.2.0', target, corpus: target },
    { version: '1.1.0', target, corpus: target },
  ]);
  assert.equal(ambiguous.tier, 'range');
  assert.match(ambiguous.version, /^\^1\.2\.0$/);
});

test('semver constraints intersect before selecting a transitive version', () => {
  assert.equal(satisfies('1.3.5', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  const intersection = intersectConstraints(['^1.2.0', '<1.4.0'], ['1.1.0', '1.2.0', '1.3.5', '1.4.0']);
  assert.equal(intersection.selectedVersion, '1.3.5');
});

test('pipeline recognizes a cached exact bundle version and propagates verified registry dependencies', async () => {
  const code = `/*! React v18.3.1 | MIT License */\nfunction render(el){return el.type + el.props.children + Array.isArray(el.children)}`;
  const normalized = await normalizeBundle({ url: 'https://example.test/app.js', code });
  const target = await fingerprintCode(normalized.code);
  const cache = new MemoryCache();
  const corpus = (name, version, fingerprint, dependencies = {}) => ({
    name, version, dependencies, peerDependencies: {}, optionalDependencies: {}, vector: fingerprint, moduleVectors: [fingerprint],
  });
  cache.putVersion(corpus('react', '18.3.1', target, { scheduler: '^0.23.0' }));
  cache.putVersion(corpus('react', '18.2.0', vector({ identifiers: ['unrelated'], ngrams: ['different'], astHashes: ['different'] })));
  cache.putVersion(corpus('scheduler', '0.23.2', target));
  cache.putVersion(corpus('scheduler', '0.23.1', vector({ identifiers: ['unrelated'], ngrams: ['different'], astHashes: ['different'] })));

  const packuments = {
    react: {
      versions: {
        '18.3.1': { name: 'react', version: '18.3.1', dependencies: { scheduler: '^0.23.0' }, dist: { tarball: 'https://registry.test/react-18.3.1.tgz' } },
        '18.2.0': { name: 'react', version: '18.2.0', dist: { tarball: 'https://registry.test/react-18.2.0.tgz' } },
      },
    },
    scheduler: {
      versions: {
        '0.23.2': { name: 'scheduler', version: '0.23.2', dist: { tarball: 'https://registry.test/scheduler-0.23.2.tgz' } },
        '0.23.1': { name: 'scheduler', version: '0.23.1', dist: { tarball: 'https://registry.test/scheduler-0.23.1.tgz' } },
      },
    },
  };
  const registry = {
    async getPackument(name) { return packuments[name] || null; },
    async getTarball() { throw new Error('cache hit expected; no tarballs should be fetched'); },
  };

  const result = await analyzeBundles([{ url: 'https://example.test/app.js', code }], {
    cache,
    registry,
    candidateNames: [{ name: 'react', evidence: [{ source: 'debun-pog', detail: 'fixture candidate' }] }],
    maxCandidates: 4,
    maxFingerprintSlices: 1,
  });
  assert.equal(result.packages.find((item) => item.name === 'react').tier, 'exact');
  assert.equal(result.packages.find((item) => item.name === 'react').version, '18.3.1');
  assert.ok(result.stats.fingerprintSlices <= 1);
  const scheduler = result.packages.find((item) => item.name === 'scheduler');
  assert.ok(scheduler);
  assert.equal(scheduler.tier, 'exact');
  assert.equal(scheduler.version, '0.23.2');
  assert.ok(scheduler.evidence.some((item) => item.source === 'transitive-registry'));
});

test('registry operations obey one shared concurrency cap', async () => {
  let active = 0;
  let maxActive = 0;
  const wrapped = withBoundedRegistry({
    async getPackument() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return {};
    },
    async getTarball() { return null; },
  }, 2);
  await Promise.all(Array.from({ length: 8 }, () => wrapped.getPackument('sample')));
  assert.ok(maxActive <= 2, `observed concurrency ${maxActive}`);
});

test('SQLite corpus cache persists version fingerprints and inverted features', () => {
  const cache = createSqliteCache(':memory:');
  try {
    cache.putVersion({
      name: 'fixture-lib', version: '1.2.3', dependencies: {}, peerDependencies: {}, optionalDependencies: {},
      vector: vector({ stringLiterals: ['unique fixture marker'], properties: ['fixture.render'] }),
    });
    assert.equal(cache.getVersion('fixture-lib', '1.2.3').version, '1.2.3');
    assert.ok(cache.findCandidateNames(['s:unique fixture marker'], 5).some((item) => item.name === 'fixture-lib'));
  } finally { cache.close(); }
});

test('legacy analyzer does not promote candidates without registry fingerprints into installed packages', async () => {
  const site = createStaticServer(path.join(__dirname, 'fixtures', 'site'));
  const baseUrl = await site.listen();
  const cache = new MemoryCache();
  try {
    const result = await analyze(baseUrl, {
      timeout: 10000,
      includeSourceMaps: false,
      fetchRootManifest: false,
      useDebun: false,
      debunPlus: true,
      debunPlusOptions: {
        cache,
        registry: { async getPackument() { return null; }, async getTarball() { return null; } },
        candidateNames: [{ name: 'unavailable-package', evidence: [{ source: 'debun-pog', detail: 'integration fixture' }] }],
      },
    });
    assert.equal(result.debunPlus.stats.bundlesNormalized, result.stats.sourcesAnalyzed > 0 ? result.stats.externalScripts + result.stats.inlineScripts : 0);
    assert.equal(result.packages.some((item) => item.name === 'unavailable-package'), false);
  } finally {
    await site.close();
  }
});

test('registry inference completes beyond the removed page-wide registry budget', async () => {
  const site = createStaticServer(path.join(__dirname, 'fixtures', 'site'));
  const baseUrl = await site.listen();
  let registryRequestFinished = false;
  try {
    const result = await analyze(baseUrl, {
      timeout: 10000,
      includeSourceMaps: false,
      fetchRootManifest: false,
      useDebun: false,
      debunPlus: true,
      // This legacy option used to trigger an internal abort (clamped to 1s).
      registryAnalysisBudgetMs: 1,
      debunPlusOptions: {
        cache: new MemoryCache(),
        registry: {
          async getPackument() {
            await new Promise((resolve) => setTimeout(resolve, 1100));
            registryRequestFinished = true;
            return { name: 'unavailable-package', versions: {} };
          },
          async getTarball() { return null; },
        },
        candidateNames: [{ name: 'unavailable-package', evidence: [{ source: 'debun-pog', detail: 'slow registry fixture' }] }],
      },
    });
    assert.equal(registryRequestFinished, true);
    assert.ok(result.debunPlus, 'registry inference should return a result');
    assert.ok(!result.errors.some((error) => error.includes('page budget')));
  } finally {
    await site.close();
  }
});
