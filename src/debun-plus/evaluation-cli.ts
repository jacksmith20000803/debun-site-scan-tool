declare const require: (name: string) => any;
declare const process: any;

import { evaluateBundleDirectory, formatEvaluationMarkdown } from './evaluation';
import { createRegistryClient } from './registry';
import { createSqliteCache } from './sqlite-cache';

const fs = require('node:fs/promises');
const path = require('node:path');

export async function runEvaluationCli(argv: string[] = []): Promise<number> {
  const { Command } = require('commander');
  const program = new Command();
  program
    .name('debun-plus eval')
    .description('Measure package-name and version detection against a fixture truth file.')
    .requiredOption('--bundles <dir>', 'directory containing the fixture JavaScript bundles')
    .requiredOption('--ground-truth <file>', 'JSON file containing fixture package names and exact versions')
    .option('-o, --output <file>', 'write the Markdown baseline report', 'EVAL-REPORT.md')
    .option('--json-output <file>', 'also write the full machine-readable evaluation result')
    .option('--database <sqlite-file>', 'registry and fingerprint cache', 'storage/debun-plus.sqlite')
    .option('--offline', 'use only cached registry metadata and version fingerprints')
    .option('--concurrency <n>', 'bounded registry concurrency (maximum 8)', (value: string) => Number.parseInt(value, 10), 4)
    .option('--max-candidates <n>', 'maximum candidate packages compared per fixture', (value: string) => Number.parseInt(value, 10), 20)
    .showHelpAfterError();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error: any) {
    if (error?.code === 'commander.helpDisplayed' || error?.code === 'commander.version') return 0;
    process.stderr.write(`${error?.message || error}\n`);
    return error?.exitCode || 2;
  }

  const options = program.opts();
  let cache: ReturnType<typeof createSqliteCache> | undefined;
  try {
    cache = createSqliteCache(path.resolve(options.database));
    const registry = options.offline
      ? {
        async getPackument(name: string) { return cache?.getPackument?.(name) || null; },
        async getTarball() { return null; },
      }
      : createRegistryClient({ cache, concurrency: options.concurrency });
    const report = await evaluateBundleDirectory({
      bundlesDir: options.bundles,
      groundTruthPath: options.groundTruth,
      analyzeOptions: { cache, registry, databasePath: path.resolve(options.database), concurrency: options.concurrency, maxCandidates: options.maxCandidates },
    });
    const markdown = formatEvaluationMarkdown(report);
    const outputPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, markdown, 'utf8');
    if (options.jsonOutput) {
      const jsonPath = path.resolve(options.jsonOutput);
      await fs.mkdir(path.dirname(jsonPath), { recursive: true });
      await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(markdown);
    process.stdout.write(`\nMarkdown report: ${outputPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    cache?.close?.();
  }
}
