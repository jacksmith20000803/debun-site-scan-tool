import { BundleFormatSummary, PackageDetection } from './types';

export interface DetectionReport {
  schemaVersion: 1;
  generatedAt: string;
  input: string;
  stats: Record<string, number>;
  bundleFormats: BundleFormatSummary[];
  packages: Array<{
    name: string;
    version: string;
    tier: PackageDetection['tier'];
    confidence: number;
    margin: number;
    evidenceSources: string[];
    signals: string[];
    evidence: PackageDetection['evidence'];
    dependencyStatus?: PackageDetection['dependencyStatus'];
  }>;
}

export function createDetectionReport(input: string, packages: PackageDetection[], stats: Record<string, number>, bundleFormats: BundleFormatSummary[] = []): DetectionReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    input,
    stats,
    bundleFormats,
    packages: packages.map((item) => ({
      name: item.name,
      version: item.version,
      tier: item.tier,
      confidence: Number(item.score.toFixed(4)),
      margin: Number(item.margin.toFixed(4)),
      evidenceSources: [...new Set(item.evidence.map((evidence) => evidence.source))].sort(),
      signals: [...new Set(item.evidence.map((evidence) => evidence.signal || evidence.source))].sort(),
      evidence: item.evidence,
      ...(item.dependencyStatus ? { dependencyStatus: item.dependencyStatus } : {}),
    })),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

export function renderDetectionTable(packages: DetectionReport['packages']): string {
  const rows = packages.map((item) => [
    item.name,
    item.version,
    item.tier,
    `${(item.confidence * 100).toFixed(1)}%`,
    item.evidenceSources.join(', ') || '—',
  ]);
  const headings = ['Package', 'Version', 'Tier', 'Confidence', 'Evidence sources'];
  const widths = headings.map((heading, column) => Math.max(heading.length, ...rows.map((row) => Math.min(72, row[column].length))));
  const format = (row: string[]) => row.map((cell, index) => pad(cell.slice(0, widths[index]), widths[index])).join('  ').trimEnd();
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  if (!rows.length) return `${format(headings)}\n${divider}\nNo packages detected.`;
  return [format(headings), divider, ...rows.map(format)].join('\n');
}

export function renderExplain(packages: DetectionReport['packages']): string {
  if (!packages.length) return 'No verdicts to explain.';
  return packages.map((item) => {
    const heading = `${item.name}@${item.version} — ${item.tier}, confidence ${(item.confidence * 100).toFixed(1)}%, margin ${(item.margin * 100).toFixed(1)}%`;
    const evidence = item.evidence.map((signal) => {
      const name = signal.signal || signal.source;
      const weight = signal.weight === undefined ? '' : ` (weight ${signal.weight.toFixed(2)})`;
      return `  • ${name}${weight}: ${signal.detail}`;
    });
    return [heading, ...(evidence.length ? evidence : ['  • no evidence was recorded'])].join('\n');
  }).join('\n');
}
