'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createStaticServer } = require('./helpers/server');
const { analyze, unknownVersionCandidates } = require('../src/analyze');

const SITE = path.join(__dirname, 'fixtures', 'site');

function find(result, name) {
  return result.packages.find((pkg) => pkg.name === name);
}

test('LOW-confidence package leads without versions are sent to registry fingerprinting', () => {
  const candidates = unknownVersionCandidates([
    { name: 'small-lib', signal: 'debun-likely', detail: 'bundle property-order lead' },
    { name: 'known-version', signal: 'debun-likely', detail: 'already versioned lead', version: '2.3.4' },
  ]);

  assert.deepEqual(candidates.map(({ name }) => name), ['small-lib']);
  assert.ok(candidates[0].evidence.some((item) => item.source === 'debun-pog'));
});

test('end-to-end: infers packages and exact versions from a fixture site', async () => {
  const site = createStaticServer(SITE);
  const baseUrl = await site.listen();
  try {
    const result = await analyze(`${baseUrl}/`, { timeout: 10000 });

    assert.equal(result.page.status, 200);
    assert.equal(result.project.name, 'my-app');
    assert.equal(result.project.version, '2.3.4');
    assert.equal(result.stats.externalScripts, 3);
    assert.ok(result.stats.sourceMapsParsed >= 1, 'source map parsed');

    const preact = find(result, 'preact');
    assert.ok(preact, 'preact detected');
    assert.equal(preact.version, '10.26.8');
    assert.ok(preact.confidence >= 0.6, `preact confidence ${preact?.confidence}`);
    assert.ok(preact.signals.includes('debun-range') || preact.signals.includes('debun-exact'));

    const lodash = find(result, 'lodash');
    assert.ok(lodash, 'lodash detected');
    assert.equal(lodash.version, '4.17.21');

    const react = find(result, 'react');
    assert.ok(react, 'react detected via source map');
    assert.equal(react.version, '18.3.1');

    const axiosPackage = find(result, 'axios');
    assert.ok(axiosPackage, 'axios detected via source map');

    assert.equal(result.declaredDependencies.react, '^18.3.1');
    assert.equal(result.declaredDependencies.lodash, '^4.17.21');
  } finally {
    await site.close();
  }
});

test('end-to-end: a package.json URL is treated as a manifest', async () => {
  const site = createStaticServer(SITE);
  const baseUrl = await site.listen();
  try {
    const result = await analyze(`${baseUrl}/package.json`, { timeout: 10000 });
    assert.equal(result.project.name, 'my-app');
    assert.equal(result.project.version, '2.3.4');
    assert.equal(result.declaredDependencies.react, '^18.3.1');
    assert.equal(result.stats.externalScripts, 0);
    const react = find(result, 'react');
    assert.ok(react);
    assert.equal(react.signals.includes('declared-dep'), true);
  } finally {
    await site.close();
  }
});

test('end-to-end: no-color text report renders', async () => {
  const site = createStaticServer(SITE);
  const baseUrl = await site.listen();
  try {
    const result = await analyze(`${baseUrl}/`, { timeout: 10000 });
    const { renderText } = require('../src/report');
    const text = renderText(result, { color: false });
    assert.match(text, /page-deps/);
    assert.match(text, /preact/);
    assert.match(text, /Detected packages/);
  } finally {
    await site.close();
  }
});
