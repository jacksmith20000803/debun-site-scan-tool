#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli');

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`Unexpected error: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
);
