declare const require: (name: string) => any;

import { analyzeBundles } from './pipeline';
import { satisfies } from './semver';
import { DebunPlusOptions, DebunPlusResult, PackageDetection } from './types';

const fs = require('node:fs/promises');
const path = require('node:path');

export interface GroundTruthPackage {
  name: string;
  version: string;
}

export interface GroundTruthFixture {
  id: string;
  bundler: string;
  bundle: string;
  buildMethod?: string;
  packages: GroundTruthPackage[];
}

export interface GroundTruthFile {
  schemaVersion: 1;
  builderInfo?: Record<string, unknown> & { note?: string };
  fixtures: GroundTruthFixture[];
}

export interface EvaluationMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
}

export interface EvaluationFixtureResult extends GroundTruthFixture {
  predictedPackages: PackageDetection[];
}

export interface EvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  bundleDirectory: string;
  groundTruthFile: string;
  fixtureCount: number;
  builderInfo?: GroundTruthFile['builderInfo'];
  overall: { name: EvaluationMetrics; version: EvaluationMetrics };
  byTier: Record<'exact' | 'range' | 'possible', { name: EvaluationMetrics; version: EvaluationMetrics }>;
  byBundler: Record<string, { name: EvaluationMetrics; version: EvaluationMetrics }>;
  fixtures: EvaluationFixtureResult[];
}

export interface EvaluationOptions {
  bundlesDir: string;
  groundTruthPath: string;
  analyze?: (sources: Array<{ url?: string; code: string }>, options?: DebunPlusOptions) => Promise<DebunPlusResult>;
  analyzeOptions?: DebunPlusOptions;
}

function normalizedName(name: string): string { return name.trim().toLowerCase(); }

function assertGroundTruth(value: unknown): GroundTruthFile {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).fixtures)) {
    throw new Error('Ground truth must be a JSON object with a fixtures array.');
  }
  const fixtures = (value as any).fixtures as any[];
  const ids = new Set<string>();
  for (const [index, fixture] of fixtures.entries()) {
    if (!fixture || typeof fixture.id !== 'string' || !fixture.id.trim()) throw new Error(`Ground-truth fixture ${index + 1} is missing an id.`);
    if (ids.has(fixture.id)) throw new Error(`Ground-truth fixture id is duplicated: ${fixture.id}`);
    ids.add(fixture.id);
    if (typeof fixture.bundler !== 'string' || !fixture.bundler.trim()) throw new Error(`Ground-truth fixture ${fixture.id} is missing its bundler.`);
    if (typeof fixture.bundle !== 'string' || !fixture.bundle.trim()) throw new Error(`Ground-truth fixture ${fixture.id} is missing its bundle path.`);
    if (!Array.isArray(fixture.packages)) throw new Error(`Ground-truth fixture ${fixture.id} must contain a packages array.`);
    for (const item of fixture.packages) {
      if (!item || typeof item.name !== 'string' || typeof item.version !== 'string') {
        throw new Error(`Ground-truth fixture ${fixture.id} has a package without name and version.`);
      }
    }
  }
  return value as GroundTruthFile;
}

function containedBundlePath(directory: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error(`Bundle path must be relative to --bundles: ${relativePath}`);
  const root = path.resolve(directory);
  const file = path.resolve(root, relativePath);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error(`Bundle path escapes --bundles: ${relativePath}`);
  return file;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function metric(truePositive: number, falsePositive: number, falseNegative: number): EvaluationMetrics {
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
  };
}

function versionMatches(truth: GroundTruthPackage, detection: PackageDetection): boolean {
  if (detection.tier === 'range') return satisfies(truth.version, detection.version);
  return detection.version === truth.version;
}

function metricsFor(fixtures: EvaluationFixtureResult[], tier?: PackageDetection['tier']): { name: EvaluationMetrics; version: EvaluationMetrics } {
  let nameTp = 0; let nameFp = 0; let nameFn = 0;
  let versionTp = 0; let versionFp = 0; let versionFn = 0;
  for (const fixture of fixtures) {
    const truthByName = new Map(fixture.packages.map((item) => [normalizedName(item.name), item]));
    const predictions = fixture.predictedPackages.filter((item) => !tier || item.tier === tier);
    const predictionByName = new Map(predictions.map((item) => [normalizedName(item.name), item]));
    for (const prediction of predictions) {
      const truth = truthByName.get(normalizedName(prediction.name));
      if (truth) {
        nameTp++;
        if (versionMatches(truth, prediction)) versionTp++;
        else versionFp++;
      } else {
        nameFp++;
        versionFp++;
      }
    }
    for (const truth of fixture.packages) {
      const prediction = predictionByName.get(normalizedName(truth.name));
      if (!prediction) {
        nameFn++;
        versionFn++;
      } else if (!versionMatches(truth, prediction)) {
        versionFn++;
      }
    }
  }
  return { name: metric(nameTp, nameFp, nameFn), version: metric(versionTp, versionFp, versionFn) };
}

