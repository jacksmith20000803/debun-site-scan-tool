'use strict';

const { normalizeKey } = require('./naming');

const VERSION = String.raw`\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?`;

/**
 * Maps a JavaScript identifier to the npm package whose `.version`/`.VERSION`
 * it exposes. Only known identifiers emit evidence, which keeps precision high.
 */
const IDENTIFIER_PACKAGES = {
  jQuery: 'jquery',
  $: 'jquery',
  moment: 'moment',
  Vue: 'vue',
  React: 'react',
  ReactDOM: 'react-dom',
  Angular: 'angular',
  ng: 'angular',
  Backbone: 'backbone',
  Handlebars: 'handlebars',
  io: 'socket.io',
  d3: 'd3',
  gsap: 'gsap',
  TweenMax: 'gsap',
  Alpine: 'alpinejs',
  htmx: 'htmx.org',
  axios: 'axios',
  Chart: 'chart.js',
  Highcharts: 'highcharts',
  L: 'leaflet',
  PIXI: 'pixi.js',
  THREE: 'three',
  _: 'lodash',
};

const ASSIGNMENT_PATTERNS = [
  /([A-Za-z_$][\w$]*)\.version\s*=\s*["'](\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)["']/g,
  /([A-Za-z_$][\w$]*)\.VERSION\s*=\s*["'](\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)["']/g,
  /([A-Za-z_$][\w$]*)\.fn\.jquery\s*=\s*["'](\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)["']/g,
];

/**
 * Find `X.version = "1.2.3"` style assignments for known libraries.
 * @returns {Array<{name:string, version:string, signal:'global', evidence:string}>}
 */
function extractGlobalVersions(code) {
  if (!code) return [];
  const results = [];
  const seen = new Set();
  const scan = code.length > 3_000_000 ? code.slice(0, 3_000_000) : code;

  for (const pattern of ASSIGNMENT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(scan)) !== null) {
      const identifier = match[1];
      const version = match[2];
      const pkg = IDENTIFIER_PACKAGES[identifier];
      if (!pkg || !version) continue;
      const key = `${normalizeKey(pkg)}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        name: normalizeKey(pkg),
        version,
        signal: 'global',
        evidence: `${identifier}.version = ${version}`,
      });
    }
  }
  return results;
}

module.exports = { extractGlobalVersions, IDENTIFIER_PACKAGES };
