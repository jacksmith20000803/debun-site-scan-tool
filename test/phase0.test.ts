import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runPhase0 } from '../src/debun-plus/phase0';
import { normalizeBundle } from '../src/debun-plus/normalize';
import { runAnalysisCli } from '../src/debun-plus/analysis-cli';

const fixture = (name: string) => resolve(process.cwd(), 'test/fixtures/phase0', name);

describe('Phase 0 source normalization and slicing', () => {
  it('slices a minified webpack-style chunk and preserves its license banner', async () => {
    const result = await runPhase0(fixture('webpack.min.js'));
    expect(result.fragments.length).toBeGreaterThan(0);
    expect(result.fragments.some((fragment) => fragment.granularity === 'function')).toBe(true);
    expect(result.fragments.some((fragment) => fragment.granularity === 'statement-block')).toBe(true);
    expect(result.fragments.some((fragment) => fragment.code.includes('debounce'))).toBe(true);
    expect(result.fragments.some((fragment) => fragment.licenseComments.some((comment) => comment.includes('@license MIT')))).toBe(true);
    expect(result.removedRuntimeIdentifiers).toContain('webpackChunk_demo');
    expect(result.sources[0].strippedSource).not.toContain('webpackChunk_demo');
  });

  it('slices library code from an esbuild-style helper wrapper', async () => {
    const result = await runPhase0(fixture('esbuild.js'));
    expect(result.fragments.length).toBeGreaterThan(0);
    expect(result.fragments.some((fragment) => fragment.code.includes('parseColor'))).toBe(true);
    expect(result.removedRuntimeIdentifiers).toContain('__defProp');
  });

  it('slices library code while removing Rollup export metadata', async () => {
    const result = await runPhase0(fixture('rollup.js'));
    expect(result.fragments.length).toBeGreaterThan(0);
    expect(result.fragments.some((fragment) => fragment.code.includes('clampValue'))).toBe(true);
    expect(result.sources[0].strippedSource).not.toContain('__esModule');
  });

  it('slices current stable Turbopack registration arrays by structure and keeps the bundler as a hint', async () => {
    const chunkDirectory = resolve(process.cwd(), 'test/fixtures/turbopack/next-16.4.2/chunks');
    const chunkFiles = await readdir(chunkDirectory);
    let chunk = '';
    for (const file of chunkFiles) {
      const candidate = resolve(chunkDirectory, file);
      const code = await readFile(candidate, 'utf8');
      if (code.includes('kebabCase') && code.includes('TURBOPACK')) { chunk = candidate; break; }
    }
    expect(chunk).not.toBe('');
    const result = await runPhase0(chunk);
    expect(result.sources[0].bundleFormat).toBe('recognized(module-registry)');
    expect(result.sources[0].bundleFormatHints).toContain('turbopack');
    expect(result.fragments.some((fragment) => fragment.code.includes('kebabCase'))).toBe(true);
    expect(result.sources[0].bundleFormatConfidence).toBeGreaterThan(0.7);
  }, 30_000);

  it('keeps ESM-shaped top-level declarations and reports unknown bundle formats honestly', async () => {
    const code = 'const esmSentinel = "top-level-library-sentinel"; export function transformValue(input){return input + esmSentinel}';
    const normalized = await normalizeBundle({ url: 'fixture.mjs', code });
    expect(normalized.coarseModules.some((fragment) => fragment.includes('esmSentinel'))).toBe(true);
    expect(normalized.bundleFormat).toBe('unrecognized(unknown)');
    expect(normalized.bundleFormatConfidence).toBeLessThan(0.5);
  });

  it('recognizes an unfamiliar module registry without any bundler-name hint', async () => {
    const code = 'globalThis.registry.push([document.currentScript,73,(a,b,c)=>{return "package-fragment-alpha"},74,(a,b,c)=>{return "package-fragment-beta"}]);';
    const normalized = await normalizeBundle({ code });
    expect(normalized.bundleFormat).toBe('recognized(module-registry)');
    expect(normalized.bundleFormatHints).toEqual([]);
    expect(normalized.bundleFormatConfidence).toBeGreaterThan(0.7);
    expect(normalized.coarseModules.length).toBe(2);
  });

  it('reports UTF-8 byte offsets and records malformed sources without throwing', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'debun-phase0-'));
    const file = path.join(directory, 'broken.js');
    await fs.writeFile(file, 'const broken = ;', 'utf8');
    try {
      const unicodeSource = 'function emoji(){return "😀"}';
      const temp = path.join(directory, 'unicode.js');
      await fs.writeFile(temp, unicodeSource, 'utf8');
      const unicodeResult = await runPhase0(temp);
      const functionFragment = unicodeResult.fragments.find((fragment) => fragment.granularity === 'function');
      expect(functionFragment?.endByte).toBe(Buffer.byteLength(unicodeSource, 'utf8'));

      // Recursive directory collection isolates malformed files without losing good sources.
      const malformedResult = await runPhase0(directory);
      expect(malformedResult.stats.parseFailures).toBe(1);
      expect(malformedResult.parseFailures[0].sourceFile).toBe(file);
      expect(malformedResult.stats.sourcesParsed).toBe(1);
      expect(malformedResult.stats.sourcesDiscovered).toBe(2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('collects page scripts with bounded concurrency and retries transient failures', async () => {
    const counts = new Map<string, number>();
    let active = 0;
    let peakActive = 0;
    const scriptPaths = Array.from({ length: 10 }, (_, index) => `/asset-${index}.js`);
    const fetchImpl = async (input: string) => {
      if (input === 'https://example.test/') {
        return {
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () => `<html>${scriptPaths.map((src) => `<script src="${src}"></script>`).join('')}<script>function inlineWidget(value){return value + "inline-widget"}</script></html>`,
        };
      }
      const count = (counts.get(input) || 0) + 1;
      counts.set(input, count);
      if (input.endsWith('/asset-0.js') && count === 1) {
        return { ok: false, status: 503, statusText: 'Unavailable', headers: { get: () => 'text/javascript' }, text: async () => '' };
      }
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active--;
      const index = Number(input.match(/asset-(\d+)\.js$/)?.[1] || 0);
      return {
        ok: true,
        headers: { get: () => 'text/javascript' },
        text: async () => `function packageAsset${index}(value){return value + "asset-${index}"}`,
      };
    };
    const result = await runPhase0('https://example.test/', { fetchImpl, retries: 1, backoffMs: 0, concurrency: 8 });
    expect(result.stats.sourcesDiscovered).toBe(11);
    expect(result.stats.fetchFailures).toBe(0);
    expect(counts.get('https://example.test/asset-0.js')).toBe(2);
    expect(peakActive).toBeLessThanOrEqual(8);
    expect(result.fragments.some((fragment) => fragment.code.includes('packageAsset9'))).toBe(true);
    expect(result.fragments.some((fragment) => fragment.code.includes('inlineWidget'))).toBe(true);
  });

  it('explains an empty scan when the page exposes no JavaScript sources', async () => {
    const result = await runPhase0('https://example.test/no-scripts', {
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => '<!doctype html><html><head><title>No scripts</title></head><body>Static page</body></html>',
      }),
    });
    expect(result.stats.sourcesDiscovered).toBe(0);
    expect(result.warnings).toContain('No JavaScript sources were discovered for https://example.test/no-scripts.');
  });

  it('keeps Phase 0 format diagnostics in the final single-file JSON report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'debun-format-report-'));
    const bundle = join(directory, 'bundle.js');
    const reportFile = join(directory, 'report.json');
    try {
      await writeFile(bundle, 'globalThis.registry.push([null,1,(a,b,c)=>{return "package-fragment-alpha"},2,(a,b,c)=>{return "package-fragment-beta"}]);');
      const exitCode = await runAnalysisCli([bundle, '--offline', '--database', join(directory, 'cache.sqlite'), '--output', reportFile]);
      expect(exitCode).toBe(0);
      const report = JSON.parse(await readFile(reportFile, 'utf8'));
      expect(report.bundleFormats[0]).toMatchObject({
        bundleFormat: 'recognized(module-registry)', confidence: 0.78,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