export async function evaluateBundleDirectory(options: EvaluationOptions): Promise<EvaluationReport> {
  const bundlesDir = path.resolve(options.bundlesDir);
  const groundTruthPath = path.resolve(options.groundTruthPath);
  const groundTruth = assertGroundTruth(JSON.parse(await fs.readFile(groundTruthPath, 'utf8')));
  if (!groundTruth.fixtures.length) throw new Error('Ground truth contains no fixtures.');
  const analyzer = options.analyze || analyzeBundles;
  const fixtureResults: EvaluationFixtureResult[] = [];
  for (const fixture of groundTruth.fixtures) {
    const bundlePath = containedBundlePath(bundlesDir, fixture.bundle);
    const code = await fs.readFile(bundlePath, 'utf8');
    const result = await analyzer([{ url: bundlePath, code }], options.analyzeOptions);
    fixtureResults.push({ ...fixture, predictedPackages: result.packages });
  }
  const tiers = ['exact', 'range', 'possible'] as const;
  const byTier = Object.fromEntries(tiers.map((tier) => [tier, metricsFor(fixtureResults, tier)])) as EvaluationReport['byTier'];
  const bundlers = [...new Set(fixtureResults.map((item) => item.bundler))].sort();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    bundleDirectory: bundlesDir,
    groundTruthFile: groundTruthPath,
    fixtureCount: fixtureResults.length,
    ...(groundTruth.builderInfo ? { builderInfo: groundTruth.builderInfo } : {}),
    overall: metricsFor(fixtureResults),
    byTier,
    byBundler: Object.fromEntries(bundlers.map((bundler) => [
      bundler,
      metricsFor(fixtureResults.filter((fixture) => fixture.bundler === bundler)),
    ])),
    fixtures: fixtureResults,
  };
}

function pct(value: number | null): string { return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }

function metricRows(label: string, values: { name: EvaluationMetrics; version: EvaluationMetrics }): string[] {
  return [
    `| ${label} | name | ${values.name.truePositive} | ${values.name.falsePositive} | ${values.name.falseNegative} | ${pct(values.name.precision)} | ${pct(values.name.recall)} |`,
    `| ${label} | version | ${values.version.truePositive} | ${values.version.falsePositive} | ${values.version.falseNegative} | ${pct(values.version.precision)} | ${pct(values.version.recall)} |`,
  ];
}

export function formatEvaluationMarkdown(report: EvaluationReport): string {
  const lines = [
    '# debun-plus evaluation',
    '',
    `Generated: ${report.generatedAt}`,
    `Fixtures: ${report.fixtureCount}`,
    `Bundles: \`${report.bundleDirectory}\``,
    `Ground truth: \`${report.groundTruthFile}\``,
    '',
    'Precision and recall are computed per fixture/package pair. For version scoring, an exact verdict must equal the truth version; a range verdict is correct when it includes the truth version; a possible verdict must equal it exactly.',
    'Tier-specific recall measures the share of all ground-truth package/version pairs recovered at that tier.',
    ...(report.builderInfo?.note ? [`Builder note: ${report.builderInfo.note}`] : []),
    '',
    '| Scope | Measure | TP | FP | FN | Precision | Recall |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...metricRows('overall', report.overall),
    '',
    '## By tier',
    '',
    '| Tier | Measure | TP | FP | FN | Precision | Recall |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.byTier).flatMap(([tier, values]) => metricRows(tier, values)),
    '',
    '## By bundler',
    '',
    '| Bundler | Measure | TP | FP | FN | Precision | Recall |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.byBundler).flatMap(([bundler, values]) => metricRows(bundler, values)),
    '',
    '## Fixture details',
    '',
    '| Fixture | Bundler / build method | Truth packages | Detected packages |',
    '| --- | --- | --- | --- |',
    ...report.fixtures.map((fixture) => `| ${fixture.id} | ${fixture.bundler}${fixture.buildMethod ? ` (${fixture.buildMethod})` : ''} | ${fixture.packages.map((item) => `${item.name}@${item.version}`).join(', ') || '—'} | ${fixture.predictedPackages.map((item) => `${item.name}@${item.version} (${item.tier})`).join(', ') || '—'} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export async function listJavascriptBundles(directory: string): Promise<string[]> {
  const root = path.resolve(directory);
  const found: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.(?:c|m)?js$/i.test(entry.name)) found.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  await visit(root);
  return found.sort();
}
