'use strict';

const { normalizeKey } = require('./naming');

const VERSION = String.raw`\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?`;

/**
 * Curated version signatures found in comments or code of widely used
 * libraries. These complement the POG engine (and give evidence for libraries
 * debun has no fingerprint for).
 */
const SIGNATURES = [
  { name: 'jquery', re: /jQuery JavaScript Library v?([\d.]+)/i },
  { name: 'jquery', re: /jQuery\.fn\.jquery\s*=\s*["']([\d.]+)["']/ },
  { name: 'jquery', re: /jquery[/-]v?(\d+\.\d+\.\d+)(?:\.min)?\.js/i },
  { name: 'lodash', re: /lodash\.js\s+v?([\d.]+)/i },
  { name: 'lodash', re: /\bVERSION\s*=\s*['"](\d+\.\d+\.\d+(-\w+)?)['"][\s\S]{0,80}?lodash/i },
  // Require an Underscore banner, not a package attribution embedded in another
  // library's license (for example, Lodash credits Underscore in its header).
  { name: 'underscore', re: /\/\*!\s*Underscore\.js\s+v?([\d.]+)/i },
  { name: 'moment', re: /moment\.js\s+v?([\d.]+)/i },
  { name: 'react', re: /@license\s+React\s+v?([\d.]+)/i },
  { name: 'react', re: /React\s+v(\d+\.\d+\.\d+)/i },
  { name: 'react-dom', re: /ReactDOM\s+v(\d+\.\d+\.\d+)/i },
  { name: 'vue', re: /Vue\.js\s+v?([\d.]+)/i },
  { name: 'vue', re: /@vue\/(?:runtime|shared)[\s\S]{0,40}?(\d+\.\d+\.\d+)/i },
  { name: 'angular', re: /@license\s+Angular(?:JS)?\s+v?([\d.]+)/i },
  { name: 'angular', re: /AngularJS\s+v(\d+\.\d+\.\d+)/i },
  { name: 'bootstrap', re: /Bootstrap\s+v?([\d.]+)/i },
  { name: 'three.js', re: /three\.js\s+r(\d+)/i },
  { name: 'gsap', re: /(?:gsap|TweenMax|TweenLite)[^\n]{0,20}?\s(\d+\.\d+\.\d+)/i },
  { name: 'axios', re: /axios[/@]v?([\d.]+)/i },
  { name: 'axios', re: /axios\/([\d.]+)/i },
  { name: 'd3', re: /d3(?:\.js)?\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'backbone.js', re: /Backbone\.js\s+v?([\d.]+)/i },
  { name: 'handlebars.js', re: /Handlebars\.js\s+v?([\d.]+)/i },
  { name: 'socket.io', re: /socket\.io(?:-client)?\s+v?([\d.]+)/i },
  { name: 'ember-source', re: /Ember\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'alpinejs', re: /Alpine\.js\s+v?([\d.]+)/i },
  { name: 'htmx.org', re: /htmx\s+v?([\d.]+)/i },
  { name: 'preact', re: /@license\s+Preact\s+v?([\d.]+)/i },
  { name: 'core-js', re: /core-js\s+v?([\d.]+)/i },
  { name: 'popper.js', re: /Popper\.js\s+v?([\d.]+)/i },
  { name: 'chart.js', re: /Chart\.js\s+v?([\d.]+)/i },
  { name: 'leaflet', re: /Leaflet\s+v?([\d.]+)/i },
  { name: 'gsap', re: /@license\s+GSAP\s+v?([\d.]+)/i },
];

const BANNER_BLOCK = /\/\*[\s\S]{0,2000}?\*\//g;
const LICENSE_NAME_VERSION = new RegExp(
  String.raw`^\s*/\*[\s*!]*(?:@license\s+)?([A-Za-z][\w.+-]{1,30})\s+v?(${VERSION})\b`,
  'i'
);

/**
 * Extract version hints from license/version banners and code signatures.
 * @returns {Array<{name:string, version:string, signal:'banner', evidence:string}>}
 */
function extractBannerHints(code) {
  if (!code) return [];
  const results = [];
  const seen = new Set();
  const add = (name, version, evidence) => {
    if (!name || !version) return;
    const key = `${normalizeKey(name)}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ name: normalizeKey(name), version, signal: 'banner', evidence });
  };

  for (const signature of SIGNATURES) {
    const match = signature.re.exec(code);
    if (match && match[1]) {
      add(signature.name, match[1], `code signature: /${signature.re.source.slice(0, 60)}…/`);
    }
  }

  // Parse license banners: `/*! Name v1.2.3 ... */`
  const head = code.slice(0, 8000);
  let block;
  while ((block = BANNER_BLOCK.exec(head)) !== null) {
    const text = block[0];
    if (!/@license|@preserve|@version|Copyright|MIT|BSD|Apache/i.test(text) && !/\bv\d+\.\d+/.test(text)) {
      continue;
    }
    const license = LICENSE_NAME_VERSION.exec(text);
    if (license && license[1] && license[2]) {
      const candidate = normalizeKey(license[1]);
      if (isPlausiblePackageName(candidate)) {
        add(candidate, license[2], `banner: ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }

  return results;
}

function isPlausiblePackageName(name) {
  if (!name) return false;
  const blocked = new Set([
    'copyright',
    'license',
    'version',
    'the',
    'and',
    'www',
    'http',
    'https',
    'all',
    'rights',
    'reserved',
    'min',
    'js',
    'es',
    'esm',
    'umd',
  ]);
  if (blocked.has(name)) return false;
  return /^@?[a-z][a-z0-9._-]*$/.test(name);
}

module.exports = { extractBannerHints, SIGNATURES };
