declare const require: (name: string) => any;
declare const process: any;

import { analyzeBundles } from './pipeline';
import { runPhase0 } from './phase0';
import { createDetectionReport, renderDetectionTable, renderExplain } from './report';
import { createRegistryClient } from './registry';
import { createSqliteCache } from './sqlite-cache';
import { analyzeCrawledSite, crawlSite } from './crawl';

const fs = require('node:fs/promises');
const path = require('node:path');

export async function runAnalysisCli(argv: string[] = []): Promise<number> {
  const { Command } = require('commander');
  const program = new Command();
  program
    .name('debun-plus analyze')
    .description('Analyze rendered JavaScript bundle sources and report npm package/version verdicts.')
    .argument('<url-or-path>', 'HTTP(S) page, JavaScript file, or directory of JavaScript files')
    .option('-o, --output <file>', 'write the machine-readable JSON report', 'debun-plus-report.json')
    .option('--database <sqlite-file>', 'registry and fingerprint cache', 'storage/debun-plus.sqlite')
    .option('--offline', 'use only cached registry metadata and version fingerprints')
    .option('--max-candidates <n>', 'maximum candidate packages to compare', (value: string) => Number.parseInt(value, 10), 20)
    .option('--concurrency <n>', 'bounded registry concurrency (maximum 8)', (value: string) => Number.parseInt(value, 10), 4)
    .option('--depth <n>', 'crawl depth: 0 scans only the supplied page; 1..3 enables linked-page scanning', (value: string) => Number.parseInt(value, 10), 0)
    .option('--allow-domain <domain>', 'allow this additional domain and its subdomains (repeatable)', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--max-asset-mb <n>', 'maximum total JavaScript asset bytes to read while crawling', (value: string) => Number.parseFloat(value), 50)
    .option('--request-delay-ms <n>', 'minimum delay between requests to the same host in crawl mode', (value: string) => Number.parseInt(value, 10), 250)
    .option('--explain', 'print each verdict and the evidence signals that fired')
    .option('--json', 'also print the JSON report to stdout')
    .showHelpAfterError();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error: any) {
    if (error?.code === 'commander.helpDisplayed' || error?.code === 'commander.version') return 0;
    process.stderr.write(`${error?.message || error}\n`);
    return error?.exitCode || 2;
  }

  const input = program.args[0] as string;
  const options = program.opts();
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
  let cache: ReturnType<typeof createSqliteCache> | undefined;
  try {
    cache = createSqliteCache(path.resolve(options.database));
    const registry = options.offline
      ? {
        async getPackument(name: string) { return cache?.getPackument?.(name) || null; },
        async getTarball() { return null; },
      }
      : createRegistryClient({ cache, concurrency: options.concurrency });
    const analyzeOptions = {
      cache,
      registry,
      databasePath: path.resolve(options.database),
      maxCandidates: options.maxCandidates,
      concurrency: options.concurrency,
    };
    let report: any;
    let stats: Record<string, number>;
    let crawlWarnings: string[] = [];
    if (options.depth > 0) {
      let start: URL;
      try { start = new URL(input); } catch (_) { throw new Error('--depth 1..3 requires an HTTP(S) URL input.'); }
      if (!['http:', 'https:'].includes(start.protocol)) throw new Error('--depth 1..3 requires an HTTP(S) URL input.');
      const crawled = await crawlSite(input, {
        depth: options.depth,
        allowDomains: options.allowDomain,
        maxAssetBytes: options.maxAssetMb * 1024 * 1024,
        requestDelayMs: options.requestDelayMs,
        onLog: (message) => process.stderr.write(`[debun-plus] ${message}\n`),
      });
      const perAssetStats: Array<Record<string, number>> = [];
      const bundleFormats: any[] = [];
      const analyzed = await analyzeCrawledSite(crawled, async (source) => {
        const result = await analyzeBundles([source], analyzeOptions);
        perAssetStats.push(result.stats);
        bundleFormats.push(...result.bundleFormats);
        return result.packages;
      });
      crawlWarnings = analyzed.warnings;
      if (analyzed.assets.length === 0) crawlWarnings.push('No JavaScript assets were discovered; no package fingerprints could be compared.');
      stats = {
        pagesScanned: analyzed.pages.filter((page) => !page.error).length,
        uniqueBundlesAnalyzed: analyzed.assetsAnalyzed,
        assetBytesRead: analyzed.assetBytes,
        linksDiscovered: analyzed.linksDiscovered,
        candidatesGenerated: perAssetStats.reduce((sum, item) => sum + item.candidatesGenerated, 0),
        versionsCompared: perAssetStats.reduce((sum, item) => sum + item.versionsCompared, 0),
        registryRequests: perAssetStats.reduce((sum, item) => sum + item.registryRequests, 0),
        cacheHits: perAssetStats.reduce((sum, item) => sum + item.cacheHits, 0),
      };
      const detectionReport = createDetectionReport(input, analyzed.packages, stats, bundleFormats);
      const withPageInfo = (item: any) => ({
        name: item.name,
        version: item.version,
        tier: item.tier,
        confidence: Number(item.score.toFixed(4)),
        margin: Number(item.margin.toFixed(4)),
        evidenceSources: [...new Set(item.evidence.map((evidence: any) => evidence.source))].sort(),
        signals: [...new Set(item.evidence.map((evidence: any) => evidence.signal || evidence.source))].sort(),
        evidence: item.evidence,
        ...(item.dependencyStatus ? { dependencyStatus: item.dependencyStatus } : {}),
        pagesSeen: item.pagesSeen || [],
        versionConsensus: item.versionConsensus || 'unknown',
        ...(item.conflictingVersions ? { conflictingVersions: item.conflictingVersions } : {}),
      });
      report = {
        ...detectionReport,
        crawl: {
          depth: analyzed.depth,
          pagesVisited: analyzed.pages.length,
          maxPages: analyzed.maxPages,
          linksDiscovered: analyzed.linksDiscovered,
          uniqueBundlesFetched: analyzed.assets.length,
          uniqueBundlesAnalyzed: analyzed.assetsAnalyzed,
          assetBytesRead: analyzed.assetBytes,
          maxAssetBytes: analyzed.maxAssetBytes,
          stoppedReason: analyzed.stoppedReason,
          urlNormalization: analyzed.urlNormalization,
          warnings: analyzed.warnings,
        },
        pages: analyzed.pages.map((page) => ({
          url: page.url,
          depth: page.depth,
          title: page.title,
          linksDiscovered: page.linksDiscovered,
          bundles: page.assetHashes.length,
          ...(page.error ? { error: page.error } : {}),
          packages: (page.packages || []).map(withPageInfo),
        })),
        packages: analyzed.packages.map(withPageInfo),
      };
    } else {
      const phase0 = await runPhase0(input, { onLog: (message) => process.stderr.write(`[debun-plus] ${message}\n`) });
      const sources = phase0.sources.map((source) => ({ url: source.sourceFile, code: source.strippedSource }));
      const result = await analyzeBundles(sources, analyzeOptions);
      stats = {
        ...result.stats,
        parseFailures: phase0.stats.parseFailures,
        fetchFailures: phase0.stats.fetchFailures,
        unrecognizedFormats: phase0.stats.unrecognizedFormats,
      };
      const phase0BundleFormats = phase0.sources.map((source) => ({
          sourceFile: source.sourceFile,
          bundleFormat: source.bundleFormat,
          confidence: source.bundleFormatConfidence,
          hints: source.bundleFormatHints,
          evidence: source.bundleFormatEvidence,
        }));
      report = createDetectionReport(input, result.packages, stats, phase0BundleFormats.length ? phase0BundleFormats : result.bundleFormats);
      report.warnings = phase0.warnings;
    }
    const outputPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`${renderDetectionTable(report.packages)}\nJSON report: ${outputPath}\n`);
      if (options.depth > 0) process.stderr.write(`Pages scanned: ${stats.pagesScanned}; unique bundles analyzed: ${stats.uniqueBundlesAnalyzed}\n`);
      if (report.bundleFormats?.length) process.stderr.write(`Bundle formats: ${report.bundleFormats.map((item: any) => item.bundleFormat).join(', ')}\n`);
      if (options.explain) process.stderr.write(`${renderExplain(report.packages)}\n`);
    } else {
      console.log(renderDetectionTable(report.packages));
      console.log(`\nJSON report: ${outputPath}`);
      if (options.depth > 0) console.log(`Pages scanned: ${stats.pagesScanned}; unique bundles analyzed: ${stats.uniqueBundlesAnalyzed}`);
      if (report.bundleFormats?.length) console.log(`Bundle formats: ${report.bundleFormats.map((item: any) => item.bundleFormat).join(', ')}`);
      if (options.explain) console.log(`\n${renderExplain(report.packages)}`);
    }
    if (crawlWarnings.length) process.stderr.write(`${crawlWarnings.map((warning) => `Warning: ${warning}`).join('\n')}\n`);
    return options.depth > 0 && !(report.pages || []).some((page: any) => !page.error) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Analysis failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    cache?.close?.();
  }
}
