'use strict';

const { normalizeKey } = require('./naming');

const NAME = String.raw`"name"\s*:\s*"([^"]{1,214})"`;
const VERSION = String.raw`"version"\s*:\s*"([^"]{1,64})"`;
const DEP_BLOCK = String.raw`"dependencies"\s*:\s*\{([^}]{0,20000})\}`;

/**
 * Parse a `package.json` document into a normalized manifest.
 */
function parseManifest(text) {
  if (!text || typeof text !== 'string') return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!json || typeof json !== 'object' || typeof json.name !== 'string') return null;
  return {
    name: json.name,
    version: typeof json.version === 'string' ? json.version : undefined,
    dependencies: json.dependencies && typeof json.dependencies === 'object' ? json.dependencies : {},
    devDependencies: json.devDependencies && typeof json.devDependencies === 'object' ? json.devDependencies : {},
    peerDependencies: json.peerDependencies && typeof json.peerDependencies === 'object' ? json.peerDependencies : {},
  };
}

function parseDependencyPairs(body) {
  const deps = {};
  const re = /"((?:@[^"/]+\/)?[^"]{1,214})"\s*:\s*"([^"]{1,128})"/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    deps[match[1]] = match[2];
  }
  return deps;
}

/**
 * Scan arbitrary text (bundle source, source map, HTML) for embedded
 * `package.json` content. Handles escaped JSON (`\"name\":\"...\"`) that occurs
 * inside generated module wrappers.
 *
 * @returns {Array<{name:string, version?:string, dependencies:Record<string,string>,
 *   devDependencies:Record<string,string>, evidence:string}>}
 */
function extractEmbeddedManifests(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  const seen = new Set();

  // Un-escape `\"` so the same regexes work for embedded JSON strings.
  const normalized = text.includes('\\"') ? text.replace(/\\"/g, '"') : text;

  const nameVersion = new RegExp(`${NAME}\\s*,\\s*${VERSION}`);
  const versionName = new RegExp(`${VERSION}\\s*,\\s*${NAME}`);

  const record = (name, version, evidence) => {
    const key = `${normalizeKey(name)}@${version || '*'}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      name,
      version,
      dependencies: {},
      devDependencies: {},
      evidence,
    });
  };

  let match;
  const nvRe = new RegExp(nameVersion.source, 'g');
  while ((match = nvRe.exec(normalized)) !== null) {
    record(match[1], match[2], `embedded package.json: ${match[1]}@${match[2]}`);
  }
  const vnRe = new RegExp(versionName.source, 'g');
  while ((match = vnRe.exec(normalized)) !== null) {
    record(match[2], match[1], `embedded package.json: ${match[2]}@${match[1]}`);
  }

  // Declared dependency lists.
  const depRe = new RegExp(DEP_BLOCK, 'g');
  while ((match = depRe.exec(normalized)) !== null) {
    const deps = parseDependencyPairs(match[1]);
    if (Object.keys(deps).length > 0) {
      results.push({
        name: undefined,
        version: undefined,
        dependencies: deps,
        devDependencies: {},
        evidence: `embedded "dependencies" block (${Object.keys(deps).length} entries)`,
      });
      break; // one representative dependency block per source is enough
    }
  }

  return results;
}

module.exports = { parseManifest, extractEmbeddedManifests };
