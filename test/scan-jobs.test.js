'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanJobManager } = require('../src/scan-jobs');

test('scan jobs keep running independently of a page and can be stopped immediately', async () => {
  let receivedSignal;
  let stopped;
  const manager = createScanJobManager(({ signal }) => new Promise((resolve, reject) => {
    receivedSignal = signal;
    stopped = new Promise((done) => signal.addEventListener('abort', done, { once: true }));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));

  const started = manager.start(['https://example.test/']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get(started.id).status, 'running');

  const result = manager.stop(started.id);
  assert.equal(result.status, 'stopped');
  assert.equal(receivedSignal.aborted, true);
  await stopped;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get(started.id).status, 'stopped');
});

test('only one scan job can run at a time', async () => {
  const manager = createScanJobManager(() => new Promise(() => {}));
  const first = manager.start(['https://example.test/']);
  assert.throws(() => manager.start(['https://other.test/']), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.activeJob.id, first.id);
    return true;
  });
  manager.stop(first.id);
});

test('completed scan results remain available after the initiating page is gone', async () => {
  const manager = createScanJobManager(async ({ updateProgress, addSiteResult }) => {
    updateProgress({ stageLabel: 'Scanning page 1' });
    addSiteResult({ url: 'https://example.test/' });
    return { scanCompleted: true };
  });
  const started = manager.start(['https://example.test/']);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const completed = manager.get(started.id);
  assert.equal(completed.status, 'complete');
  assert.deepEqual(completed.result, { scanCompleted: true });
  assert.deepEqual(completed.siteResults, [{ url: 'https://example.test/' }]);
});

test('scan jobs preserve the selected shallow or deep scan mode', async () => {
  let receivedMode;
  const manager = createScanJobManager(async ({ scanMode }) => {
    receivedMode = scanMode;
    return { scanCompleted: true };
  });
  const started = manager.start(['https://example.test/'], { scanMode: 'shallow' });
  assert.equal(started.scanMode, 'shallow');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receivedMode, 'shallow');
  assert.equal(manager.get(started.id).scanMode, 'shallow');
});
