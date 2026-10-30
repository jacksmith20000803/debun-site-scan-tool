'use strict';

const { normalizeKey } = require('./naming');
const { sourceMapPatterns } = require('../bundler-patterns');

const NODE_MODULES = /(?:\/|^)node_modules\/((?:@[^/\s]+\/)?[^/\s]+)(?:\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?))?/;

function parseScoped(path) {
  const match = NODE_MODULES.exec(path);
  if (!match) return null;
  return { name: normalizeKey(match[1]), version: match[2] || undefined };
}

/**
 * Extract package/version evidence from a parsed source map.
 * @returns {Array<{name:string, version?:string, signal:'sourcemap', evidence:string}>}
 */
function packagesFromSourceMap(map) {
  const results = [];
  const seen = new Set();
  const add = (name, version, evidence) => {
    if (!name) return;
    const key = `${name}@${version || '*'}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ name, version, signal: 'sourcemap', evidence });
  };

  const sources = Array.isArray(map.sources) ? map.sources : [];
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];

  sources.forEach((source, index) => {
    if (typeof source !== 'string') return;
    const parsed = parseScoped(source);
    if (parsed) {
      add(
        parsed.name,
        parsed.version,
        parsed.version
          ? `source map: node_modules/${parsed.name}@${parsed.version}`
          : `source map: node_modules/${parsed.name}`
      );
    }

    for (const entry of sourceMapPatterns()) {
      const match = entry.pattern.exec(source);
      const packageName = match?.[2] || match?.[1];
      if (packageName) add(normalizeKey(packageName), undefined, `source map (${entry.name} pattern): ${packageName}`);
    }

    // If a package.json is embedded as source content, read name/version from it.
    const content = contents[index];
    if (typeof content === 'string' && /package\.json$/.test(source) && content.length < 200_000) {
      try {
        const manifest = JSON.parse(content);
        if (manifest && manifest.name) {
          add(normalizeKey(manifest.name), manifest.version, `source map package.json: ${manifest.name}@${manifest.version || '?'}`);
        }
      } catch (_) {
        /* not JSON */
      }
    }
  });

  return results;
}

module.exports = { packagesFromSourceMap, parseScoped };
