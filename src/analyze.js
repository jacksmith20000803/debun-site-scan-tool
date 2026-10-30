'use strict';

const { normalizeUrl, resolveUrl } = require('./util/url');
const { log } = require('./util/log');
const { fetchDocument, fetchText, mapPool } = require('./fetch');
const { extractFromHtml, extractSourceMappingUrls } = require('./extract');
const { inferWithDebun } = require('./inference/debun');
const { inferFromUrl } = require('./inference/url-hint');
const { extractBannerHints } = require('./inference/banner');
const { extractGlobalVersions } = require('./inference/global-version');
const { packagesFromSourceMap } = require('./inference/sourcemap');
const { extractEmbeddedManifests, parseManifest } = require('./inference/embedded-manifest');
const { mergeEvidence } = require('./inference/merge');
const { throwIfAborted, isAbortError } = require('./util/abort');

const DEFAULTS = {
  timeout: 20000,
  maxScripts: 60,
  concurrency: 6,
  browser: false,
  useDebun: true,
  includeSourceMaps: true,
  maxSourceMaps: 12,
  fetchRootManifest: true,
  debunPlus: false,
  saveScripts: null,
};

const PLUS_EVIDENCE_SOURCE = {
  'debun-exact': 'debun-pog',
  'debun-range': 'debun-pog',
  'debun-likely': 'debun-pog',
  url: 'script-url',
  banner: 'license-banner',
  global: 'runtime-global',
  sourcemap: 'embedded-version',
  manifest: 'embedded-version',
};

/** Re-try registry fingerprinting for every package lead lacking a version. */
function unknownVersionCandidates(evidenceList) {
  return mergeEvidence(evidenceList)
    .filter((pkg) => !pkg.version)
    .map((pkg) => ({
      name: pkg.name,
      evidence: pkg.evidence.flatMap((item) => {
        const source = PLUS_EVIDENCE_SOURCE[item.signal];
        return source ? [{ source, detail: item.detail, ...(item.version ? { version: item.version } : {}) }] : [];
      }),
    }))
    .filter((candidate) => candidate.evidence.length > 0);
}

function isJavaScript(contentType, url) {
  if (contentType && /(?:java|ecma)script|text\/js\b/i.test(contentType)) return true;
  return /\.(?:m?js|cjs)(?:$|\?)/i.test(new URL(url).pathname);
}

function isJson(contentType, url) {
  if (contentType && /json/i.test(contentType)) return true;
  return /\.json(?:$|\?)/i.test(new URL(url).pathname);
}

function isReportableNpmName(value) {
  const name = String(value || '');
  if (!name || name.length > 214 || name !== name.toLowerCase()) return false;
  if (name.startsWith('@')) return /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name);
  return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

function decodeDataUri(uri) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  try {
    const isBase64 = Boolean(match[2]);
    const payload = isBase64 ? Buffer.from(match[3], 'base64').toString('utf-8') : decodeURIComponent(match[3]);
    return payload;
  } catch (_) {
    return null;
  }
}

