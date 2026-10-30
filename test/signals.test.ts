import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { detectEmbeddedVersionSignals, detectLicenseBannerSignals, detectMetaFrameworkSignals, detectRuntimeGlobalSignals, detectUmdGlobalSignals, validatePublishedSignalVersions } from '../src/debun-plus/signals';
import { analyzeBundles } from '../src/debun-plus/pipeline';
import { createSqliteCache } from '../src/debun-plus/sqlite-cache';
import { phase1CandidateEvidence } from '../src/debun-plus/signals';

const fixturePath = (name: string) => resolve(process.cwd(), 'test/fixtures/phase1', name);
const jquerySourcePromise = readFile(fixturePath('jquery.umd.js'), 'utf8');
const nextSourcePromise = readFile(fixturePath('next-page-chunk.js'), 'utf8');

describe('Phase 1.2 independent package signals', () => {
  it('extracts package/version pairs from preserved license banners', async () => {
    const signals = await detectLicenseBannerSignals(await jquerySourcePromise);
    expect(signals).toContainEqual(expect.objectContaining({
      signal: 'license-banner', package: 'jquery', version: '3.7.1', weight: 0.95,
    }));
  });

  it('recognizes embedded versions and drops unpublished versions at registry validation', async () => {
    const signals = await detectEmbeddedVersionSignals(await jquerySourcePromise);
    const jqueryVersion = signals.find((item) => item.package === 'jquery' && item.version === '3.7.1');
    expect(jqueryVersion).toEqual(expect.objectContaining({ signal: 'embedded-version', weight: 0.98 }));
    expect(validatePublishedSignalVersions([jqueryVersion!], { versions: { '3.7.1': { name: 'jquery', version: '3.7.1' } } })).toEqual([jqueryVersion]);
    expect(validatePublishedSignalVersions([jqueryVersion!], { versions: { '3.6.4': { name: 'jquery', version: '3.6.4' } } })).toEqual([]);

    const genericVersion = await detectEmbeddedVersionSignals(`/*! @license @scope/widget */\nmodule.exports.version = '2.4.6';`);
    expect(genericVersion).toContainEqual(expect.objectContaining({ package: '@scope/widget', version: '2.4.6' }));
  });

  it('detects a jQuery runtime global without relying on UMD syntax', async () => {
    const globals = detectRuntimeGlobalSignals(`function usePlugin(){return window.jQuery.fn.jquery + jQuery.ajax('/api')}`);
    expect(globals).toContainEqual(expect.objectContaining({ signal: 'runtime-global', package: 'jquery' }));
    expect(detectRuntimeGlobalSignals(await jquerySourcePromise).some((item) => item.package === 'jquery')).toBe(true);
  });

  it('identifies UMD global leaks independently', async () => {
    const signals = detectUmdGlobalSignals(await jquerySourcePromise);
    expect(signals).toContainEqual(expect.objectContaining({ signal: 'umd-global', package: 'jquery' }));
    expect(detectUmdGlobalSignals('window.jQuery = api;')).toEqual([]);
  });

  it('detects Next.js page runtime reads from a page chunk', async () => {
    const signals = detectMetaFrameworkSignals(await nextSourcePromise);
    expect(signals).toContainEqual(expect.objectContaining({ signal: 'meta-framework', package: 'next' }));
  });

  it('does not expose embedded version evidence unless npm publishes that package version', async () => {
    const cache = createSqliteCache(':memory:');
    const embeddedHit = {
      signal: 'embedded-version' as const,
      package: 'jquery',
      version: '99.0.0',
      weight: 0.98,
      detail: 'fixture package version string',
    };
    try {
      const result = await analyzeBundles([{ code: 'function app(){return window.jQuery.fn.jquery}' }], {
        cache,
        registry: {
          async getPackument() { return { versions: { '3.7.1': { name: 'jquery', version: '3.7.1' } } }; },
          async getTarball() { return null; },
        },
        candidateNames: [{ name: 'jquery', evidence: [phase1CandidateEvidence(embeddedHit)] }],
      });
      const candidate = result.candidates.find((item) => item.name === 'jquery');
      expect(candidate?.evidence.some((item) => item.version === '99.0.0')).toBe(false);
      expect(candidate?.evidence.some((item) => item.signal === 'embedded-version')).toBe(false);
    } finally {
      cache.close();
    }
  });
});
