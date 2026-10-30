'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectWordPress } = require('../src/vulnerabilities');
const { mergeEvidence } = require('../src/inference/merge');
const { inferFromUrl } = require('../src/inference/url-hint');

test('WordPress asset query versions remain hints rather than installed versions', () => {
  const [plugin, theme] = detectWordPress(
    '<script src="/wp-content/plugins/example-plugin/js/app.js?ver=7.4.2"></script><link href="/wp-content/themes/example-theme/style.css?ver=3.1.0">',
  );
  assert.equal(plugin.slug, 'example-plugin');
  assert.equal(plugin.version, null);
  assert.equal(plugin.versionHint, '7.4.2');
  assert.equal(theme.slug, 'example-theme');
  assert.equal(theme.version, null);
  assert.equal(theme.versionHint, '3.1.0');
});

test('WordPress generator metadata is retained as core version evidence', () => {
  const [core] = detectWordPress('<meta name="generator" content="WordPress 6.7.1">');
  assert.equal(core.componentType, 'core');
  assert.equal(core.version, '6.7.1');
});

test('WordPress asset cache URLs are not treated as npm package versions', () => {
  assert.equal(inferFromUrl('https://wordpress.org/wp-includes/js/wp-emoji-release.min.js?ver=7.2-beta1-64681'), null);
  assert.equal(inferFromUrl('https://example.com/wp-content/plugins/sample/assets/app.js?ver=4.1.0'), null);
});

test('declared dependency ranges do not become installed package versions', () => {
  const [pkg] = mergeEvidence([{ name: 'example-package', declaredRange: '^4.2.0', signal: 'declared-dep', detail: 'package.json' }]);
  assert.equal(pkg.version, undefined);
  assert.equal(pkg.installationStatus, 'declared-only');
  assert.deepEqual(pkg.declaredRanges, ['^4.2.0']);
});
