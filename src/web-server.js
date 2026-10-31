'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeSite } = require('./site-analyze');
const { createScanStore } = require('./scan-store');
const { createScanJobManager } = require('./scan-jobs');
const { throwIfAborted } = require('./util/abort');
require('./net');

const ROOT = path.join(__dirname, '..', 'web');
const MAX_BODY = 1024 * 1024;
const MAX_URLS = 25;
const scanStore = createScanStore();

function persistScanResult(result) {
  try {
    return scanStore.save(result);
  } catch (error) {
    console.log('[debun-plus:web] could not persist scan JSON', {
      url: result?.url || null,
      message: error?.message || String(error),
    });
    return null;
  }
}

function makeFailedScan(url, error, scanMode = 'deep') {
  const message = error?.message || String(error);
  return {
    url,
    finalUrl: url,
    fetchedAt: new Date().toISOString(),
    scanMode: scanMode === 'shallow' ? 'shallow' : 'deep',
    scanCompleted: false,
    framework: 'unknown',
    bundler: 'unknown',
    dashboardScan: { websiteUrl: url, finalUrl: url, status: 0, framework: 'unknown', bundler: 'unknown', checked: false, reason: message },
    reportEligible: false,
    reportReason: `No JSON report was produced because the scan could not complete. ${message}`,
    reason: message,
    report: null,
    packageCount: 0,
    packages: [],
    errors: [message],
    pages: [],
    crawl: { pagesVisited: 0 },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(Object.assign(new Error('Request is too large (1 MB maximum).'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function analyzeUrl(value, options = {}) {
  const scanMode = options.scanMode === 'shallow' ? 'shallow' : 'deep';
  const scanProfile = scanMode === 'shallow'
    ? {
        singlePageOnly: true,
        maxPages: 1,
        maxDepth: 0,
        maxLinksPerPage: 0,
        requestDelayMs: 0,
        timeout: 10000,
        robotsTimeout: 1200,
        renderLoadTimeout: 2500,
        waitForNetworkIdle: false,
        renderSettleMs: 120,
        maxScripts: 8,
        scriptTimeout: 1500,
        scriptCaptureGraceMs: 250,
        scriptConcurrency: 8,
        maxScriptBytes: 2 * 1024 * 1024,
        maxExternalScriptBytes: 4 * 1024 * 1024,
        maxInlineScriptBytes: 768 * 1024,
        maxSourceMaps: 2,
        sourceMapTimeout: 1200,
        manifestTimeout: 1000,
        maxCssAssets: 2,
        cssTimeout: 1000,
        debunTimeoutMs: 4000,
        registryTimeoutMs: 1000,
        registryConcurrency: 6,
        debunPlusOptions: {
          maxCandidates: 2,
          maxVersionsPerPackage: 1,
          maxFingerprintSlices: 16,
          maxTransitiveDepth: 0,
          registryTimeoutMs: 1000,
        },
        registryConcurrency: 4,
      }
    : { maxPages: 25, maxDepth: 1, maxLinksPerPage: 24, includeRequestedPage: false, requestDelayMs: 500, renderLoadTimeout: 4000, renderIdleTimeout: 1200, scriptCaptureGraceMs: 1500, registryConcurrency: 8 };
  return analyzeSite(value, {
    ...scanProfile,
    timeout: scanProfile.timeout || 15000,
    maxScripts: scanProfile.maxScripts || 60,
    debunTimeoutMs: scanProfile.debunTimeoutMs || 6000,
    scriptTimeout: scanProfile.scriptTimeout || (scanMode === 'shallow' ? 1500 : 2000),
    scriptConcurrency: 8,
    maxScriptBytes: scanMode === 'shallow' ? 2 * 1024 * 1024 : 4 * 1024 * 1024,
    maxExternalScriptBytes: scanMode === 'shallow' ? 6 * 1024 * 1024 : 24 * 1024 * 1024,
    maxInlineScriptBytes: scanMode === 'shallow' ? 1024 * 1024 : 2 * 1024 * 1024,
    maxSourceMaps: scanProfile.maxSourceMaps ?? (scanMode === 'shallow' ? 2 : 12),
    sourceMapTimeout: scanProfile.sourceMapTimeout || 2500,
    manifestTimeout: scanProfile.manifestTimeout || 1500,
    maxCssAssets: scanProfile.maxCssAssets ?? (scanMode === 'shallow' ? 2 : 12),
    cssTimeout: scanProfile.cssTimeout || 1500,
    registryTimeoutMs: scanProfile.registryTimeoutMs || 1000,
    registryConcurrency: scanProfile.registryConcurrency || 4,
    debunPlus: true,
    scanMode,
    debunPlusOptions: {
      maxCandidates: scanProfile.debunPlusOptions?.maxCandidates || (scanMode === 'shallow' ? 5 : 16),
      maxAstCandidates: scanProfile.debunPlusOptions?.maxAstCandidates ?? (scanMode === 'shallow' ? 2 : 6),
      maxVersionsPerPackage: scanProfile.debunPlusOptions?.maxVersionsPerPackage || (scanMode === 'shallow' ? 1 : 3),
      maxFingerprintSlices: scanProfile.debunPlusOptions?.maxFingerprintSlices || (scanMode === 'shallow' ? 16 : 48),
      maxTransitiveDepth: scanProfile.debunPlusOptions?.maxTransitiveDepth ?? 1,
      registryTimeoutMs: scanProfile.debunPlusOptions?.registryTimeoutMs || 1500,
    },
    ...options,
  });
}

function beginEventStream(response) {
  response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
}

function writeEvent(response, event) {
  if (response.destroyed || response.writableEnded) return Promise.resolve();
  if (response.write(`${JSON.stringify(event)}\n`)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      response.off('drain', finish);
      response.off('close', finish);
      response.off('error', finish);
      resolve();
    };
    response.once('drain', finish);
    response.once('close', finish);
    response.once('error', finish);
  });
}

function summarizeSiteResult(result) {
  return {
    url: result.url,
    finalUrl: result.finalUrl,
    framework: result.framework,
    bundler: result.bundler,
    technologyStack: result.technologyStack || [],
    securityAssessment: result.securityAssessment || null,
    assetsDiscovered: result.assetsDiscovered || 0,
    scriptsDiscovered: result.scriptsDiscovered || 0,
    scanCompleted: result.scanCompleted,
    reportEligible: result.reportEligible,
    packageCount: result.packageCount,
    pagesScanned: (result.pages || []).filter((page) => page.scanCompleted === true).length,
    packages: (result.packages || []).map(({ name, version, versionHint, ecosystem, componentType, slug, tier, confidence, alternatives, evidence, declared, declaredRanges, installationStatus, vulnerabilityStatus, vulnerabilityLookup, vulnerabilities, potentialVulnerabilities, vulnerabilityDatabase }) => ({
      name,
      version,
      versionHint,
      ecosystem,
      componentType,
      slug,
      tier,
      confidence,
      alternatives,
      declared,
      declaredRanges,
      installationStatus,
      vulnerabilityStatus,
      vulnerabilityLookup,
      vulnerabilities,
      potentialVulnerabilities,
      vulnerabilityDatabase,
      evidenceSources: [...new Set((evidence || []).map((item) => item.signal || item.source || item.detail).filter(Boolean))],
    })),
    packageLeads: (result.packageLeads || []).map(({ name, confidence, evidence, pagesSeen }) => ({ name, confidence, evidence, pagesSeen })),
    pages: (result.pages || []).map(({ url, finalUrl, title, status, scanCompleted, packageNames, assetsDiscovered, scriptsDiscovered }) => ({
      url, finalUrl, title, status, scanCompleted, packageNames, assetsDiscovered, scriptsDiscovered,
    })),
    newlyDiscovered: (result.newlyDiscovered || []).map(({ name, version, tier, confidence, alternatives }) => ({ name, version, tier, confidence, alternatives })),
    crawl: { pagesVisited: result.crawl?.pagesVisited || 0, warnings: result.crawl?.warnings || [] },
    warnings: result.warnings || result.crawl?.warnings || [],
    scanMode: result.scanMode || 'deep',
    reason: result.reason,
    reportReason: result.reportReason,
    errors: result.errors || [],
    savedScan: result.savedScan || null,
  };
}

async function executeScanJob({ urls, scanMode = 'deep', signal, updateProgress, addSiteResult }) {
  const results = [];
  const jsonReports = [];
  for (const [index, value] of urls.entries()) {
    throwIfAborted(signal);
    const siteIndex = index + 1;
    const onProgress = (event) => updateProgress({
      ...event,
      siteIndex,
      siteCount: urls.length,
      siteUrl: value,
    });
    onProgress({ type: 'progress', stageLabel: `${scanMode === 'shallow' ? 'Shallow' : 'Deep'} scan · starting URL ${siteIndex} of ${urls.length}…`, pagesScanned: 0, pagesAttempted: 0, totalPages: 1 });
    try {
      const result = await analyzeUrl(value, { signal, onProgress, scanMode });
      throwIfAborted(signal);
      result.savedScan = persistScanResult(result);
      results.push(result);
      if (result.reportEligible && result.report) jsonReports.push(result.report);
      addSiteResult(summarizeSiteResult(result));
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw error;
      console.log('[debun-plus:web] scan job URL failed', {
        siteIndex,
        url: value,
        message: error?.message || String(error),
      });
      const failed = makeFailedScan(value, error, scanMode);
      failed.savedScan = persistScanResult(failed);
      results.push(failed);
      addSiteResult(summarizeSiteResult(failed));
    }
    if (index < urls.length - 1) {
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(), 500);
        const onAbort = () => {
          finish(signal.reason || new Error('Scan stopped by user.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  return urls.length === 1
    ? { scanResult: results[0], jsonReport: jsonReports[0] || null }
    : { scanResults: results, jsonReport: jsonReports };
}

const scanJobs = createScanJobManager(executeScanJob);

function serveStatic(pathname, response) {
  const decodedPath = decodeURIComponent(pathname.slice(1));
  const assetsRoot = path.resolve(ROOT, '..', 'assets');
  const servingAssets = decodedPath.startsWith('assets/');
  const servingIcon = decodedPath === 'ico.ico';
  const absolute = servingIcon
    ? path.resolve(ROOT, '..', 'ico.ico')
    : servingAssets
    ? path.resolve(assetsRoot, decodedPath.slice('assets/'.length))
    : path.resolve(ROOT, pathname === '/' ? 'index.html' : pathname === '/saved' || pathname === '/saved/' ? 'saved.html' : decodedPath);
  const allowedRoot = servingAssets ? assetsRoot : servingIcon ? path.dirname(absolute) : ROOT;
  if (!absolute.startsWith(`${allowedRoot}${path.sep}`) && absolute !== path.join(ROOT, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(absolute, (error, data) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    const type = absolute.endsWith('.css') ? 'text/css; charset=utf-8' : absolute.endsWith('.js') ? 'text/javascript; charset=utf-8' : absolute.endsWith('.png') ? 'image/png' : absolute.endsWith('.ico') ? 'image/x-icon' : 'text/html; charset=utf-8';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const jobPath = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)(\/stop)?$/i);
  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    try {
      const data = JSON.parse(await readBody(request));
      let urls;
      if (Array.isArray(data.urls)) {
        if (!data.urls.length) return sendJson(response, 400, { error: 'The text file contains no URLs.' });
        if (data.urls.length > MAX_URLS) return sendJson(response, 400, { error: `A batch can contain up to ${MAX_URLS} URLs.` });
        if (data.urls.some((value) => typeof value !== 'string' || !value.trim())) return sendJson(response, 400, { error: 'Each entry must be a valid URL.' });
        urls = data.urls.map((value) => value.trim());
      } else if (typeof data.url === 'string' && data.url.trim()) {
        urls = [data.url.trim()];
      } else {
        return sendJson(response, 400, { error: 'Enter a URL or a list of URLs to scan.' });
      }
      const scanMode = data.scanMode === 'shallow' ? 'shallow' : 'deep';
      const job = scanJobs.start(urls, { scanMode });
      console.log('[debun-plus:web] background scan started', { jobId: job.id, urls: job.urls.length, scanMode });
      return sendJson(response, 202, job);
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { error: error.message || 'Could not start the scan.', activeJob: error.activeJob || null });
    }
  }
  if (jobPath && request.method === 'GET' && !jobPath[2]) {
    const job = scanJobs.get(jobPath[1]);
    return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: 'Scan job not found.' });
  }
  if (jobPath && request.method === 'POST' && jobPath[2] === '/stop') {
    const job = scanJobs.stop(jobPath[1]);
    if (!job) return sendJson(response, 404, { error: 'Scan job not found.' });
    console.log('[debun-plus:web] background scan stop requested', { jobId: job.id, status: job.status });
    return sendJson(response, 200, job);
  }
  const savedScanPath = url.pathname.match(/^\/api\/scans\/([0-9a-f-]+)$/i);
  if (request.method === 'GET' && url.pathname === '/api/scans') {
    const page = Number(url.searchParams.get('page')) || 1;
    const pageSize = Number(url.searchParams.get('pageSize')) || 25;
    const search = url.searchParams.get('search') || '';
    return sendJson(response, 200, scanStore.list({ page, pageSize, search }));
  }
  if (request.method === 'GET' && savedScanPath) {
    const record = scanStore.read(savedScanPath[1]);
    return record ? sendJson(response, 200, record) : sendJson(response, 404, { error: 'Saved scan not found.' });
  }
  if (request.method === 'DELETE' && savedScanPath) {
    return scanStore.remove(savedScanPath[1])
      ? sendJson(response, 200, { deleted: true })
      : sendJson(response, 404, { error: 'Saved scan not found.' });
  }
  if (request.method === 'GET') return serveStatic(url.pathname, response);
  if (request.method !== 'POST' || !['/api/analyze', '/api/batch'].includes(url.pathname)) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    const data = JSON.parse(await readBody(request));
    if (url.pathname === '/api/analyze') {
      if (!data.url || typeof data.url !== 'string') return sendJson(response, 400, { error: 'Enter a URL to analyze.' });
      console.log('[debun-plus:web] analysis request received', { url: data.url, stream: data.stream === true });
      if (data.stream === true) {
        beginEventStream(response);
        await writeEvent(response, { type: 'progress', pagesScanned: 0, totalPages: 1, currentUrl: data.url });
        try {
          const result = await analyzeUrl(data.url, { onProgress: (event) => writeEvent(response, event), scanMode: data.scanMode });
          result.savedScan = persistScanResult(result);
          await writeEvent(response, {
            type: 'result',
            data: {
              scanResult: result,
              jsonReport: result.reportEligible ? result.report : null,
              reportReason: result.reportReason,
            },
          });
        } catch (error) {
          console.log('[debun-plus:web] analysis request failed', {
            url: data.url,
            message: error?.message || String(error),
            stack: error?.stack || null,
          });
          const failed = makeFailedScan(data.url, error, data.scanMode);
          failed.savedScan = persistScanResult(failed);
          await writeEvent(response, {
            type: 'result',
            data: { scanResult: failed, jsonReport: null, reportReason: failed.reportReason },
          });
        }
        return response.end();
      }
      const result = await analyzeUrl(data.url, { scanMode: data.scanMode });
      result.savedScan = persistScanResult(result);
      if (!result.reportEligible) {
        return sendJson(response, 200, { dashboardScan: result.dashboardScan, report: null, reportReason: result.reportReason });
      }
      return sendJson(response, 200, result.report);
    }
    if (!Array.isArray(data.urls) || data.urls.length === 0) return sendJson(response, 400, { error: 'The text file contains no URLs.' });
    if (data.urls.length > MAX_URLS) return sendJson(response, 400, { error: `A batch can contain up to ${MAX_URLS} URLs.` });
    console.log('[debun-plus:web] batch analysis received', { urls: data.urls.length, stream: data.stream === true });
    if (data.stream === true) {
      beginEventStream(response);
      const results = [];
      for (const [index, value] of data.urls.entries()) {
        const siteIndex = index + 1;
        const siteProgress = (event) => writeEvent(response, { ...event, siteIndex, siteCount: data.urls.length, siteUrl: value });
        await siteProgress({ type: 'progress', pagesScanned: 0, totalPages: 1 });
        try {
          const result = await analyzeUrl(value, { onProgress: siteProgress, scanMode: data.scanMode });
          result.savedScan = persistScanResult(result);
          results.push(result);
        } catch (error) {
          console.log('[debun-plus:web] batch URL analysis failed', {
            siteIndex,
            url: value,
            message: error?.message || String(error),
            stack: error?.stack || null,
          });
          const failed = makeFailedScan(value, error, data.scanMode);
          failed.savedScan = persistScanResult(failed);
          results.push(failed);
        }
        await writeEvent(response, {
          type: 'site-result',
          siteIndex,
          siteCount: data.urls.length,
          data: summarizeSiteResult(results[results.length - 1]),
        });
        if (index < data.urls.length - 1) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await writeEvent(response, {
        type: 'done',
        data: {
          scanResults: results,
          jsonReport: results.filter((result) => result.reportEligible).map((result) => result.report),
        },
      });
      return response.end();
    }
    const results = [];
    for (const value of data.urls) {
      if (results.length > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const result = await analyzeUrl(value, { scanMode: data.scanMode });
        result.savedScan = persistScanResult(result);
        results.push(result);
      } catch (error) {
        console.log('[debun-plus:web] batch URL analysis failed', {
          url: value,
          message: error?.message || String(error),
          stack: error?.stack || null,
        });
        const failed = makeFailedScan(value, error, data.scanMode);
        failed.savedScan = persistScanResult(failed);
        results.push(failed);
      }
    }
    const reports = results.filter((result) => result.reportEligible).map((result) => result.report);
    if (reports.length === 0) {
      response.writeHead(204, { 'cache-control': 'no-store' });
      return response.end();
    }
    return sendJson(response, 200, reports);
  } catch (error) {
    console.log('[debun-plus:web] request failed', {
      method: request.method,
      path: url.pathname,
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
    return sendJson(response, error.statusCode || 400, { error: error.message || 'Invalid request.' });
  }
});

const port = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = address && typeof address === 'object' ? address.port : port;
  console.log('[debun-plus:web] listening', { url: `http://${host}:${listeningPort}` });
});

module.exports = server;
