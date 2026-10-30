#!/usr/bin/env node
'use strict';

const subcommand = process.argv[2];
const run = subcommand === 'analyze'
  ? () => require('../dist/src/debun-plus/analysis-cli').runAnalysisCli(process.argv.slice(3))
  : subcommand === 'eval'
    ? () => require('../dist/src/debun-plus/evaluation-cli').runEvaluationCli(process.argv.slice(3))
    : subcommand === 'build-index'
      ? require('../dist/src/debun-plus/literal-index-cli').runLiteralIndexCli
      : require('../dist/src/debun-plus/phase0').runPhase0Cli;

run().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`Unexpected error: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
);
