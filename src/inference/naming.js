'use strict';

/**
 * Canonicalize library identifiers to their npm package names.
 *
 * debun-cli's database uses labels such as `lodash.js`, `three.js`, `jqueryui`
 * or `react-dom`; source-map and URL heuristics surface npm names. Normalizing
 * them lets every signal vote for the same package.
 */

// Explicit aliases for identifiers that differ from the npm package name.
const ALIASES = {
  'react-dom': 'react',
  'reactdom': 'react',
  'react': 'react',
  'angular': 'angular',
  'angular.js': 'angular',
  'angularjs': 'angular',
  'backbone.js': 'backbone',
  'backbone': 'backbone',
  'can.js': 'can',
  'fabric.js': 'fabric',
  'fuse.js': 'fuse.js',
  'hammer.js': 'hammerjs',
  'handlebars.js': 'handlebars',
  'jqueryui': 'jquery-ui',
  'jquery-ui': 'jquery-ui',
  'jquery.isotope': 'isotope-layout',
  'lodash.js': 'lodash',
  'lodash': 'lodash',
  'marionette': 'backbone.marionette',
  'moment.js': 'moment',
  'moment': 'moment',
  'numeral.js': 'numeral',
  'paper.js': 'paper',
  'pixi.js': 'pixi.js',
  'require.js': 'requirejs',
  'sammy.js': 'sammy',
  'spinejs': 'spine',
  'three.js': 'three',
  'threejs': 'three',
  'tween.js': 'tween.js',
  'underscore.js': 'underscore',
  'underscore': 'underscore',
  'velocity': 'velocity-animate',
  'webfont': 'webfontloader',
  'vue': 'vue',
  'vue.js': 'vue',
  'matter-js': 'matter-js',
  'mapbox-gl': 'mapbox-gl',
  'socket.io': 'socket.io',
  'material-design-lite': 'material-design-lite',
};

/**
 * Normalize an arbitrary identifier into a comparable package key.
 * Scoped packages keep their leading `@scope/`.
 */
function normalizeKey(name) {
  if (!name) return '';
  let value = String(name).trim().toLowerCase();
  value = value.replace(/^node_modules\//, '');
  value = value.replace(/\/+$/, '');
  if (ALIASES[value]) return ALIASES[value];
  // Strip a trailing `.js`/`.mjs`/`.min` style suffix only when it is not part
  // of a real npm name (e.g. `fuse.js` must survive).
  if (value.endsWith('.js') && !value.endsWith('.js.js') && !['fuse.js', 'pixi.js'].includes(value)) {
    const stripped = value.slice(0, -3);
    if (ALIASES[stripped]) return ALIASES[stripped];
  }
  return value;
}

/** Human-facing name (prefers the npm-ish canonical form). */
function displayName(name) {
  return normalizeKey(name);
}

module.exports = { normalizeKey, displayName, ALIASES };
