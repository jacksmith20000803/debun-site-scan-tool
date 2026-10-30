'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { inferFromUrl } = require('../src/inference/url-hint');
const { extractBannerHints } = require('../src/inference/banner');
const { extractGlobalVersions } = require('../src/inference/global-version');
const { extractEmbeddedManifests, parseManifest } = require('../src/inference/embedded-manifest');
const { packagesFromSourceMap } = require('../src/inference/sourcemap');
const { mergeEvidence, isConcreteVersion } = require('../src/inference/merge');
const { normalizeKey } = require('../src/inference/naming');
const { mediumOrHigherUnknownVersionCandidates } = require('../src/analyze');

test('url hints: registries and filenames', () => {
  assert.deepEqual(pick(inferFromUrl('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js')), { name: 'lodash', version: '4.17.21' });
  assert.deepEqual(pick(inferFromUrl('https://unpkg.com/react@18.3.1/umd/react.production.min.js')), { name: 'react', version: '18.3.1' });
  assert.deepEqual(pick(inferFromUrl('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js')), { name: 'jquery', version: '3.7.1' });
  assert.deepEqual(pick(inferFromUrl('https://code.jquery.com/jquery-3.6.0.min.js')), { name: 'jquery', version: '3.6.0' });
  assert.deepEqual(pick(inferFromUrl('https://esm.sh/vue@3.5.13')), { name: 'vue', version: '3.5.13' });
});

test('url hints: scoped packages and query strings', () => {
  assert.deepEqual(pick(inferFromUrl('https://cdn.jsdelivr.net/npm/@babel/core@7.24.0/lib/index.js')), { name: '@babel/core', version: '7.24.0' });
  const query = inferFromUrl('https://example.com/js/moment.js?v=2.29.4');
  assert.equal(query.name, 'moment');
  assert.equal(query.version, '2.29.4');
});

test('url hints: ignores documentation paths', () => {
  assert.equal(inferFromUrl('https://getbootstrap.com/docs/6.0/getting-started/'), null);
  assert.equal(inferFromUrl('https://example.com/assets/2.0.0/app.js'), null);
});

test('banner hints', () => {
  assert.deepEqual(firstNameVersion(extractBannerHints('/*! lodash.js 4.17.21 | MIT License */')), { name: 'lodash', version: '4.17.21' });
  assert.deepEqual(firstNameVersion(extractBannerHints('/*! jQuery v3.6.0 | (c) OpenJS */')), { name: 'jquery', version: '3.6.0' });
  assert.deepEqual(firstNameVersion(extractBannerHints('/** @license React v18.2.0 */')), { name: 'react', version: '18.2.0' });
});

test('lodash license attribution is not mistaken for an Underscore package banner', () => {
  const lodash = fs.readFileSync(path.join(__dirname, 'fixtures', 'scoring', 'lodash-4.18.1.min.js'), 'utf8');
  assert.deepEqual(firstNameVersion(extractBannerHints('/*! Underscore.js 1.8.3 */')), { name: 'underscore', version: '1.8.3' });
  assert.equal(extractBannerHints(lodash).some((hit) => hit.name === 'underscore'), false);
});

test('global version assignments', () => {
  const jq = extractGlobalVersions('jQuery.fn.jquery = "3.6.0";');
  assert.ok(jq.some((hint) => hint.name === 'jquery' && hint.version === '3.6.0'));
  const moment = extractGlobalVersions('moment.version = "2.29.4"');
  assert.ok(moment.some((hint) => hint.name === 'moment' && hint.version === '2.29.4'));
  assert.equal(extractGlobalVersions('someRandomLib.version = "1.2.3"').length, 0);
});

test('embedded package.json manifests', () => {
  const plain = extractEmbeddedManifests('var meta = {"name":"foo","version":"1.2.3"}');
  assert.ok(plain.some((m) => m.name === 'foo' && m.version === '1.2.3'));

  const escaped = extractEmbeddedManifests('var s = "{\\"name\\":\\"bar\\",\\"version\\":\\"2.0.0\\"}"');
  assert.ok(escaped.some((m) => m.name === 'bar' && m.version === '2.0.0'));

  const deps = extractEmbeddedManifests('{"dependencies":{"react":"^18.3.1","lodash":"^4.17.21"}}');
  const withDeps = deps.find((m) => Object.keys(m.dependencies).length > 0);
  assert.deepEqual(withDeps.dependencies, { react: '^18.3.1', lodash: '^4.17.21' });
});