async function collectSourceMapEvidence(sources, options, errors) {
  throwIfAborted(options.signal);
  const evidence = [];
  const dataUriMaps = [];
  const externalMaps = [];

  for (const source of sources) {
    if (!source.code) continue;
    for (const mappingUrl of extractSourceMappingUrls(source.code)) {
      if (mappingUrl.startsWith('data:')) {
        dataUriMaps.push(mappingUrl);
      } else {
        const absolute = resolveUrl(source.url, mappingUrl);
        if (absolute) externalMaps.push({ url: absolute, from: source.url });
      }
    }
  }

  const parsedMaps = [];
  for (const dataUri of dataUriMaps.slice(0, options.maxSourceMaps)) {
    const text = decodeDataUri(dataUri);
    if (!text) continue;
    try {
      parsedMaps.push({ map: JSON.parse(text), origin: 'inline' });
    } catch (_) {
      /* ignore */
    }
  }

  const remaining = Math.max(0, options.maxSourceMaps - parsedMaps.length);
  const fetched = await mapPool(externalMaps.slice(0, remaining), options.concurrency, async (entry) => {
    const response = await fetchText(entry.url, { timeout: options.sourceMapTimeout ?? options.timeout, signal: options.signal });
    if (!response || !response.text) return null;
    try {
      return { map: JSON.parse(response.text), origin: entry.url };
    } catch (_) {
      errors.push(`source map is not valid JSON: ${entry.url}`);
      return null;
    }
  }, { signal: options.signal });
  for (const item of fetched) {
    if (item && item.map) parsedMaps.push(item);
  }

  for (const parsed of parsedMaps) {
    for (const hit of packagesFromSourceMap(parsed.map)) {
      evidence.push({
        name: hit.name,
        version: hit.version,
        signal: 'sourcemap',
        detail: hit.evidence,
        scope: 'library',
      });
    }
  }
  return { evidence, mapsParsed: parsedMaps.length };
}

/**
 * Analyze a URL and infer the packages/versions it uses.
 */
