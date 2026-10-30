'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferWithDebun } = require('../src/inference/debun');

test('pressing Stop terminates an active JavaScript fingerprint worker', async () => {
  const controller = new AbortController();
  const code = Array.from({ length: 3000 }, (_, index) => `function part${index}(x){return x&&x.value&&x.value.next;}`).join('\n');
  const inference = inferWithDebun([{ url: 'large.js', code }], { timeoutMs: 30000, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('Stopped by test.'));
  await assert.rejects(inference, (error) => error.name === 'AbortError');
});