test('package.json parsing', () => {
  const manifest = parseManifest('{"name":"my-app","version":"2.3.4","dependencies":{"react":"^18.3.1"}}');
  assert.equal(manifest.name, 'my-app');
  assert.equal(manifest.version, '2.3.4');
  assert.equal(manifest.dependencies.react, '^18.3.1');
});

test('source map package extraction', () => {
  const hits = packagesFromSourceMap({
    sources: [
      'webpack://my-app/./node_modules/axios/index.js',
      'webpack://my-app/./node_modules/lodash/lodash.js',
      'webpack://my-app/./node_modules/react/package.json',
      '/build/node_modules/vue/3.4.21/dist/vue.js',
    ],
    sourcesContent: [null, null, '{"name":"react","version":"18.3.1"}', null],
  });
  const byName = Object.fromEntries(hits.map((hit) => [hit.name, hit.version]));
  assert.equal(byName.axios, undefined);
  assert.equal(byName.lodash, undefined);
  assert.equal(byName.react, '18.3.1');
  assert.equal(byName.vue, '3.4.21');
});

test('merge: corroboration raises confidence, lone weak signal stays low', () => {
  const strong = mergeEvidence([
    { name: 'react', version: '18.3.1', signal: 'sourcemap', detail: 'a' },
    { name: 'react', version: '^18.3.1', signal: 'declared-dep', detail: 'b' },
    { name: 'react', version: '18.3.1', signal: 'url', detail: 'c' },
  ]).find((record) => record.name === 'react');
  assert.equal(strong.version, '18.3.1');
  assert.equal(strong.tier, 'high');
  assert.ok(strong.confidence >= 0.85);

  const weak = mergeEvidence([{ name: 'flexslider', version: '2.6.0', signal: 'debun-likely', detail: 'x' }])[0];
  assert.equal(weak.tier, 'low');
  assert.ok(weak.confidence < 0.6);
});

test('merge: concrete versions beat ranges', () => {
  const record = mergeEvidence([
    { name: 'lodash', version: '^4.17.21', signal: 'declared-dep', detail: 'manifest' },
    { name: 'lodash', version: '4.17.20', signal: 'debun-range', detail: 'pog' },
  ])[0];
  assert.equal(record.version, '4.17.20');
  assert.equal(record.versionIsExact, true);
});

test('merge: stronger registry-backed ranges beat low-confidence concrete guesses', () => {
  const record = mergeEvidence([
    { name: 'react', version: '18.1.0', signal: 'debun-likely', detail: 'weak POG version guess' },
    { name: 'react', version: '^18.3.1', signal: 'registry-range', detail: 'bundle fingerprint range' },
  ])[0];
  assert.equal(record.version, '^18.3.1');
  assert.equal(record.versionIsExact, false);
});

test('version recovery retries LOW and higher-confidence packages without version evidence', () => {
  const candidates = mediumOrHigherUnknownVersionCandidates([
    { name: 'react', signal: 'manifest', detail: 'package identity from manifest' },
    { name: 'react', signal: 'url', detail: 'package path without a version' },
    { name: 'tiny-lib', signal: 'url', detail: 'a single weak package URL hint' },
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].name, 'react');
  assert.deepEqual(candidates[0].evidence.map((item) => item.source).sort(), ['embedded-version', 'script-url']);
  assert.equal(candidates[1].name, 'tiny-lib');
  assert.deepEqual(candidates[1].evidence.map((item) => item.source), ['script-url']);
});

test('naming aliases', () => {
  assert.equal(normalizeKey('react-dom'), 'react');
  assert.equal(normalizeKey('lodash.js'), 'lodash');
  assert.equal(normalizeKey('jqueryui'), 'jquery-ui');
  assert.equal(normalizeKey('fuse.js'), 'fuse.js');
  assert.equal(isConcreteVersion('1.2.3'), true);
  assert.equal(isConcreteVersion('^1.2.3'), false);
});

function pick(hint) {
  if (!hint) return null;
  return { name: hint.name, version: hint.version };
}

function firstNameVersion(hints) {
  if (!hints.length) return null;
  return { name: hints[0].name, version: hints[0].version };
}
