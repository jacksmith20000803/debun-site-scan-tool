import { describe, expect, it } from 'vitest';
import { createDetectionReport, renderDetectionTable, renderExplain } from '../src/debun-plus/report';
import type { PackageDetection } from '../src/debun-plus/types';

describe('final detection output', () => {
  it('includes tier, confidence, evidence sources, and dependency presence status in JSON and the table', () => {
    const packages: PackageDetection[] = [{
      name: 'tiny-lib', version: '^2.0.0', tier: 'range', score: 0.72, margin: 0.04,
      dependencyStatus: 'confirmed', dependencies: {},
      evidence: [
        { source: 'license-banner', detail: 'license identifies tiny-lib' },
        { source: 'registry-fingerprint', signal: 'ast-hash', detail: 'AST score supports a range', weight: 0.72 },
      ],
    }];
    const report = createDetectionReport('bundle.js', packages, { fingerprintSlices: 4 }, [{
      sourceFile: 'bundle.js', bundleFormat: 'unrecognized(unknown)', confidence: 0.42,
      hints: [], evidence: ['top-level declaration or lazy function slices'],
    }]);

    expect(report.bundleFormats[0]).toMatchObject({
      sourceFile: 'bundle.js', bundleFormat: 'unrecognized(unknown)', confidence: 0.42, hints: [],
    });

    expect(report.packages[0]).toMatchObject({
      name: 'tiny-lib', version: '^2.0.0', tier: 'range', confidence: 0.72,
      evidenceSources: ['license-banner', 'registry-fingerprint'],
      signals: ['ast-hash', 'license-banner'],
      dependencyStatus: 'confirmed',
    });
    const table = renderDetectionTable(report.packages);
    expect(table).toContain('Tier');
    expect(table).toContain('Confidence');
    expect(table).toContain('license-banner, registry-fingerprint');
    expect(renderExplain(report.packages)).toContain('ast-hash (weight 0.72): AST score supports a range');
  });
});
