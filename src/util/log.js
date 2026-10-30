'use strict';

const chalk = require('chalk');

let verbose = false;

function setVerbose(value) {
  verbose = Boolean(value);
}

const log = {
  get verbose() {
    return verbose;
  },
  info(message) {
    process.stderr.write(`${message}\n`);
  },
  step(message) {
    if (verbose) process.stderr.write(`${chalk.dim('·')} ${chalk.dim(message)}\n`);
  },
  warn(message) {
    process.stderr.write(`${chalk.yellow('!')} ${message}\n`);
  },
  error(message) {
    process.stderr.write(`${chalk.red('✖')} ${message}\n`);
  },
  success(message) {
    process.stderr.write(`${chalk.green('✔')} ${message}\n`);
  },
};

module.exports = { log, setVerbose };
