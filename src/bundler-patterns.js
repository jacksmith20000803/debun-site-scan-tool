const fs = require('node:fs');
const path = require('node:path');

function loadBundlerPatterns() {
  const candidates = [
    path.resolve(process.cwd(), 'patterns/bundlers.json'),
    path.resolve(__dirname, '../patterns/bundlers.json'),
    path.resolve(__dirname, '../../patterns/bundlers.json'),
  ];
  for (const candidate of candidates) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch (_) {}
  }
  return { schemaVersion: 1, bundlers: {} };
}

function toRegExp(value) {
  try { return new RegExp(value, 'i'); } catch (_) { return null; }
}

function findBundlerHints(code = '', urls = [], html = '') {
  const patterns = loadBundlerPatterns();
  const codeText = `${code}\n${html}`;
  const urlText = Array.isArray(urls) ? urls.join('\n') : String(urls || '');
  const hints = [];
  for (const [name, entry] of Object.entries(patterns.bundlers || {})) {
    const identifierPatterns = (entry.identifierPatterns || []).map(toRegExp).filter(Boolean);
    const codePatterns = (entry.codePatterns || []).map(toRegExp).filter(Boolean);
    const urlPatterns = (entry.urlPatterns || []).map(toRegExp).filter(Boolean);
    const matched = identifierPatterns.some((pattern) => pattern.test(codeText))
      || codePatterns.some((pattern) => pattern.test(codeText))
      || urlPatterns.some((pattern) => pattern.test(urlText));
    if (matched) hints.push({ name, version: entry.version || 'unversioned' });
  }
  return hints;
}

function preferredBundlerHint(hints) {
  const patterns = loadBundlerPatterns().bundlers || {};
  return [...(hints || [])].sort((left, right) =>
    (patterns[left.name]?.priority ?? Number.MAX_SAFE_INTEGER) - (patterns[right.name]?.priority ?? Number.MAX_SAFE_INTEGER))[0] || null;
}

function isBundlerRuntimeIdentifier(identifier) {
  const text = String(identifier || '');
  for (const entry of Object.values(loadBundlerPatterns().bundlers || {})) {
    for (const value of entry.identifierPatterns || []) {
      const pattern = toRegExp(value);
      if (pattern && pattern.test(text)) return true;
    }
  }
  return false;
}

function matchesDataPattern(text, field) {
  const value = String(text || '');
  return Object.values(loadBundlerPatterns().bundlers || {}).some((entry) =>
    (entry[field] || []).some((source) => {
      const pattern = toRegExp(source);
      return pattern && pattern.test(value);
    }));
}

function sourceMapPatterns() {
  return Object.entries(loadBundlerPatterns().bundlers || {}).flatMap(([name, entry]) =>
    (entry.sourceMapPatterns || []).map((pattern) => ({ name, pattern: toRegExp(pattern) })).filter((item) => item.pattern));
}

function isBundlerBoilerplate(value) {
  return (loadBundlerPatterns().boilerplatePatterns || []).some((source) => {
    const pattern = toRegExp(source);
    return pattern && pattern.test(String(value || ''));
  });
}

module.exports = {
  loadBundlerPatterns,
  findBundlerHints,
  preferredBundlerHint,
  isBundlerRuntimeIdentifier,
  isBundlerRegistrationHint: (text) => matchesDataPattern(text, 'registrationPatterns'),
  isBundlerMetadata: (text) => matchesDataPattern(text, 'metadataPatterns'),
  sourceMapPatterns,
  isBundlerBoilerplate,
};
