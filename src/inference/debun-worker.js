'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { inferWithDebunInline } = require('./debun');

inferWithDebunInline(workerData.sources)
  .then((result) => parentPort.postMessage({ result }))
  .catch((error) => parentPort.postMessage({ error: error?.message || String(error), stack: error?.stack || null }));