async function analyze(target, userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  throwIfAborted(options.signal);
  const startedAt = Date.now();
  const errors = [];
  const evidence = [];

  const url = normalizeUrl(target).toString();
  let finalUrl = url;
  let status = 0;
  let contentType = '';
  let html = '';
  let crawler = options.browser ? 'browser' : 'http';

  let externalSources = [];
  let inlineSources = [];
  let assets = [];
  let meta = {};
  let inlineScriptsFound = 0;
  let technology = null;
  let browserFailed = false;
  let manifestProject = null;

  // ---------------------------------------------------------------------------
  // 1. Retrieve the page / document.
  // ---------------------------------------------------------------------------
  if (options.browser) {
    try {
      const result = options.renderedPage || await require('./browser').crawlWithBrowser(url, options);
      throwIfAborted(options.signal);
      finalUrl = result.finalUrl || url;
      status = result.status;
      html = result.html || '';
      externalSources = result.externalScripts || [];
      inlineSources = (result.inlineScripts || []).map((entry, index) => ({
        url: `${finalUrl}#inline-${index}`,
        code: entry.content,
        inline: true,
      }));
      inlineScriptsFound = inlineSources.length;
      technology = result.technology || { framework: 'unknown', bundler: 'unknown', reason: 'Unable to identify the site framework and bundler.' };
      const parsed = extractFromHtml(html, finalUrl);
      meta = parsed.meta;
      assets = parsed.assets;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      errors.push(`browser crawl failed: ${error.message}`);
      log.warn(`browser crawl failed: ${error.message}`);
      browserFailed = true;
      technology = { framework: 'unknown', bundler: 'unknown', reason: 'The rendered browser scan failed before package analysis could start.' };
    }
  }

  // Browser mode must never silently fall back to analyzing unrendered source.
  if (options.browser && browserFailed) {
    return {
      url,
      finalUrl,
      crawler,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      page: { status, contentType, title: undefined, generator: undefined, description: undefined, language: undefined, bytes: html.length },
      project: null,
      technology,
      scanCompleted: false,
      stats: { externalScripts: 0, inlineScripts: 0, sourcesAnalyzed: 0, scriptBytes: 0, sourceMapsParsed: 0, debunLibraries: 0, assets: 0 },
      packageCount: 0,
      packages: [],
      declaredDependencies: {},
      errors,
    };
  }

  if (crawler === 'http') {
    const document = await fetchDocument(url, { timeout: options.timeout, signal: options.signal });
    throwIfAborted(options.signal);
    finalUrl = document.finalUrl;
    status = document.status;
    contentType = document.contentType;
    html = document.body;

    if (!document.ok) {
      errors.push(`HTTP ${document.status} when fetching ${finalUrl}`);
    }

    if (isJson(contentType, finalUrl)) {
      // The URL points at a manifest/document; treat it as the source of truth.
      const manifest = parseManifest(html);
      if (manifest) {
        manifestProject = { name: manifest.name, version: manifest.version, source: finalUrl };
        recordManifest(manifest, evidence, { source: finalUrl, manifestDocument: true });
      } else {
        errors.push(`${finalUrl} returned ${contentType || 'a document'} but is not a JSON package manifest`);
      }
    } else if (isJavaScript(contentType, finalUrl)) {
      externalSources.push({ url: finalUrl, code: html, contentType: contentType || 'text/javascript' });
    } else {
      const parsed = extractFromHtml(html, finalUrl);
      meta = parsed.meta;
      assets = parsed.assets;
      inlineScriptsFound = parsed.inlineScripts.length;
      inlineSources = parsed.inlineScripts.map((entry, index) => ({
        url: `${finalUrl}#inline-${index}`,
        code: entry.content,
        inline: true,
      }));

      // 2. Download external scripts (bounded concurrency).
      const toFetch = parsed.scripts.slice(0, options.maxScripts);
      const fetched = await mapPool(toFetch, options.concurrency, async (entry) => {
        const response = await fetchText(entry.url, { timeout: options.timeout, signal: options.signal });
        if (!response) return null;
        return { url: response.url || entry.url, code: response.text, contentType: response.contentType };
      }, { signal: options.signal });
      for (const item of fetched) {
        if (item) externalSources.push(item);
      }
      const skipped = parsed.scripts.length - toFetch.length;
      if (skipped > 0) log.step(`skipping ${skipped} script(s) beyond --max-scripts=${options.maxScripts}`);
    }
  } else {
    // Browser mode: script bodies were captured while the page executed, and
    // assets/meta were extracted from the rendered HTML above.
    log.step('using scripts captured by the browser');
  }

  const sources = [...externalSources, ...inlineSources];
  throwIfAborted(options.signal);
  const totalBytes = sources.reduce((sum, source) => sum + (source.code ? source.code.length : 0), 0);
  const analysisStartedAt = Date.now();
  console.log('[debun-plus:analysis] package inference started', {
    url: finalUrl,
    scripts: sources.length,
    scriptBytes: totalBytes,
    scriptBudget: options.renderedPage?.scriptBudget
      ? {
          analyzedBytes: options.renderedPage.scriptBudget.externalBytes + options.renderedPage.scriptBudget.inlineBytes,
          skipped: options.renderedPage.scriptBudget.skippedExternal + options.renderedPage.scriptBudget.skippedInline,
        }
      : null,
  });

  // ---------------------------------------------------------------------------
  // 3. Inference: Debun Property-Order-Graph engine.
  // ---------------------------------------------------------------------------
  let debunHits = [];
  if (options.useDebun && sources.length > 0) {
    const inferenceStartedAt = Date.now();
    try {
      debunHits = await inferWithDebun(sources, { timeoutMs: options.debunTimeoutMs, signal: options.signal });
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      errors.push(`debun inference failed: ${error.message}`);
      log.warn(`debun inference failed: ${error.message}`);
    }
    console.log('[debun-plus:analysis] debun inference finished', {
      url: finalUrl,
      scripts: sources.length,
      packages: debunHits.length,
      durationMs: Date.now() - inferenceStartedAt,
    });
  }

  for (const hit of debunHits) {
    const addVersions = (versions, signal) => {
      for (const version of versions) {
        evidence.push({
          name: hit.name,
          version,
          signal,
          detail: `debun POG match (${signal.replace('debun-', '')})` + (hit.files[0] ? ` in ${hit.files[0]}` : ''),
          scope: 'library',
        });
      }
    };
    if (hit.exactVersions.length > 0) addVersions(hit.exactVersions, 'debun-exact');
    if (hit.rangeVersions.length > 0) addVersions(hit.rangeVersions, 'debun-range');
    if (hit.likelyVersions.length > 0) addVersions(hit.likelyVersions, 'debun-likely');
    if (hit.exactVersions.length === 0 && hit.rangeVersions.length === 0 && hit.likelyVersions.length === 0) {
      evidence.push({
        name: hit.name,
        signal: 'debun-likely',
        detail: `debun POG match without a version`,
        scope: 'library',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Inference: URL / CDN hints.
  // ---------------------------------------------------------------------------
  for (const source of externalSources) {
    const hint = inferFromUrl(source.url);
    if (hint) {
      evidence.push({
        name: hint.name,
        version: hint.version,
        signal: 'url',
        detail: hint.evidence,
        scope: 'library',
      });
    }
  }
  // The page URL itself can carry a hint (e.g. a CDN-hosted script/document).
  const pageHint = inferFromUrl(finalUrl);
  if (pageHint) {
    evidence.push({
      name: pageHint.name,
      version: pageHint.version,
      signal: 'url',
      detail: `page URL: ${pageHint.evidence}`,
      scope: 'library',
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Inference: banners, global version assignments, embedded manifests.
  // ---------------------------------------------------------------------------
  for (const source of sources) {
    if (!source.code) continue;
    for (const hint of extractBannerHints(source.code)) {
      evidence.push({ name: hint.name, version: hint.version, signal: 'banner', detail: `${hint.evidence} (${source.url})`, scope: 'library' });
    }
    for (const hint of extractGlobalVersions(source.code)) {
      evidence.push({ name: hint.name, version: hint.version, signal: 'global', detail: `${hint.evidence} (${source.url})`, scope: 'library' });
    }
    for (const manifest of extractEmbeddedManifests(source.code)) {
      recordManifest(manifest, evidence, { source: source.url });
    }
  }

  if (html) {
    for (const manifest of extractEmbeddedManifests(html)) {
      recordManifest(manifest, evidence, { source: finalUrl });
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Inference: the site's own package.json (when published at the origin).
  // ---------------------------------------------------------------------------
  let rootManifest = null;
  if (options.fetchRootManifest) {
    try {
      const origin = new URL(finalUrl).origin;
      const candidates = [`${origin}/package.json`];
      for (const candidate of candidates) {
        const response = await fetchText(candidate, { timeout: Math.min(options.timeout, options.manifestTimeout ?? 8000), signal: options.signal });
        if (response && response.text) {
          const manifest = parseManifest(response.text);
          if (manifest) {
            rootManifest = { ...manifest, source: candidate };
            recordManifest(manifest, evidence, { source: candidate, root: true });
            break;
          }
        }
      }
    } catch (_) {
      throwIfAborted(options.signal);
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Inference: source maps.
  // ---------------------------------------------------------------------------
  let mapsParsed = 0;
  if (options.includeSourceMaps && sources.length > 0) {
    try {
      const result = await collectSourceMapEvidence(sources, options, errors);
      evidence.push(...result.evidence);
      mapsParsed = result.mapsParsed;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      errors.push(`source map analysis failed: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Enhanced bundle-corpus inference (independent of source maps/build files).
  // ---------------------------------------------------------------------------
  let debunPlus = null;
  if (options.debunPlus && sources.length > 0) {
    try {
      const { analyzeBundles } = require('../dist/src/debun-plus');
      const candidateNames = [
        ...(options.debunPlusOptions?.candidateNames || []),
        ...unknownVersionCandidates(evidence),
      ];
      for (const hit of debunHits) {
        const versions = [...hit.exactVersions, ...hit.rangeVersions, ...hit.likelyVersions];
        candidateNames.push({
          name: hit.name,
          evidence: versions.length
            ? versions.map((version) => ({ source: 'debun-pog', detail: 'debun-cli Property-Order-Graph candidate', version }))
            : [{ source: 'debun-pog', detail: 'debun-cli Property-Order-Graph candidate' }],
        });
      }
      for (const source of externalSources) {
        const hint = inferFromUrl(source.url);
        if (hint) candidateNames.push({
          name: hint.name,
          evidence: [{ source: 'script-url', detail: hint.evidence, version: hint.version }],
        });
      }
      const cssUrls = assets.filter((assetUrl) => /\.css(?:[?#]|$)/i.test(assetUrl)).slice(0, options.maxCssAssets ?? 4);
      const cssResponses = await mapPool(cssUrls, options.concurrency, async (assetUrl) => fetchText(assetUrl, { timeout: options.cssTimeout ?? Math.min(options.timeout, 1500), maxBytes: 2 * 1024 * 1024, signal: options.signal }), { signal: options.signal });
      const cssSources = cssResponses.filter((item) => item && item.text).map((item) => item.text);
      const plusOptions = { ...(options.debunPlusOptions || {}), candidateNames };
      if (cssSources.length) plusOptions.cssSources = [...(plusOptions.cssSources || []), ...cssSources];
      if (options.registryConcurrency || options.debunPlusOptions?.concurrency) {
        plusOptions.concurrency = options.registryConcurrency || options.debunPlusOptions.concurrency;
      }
      // Registry matching can take longer than a fixed page-wide budget when
      // the package/version corpus is cold. Keep individual requests bounded,
      // while allowing the scan to finish unless the user presses Stop.
      plusOptions.registryTimeoutMs = Math.max(1000, Math.min(Number(options.registryTimeoutMs ?? plusOptions.registryTimeoutMs) || 2500, 20000));
      const plusStartedAt = Date.now();
      plusOptions.signal = options.signal;
      console.log('[debun-plus:analysis] registry inference started', {
        url: finalUrl,
        candidates: candidateNames.length,
        requestTimeoutMs: plusOptions.registryTimeoutMs,
      });
      debunPlus = await analyzeBundles(sources.map(({ url: sourceUrl, code }) => ({ url: sourceUrl, code })), plusOptions);
      console.log('[debun-plus:analysis] debun-plus inference finished', {
        url: finalUrl,
        packages: debunPlus.packages.length,
        candidates: debunPlus.candidates.length,
        registryRequests: debunPlus.stats.registryRequests,
        durationMs: Date.now() - plusStartedAt,
      });
      for (const detection of debunPlus.packages) {
        // A registry-independent candidate with a zero score is only a lead,
        // not reliable package or version evidence. Avoid promoting it into
        // the installed package list.
        if (detection.tier === 'possible' && Number(detection.score) === 0 && detection.evidence.some((item) => /registry corpus version fingerprints were unavailable/i.test(item.detail || ''))) continue;
        const signal = detection.tier === 'exact' ? 'registry-exact' : detection.tier === 'range' ? 'registry-range' : 'registry-possible';
        evidence.push({
          name: detection.name,
          version: detection.version && detection.version !== 'unknown' ? detection.version : undefined,
          signal,
          detail: `debun-plus corpus fingerprint (score ${detection.score.toFixed(3)}, margin ${detection.margin.toFixed(3)}); ${detection.evidence.map((item) => item.detail).join('; ')}`,
          scope: detection.evidence.some((item) => item.source !== 'transitive-registry') ? 'library' : 'dependency',
        });
      }
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      errors.push(`debun-plus inference failed: ${error.message}`);
      log.warn(`debun-plus inference failed: ${error.message}`);
    }
  }

  throwIfAborted(options.signal);

  // ---------------------------------------------------------------------------
  // 9. Merge and summarize.
  // ---------------------------------------------------------------------------
  const packages = mergeEvidence(evidence);
  const verifiedNames = new Set(packages.map((pkg) => pkg.name.toLowerCase()));
  const leadConfidence = {
    'script-url': 0.9,
    'embedded-version': 0.85,
    'license-banner': 0.82,
    'runtime-global': 0.78,
    'meta-framework': 0.78,
    'umd-global': 0.78,
    'css-class': 0.62,
    'bundle-string': 0.55,
    'ast-property': 0.35,
  };
  const packageLeads = (debunPlus?.candidates || [])
    .filter((candidate) => isReportableNpmName(candidate.name) && !verifiedNames.has(candidate.name.toLowerCase()))
    .map((candidate) => ({
      name: candidate.name,
      confidence: Math.max(0, ...candidate.evidence.map((item) => leadConfidence[item.source] || 0.45)),
      evidence: candidate.evidence.map((item) => ({ source: item.source, detail: item.detail, ...(item.version ? { versionHint: item.version } : {}) })),
    }))
    .filter((candidate) => candidate.evidence.length > 0);
  console.log('[debun-plus:analysis] package inference finished', {
    url: finalUrl,
    packages: packages.length,
    durationMs: Date.now() - analysisStartedAt,
    elapsedMs: Date.now() - startedAt,
  });

  const declaredDependencies = new Map();
  for (const item of evidence) {
    if (item.signal === 'declared-dep' && item.name) {
      const key = item.name;
      if (!declaredDependencies.has(key)) declaredDependencies.set(key, item.declaredRange || item.version);
    }
  }

  const project = rootManifest
    ? { name: rootManifest.name, version: rootManifest.version, source: rootManifest.source }
    : manifestProject || pickProject(packages);

  if (options.saveScripts) {
    try {
      saveSources(options.saveScripts, sources);
    } catch (error) {
      errors.push(`failed to save scripts: ${error.message}`);
    }
  }

  return {
    url,
    finalUrl,
    crawler,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    page: {
      status,
      contentType,
      title: meta.title,
      generator: meta.generator,
      description: meta.description,
      language: meta.lang,
      bytes: html.length,
    },
    project,
    technology,
    debunPlus,
    packageLeads,
    scanCompleted: true,
    stats: {
      externalScripts: externalSources.length,
      inlineScripts: inlineScriptsFound,
      sourcesAnalyzed: sources.length,
      scriptBytes: totalBytes,
      sourceMapsParsed: mapsParsed,
      debunLibraries: debunHits.length,
      assets: assets.length,
    },
    packageCount: packages.length,
    packages,
    declaredDependencies: Object.fromEntries(declaredDependencies),
    errors,
  };
}

/** Add a manifest's own identity and every declared dependency as evidence. */
function recordManifest(manifest, evidence, context) {
  if (!manifest) return;
  if (manifest.name && !context.root && !context.manifestDocument) {
    evidence.push({
      name: manifest.name,
      version: manifest.version,
      signal: 'manifest',
      detail: `package manifest (${context.source})${context.root ? ' [site root]' : ''}`,
      scope: 'library',
    });
  }
  const push = (deps, kind) => {
    if (!deps) return;
    for (const [name, range] of Object.entries(deps)) {
      evidence.push({
        name,
        // A declared semver range is not evidence of the version installed in
        // production. Keep the declaration for display, but never use it for
        // exact-version scoring or vulnerability matching.
        declaredRange: typeof range === 'string' ? range : undefined,
        signal: 'declared-dep',
        detail: `${kind} in package manifest (${context.source})`,
        scope: 'dependency',
      });
    }
  };
  push(manifest.dependencies, 'dependency');
  push(manifest.peerDependencies, 'peer dependency');
}

function pickProject(packages) {
  if (!packages.length) return null;
  const manifestRecord = packages.find((pkg) => pkg.evidence.some((e) => e.signal === 'manifest'));
  if (manifestRecord) return { name: manifestRecord.name, version: manifestRecord.version, source: 'embedded manifest' };
  return null;
}

function saveSources(directory, sources) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(directory, { recursive: true });
  sources.forEach((source, index) => {
    const safe = (source.url || `inline-${index}`)
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9._/-]+/g, '_')
      .slice(-200);
    const target = path.join(directory, safe || `source-${index}.js`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.code || '');
  });
  log.success(`saved ${sources.length} source file(s) to ${directory}`);
}

module.exports = {
  analyze,
  isJavaScript,
  isJson,
  unknownVersionCandidates,
  // Kept as an alias for existing callers; behavior now includes LOW leads.
  mediumOrHigherUnknownVersionCandidates: unknownVersionCandidates,
};
