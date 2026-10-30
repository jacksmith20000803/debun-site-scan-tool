'use strict';

const { crawlSiteWithMdream } = require('./mdream-crawler');
const { analyze } = require('./analyze');
const { mergeEvidence } = require('./inference/merge');
const { normalizeKey } = require('./inference/naming');
const { throwIfAborted, isAbortError } = require('./util/abort');
const { detectWordPress, enrichVulnerabilities } = require('./vulnerabilities');

async function scanRenderedPage(renderedPage, options) {
  throwIfAborted(options.signal);
  const framework = renderedPage.technology?.framework || 'unknown';
  const bundler = renderedPage.technology?.bundler || 'unknown';
  const frameworkReason = renderedPage.technology?.reason || null;
  const technologyStack = renderedPage.technologyStack || [];
  if (renderedPage.scanBlocked) {
    const reason = renderedPage.challenge
      ? 'Page presented an access or browser challenge; scanning stopped at this page.'
      : `Page returned HTTP ${renderedPage.status}; scanning stopped at this page.`;
    return { url: renderedPage.url, finalUrl: renderedPage.finalUrl, depth: renderedPage.depth, status: renderedPage.status, linksFound: renderedPage.linksFound || 0, title: renderedPage.title, framework, bundler, frameworkReason, technologyStack, assetsDiscovered: renderedPage.assetCount || 0, scriptsDiscovered: renderedPage.scriptsDiscovered || 0, dashboardChecked: false, scanCompleted: false, packageCount: 0, packages: [], errors: [reason] };
  }
  if (renderedPage.error) {
    return { url: renderedPage.url, finalUrl: renderedPage.finalUrl, depth: renderedPage.depth, status: renderedPage.status, linksFound: renderedPage.linksFound || 0, title: null, framework: 'unknown', bundler: 'unknown', frameworkReason, technologyStack, assetsDiscovered: renderedPage.assetCount || 0, scriptsDiscovered: renderedPage.scriptsDiscovered || 0, dashboardChecked: false, scanCompleted: false, packageCount: 0, packages: [], errors: [`Could not render ${renderedPage.url}: ${renderedPage.error}`] };
  }
  try {
    const result = await analyze(renderedPage.finalUrl, {
      ...options,
      browser: true,
      renderedPage,
      fetchRootManifest: renderedPage.isDashboard === true && options.fetchRootManifest !== false,
    });
    throwIfAborted(options.signal);
    const wpComponents = detectWordPress(renderedPage.html || '', renderedPage.finalUrl);
    const wpPackages = wpComponents.map((component) => ({
      ...component,
      tier: component.version ? 'exact' : 'possible',
      confidence: component.version ? 0.95 : 0.72,
      declared: false,
      evidence: [{ signal: 'wordpress-asset', version: component.version, detail: `${component.evidence.join(', ')}${component.versionHint ? `; ?ver=${component.versionHint} is an asset hint, not an installed version` : ''}` }],
    }));
    const combinedPackages = [...result.packages];
    for (const component of wpPackages) {
      if (!combinedPackages.some((item) => item.ecosystem === 'WordPress' && item.componentType === component.componentType && item.slug === component.slug)) combinedPackages.push(component);
    }
    return {
      url: renderedPage.url,
      finalUrl: renderedPage.finalUrl,
      depth: renderedPage.depth,
      status: renderedPage.status,
      linksFound: renderedPage.linksFound || 0,
      title: renderedPage.title,
      framework,
      bundler,
      frameworkReason,
      technologyStack,
      assetsDiscovered: renderedPage.assetCount || 0,
      scriptsDiscovered: renderedPage.scriptsDiscovered || 0,
      dashboardChecked: true,
      scanCompleted: result.scanCompleted !== false,
      packageCount: combinedPackages.length,
      packages: combinedPackages,
      packageLeads: result.packageLeads || [],
      declaredDependencies: result.declaredDependencies,
      errors: result.errors,
    };
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    console.log('[debun-plus:analysis] page package analysis failed', {
      url: renderedPage.finalUrl || renderedPage.url,
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
    return { url: renderedPage.url, finalUrl: renderedPage.finalUrl, depth: renderedPage.depth, status: renderedPage.status, linksFound: renderedPage.linksFound || 0, title: renderedPage.title, framework, bundler, frameworkReason, technologyStack, assetsDiscovered: renderedPage.assetCount || 0, scriptsDiscovered: renderedPage.scriptsDiscovered || 0, dashboardChecked: true, scanCompleted: false, packageCount: 0, packages: [], errors: [error.message] };
  }
}

/** Render a site's linked pages, report scan progress, and merge package evidence. */
async function analyzeSite(target, options = {}) {
  throwIfAborted(options.signal);
  const pages = [];
  let pagesScanned = 0;
  let pageAnalysisOptions = options;
  let sharedRegistryCache = null;
  console.log('[debun-plus:analysis] site scan started', { url: String(target) });
  if (options.debunPlus) {
    const { createRegistryClient, createSqliteCache } = require('../dist/src/debun-plus');
    const registryConcurrency = Math.max(1, Math.min(8, Number(options.registryConcurrency || options.debunPlusOptions?.concurrency) || 4));
    sharedRegistryCache = createSqliteCache(options.debunPlusOptions?.databasePath);
    const sharedRegistry = createRegistryClient({
      cache: sharedRegistryCache,
      timeoutMs: options.registryTimeoutMs || options.debunPlusOptions?.registryTimeoutMs,
      concurrency: registryConcurrency,
    });
    pageAnalysisOptions = {
      ...options,
      debunPlusOptions: {
        ...options.debunPlusOptions,
        cache: sharedRegistryCache,
        registry: sharedRegistry,
        concurrency: registryConcurrency,
      },
    };
    console.log('[debun-plus:analysis] shared site registry cache enabled', { registryConcurrency });
  }
  const emitProgress = async (event) => {
    if (options.signal?.aborted) return;
    if (typeof options.onProgress !== 'function') return;
    try {
      await options.onProgress(event);
    } catch (_) {
      /* A disconnected progress client should not interrupt the scan. */
    }
  };
  await emitProgress({
    type: 'progress',
    pagesScanned: 0,
    pagesAttempted: 0,
    totalPages: 1,
    stageLabel: 'Opening submitted URL…',
  });
  let crawl;
  try {
    crawl = await crawlSiteWithMdream(target, {
      ...pageAnalysisOptions,
      onCrawlProgress: (state = {}) => emitProgress({
        type: 'progress',
        pagesScanned,
        pagesAttempted: pages.length,
        totalPages: Math.max(Number(state.pagesQueued) || 0, pages.length, 1),
        currentUrl: state.currentUrl,
        stageLabel: state.stageLabel,
      }),
      onPageScanned: async (renderedPage, crawlState) => {
        throwIfAborted(options.signal);
        const page = await scanRenderedPage(renderedPage, pageAnalysisOptions);
        throwIfAborted(options.signal);
        pages.push(page);
        if (page.scanCompleted) pagesScanned++;
        console.log('[debun-plus:analysis] page scan finished', {
          url: page.finalUrl || page.url,
          status: page.status,
          scanCompleted: page.scanCompleted,
          packages: page.packageCount,
          errors: page.errors || [],
        });
        await emitProgress({
          type: 'progress',
          pagesScanned,
          pagesAttempted: pages.length,
          totalPages: Math.max(crawlState.pagesQueued, pages.length),
          currentUrl: page.finalUrl || page.url,
          title: page.title,
          scanCompleted: page.scanCompleted,
        });
        return page;
      },
    });
    throwIfAborted(options.signal);
  } finally {
    sharedRegistryCache?.close?.();
  }
  console.log('[debun-plus:analysis] crawl finished', {
    url: crawl.requestedUrl || String(target),
    pagesVisited: pages.length,
    pagesScanned,
    pagesQueued: crawl.pagesQueued,
    stoppedReason: crawl.stoppedReason || null,
  });
  throwIfAborted(options.signal);
  pages.sort((left, right) => Number(right.finalUrl === crawl.dashboardUrl) - Number(left.finalUrl === crawl.dashboardUrl));
  await emitProgress({ type: 'complete', pagesScanned, pagesAttempted: pages.length, totalPages: pages.length });

  const packageEvidence = [];
  const foundOn = new Map();
  for (const page of pages) {
    for (const pkg of page.packages) {
      if (pkg.ecosystem === 'WordPress') continue;
      const key = normalizeKey(pkg.name);
      if (!foundOn.has(key)) foundOn.set(key, new Set());
      foundOn.get(key).add(page.finalUrl);
      for (const evidence of pkg.evidence || []) {
        packageEvidence.push({ name: pkg.name, version: evidence.version, declaredRange: evidence.declaredRange, signal: evidence.signal, detail: evidence.detail, scope: pkg.declared ? 'dependency' : 'library' });
      }
    }
  }

  const detectedPackages = mergeEvidence(packageEvidence).map((pkg) => ({
    ...pkg,
    foundOn: [...(foundOn.get(pkg.name) || [])],
    pagesFound: (foundOn.get(pkg.name) || new Set()).size,
  }));
  const wordpressPackages = [];
  for (const page of pages) for (const pkg of page.packages || []) {
    if (pkg.ecosystem === 'WordPress' && !wordpressPackages.some((item) => item.componentType === pkg.componentType && item.slug === pkg.slug)) wordpressPackages.push(pkg);
  }
  const packages = await enrichVulnerabilities([...detectedPackages, ...wordpressPackages], { signal: options.signal });
  const verifiedPackageNames = new Set(packages.map((pkg) => normalizeKey(pkg.name)));
  const packageLeadMap = new Map();
  for (const page of pages) for (const lead of page.packageLeads || []) {
    const key = normalizeKey(lead.name);
    if (verifiedPackageNames.has(key)) continue;
    if (!packageLeadMap.has(key)) packageLeadMap.set(key, { ...lead, pagesSeen: [] });
    const current = packageLeadMap.get(key);
    current.confidence = Math.max(current.confidence || 0, lead.confidence || 0);
    current.evidence = [...new Map([...current.evidence, ...(lead.evidence || [])].map((item) => [`${item.source}:${item.detail}`, item])).values()];
    if (page.finalUrl && !current.pagesSeen.includes(page.finalUrl)) current.pagesSeen.push(page.finalUrl);
  }
  const packageLeads = [...packageLeadMap.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  const firstPagePackages = new Set((pages[0]?.packages || []).map((pkg) => normalizeKey(pkg.name)));
  const newlyDiscovered = packages.filter((pkg) => !firstPagePackages.has(pkg.name));
  const declaredDependencies = Object.assign({}, ...pages.map((page) => page.declaredDependencies || {}));

  const scanCompleted = pages.some((page) => page.scanCompleted);
  const framework = pages[0]?.framework || 'unknown';
  const bundler = pages[0]?.bundler || 'unknown';
  const technologyByKey = new Map();
  for (const page of pages) for (const tech of page.technologyStack || []) {
    const key = `${tech.category}\0${tech.name}`;
    if (!technologyByKey.has(key)) technologyByKey.set(key, { ...tech, evidence: [...(tech.evidence || [])] });
    else {
      const existing = technologyByKey.get(key);
      existing.confidence = Math.max(existing.confidence || 0, tech.confidence || 0);
      existing.evidence = [...new Set([...existing.evidence, ...(tech.evidence || [])])];
    }
  }
  const technologyStack = [...technologyByKey.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const assetsDiscovered = pages.reduce((sum, page) => sum + (Number(page.assetsDiscovered) || 0), 0);
  const scriptsDiscovered = pages.reduce((sum, page) => sum + (Number(page.scriptsDiscovered) || 0), 0);
  const dashboardChecked = pages[0]?.dashboardChecked === true;
  // Framework and bundler are descriptive metadata, not scan eligibility
  // requirements. Any successfully rendered destination root can produce a report.
  const reportEligible = pages[0]?.scanCompleted === true;
  const reportReason = reportEligible
    ? undefined
    : !dashboardChecked
      ? `No JSON report was produced because the dashboard check could not complete. ${crawl.stoppedReason || pages[0]?.errors?.join(' ') || 'The destination root was not available.'}`
      : pages[0]?.errors?.join(' ') || 'No JSON report was produced because the destination root could not be scanned successfully.';
  const reason = scanCompleted
    ? undefined
    : pages.find((page) => page.errors?.length)?.errors.join(' ')
      || crawl.stoppedReason
      || 'No pages could be rendered, so package analysis did not complete.';

  const dashboardScan = {
    websiteUrl: crawl.dashboardUrl || crawl.requestedUrl || String(target),
    finalUrl: pages[0]?.finalUrl || crawl.finalUrl || String(target),
    title: pages[0]?.title || null,
    status: pages[0]?.status ?? 0,
    framework,
    bundler,
    technologyStack,
    assetsDiscovered,
    scriptsDiscovered,
    detectionReason: pages[0]?.frameworkReason || null,
    checked: dashboardChecked,
    reason: reportEligible ? null : reportReason,
  };
  const report = reportEligible ? {
    websiteUrl: crawl.requestedUrl || String(target),
    finalUrl: crawl.finalUrl || pages[0].finalUrl,
    framework,
    bundler,
    technologies: technologyStack,
    packageLeads,
    assetsDiscovered,
    scriptsDiscovered,
    pagesScanned: pages.filter((page) => page.scanCompleted === true).length,
    totalDependencies: packages.length,
    dependencies: packages.map((pkg) => ({ name: pkg.name, version: pkg.version || 'unknown' })),
    vulnerabilities: packages.flatMap((pkg) => (pkg.vulnerabilities || []).map((vulnerability) => ({
      package: pkg.name,
      version: pkg.version || 'unknown',
      ecosystem: pkg.ecosystem || 'npm',
      status: pkg.vulnerabilityStatus,
      ...vulnerability,
    }))),
    vulnerabilitySources: ['OSV.dev', 'WPVulnerability'],
  } : null;
  console.log('[debun-plus:analysis] report status', {
    url: crawl.requestedUrl || String(target),
    eligible: reportEligible,
    totalDependencies: packages.length,
    reason: reportReason || null,
  });

  return {
    url: crawl.requestedUrl || String(target),
    finalUrl: crawl.finalUrl || pages[0]?.finalUrl || String(target),
    scanMode: options.scanMode === 'shallow' ? 'shallow' : 'deep',
    fetchedAt: new Date().toISOString(),
    crawler: 'browser',
    scanCompleted,
    framework,
    bundler,
    technologyStack,
    assetsDiscovered,
    scriptsDiscovered,
    dashboardScan,
    reportEligible,
    reportReason,
    report,
    ...(reason ? { reason } : {}),
    crawl: {
      pagesVisited: pages.length,
      linksDiscovered: crawl.discoveredCount,
      pagesQueued: crawl.pagesQueued,
      maxPages: crawl.maxPages,
      maxDepth: crawl.maxDepth,
      maxLinksPerPage: crawl.maxLinksPerPage,
      delayBetweenPagesMs: crawl.delayMs,
      stoppedReason: crawl.stoppedReason,
      warnings: crawl.warnings,
    },
    pages: pages.map(({ packages: pagePackages, declaredDependencies: _declared, ...page }) => ({ ...page, packageNames: pagePackages.map((pkg) => pkg.name) })),
    initialPackages: pages[0]?.packages || [],
    newlyDiscovered,
    packageCount: packages.length,
    packages,
    packageLeads,
    declaredDependencies,
  };
}

module.exports = { analyzeSite };
