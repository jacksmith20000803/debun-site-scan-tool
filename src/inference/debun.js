'use strict';

/**
 * Bridge to the `debun-cli` inference engine.
 *
 * debun-cli detects third-party JavaScript libraries inside bundled code using
 * Property-Order Graphs (POGs). Even after minification/concatenation the
 * relative order in which properties are accessed stays stable, so a hash of
 * that order becomes a robust fingerprint. debun-cli ships a database that maps
 * fingerprints to library + version ranges.
 *
 * The published package exposes the engine as compiled CommonJS under `dist/`:
 *   - dist/fingerprint-collector/index.js  -> default fingerprintCollector(code)
 *   - dist/lib-scorer.js                    -> { evaluate(hashes, options) }
 *
 * We call those primitives directly to obtain structured results (the CLI only
 * prints an ANSI box that would have to be scraped). This is the exact same
 * code path the `debun detect` command uses.
 */

const { log } = require('../util/log');
const { makeAbortError, throwIfAborted } = require('../util/abort');
const { Worker } = require('node:worker_threads');

const SCORE_OPTIONS = { SCORE_THRESHOLD: 0.2, MIN_FUNCTION_COUNT: 5 };

let enginePromise = null;

function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { createRequire } = require('node:module');
      const { join } = require('node:path');

      let base;
      try {
        base = require.resolve('debun-cli/package.json');
      } catch (error) {
        throw new Error(
          "Could not resolve 'debun-cli'. Install it with `npm install debun-cli` " +
            `(the Property-Order-Graph engine is required). Cause: ${error.message}`
        );
      }

      const requireFromDebun = createRequire(base);
      const fingerprintCollector = requireFromDebun(join(base, '..', 'dist', 'fingerprint-collector', 'index.js')).default;
      const { evaluate } = requireFromDebun(join(base, '..', 'dist', 'lib-scorer.js'));

      if (typeof fingerprintCollector !== 'function' || typeof evaluate !== 'function') {
        throw new Error('debun-cli engine layout is unexpected; cannot locate the inference primitives.');
      }
      return { fingerprintCollector, evaluate, version: require(base).version };
    })();
  }
  return enginePromise;
}

/** Convert an array of POG fingerprints into debun's `hashes` input shape. */
function fingerprintsToHashes(fingerprints) {
  const hashes = {};
  for (const fingerprint of fingerprints) {
    if (!fingerprint) continue;
    const key = fingerprint.nodes;
    if (!hashes[key]) hashes[key] = [];
    if (!hashes[key].includes(fingerprint.hash)) hashes[key].push(fingerprint.hash);
  }
  return hashes;
}

function mergeVersionLists(target, source) {
  for (const version of source) {
    if (!target.includes(version)) target.push(version);
  }
}

/**
 * Run debun inference over a set of JavaScript sources.
 *
 * @param {Array<{url?:string, code:string}>} sources
 * @returns {Promise<Array<{
 *   name:string, exactVersions:string[], rangeVersions:string[],
 *   likelyVersions:string[], files:string[], matchCount:number
 * }>>}
 */
async function inferWithDebunInline(sources) {
  const { fingerprintCollector, evaluate } = await loadEngine();

  const merged = new Map();

  for (const source of sources) {
    if (!source || typeof source.code !== 'string' || !source.code.trim()) continue;

    let fingerprints;
    try {
      fingerprints = fingerprintCollector(source.code);
    } catch (error) {
      log.step(`debun fingerprinting skipped a source (${source.url || 'inline'}): ${error.message}`);
      continue;
    }

    const hashes = fingerprintsToHashes(fingerprints);
    if (Object.keys(hashes).length === 0) continue;

    let scores;
    try {
      scores = evaluate(hashes, SCORE_OPTIONS);
    } catch (error) {
      log.step(`debun scoring failed for ${source.url || 'inline'}: ${error.message}`);
      continue;
    }

    for (const score of scores) {
      let record = merged.get(score.libName);
      if (!record) {
        record = {
          name: score.libName,
          exactVersions: [],
          rangeVersions: [],
          likelyVersions: [],
          files: [],
          matchCount: 0,
        };
        merged.set(score.libName, record);
      }
      mergeVersionLists(record.exactVersions, score.type3Versions);
      mergeVersionLists(record.rangeVersions, score.type2Versions);
      mergeVersionLists(record.likelyVersions, score.topVersions);
      if (source.url && !record.files.includes(source.url)) record.files.push(source.url);
      record.matchCount += 1;
    }
  }

  return [...merged.values()];
}

/** Run the legacy CPU-heavy fingerprint engine in a disposable worker when a time budget is supplied. */
function inferWithDebun(sources, options = {}) {
  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return inferWithDebunInline(sources);
  if (options.signal?.aborted) return Promise.reject(makeAbortError(options.signal.reason));

  return new Promise((resolve, reject) => {
    const worker = new Worker(require.resolve('./debun-worker'), {
      workerData: { sources },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error(`debun fingerprint inference exceeded its ${timeoutMs}ms time budget`));
    }, timeoutMs);
    const onAbort = () => finish(makeAbortError(options.signal.reason));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (message) => {
      if (message?.error) {
        const error = new Error(message.error);
        if (message.stack) error.stack = message.stack;
        finish(error);
      } else {
        finish(null, message?.result || []);
      }
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new Error(`debun inference worker exited with code ${code}`));
      else if (!settled) finish(new Error('debun inference worker exited without a result'));
    });
  });
}

module.exports = { inferWithDebun, inferWithDebunInline, loadEngine };
