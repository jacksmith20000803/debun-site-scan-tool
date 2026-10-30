'use strict';

require('./net');

const fs = require('node:fs');
const { Command } = require('commander');
const { analyze } = require('./analyze');
const { renderText, toJson } = require('./report');
const { setVerbose, log } = require('./util/log');

const TIER_THRESHOLD = { high: 0.85, medium: 0.6, low: 0 };

function parseMinConfidence(value) {
  if (value == null) return 0;
  const text = String(value).toLowerCase();
  if (text in TIER_THRESHOLD) return TIER_THRESHOLD[text];
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(1, numeric));
  throw new Error(`Invalid --min-confidence value: ${value}`);
}

function buildProgram() {
  const program = new Command();

  program
    .name('debun-plus')
    .description(
      'Retrieve a URL and infer the npm packages (and versions) it ships.\n' +
        'Combines debun-cli Property-Order-Graph matches with AST and npm registry bundle fingerprints.'
    )
    .version(require('../package.json').version)
    .argument('<url>', 'page URL to analyze (https:// is assumed when missing)')
    .option('-j, --json', 'emit a JSON report instead of text', false)
    .option('-o, --output <file>', 'write the report to a file')
    .option('--browser', 'render the page with a headless browser (needs Chromium)', false)
    .option('--no-debun', 'disable the debun Property-Order-Graph engine')
    .option('--no-plus', 'disable debun-plus registry corpus matching')
    .option('--no-source-maps', 'do not fetch or parse source maps')
    .option('--no-root-manifest', 'do not try <origin>/package.json')
    .option('--max-scripts <n>', 'maximum external scripts to download', (v) => parseInt(v, 10), 60)
    .option('--max-source-maps <n>', 'maximum source maps to parse', (v) => parseInt(v, 10), 12)
    .option('--plus-database <file>', 'SQLite cache for debun-plus registry fingerprints')
    .option('--concurrency <n>', 'parallel downloads', (v) => parseInt(v, 10), 6)
    .option('--timeout <ms>', 'per-request timeout in milliseconds', (v) => parseInt(v, 10), 20000)
    .option('--min-confidence <level>', 'hide packages below this tier or numeric score (high|medium|low|0..1)', 'low')
    .option('--save-scripts <dir>', 'save every analyzed script body to a directory')
    .option('--no-color', 'disable colored output')
    .option('-v, --verbose', 'verbose progress logging', false)
    .showHelpAfterError();

  program.configureHelp({ sortSubcommands: false });

  return program;
}

async function run(argv = process.argv) {
  const program = buildProgram();
  program.exitOverride();

  let parsed;
  try {
    parsed = program.parse(argv);
  } catch (error) {
    // commander throws for --help/--version and usage errors.
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0;
    process.stderr.write(`${error.message}\n`);
    return error.exitCode || 2;
  }

  const url = program.args[0];
  const options = program.opts();
  setVerbose(options.verbose);

  let minConfidence;
  try {
    minConfidence = parseMinConfidence(options.minConfidence);
  } catch (error) {
    log.error(error.message);
    return 2;
  }

  let result;
  try {
    result = await analyze(url, {
      browser: options.browser,
      useDebun: options.debun !== false,
      debunPlus: options.plus !== false,
      registryConcurrency: options.concurrency,
      includeSourceMaps: options.sourceMaps !== false,
      fetchRootManifest: options.rootManifest !== false,
      maxScripts: options.maxScripts,
      maxSourceMaps: options.maxSourceMaps,
      concurrency: options.concurrency,
      timeout: options.timeout,
      saveScripts: options.saveScripts || null,
      debunPlusOptions: options.plusDatabase ? { databasePath: options.plusDatabase } : undefined,
    });
  } catch (error) {
    log.error(error.message);
    if (options.verbose && error.stack) process.stderr.write(`${error.stack}\n`);
    return 1;
  }

  if (minConfidence > 0) {
    result.packages = result.packages.filter((pkg) => pkg.confidence >= minConfidence);
    result.packageCount = result.packages.length;
  }

  const color = options.color !== false && !options.json;
  const output = options.json ? toJson(result) : renderText(result, { color });

  if (options.output) {
    fs.writeFileSync(options.output, output);
    log.success(`report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }

  return 0;
}

module.exports = { run, buildProgram, parseMinConfidence };
