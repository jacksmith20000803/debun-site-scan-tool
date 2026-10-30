'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScanStore } = require('../src/scan-store');

test('saved scan records persist detailed JSON and support search, paging, reading, and deletion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debun-scan-store-'));
  const store = createScanStore(directory);
  try {
    const first = store.save({
      url: 'https://one.example/',
      finalUrl: 'https://one.example/home',
      framework: 'react',
      bundler: 'webpack',
      scanCompleted: true,
      reportEligible: true,
      packages: [{ name: 'react', version: '18.3.1' }],
      pages: [{ url: 'https://one.example/', scanCompleted: true, packageNames: ['react'] }],
      report: { websiteUrl: 'https://one.example/', totalDependencies: 1, dependencies: [{ name: 'react', version: '18.3.1' }] },
    });
    store.save({ url: 'https://two.example/', finalUrl: 'https://two.example/', framework: 'svelte', bundler: 'vite' });
    store.save({ url: 'https://three.example/', finalUrl: 'https://three.example/', framework: 'vue', bundler: 'vite' });

    const all = store.list({ pageSize: 2 });
    assert.equal(all.total, 3);
    assert.equal(all.pageCount, 2);
    assert.equal(all.items.length, 2);
    assert.deepEqual(store.list({ page: 2, pageSize: 2 }).items.map((item) => item.url), ['https://one.example/']);
    assert.equal(store.list({ search: 'svelte' }).items[0].url, 'https://two.example/');
    assert.equal(store.read(first.id).scanResult.pages[0].packageNames[0], 'react');
    assert.equal(store.read(first.id).report.dependencies[0].version, '18.3.1');
    assert.equal(fs.existsSync(path.join(directory, `${first.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(directory, `${first.id}.summary.json`)), true);
    assert.equal('scanResult' in JSON.parse(fs.readFileSync(path.join(directory, `${first.id}.summary.json`), 'utf8')), false);

    const compactOnly = store.save({ url: 'https://compact.example/', framework: 'astro', bundler: 'vite' });
    fs.writeFileSync(path.join(directory, `${compactOnly.id}.json`), 'not parsed while building the list');
    assert.equal(store.list({ search: 'compact.example' }).items[0].url, 'https://compact.example/');

    assert.equal(store.remove(first.id), true);
    assert.equal(store.read(first.id), null);
    assert.equal(store.remove(first.id), false);
    assert.equal(store.remove(compactOnly.id), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
