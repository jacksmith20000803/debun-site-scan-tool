'use strict';

const axios = require('axios');
const { mapPool } = require('./fetch');
const semver = require('semver');

const http = axios.create({ timeout: 8000, maxRedirects: 3, headers: { 'User-Agent': 'Debun-Plus/1.1 vulnerability-audit', Accept: 'application/json' } });
const responseCache = new Map();
const RESPONSE_CACHE_TTL_MS = 30 * 60 * 1000;

function readCache(key) {
  const item = responseCache.get(key);
  if (!item) return undefined;
  if (item.expiresAt <= Date.now()) { responseCache.delete(key); return undefined; }
  return item.value;
}

function writeCache(key, value) {
  if (responseCache.size > 2000) {
    for (const [cacheKey, item] of responseCache) if (item.expiresAt <= Date.now()) responseCache.delete(cacheKey);
  }
  responseCache.set(key, { value, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => { const key = keyOf(item); if (!key || seen.has(key)) return false; seen.add(key); return true; });
}

/** Public-page detection only. WordPress asset `?ver=` values are cache keys, not reliable installed versions. */
function detectWordPress(html = '', baseUrl = '') {
  const found = new Map();
  const add = (type, slug, version, evidence, versionHint = null) => {
    slug = String(slug || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(slug)) return;
    const key = `${type}:${slug}`;
    const item = found.get(key) || { name: slug, slug, version: null, versionHint: null, ecosystem: 'WordPress', componentType: type, evidence: [] };
    if (version && (!item.version || item.version === 'unknown')) item.version = version;
    if (versionHint && !item.versionHint) item.versionHint = versionHint;
    if (evidence && !item.evidence.includes(evidence)) item.evidence.push(evidence);
    found.set(key, item);
  };
  const text = String(html);
  if (/\/wp-content\/(?:plugins|themes)\/|\/wp-includes\//i.test(text) || /name=["']generator["'][^>]*wordpress/i.test(text)) {
    const generator = /name=["']generator["'][^>]*content=["'][^"']*WordPress\s*([\d.]+)/i.exec(text) || /content=["'][^"']*WordPress\s*([\d.]+)[^"']*["'][^>]*name=["']generator["']/i.exec(text);
    if (generator) add('core', 'wordpress', generator[1], 'generator-meta');
  }
  // URLs are commonly HTML-escaped or relative; this catches paths without an absolute host.
  for (const m of text.matchAll(/\/wp-content\/(plugins|themes)\/([^/?#"'<>]+)\/[^\s"'<>]*/gi)) {
    const version = /[?&]ver=([\w.+-]+)/i.exec(m[0]);
    add(m[1] === 'plugins' ? 'plugin' : 'theme', m[2], null, 'public-asset-url', version?.[1] || null);
  }
  return [...found.values()];
}

async function lookupWordPress(component) {
  const cacheKey = `wp:${component.componentType}:${component.slug}:${component.version || 'unknown'}`;
  const cached = readCache(cacheKey);
  if (cached !== undefined) return cached;
  if (component.componentType === 'core') {
    if (!component.version) return [];
    const url = `https://www.wpvulnerability.net/core/${encodeURIComponent(component.version)}/`;
    const { data } = await http.get(url);
    const result = normalizeWpResponse(data, component);
    writeCache(cacheKey, result);
    return result;
  }
  const url = `https://www.wpvulnerability.net/${component.componentType}/${encodeURIComponent(component.slug)}/`;
  const { data } = await http.get(url);
  const result = normalizeWpResponse(data, component);
  writeCache(cacheKey, result);
  return result;
}

function normalizeWpResponse(data, component) {
  const entries = data?.data?.vulnerability || data?.data?.vulnerabilities || data?.vulnerability || data?.vulnerabilities || [];
  if (!Array.isArray(entries)) return [];
  const versionRangeMatches = (version, operator = {}) => {
    const installed = semver.coerce(version);
    if (!installed) return null;
    const min = semver.coerce(operator.min_version);
    const max = semver.coerce(operator.max_version);
    if (!min && !max) return null;
    if (min && (operator.min_operator === 'gt' ? semver.lte(installed, min) : operator.min_operator === 'gte' ? semver.lt(installed, min) : false)) return false;
    if (max && (operator.max_operator === 'lt' ? semver.gte(installed, max) : operator.max_operator === 'lte' ? semver.gt(installed, max) : false)) return false;
    return true;
  };
  return entries.filter((v) => {
    if (!component.version) return true;
    return versionRangeMatches(component.version, v.operator || {}) !== false;
  }).map((v) => {
    const source = (v.source || []).find((item) => /^CVE-/i.test(item.name || item.id || '')) || (v.source || [])[0] || {};
    const cve = source.name || source.id;
    const rangeMatched = component.version ? versionRangeMatches(component.version, v.operator || {}) : null;
    return {
    id: cve || v.uuid || v.name || 'WordPress advisory',
    aliases: uniqueBy((v.source || []).map((r) => r.name || r.id).filter(Boolean), (x) => x),
    summary: source.description || v.description || v.name || 'WordPress vulnerability advisory',
    severity: v.cvss?.score ?? v.cvss_score ?? null,
    affected: v.operator || null,
    fixed: v.operator?.max_version || null,
    url: source.link || (cve ? `https://www.cve.org/CVERecord?id=${encodeURIComponent(cve)}` : `https://www.wpvulnerability.net/${component.componentType}/${encodeURIComponent(component.slug)}/`),
    source: 'WPVulnerability',
    match: rangeMatched === true ? `matched ${component.version} against WordPress affected range` : component.version ? `component version ${component.version} observed; affected range unavailable` : 'component slug matched; installed version unknown, range not verified',
  }; });
}

function osvQuery(pkg) {
  if (!pkg.version || pkg.versionIsExact !== true || Number(pkg.confidence) < 0.75 || pkg.installationStatus === 'declared-only') return null;
  const trustedVersionSignals = new Set(['debun-exact', 'registry-exact', 'sourcemap', 'manifest', 'global']);
  if (!(pkg.evidence || []).some((evidence) => evidence.version === pkg.version && trustedVersionSignals.has(evidence.signal))) return null;
  const name = String(pkg.name || '').trim();
  const version = semver.valid(pkg.version);
  if (!name || !version) return null;
  return { version, package: { name, ecosystem: 'npm' } };
}

async function lookupNpmBatch(packages, signal) {
  const result = new Map();
  const entries = packages.map((pkg) => ({ pkg, query: osvQuery(pkg), cacheKey: `npm:${pkg.name}@${pkg.version}` })).filter((x) => {
    if (!x.query) return false;
    const cached = readCache(x.cacheKey);
    if (cached !== undefined) result.set(x.pkg.name, cached);
    return cached === undefined;
  });
  if (!entries.length) return result;
  let failed = false;
  // OSV batch responses preserve input order and return only affected versions for this exact version.
  for (let offset = 0; offset < entries.length; offset += 100) {
    if (signal?.aborted) throw signal.reason || new Error('Scan stopped.');
    try {
      const { data } = await http.post('https://api.osv.dev/v1/querybatch', { queries: entries.slice(offset, offset + 100).map((x) => x.query) }, { signal });
      const rows = data?.results || [];
      await mapPool(rows.flatMap((row) => row.vulns || []), 10, async (vuln) => {
        if (!vuln.id) return;
        try {
          const detail = (await http.get(`https://api.osv.dev/v1/vulns/${encodeURIComponent(vuln.id)}`, { signal })).data;
          vuln.detail = detail;
        } catch (_) { /* Keep the identifier when detail lookup is unavailable. */ }
      }, { signal });
      for (let i = 0; i < rows.length; i++) {
        const item = entries[offset + i];
        if (item) {
          const vulnerabilities = (rows[i]?.vulns || []).map((v) => ({
          id: v.id,
          aliases: v.detail?.aliases || [],
          summary: v.detail?.summary || v.detail?.details || v.id,
          severity: v.detail?.severity?.[0]?.score || null,
          affected: (v.detail?.affected || []).flatMap((a) => a.ranges || []).flatMap((r) => r.events || []).map((e) => e.introduced || e.fixed || e.last_affected).filter(Boolean),
          url: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`,
          source: 'OSV.dev',
          match: `exact npm version ${item.pkg.version}`,
          }));
          result.set(item.pkg.name, vulnerabilities);
          writeCache(item.cacheKey, vulnerabilities);
        }
      }
    } catch (_) { failed = true; /* Vulnerability lookup is additive and must not invalidate package detection. */ }
  }
  result.failed = failed;
  return result;
}

async function enrichVulnerabilities(packages, options = {}) {
  const signal = options.signal;
  const wp = packages.filter((p) => p.ecosystem === 'WordPress');
  const npm = packages.filter((p) => p.ecosystem !== 'WordPress');
  const [npmResults, wpResults] = await Promise.all([
    lookupNpmBatch(npm, signal),
    mapPool(wp, 8, (p) => lookupWordPress(p).catch(() => null), { signal }),
  ]);
  const wpByKey = new Map(wp.map((p, i) => [`${p.componentType}:${p.slug}`, wpResults[i] || []]));
  return packages.map((pkg) => {
    const npmEligible = pkg.ecosystem !== 'WordPress' && Boolean(osvQuery(pkg));
    const lookupFailed = pkg.ecosystem === 'WordPress'
      ? wpByKey.get(`${pkg.componentType}:${pkg.slug}`) === null
      : Boolean(npmEligible && npmResults.failed && !npmResults.has(pkg.name));
    const versionUnverified = pkg.ecosystem !== 'WordPress' && !npmEligible;
    const vulnerabilities = (pkg.ecosystem === 'WordPress' ? wpByKey.get(`${pkg.componentType}:${pkg.slug}`) : npmResults.get(pkg.name)) || [];
    return { ...pkg,
    vulnerabilityStatus: lookupFailed ? 'lookup-unavailable' : versionUnverified ? 'version-unverified' : vulnerabilities.length ? (pkg.ecosystem === 'WordPress' && vulnerabilities.some((v) => !String(v.match || '').startsWith('matched ')) ? 'advisories-unverified' : 'vulnerable') : 'no-known-vulnerabilities',
    vulnerabilityLookup: lookupFailed ? 'unavailable' : versionUnverified ? 'skipped' : 'complete',
    vulnerabilities,
    vulnerabilityDatabase: pkg.ecosystem === 'WordPress' ? 'WPVulnerability' : 'OSV.dev',
  }; });
}

module.exports = { detectWordPress, enrichVulnerabilities };
