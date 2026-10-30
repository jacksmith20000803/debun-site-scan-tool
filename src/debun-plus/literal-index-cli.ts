declare const require: (name: string) => any;
declare const process: any;

import { buildLiteralIndex, readPackageList } from './literal-index';

const path = require('node:path');

export async function runLiteralIndexCli(argv = process.argv): Promise<number> {
  const { Command } = require('commander');
  const program = new Command();
  let commandOptions: any;
  program
    .name('debun-plus')
    .description('Build the Phase 1 string-literal package index.')
    .command('build-index')
    .description('scan npm tarballs from a popularity-ranked package list and store literal fingerprints in SQLite')
    .requiredOption('--packages <list-file>', 'newline-delimited npm package names, optionally name@version')
    .requiredOption('--tier <tier>', 'index tier label (use topN for the starter top-2,000 list)')
    .option('--database <sqlite-file>', 'SQLite cache file', 'storage/debun-plus.sqlite')
    .option('--limit <n>', 'maximum packages read from the top of the list', (value: string) => Number.parseInt(value, 10), 2000)
    .option('--concurrency <n>', 'maximum concurrent registry downloads (capped at 8)', (value: string) => Number.parseInt(value, 10), 8)
    .action((options: any) => { commandOptions = options; });
  program.showHelpAfterError();

  try {
    await program.parseAsync(argv);
  } catch (error: any) {
    if (error?.code === 'commander.helpDisplayed' || error?.code === 'commander.version') return 0;
    process.stderr.write(`${error?.message || error}\n`);
    return error?.exitCode || 2;
  }
  if (!commandOptions) {
    process.stderr.write('Use "debun-plus build-index --packages <list-file> --tier topN" to build the literal index.\n');
    return 2;
  }

  const packageFile = path.resolve(commandOptions.packages);
  try {
    const packages = readPackageList(packageFile);
    if (!packages.length) throw new Error(`No valid package names were found in ${packageFile}.`);
    console.log(`[debun-plus:index] building tier ${commandOptions.tier} from ${packages.length} package-list entries (limit ${commandOptions.limit})`);
    const result = await buildLiteralIndex({
      packages,
      tier: commandOptions.tier,
      databasePath: path.resolve(commandOptions.database),
      limit: commandOptions.limit,
      concurrency: commandOptions.concurrency,
      onProgress: (message) => console.log(`[debun-plus:index] ${message}`),
    });
    console.log(`[debun-plus:index] completed: ${result.packagesIndexed} packages, ${result.versionsIndexed} versions, ${result.literalsIndexed} literals stored in tier ${result.tier}`);
    if (result.packagesFailed) console.log(`[debun-plus:index] package failures: ${result.packagesFailed}; parse failures: ${result.filesParseFailed}`);
    return result.packagesFailed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`String-literal index build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
