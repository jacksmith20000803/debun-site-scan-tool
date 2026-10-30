import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateBundleDirectory, formatEvaluationMarkdown } from '../src/debun-plus/evaluation';
import type { DebunPlusResult, PackageDetection } from '../src/debun-plus/types';

function detection(name: string, version: string, tier: PackageDetection['tier']): PackageDetection {
  return { name, version, tier, score: 0.8, margin: 0.1, dependencies: {}, evidence: [{ source: 'registry-fingerprint', detail: 'fixture signal' }] };
}

describe('evaluation harness', () => {
  it('scores package names and versions overall and by verdict tier', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'debun-plus-eval-'));
    const bundlesDir = path.join(temporaryRoot, 'bundles');
    const truthPath = path.join(temporaryRoot, 'truth.json');
    await mkdir(bundlesDir);
    await writeFile(path.join(bundlesDir, 'a.js'), 'fixture-a');
    await writeFile(path.join(bundlesDir, 'b.js'), 'fixture-b');
    await writeFile(truthPath, JSON.stringify({
      schemaVersion: 1,
      fixtures: [
        { id: 'a', bundler: 'esbuild', bundle: 'a.js', packages: [{ name: 'alpha', version: '1.0.0' }] },
        { id: 'b', bundler: 'rollup', bundle: 'b.js', packages: [{ name: 'beta', version: '2.2.0' }] },
      ],
    }));
    try {
      const report = await evaluateBundleDirectory({
        bundlesDir,
        groundTruthPath: truthPath,
        analyze: async ([source]) => ({
          packages: source.code === 'fixture-a'
            ? [detection('alpha', '1.0.0', 'exact'), detection('untracked', '1.0.0', 'possible')]
            : [detection('beta', '^2.0.0', 'range')],
          candidates: [],
          stats: { bundlesNormalized: 1, moduleSlices: 0, fingerprintSlices: 0, candidatesGenerated: 0, versionsCompared: 0, registryRequests: 0, cacheHits: 0 },
        } satisfies DebunPlusResult),
      });

      expect(report.fixtureCount).toBe(2);
      expect(report.overall.name).toMatchObject({ truePositive: 2, falsePositive: 1, falseNegative: 0, precision: 0.6667, recall: 1 });
      expect(report.overall.version).toMatchObject({ truePositive: 2, falsePositive: 1, falseNegative: 0 });
      expect(report.byTier.exact.name).toMatchObject({ truePositive: 1, falsePositive: 0, falseNegative: 1 });
      expect(report.byTier.range.version).toMatchObject({ truePositive: 1, falsePositive: 0, falseNegative: 1 });
      expect(report.byTier.possible.name).toMatchObject({ truePositive: 0, falsePositive: 1, falseNegative: 2 });
      expect(formatEvaluationMarkdown(report)).toContain('| esbuild |');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects ground-truth paths that escape the bundle directory', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'debun-plus-eval-'));
    const bundlesDir = path.join(temporaryRoot, 'bundles');
    await mkdir(bundlesDir);
    const truthPath = path.join(temporaryRoot, 'truth.json');
    await writeFile(truthPath, JSON.stringify({ schemaVersion: 1, fixtures: [{
      id: 'escape', bundler: 'esbuild', bundle: '../outside.js', packages: [],
    }] }));
    try {
      await expect(evaluateBundleDirectory({ bundlesDir, groundTruthPath: truthPath })).rejects.toThrow('escapes --bundles');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
