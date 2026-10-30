'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');
const { normalizeUrl, resolveUrl } = require('./util/url');
const { fetchDocument, fetchText, mapPool } = require('./fetch');
const { extractFromHtml } = require('./extract');
const { classifyTechnology } = require('./browser');
const { detectTechnologyStack } = require('./technology-stack');
const { throwIfAborted, isAbortError, raceWithSignal } = require('./util/abort');

const DEFAULT_MAX_PAGE_SCRIPTS = 60;
const MAX_PAGE_SCRIPTS = 60;
const MAX_SINGLE_SCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_EXTERNAL_SCRIPT_BYTES = 24 * 1024 * 1024;
const MAX_INLINE_SCRIPT_BYTES = 2 * 1024 * 1024;

/** Keep the code sent to CPU-heavy recognizers within a per-page budget. */
function applyScriptBudget(externalScripts, inlineScripts, options = {}) {
  const maxSingleScriptBytes = Math.max(64 * 1024, Math.min(Number(options.maxScriptBytes) || MAX_SINGLE_SCRIPT_BYTES, MAX_SINGLE_SCRIPT_BYTES));
  const maxExternalBytes = Math.max(256 * 1024, Math.min(Number(options.maxExternalScriptBytes) || MAX_EXTERNAL_SCRIPT_BYTES, MAX_EXTERNAL_SCRIPT_BYTES));
  const maxInlineBytes = Math.max(64 * 1024, Math.min(Number(options.maxInlineScriptBytes) || MAX_INLINE_SCRIPT_BYTES, MAX_INLINE_SCRIPT_BYTES));
  let externalBytes = 0;
  let inlineBytes = 0;
  let skippedExternal = 0;
  let skippedInline = 0;
  const acceptedExternal = [];
  const acceptedInline = [];

  for (const script of externalScripts) {
    const bytes = Buffer.byteLength(script.code || '');
    if (bytes > maxSingleScriptBytes || externalBytes + bytes > maxExternalBytes) {
      skippedExternal++;
      continue;
    }
    acceptedExternal.push(script);
    externalBytes += bytes;
  }
  for (const script of inlineScripts) {
    const bytes = Buffer.byteLength(script.content || '');
    if (bytes > maxInlineBytes || inlineBytes + bytes > maxInlineBytes) {
      skippedInline++;
      continue;
    }
    acceptedInline.push(script);
    inlineBytes += bytes;
  }
  return {
    externalScripts: acceptedExternal,
    inlineScripts: acceptedInline,
    externalBytes,
    inlineBytes,
    skippedExternal,
    skippedInline,
  };
}

let browserRuntimePromise;
let mdreamCrawlerPromise;

async function loadBrowserRuntime() {
  browserRuntimePromise ||= Promise.all([import('crawlee'), import('ofetch')])
    .then(([crawlee, fetcher]) => ({
      Configuration: crawlee.Configuration,
      launchPlaywright: crawlee.launchPlaywright,
      ofetch: fetcher.ofetch,
    }));
  return browserRuntimePromise;
}

async function loadMdreamCrawler() {
  mdreamCrawlerPromise ||= Promise.all([import('@mdream/crawl'), loadBrowserRuntime()])
    .then(([module, browserRuntime]) => ({ ...browserRuntime, module }));
  const runtime = await mdreamCrawlerPromise;
  const { module, Configuration } = runtime;
  if (typeof module.crawlAndGenerate !== 'function') {
    throw new Error('@mdream/crawl does not export crawlAndGenerate().');
  }
  return {
    crawlAndGenerate: module.crawlAndGenerate,
    Configuration,
    launchPlaywright: runtime.launchPlaywright,
    ofetch: runtime.ofetch,
  };
}

function createIsolatedCrawlerConfiguration(Configuration, storageDirectory) {
  return new Configuration({
    // The environment can override top-level Crawlee options. Supplying the
    // storage client option as well keeps each crawl away from a shared
    // filesystem store, even when CRAWLEE_PERSIST_STORAGE=true is set.
    persistStorage: false,
    storageClientOptions: {
      localDataDirectory: storageDirectory,
      persistStorage: false,
    },
  });
}

function logCrawlerError(stage, error, details = {}) {
  console.log('[debun-plus:crawl] error', {
    stage,
    ...details,
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

function hasNonRetryableNetworkCause(error) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = String(current.code || current.errno || '').toUpperCase();
    if (/^(EACCES|EPERM|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|ERR_NAME_NOT_RESOLVED)$/.test(code)) return true;
    current = current.cause;
  }
  return false;
}

function isRetryableBrowserNavigationError(error) {
  if (hasNonRetryableNetworkCause(error)) return false;
  const message = String(error?.message || error || '');
  // Only retry fast transport resets. A page timeout is already a full
  // navigation budget and repeating it would make inaccessible sites stall.
  if (/timeout|timed out|ERR_ABORTED/i.test(message)) return false;
  return /ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED|ECONNRESET|EAI_AGAIN|UND_ERR_SOCKET|socket hang up/i.test(message);
}

/**
 * Retry a failed browser navigation through independent HTTP transports.
 * Some hosts close headless-browser connections and Undici reports that as a
 * generic `fetch failed`; Axios is a separate transport and can still retrieve
 * the document. Keep this fallback bounded to the dashboard/page being opened.
 */
async function fetchNavigationHtml(url, ofetch, options = {}) {
  const timeout = Math.max(1000, Number(options.timeout) || 15000);
  let fetchError;
  try {
    const response = await ofetch.raw(url, {
      responseType: 'text',
      retry: 1,
      retryDelay: 300,
      timeout,
      signal: options.signal,
    });
    const html = String(response._data ?? '');
    if (response.status >= 400) throw new Error(`HTTP ${response.status} while fetching ${url}.`);
    if (!html.trim()) throw new Error(`The HTTP fallback returned an empty document for ${url}.`);
    return {
      finalUrl: response.url || url,
      status: response.status || 200,
      html,
      transport: 'undici',
      headers: response.headers || {},
    };
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    fetchError = error;
    logCrawlerError('undici-navigation-fallback', error, { url });
  }

  try {
    const response = await fetchDocument(url, {
      timeout,
      signal: options.signal,
      maxBytes: options.maxDocumentBytes,
      headers: {
        'User-Agent': options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}.`);
    if (!response.body.trim()) throw new Error(`The HTTP fallback returned an empty document for ${url}.`);
    console.log('[debun-plus:crawl] navigation recovered with Axios', {
      requestedUrl: url,
      finalUrl: response.finalUrl,
      status: response.status,
      htmlBytes: Buffer.byteLength(response.body),
    });
    return {
      finalUrl: response.finalUrl || url,
      status: response.status,
      html: response.body,
      transport: 'axios',
      headers: response.headers || {},
    };
  } catch (axiosError) {
    if (isAbortError(axiosError, options.signal)) throw axiosError;
    logCrawlerError('axios-navigation-fallback', axiosError, { url });
    throw new Error(
      `Browser navigation and HTTP fallbacks could not retrieve ${url}. ` +
      `Fetch fallback: ${fetchError?.message || 'failed'}. Axios fallback: ${axiosError?.message || 'failed'}.`
    );
  }
}

async function gotoWithTransientRetry(page, url, gotoOptions) {
  const navigate = async () => {
    const response = await page.goto(url, gotoOptions);
    // Crawlee/Playwright can surface a socket reset as a synthetic 595
    // response instead of throwing net::ERR_EMPTY_RESPONSE.
    if (response?.status() === 595) {
      const error = new Error(`net::ERR_EMPTY_RESPONSE while opening ${url}.`);
      error.code = 'ERR_EMPTY_RESPONSE';
      throw error;
    }
    return response;
  };
  try {
    return await navigate();
  } catch (error) {
    if (!isRetryableBrowserNavigationError(error)) throw error;
    console.log('[debun-plus:crawl] transient browser navigation failure; retrying once', {
      url,
      message: error?.message || String(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return navigate();
  }
}

function pageKey(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.searchParams.sort();
    return url.toString();
  } catch (_) {
    return String(value || '');
  }
}

function uniqueUnscannedLinks(links, scannedKeys) {
  const seen = new Set();
  const pending = [];
  for (const link of links || []) {
    const key = pageKey(link);
    if (!key || scannedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    pending.push(link);
  }
  return pending;
}

function statusFromError(error) {
  const match = String(error || '').match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : 0;
}

function parseRobots(text) {
  const groups = [];
  let group = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (key === 'allow' || key === 'disallow')) {
      if (value) group.rules.push({ allow: key === 'allow', path: value });
      group.hasRules = true;
    }
  }
  const matching = groups.filter((entry) => entry.agents.includes('page-deps'));
  const selected = matching.length ? matching : groups.filter((entry) => entry.agents.includes('*'));
  return selected.flatMap((entry) => entry.rules);
}

function sitemapUrlsFromRobots(text) {
  return String(text || '').split(/\r?\n/)
    .map((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1])
    .filter(Boolean);
}

async function discoverSitemapLinks(siteUrl, robotsText, rules, ofetch, options = {}) {
  const site = new URL(siteUrl);
  const seeds = [...new Set([...sitemapUrlsFromRobots(robotsText), new URL('/sitemap.xml', site).toString()])]
    .filter((candidate) => {
      try { return new URL(candidate).origin === site.origin; } catch (_) { return false; }
    });
  const visited = new Set();
  const pages = new Set();
  const queue = seeds.slice(0, 4);
  while (queue.length && visited.size < 4 && pages.size < 200) {
    throwIfAborted(options.signal);
    const sitemap = queue.shift();
    if (!sitemap || visited.has(sitemap)) continue;
    visited.add(sitemap);
    try {
      const response = await ofetch.raw(sitemap, {
        responseType: 'text', retry: 0,
        timeout: Math.min(Number(options.sitemapTimeout) || 3000, 5000),
        signal: options.signal,
      });
      if (response.status < 200 || response.status >= 300) continue;
      const sitemapBody = String(response._data || '');
      const $ = cheerio.load(sitemapBody, { xmlMode: true });
      const locations = $('loc').toArray().map((node) => $(node).text().trim()).filter(Boolean);
      const isSitemapIndex = /<sitemapindex\b/i.test(sitemapBody);
      for (const location of locations) {
        let absolute;
        try { absolute = normalizeUrl(location).toString(); } catch (_) { continue; }
        const url = new URL(absolute);
        if (url.origin !== site.origin || !['http:', 'https:'].includes(url.protocol)) continue;
        if (isSitemapIndex || /sitemap(?:[-_\d]*)\.xml(?:\.gz)?$/i.test(url.pathname)) {
          if (!visited.has(absolute) && queue.length < 4) queue.push(absolute);
          continue;
        }
        if (isAllowedByRobots(`${url.pathname}${url.search}`, rules)) pages.add(absolute);
        if (pages.size >= 200) break;
      }
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      console.log('[debun-plus:crawl] sitemap fetch skipped', { url: sitemap, message: error?.message || String(error) });
    }
  }
  return [...pages];
}

function isAllowedByRobots(pathname, rules) {
  let winner = null;
  for (const rule of rules) {
    const anchored = rule.path.endsWith('$');
    const rawPath = anchored ? rule.path.slice(0, -1) : rule.path;
    if (!rawPath) continue;
    const escaped = rawPath.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*');
    if (!new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(pathname)) continue;
    if (!winner || rawPath.length > winner.path.length ||
      (rawPath.length === winner.path.length && rule.allow && !winner.allow)) {
      winner = { allow: rule.allow, path: rawPath };
    }
  }
  return !winner || winner.allow;
}

function htmlText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isChallengePage(html, title) {
  return /access denied|request blocked|403 forbidden|http error 403|verify (?:that )?you are human|checking your browser|security challenge|unusual traffic|captcha|just a moment/i
    .test(`${title || ''}\n${htmlText(html).slice(0, 5000)}`);
}

function runtimeMarkers(html) {
  const source = String(html || '');
  return {
    nextData: /id=["']__NEXT_DATA__["']/i.test(source),
    nextRoot: /id=["']__next["']/i.test(source),
    bundlerGlobals: [],
    nextFlight: /__next_f\.push|self\.__next_f/i.test(source),
    nextScripts: [...source.matchAll(/(?:src|href)=["']([^"']*\/_next\/[^"']*)["']/gi)].map((match) => match[1]),
    nextAssets: [...source.matchAll(/(?:src|href)=["']([^"']*\/_next\/[^"']*)["']/gi)].map((match) => match[1]),
    nuxt: /__NUXT__|data-nuxt-app|data-nuxt-data/i.test(source),
    gatsby: /___gatsby|gatsby-/.test(source),
    remix: /__remixContext|data-remix-run/.test(source),
    angular: /ng-version=|ɵɵdefineComponent|zone\.js/i.test(source),
    react: /data-reactroot|__reactFiber\$|__reactContainer\$/i.test(source),
    vue: /__VUE__|data-v-app|__vue_app__/i.test(source),
    svelteKit: /data-sveltekit-(?:preload-data|hydrate)|__sveltekit/i.test(source),
    svelte: /data-svelte-h|class=["'][^"']*svelte-/i.test(source),
    astro: /<astro-island\b/i.test(source),
    webflow: /data-wf-(?:page|site)|\/webflow(?:\.min)?\.js/i.test(source),
  };
}

function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async (work) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function capturePageScripts(page, limit = DEFAULT_MAX_PAGE_SCRIPTS) {
  const sources = new Map();
  const tasks = new Set();
  const maxScripts = Math.max(1, Math.min(Number(limit) || DEFAULT_MAX_PAGE_SCRIPTS, MAX_PAGE_SCRIPTS));
  const onResponse = (response) => {
    const task = (async () => {
      try {
        const request = response.request();
        if (request.resourceType() !== 'script') return;
        const url = response.url();
        if (!url || sources.has(url) || sources.size >= maxScripts) return;
        let timer;
        const code = await Promise.race([
          response.text(),
          new Promise((resolve) => { timer = setTimeout(() => resolve(''), 2500); }),
        ]).finally(() => clearTimeout(timer));
        if (!code) return;
        sources.set(url, { url, code, contentType: response.headers()['content-type'] || '' });
      } catch (_) {
        /* A script may be canceled or unreadable; other sources still count. */
      }
    })();
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  };
  page.on('response', onResponse);
  return {
    sources,
    async settle() { await Promise.allSettled([...tasks]); },
    dispose() { page.off('response', onResponse); },
  };
}

async function waitForRemainingPageScripts(page, capture, options = {}) {
  const maxWait = Math.max(0, Math.min(Number(options.scriptCaptureGraceMs) || 0, 2500));
  if (!maxWait) return;
  const expected = await page.locator('script[src]').count().catch(() => 0);
  const maxScripts = Math.max(1, Math.min(Number(options.maxScripts) || DEFAULT_MAX_PAGE_SCRIPTS, MAX_PAGE_SCRIPTS));
  if (capture.sources.size >= Math.min(expected, maxScripts)) return;
  await page.waitForTimeout(maxWait).catch(() => {});
  await capture.settle();
}

function extractPageLinks(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const links = new Set();
  $('a[href]').each((_, element) => {
    const url = resolveUrl(baseUrl, $(element).attr('href'));
    if (url) links.add(url);
  });
  return [...links];
}

async function waitForRenderedDom(page, url, loadTimeout, idleTimeout, signal, options = {}) {
  throwIfAborted(signal);
  try {
    await page.waitForLoadState('load', { timeout: loadTimeout });
  } catch (error) {
    if (!/timeout/i.test(error?.message || '')) throw error;
    console.log('[debun-plus:crawl] page load wait reached its limit; reading current DOM', {
      url,
      waitMs: loadTimeout,
    });
  }

  if (options.waitForNetworkIdle === false) {
    const settleMs = Math.max(0, Math.min(Number(options.renderSettleMs ?? 120) || 0, 500));
    if (settleMs) await page.waitForTimeout(settleMs);
    throwIfAborted(signal);
    return;
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: idleTimeout });
  } catch (error) {
    if (!/timeout/i.test(error?.message || '')) throw error;
    console.log('[debun-plus:crawl] network did not become idle; continuing with the loaded DOM', {
      url,
      waitMs: idleTimeout,
    });
  }
  throwIfAborted(signal);
  const settleMs = Math.max(0, Math.min(Number(options.renderSettleMs ?? 250), 1000));
  if (settleMs) await page.waitForTimeout(settleMs);
  throwIfAborted(signal);
}

function createBrowserHtmlRenderer(launchPlaywright, ofetch, options = {}) {
  const timeout = Math.max(1000, Number(options.timeout) || 15000);
  const loadTimeout = Math.min(timeout, Math.max(1000, Number(options.renderLoadTimeout) || 6000));
  const idleTimeout = Math.min(2500, Math.max(500, Number(options.renderIdleTimeout) || 1500));
  const limit = createLimiter(Math.max(1, Math.min(Number(options.renderConcurrency) || 3, 5)));
  const activePages = new Set();
  let browserPromise;
  let closePromise;

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      for (const page of activePages) await page.close().catch(() => {});
      if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        await browser?.close().catch(() => {});
        browserPromise = null;
      }
    })();
    return closePromise;
  }

  async function openPage() {
    throwIfAborted(options.signal);
    const browser = await (browserPromise ||= launchPlaywright({ useChrome: true }));
    throwIfAborted(options.signal);
    const page = await browser.newPage();
    activePages.add(page);
    return page;
  }

  const render = (value, sourceHtml) => limit(async () => {
    const url = normalizeUrl(value).toString();
    const page = await openPage();
    const scriptCapture = capturePageScripts(page, options.maxScripts);
    let sourceServed = false;

    try {
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (!sourceServed && request.isNavigationRequest() && request.frame() === page.mainFrame() && pageKey(request.url()) === pageKey(url)) {
          sourceServed = true;
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: String(sourceHtml || ''),
          });
          return;
        }
        await route.continue();
      });

      // The document HTML is already available from Mdream. Waiting for
      // DOMContentLoaded here can hang on a blocked third-party script even
      // though the page itself is fully available for inspection.
      const response = await page.goto(url, { waitUntil: 'commit', timeout: Math.min(timeout, 5000) });
      if (!sourceServed) throw new Error(`The browser did not receive the rendered HTML for ${url}.`);

      await waitForRenderedDom(page, url, loadTimeout, idleTimeout, options.signal, options);
      await waitForRemainingPageScripts(page, scriptCapture, options);
      await scriptCapture.settle();

      const rendered = {
        url: normalizeUrl(page.url()).toString(),
        status: response?.status() || 200,
        headers: response?.headers?.() || {},
        title: await page.title(),
        html: await page.content(),
        externalScripts: [...scriptCapture.sources.values()],
      };
      console.log('[debun-plus:crawl] browser render complete', {
        url: rendered.url,
        status: rendered.status,
        htmlBytes: Buffer.byteLength(rendered.html),
      });
      return rendered;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      logCrawlerError('render-page', error, { url });
      throw error;
    } finally {
      scriptCapture.dispose();
      activePages.delete(page);
      await page.close().catch(() => {});
    }
  });

  const renderLive = (value) => limit(async () => {
    const requestedUrl = normalizeUrl(value).toString();
    let navigationUrl = requestedUrl;
    let suppliedHtml = null;
    let navigationHeaders = {};
    let sourceServed = false;
    const page = await openPage();
    const scriptCapture = capturePageScripts(page, options.maxScripts);
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);

    try {
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (suppliedHtml !== null && !sourceServed && request.isNavigationRequest() && request.frame() === page.mainFrame() && pageKey(request.url()) === pageKey(navigationUrl)) {
          sourceServed = true;
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: suppliedHtml });
          return;
        }
        await route.continue();
      });

      let response;
      try {
        response = await gotoWithTransientRetry(page, requestedUrl, { waitUntil: 'commit', timeout: Math.min(timeout, 8000) });
        navigationHeaders = response?.headers?.() || {};
        if (response && response.status() >= 500) {
          throw new Error(`The browser received HTTP ${response.status()} while opening ${requestedUrl}.`);
        }
      } catch (navigationError) {
        if (isAbortError(navigationError, options.signal)) throw navigationError;
        throwIfAborted(options.signal);
        logCrawlerError('direct-browser-navigation', navigationError, { url: requestedUrl });
        const fetched = await fetchNavigationHtml(requestedUrl, ofetch, { timeout, userAgent, signal: options.signal });
        throwIfAborted(options.signal);
        navigationUrl = normalizeUrl(fetched.finalUrl || requestedUrl).toString();
        navigationHeaders = fetched.headers || {};
        const $ = cheerio.load(fetched.html);
        $('head').prepend($('<base>').attr('href', navigationUrl));
        suppliedHtml = $.html();
        // The failed live navigation may be waiting on a script or response
        // that never completes. Navigating to the same URL again while
        // fulfilling its document through a route repeats that failure. Load
        // the successfully fetched document directly into the existing page;
        // `commit` returns as soon as Playwright installs the HTML, even if a
        // remote subresource later stalls.
        response = null;
        await page.setContent(suppliedHtml, { waitUntil: 'commit', timeout: Math.min(timeout, 5000) });
      }

      await waitForRenderedDom(page, navigationUrl, loadTimeout, idleTimeout, options.signal, options);
      await waitForRemainingPageScripts(page, scriptCapture, options);
      await scriptCapture.settle();
      const rendered = {
        url: normalizeUrl(suppliedHtml !== null ? navigationUrl : page.url()).toString(),
        status: response?.status() || 200,
        headers: navigationHeaders,
        title: await page.title(),
        html: await page.content(),
        externalScripts: [...scriptCapture.sources.values()],
      };
      console.log('[debun-plus:crawl] direct browser render complete', {
        url: rendered.url,
        status: rendered.status,
        htmlBytes: Buffer.byteLength(rendered.html),
      });
      return rendered;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      logCrawlerError('direct-browser-render', error, { url: requestedUrl });
      throw error;
    } finally {
      scriptCapture.dispose();
      activePages.delete(page);
      await page.close().catch(() => {});
    }
  });

  const renderer = {
    render,
    renderLive,
    close,
  };
  if (options.signal) options.signal.addEventListener('abort', () => { void renderer.close(); }, { once: true });
  return renderer;
}

function createScriptLoader(options) {
  // Keep bundle retrieval bounded per page. A site with many stalled script
  // URLs should not turn 60 sequential 15-second timeouts into a five-minute
  // dashboard wait.
  const timeout = Math.max(1000, Math.min(Number(options.scriptTimeout) || 3000, 4000));
  const cache = new Map();
  const concurrency = Math.max(1, Math.min(Number(options.scriptConcurrency) || 8, 8));
  const limit = createLimiter(concurrency);

  return async (script) => {
    throwIfAborted(options.signal);
    if (cache.has(script.url)) return cache.get(script.url);
    const pending = limit(async () => {
      throwIfAborted(options.signal);
      const response = await fetchText(script.url, { timeout, maxBytes: MAX_SINGLE_SCRIPT_BYTES, signal: options.signal });
      return response && response.text
        ? { url: response.url || script.url, code: response.text, contentType: response.contentType || '' }
        : null;
    });
    cache.set(script.url, pending);
    return pending;
  };
}

async function makeRenderedPage(pageData, depth, loadScript, options = {}) {
  throwIfAborted(options.signal);
  const url = normalizeUrl(pageData.url).toString();
  const html = String(pageData.html || '');
  const extracted = extractFromHtml(html, url);
  const maxScripts = Math.max(1, Math.min(Number(options.maxScripts) || DEFAULT_MAX_PAGE_SCRIPTS, MAX_PAGE_SCRIPTS));
  const scriptConcurrency = Math.max(1, Math.min(Number(options.scriptConcurrency) || 8, 8));
  const capturedScripts = (pageData.externalScripts || []).slice(0, maxScripts);
  const capturedKeys = new Set(capturedScripts.map((source) => pageKey(source.url)));
  const missingScripts = extracted.scripts.filter((script) => !capturedKeys.has(pageKey(script.url)));
  const scripts = missingScripts.slice(0, Math.max(0, maxScripts - capturedScripts.length));
  const scriptFetchStartedAt = Date.now();
  console.log('[debun-plus:crawl] collecting page scripts', {
    url,
    scriptCount: capturedScripts.length + scripts.length,
    maxScripts,
    scriptConcurrency,
    scriptTimeoutMs: Math.max(1000, Math.min(Number(options.scriptTimeout) || 3000, 4000)),
  });
  const fetchedScripts = (await mapPool(scripts, scriptConcurrency, loadScript, { signal: options.signal }))
    .filter(Boolean);
  throwIfAborted(options.signal);
  const scriptBudget = applyScriptBudget([...capturedScripts, ...fetchedScripts], extracted.inlineScripts, options);
  console.log('[debun-plus:crawl] page script collection finished', {
    url,
    scriptsRequested: capturedScripts.length + scripts.length,
    scriptsFetched: capturedScripts.length + fetchedScripts.filter((entry) => !entry.error).length,
    scriptsAnalyzed: scriptBudget.externalScripts.length,
    inlineScriptsAnalyzed: scriptBudget.inlineScripts.length,
    scriptBytesAnalyzed: scriptBudget.externalBytes + scriptBudget.inlineBytes,
    scriptsSkippedByBudget: scriptBudget.skippedExternal + scriptBudget.skippedInline,
    durationMs: Date.now() - scriptFetchStartedAt,
  });
  const title = pageData.title || extracted.meta.title || null;
  const challenge = isChallengePage(html, title);
  const technology = classifyTechnology(runtimeMarkers(html), scriptBudget.externalScripts, html);
  const technologyStack = detectTechnologyStack({
    html,
    urls: [...scriptBudget.externalScripts.map((source) => source.url), ...extracted.assets],
    headers: pageData.headers || options.responseHeaders || {},
  });

  return {
    url,
    finalUrl: url,
    depth,
    status: Number(pageData.status) || (html ? 200 : 0),
    html,
    externalScripts: scriptBudget.externalScripts,
    inlineScripts: scriptBudget.inlineScripts,
    scriptBudget,
    technology,
    technologyStack,
    assetCount: extracted.scripts.length + extracted.assets.length + capturedScripts.length,
    scriptsDiscovered: Math.max(extracted.scripts.length, capturedScripts.length),
    headers: pageData.headers || options.responseHeaders || {},
    title,
    links: pageData.metadata?.links || [],
    linksFound: pageData.metadata?.links?.length || 0,
    challenge,
    scanBlocked: challenge,
    error: html ? undefined : 'The rendered page did not contain HTML.',
    isDashboard: false,
  };
}

function makeFailedPage(url, error, depth, isDashboard) {
  const status = statusFromError(error);
  return {
    url,
    finalUrl: url,
    depth,
    status,
    error: error || 'The page could not be rendered.',
    html: '',
    externalScripts: [],
    inlineScripts: [],
    technology: { framework: 'unknown', bundler: 'unknown', reason: 'The rendered page could not be inspected.' },
    title: null,
    links: [],
    linksFound: 0,
    challenge: false,
    scanBlocked: status === 403 || status === 429 || status >= 500,
    isDashboard,
  };
}

async function crawlSiteWithMdream(startUrl, options = {}) {
  throwIfAborted(options.signal);
  const requestedUrl = normalizeUrl(startUrl).toString();
  let runtime;
  try {
    runtime = options.singlePageOnly
      ? await loadBrowserRuntime()
      : await loadMdreamCrawler();
  } catch (error) {
    logCrawlerError('load-crawler-runtime', error, { requestedUrl });
    throw error;
  }
  const { crawlAndGenerate, Configuration, launchPlaywright, ofetch } = runtime;
  const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 25, 100));
  const maxDepth = Math.max(0, Math.min(Number(options.maxDepth ?? 1), 10));
  const maxLinksPerPage = Math.max(1, Math.min(Number(options.maxLinksPerPage) || 24, 100));
  const timeout = Math.max(1000, Number(options.timeout) || 15000);
  // @mdream/crawl's HTTP driver currently uses a fixed concurrency of 20.
  // Keep each call to a small explicit batch so public sites do not receive a
  // burst of requests when the root page exposes many links.
  const crawlConcurrency = Math.max(1, Math.min(Number(options.crawlConcurrency) || 2, 3));
  const crawlDelay = Math.max(0, Number(options.requestDelayMs ?? 500)) / 1000;
  const loadScript = createScriptLoader(options);
  const warnings = [];
  const foundKeys = new Set();
  const scannedKeys = new Set();
  const pages = [];
  let pagesClaimed = 0;
  const crawlResults = [];
  const discoveredLinks = new Set();
  let progressState = { crawling: { total: 0, processed: 0, failed: 0 } };
  let maxPagesQueued = 0;
  let robotsRules = [];
  let robotsText = '';
  let followLinks = true;
  let finalUrl = requestedUrl;
  let dashboardUrl = new URL('/', requestedUrl).toString();
  let resolvedPageData = null;
  let rootResponseHeaders = {};

  const reportCrawlProgress = (state = {}) => {
    if (options.signal?.aborted) return;
    if (typeof options.onCrawlProgress !== 'function') return;
    try {
      const pending = options.onCrawlProgress(state);
      pending?.catch?.((error) => logCrawlerError('progress-notification', error, { url: state.currentUrl || requestedUrl }));
    } catch (error) {
      logCrawlerError('progress-notification', error, { url: state.currentUrl || requestedUrl });
    }
  };

  console.log('[debun-plus:crawl] scan started', { requestedUrl, maxPages, maxDepth, maxLinksPerPage });
  reportCrawlProgress({
    stageLabel: options.singlePageOnly ? 'Opening submitted page…' : 'Resolving destination…',
    currentUrl: requestedUrl,
    pagesQueued: 1,
  });

  const runCrawl = async (urls, depth, limit, isResolution = false, pageDepthOverride = null) => {
    const pagesClaimedBeforeRun = pagesClaimed;
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-deps-mdream-'));
    const storageDirectory = path.join(outputDir, 'crawlee-storage');
    const crawlConfig = createIsolatedCrawlerConfiguration(Configuration, storageDirectory);
    const renderer = createBrowserHtmlRenderer(launchPlaywright, ofetch, options);
    const renderedPages = new Map();
    const runResults = [];
    const recoverInBrowser = async (failedResult) => {
      throwIfAborted(options.signal);
      const rendered = await renderer.renderLive(failedResult.url);
      throwIfAborted(options.signal);
      const pageUrl = normalizeUrl(rendered.url).toString();
      if (new URL(pageUrl).origin !== new URL(finalUrl).origin) {
        throw new Error(`Browser fallback redirected outside the destination site: ${pageUrl}`);
      }
      if (!rendered.html) throw new Error(`Browser fallback returned no HTML for ${pageUrl}.`);

      const key = pageKey(pageUrl);
      if (scannedKeys.has(key) || pagesClaimed >= maxPages) return false;
      const links = extractPageLinks(rendered.html, pageUrl)
        .slice(0, maxLinksPerPage)
        .filter((link) => {
          try {
            const next = new URL(link);
            return next.origin === new URL(finalUrl).origin &&
              isAllowedByRobots(`${next.pathname}${next.search}`, robotsRules);
          } catch (_) {
            return false;
          }
        });
      const pageData = {
        url: pageUrl,
        status: rendered.status,
        headers: rendered.headers || {},
        title: rendered.title,
        html: rendered.html,
        externalScripts: rendered.externalScripts || [],
        metadata: { title: rendered.title, links },
      };
      for (const link of links) discoveredLinks.add(pageKey(link));

      scannedKeys.add(key);
      foundKeys.add(key);
      const pageOrdinal = ++pagesClaimed;
      const isDashboard = key === pageKey(dashboardUrl);
      const depthForPage = isDashboard ? 0 : (pageDepthOverride ?? Math.min(1, depth));
      const renderedPage = await makeRenderedPage(pageData, depthForPage, loadScript, { ...options, responseHeaders: pageData.headers });
      renderedPage.isDashboard = isDashboard;
      if (renderedPage.challenge) renderedPage.links = [];

      let analysisResult;
      if (typeof options.onPageScanned === 'function') {
        try {
          analysisResult = await options.onPageScanned(renderedPage, {
            pagesVisited: pageOrdinal,
            pagesQueued: Math.max(maxPagesQueued, pageOrdinal),
            maxPages,
            maxDepth: depth,
          });
        } catch (error) {
          logCrawlerError('report-browser-fallback-progress', error, { url: pageUrl });
          warnings.push(`Could not report progress for ${pageUrl}: ${error.message}`);
        }
      }
      pages.push({ renderedPage, analysisResult });
      console.log('[debun-plus:crawl] browser fallback recovered page', {
        url: pageUrl,
        status: renderedPage.status,
        scanCompleted: analysisResult?.scanCompleted ?? false,
      });
      return true;
    };
    console.log('[debun-plus:crawl] crawl started', {
      stage: isResolution ? 'resolve-destination' : 'scan-pages',
      urls,
      depth,
      maxPages: limit,
      storage: 'isolated-memory',
    });
    try {
      throwIfAborted(options.signal);
      // Resolve the submitted URL in Chrome first. This avoids turning a
      // transient HTTP-client failure or ERR_EMPTY_RESPONSE into a failed
      // dashboard check when the browser can still render the destination.
      if (isResolution) {
        const rendered = await renderer.renderLive(urls[0]);
        throwIfAborted(options.signal);
        const resolvedUrl = normalizeUrl(rendered.url).toString();
        const pageData = {
          url: resolvedUrl,
          status: rendered.status,
          headers: rendered.headers || {},
          title: rendered.title,
          html: rendered.html,
          externalScripts: rendered.externalScripts || [],
          metadata: {
            title: rendered.title,
            links: extractPageLinks(rendered.html, resolvedUrl),
          },
        };
        resolvedPageData = pageData;
        rootResponseHeaders = pageData.headers;
        foundKeys.add(pageKey(resolvedUrl));
        console.log('[debun-plus:crawl] page found', { stage: 'resolve-destination', url: resolvedUrl });
        runResults.push({ url: resolvedUrl, title: rendered.title || '', success: true, depth: 0 });
        return runResults;
      }

      // Keep Crawlee's session state isolated from the default ./storage
      // directory. Mdream purges default stores after each run, which can
      // otherwise leave a stale SDK_SESSION_POOL_STATE record behind.
      const plannedPages = Math.min(limit, urls.length);
      maxPagesQueued = Math.max(maxPagesQueued, pagesClaimedBeforeRun + plannedPages);
      for (let offset = 0; offset < plannedPages; offset += crawlConcurrency) {
        const batch = urls.slice(offset, Math.min(offset + crawlConcurrency, plannedPages));
        const crawlPromise = Configuration.storage.run(crawlConfig, () => crawlAndGenerate({
          urls: batch,
          output: outputDir,
          // Mdream's HTTP driver otherwise starts up to 20 page requests at
          // once. Crawl small batches at depth zero; the caller owns link
          // discovery and applies the configured depth and page cap.
          driver: 'http',
          depth: 0,
          maxPages: batch.length,
          crawlDelay,
          skipSitemap: true,
          allowSubdomains: false,
          artifacts: [],
          silent: true,
          hooks: {
          'crawl:html': async (pageContext) => {
            throwIfAborted(options.signal);
            const originalUrl = normalizeUrl(pageContext.url).toString();
            let renderUrl = originalUrl;
            let sourceHtml = pageContext.html;

            // Resolve a submitted short link before selecting the destination
            // root. This extra request is limited to the one-page resolution
            // phase; normal crawl pages reuse Mdream's already-fetched HTML.
            if (isResolution) {
              try {
                const response = await ofetch.raw(originalUrl, {
                  responseType: 'text',
                  retry: 1,
                  retryDelay: 300,
                  timeout,
                  signal: options.signal,
                });
                renderUrl = normalizeUrl(response.url || originalUrl).toString();
                sourceHtml = String(response._data ?? sourceHtml ?? '');
              } catch (error) {
                logCrawlerError('resolve-final-url', error, { url: originalUrl });
              }
            }

            const rendered = await renderer.render(renderUrl, sourceHtml);
            throwIfAborted(options.signal);
            pageContext.html = rendered.html;
            renderedPages.set(pageKey(originalUrl), { ...rendered, url: renderUrl });
          },
          'crawl:page': async (pageData) => {
            throwIfAborted(options.signal);
            const originalPageUrl = normalizeUrl(pageData.url).toString();
            const rendered = renderedPages.get(pageKey(originalPageUrl));
            if (rendered) {
              pageData.url = rendered.url;
              pageData.status = rendered.status;
              pageData.headers = rendered.headers || {};
              pageData.title = rendered.title || pageData.title;
              pageData.externalScripts = rendered.externalScripts || [];
              if (pageData.metadata) {
                pageData.metadata.title = rendered.title || pageData.metadata.title;
                if (pageKey(rendered.url) !== pageKey(originalPageUrl)) {
                  pageData.metadata.links = extractPageLinks(rendered.html, rendered.url);
                }
              }
            }
            const normalizedPageUrl = normalizeUrl(pageData.url).toString();
            const key = pageKey(normalizedPageUrl);
            if (Array.isArray(pageData.metadata?.links)) {
              pageData.metadata.links = pageData.metadata.links.slice(0, maxLinksPerPage);
              if (!isResolution) {
                pageData.metadata.links = pageData.metadata.links.filter((link) => {
                  try {
                    const next = new URL(link);
                    return next.origin === new URL(finalUrl).origin &&
                      isAllowedByRobots(`${next.pathname}${next.search}`, robotsRules);
                  } catch (_) {
                    return false;
                  }
                });
              }
            }

            if (isResolution) {
              if (foundKeys.has(key)) return;
              foundKeys.add(key);
              resolvedPageData = pageData;
              console.log('[debun-plus:crawl] page found', { stage: 'resolve-destination', url: normalizedPageUrl });
              runResults.push({ url: normalizedPageUrl, title: pageData.title || '', success: true, depth: 0 });
              return;
            }

            for (const link of pageData.metadata?.links || []) discoveredLinks.add(pageKey(link));

            if (scannedKeys.has(key) || pagesClaimed >= maxPages) return;
            scannedKeys.add(key);
            const pageOrdinal = ++pagesClaimed;
            if (!foundKeys.has(key)) {
              foundKeys.add(key);
              console.log('[debun-plus:crawl] page found', { stage: 'scan-pages', url: normalizedPageUrl, depth });
            }

            const isDashboard = key === pageKey(dashboardUrl);
            const depthForPage = isDashboard ? 0 : (pageDepthOverride ?? Math.min(1, depth));
            const renderedPage = await makeRenderedPage(pageData, depthForPage, loadScript, {
              ...options,
              responseHeaders: isDashboard ? rootResponseHeaders : pageData.headers,
            });
            renderedPage.isDashboard = isDashboard;
            console.log('[debun-plus:crawl] page rendered', {
              url: renderedPage.finalUrl,
              status: renderedPage.status,
              linksFound: renderedPage.linksFound,
              isDashboard,
            });
            if (renderedPage.challenge) {
              pageData.metadata.links = [];
              if (isDashboard) warnings.push('The destination root returned a browser or access challenge.');
            }

            const discoveredForPage = isDashboard && crawlDepth > 0
              ? uniqueUnscannedLinks(pageData.metadata?.links || [], scannedKeys).slice(0, maxLinksPerPage).length
              : 0;
            maxPagesQueued = Math.max(maxPagesQueued, pagesClaimed + discoveredForPage, pageOrdinal);
            reportCrawlProgress({
              stageLabel: isDashboard ? 'Analyzing destination page…' : 'Analyzing linked page…',
              currentUrl: normalizedPageUrl,
              pagesVisited: pageOrdinal,
              pagesQueued: maxPagesQueued,
            });

            let analysisResult;
            if (typeof options.onPageScanned === 'function') {
              try {
                analysisResult = await options.onPageScanned(renderedPage, {
                  pagesVisited: pageOrdinal,
                  pagesQueued: Math.max(maxPagesQueued, pageOrdinal),
                  maxPages,
                  maxDepth: depth,
                });
              } catch (error) {
                if (isAbortError(error, options.signal)) throw error;
                logCrawlerError('report-page-progress', error, { url: normalizedPageUrl });
                warnings.push(`Could not report progress for ${normalizedPageUrl}: ${error.message}`);
              }
            }
            pages.push({ renderedPage, analysisResult });
            console.log('[debun-plus:crawl] page analysis finished', {
              url: normalizedPageUrl,
              scanCompleted: analysisResult?.scanCompleted ?? false,
              packages: analysisResult?.packageCount ?? 0,
              errors: analysisResult?.errors || [],
            });
            runResults.push({ url: normalizedPageUrl, title: pageData.title || '', success: true, depth: depthForPage });
          },
          },
        }, (progress) => {
          if (options.signal?.aborted) return;
          if (progress?.crawling) {
            progressState = {
              ...progress,
              crawling: {
                ...progress.crawling,
                total: Math.max(
                  pagesClaimedBeforeRun + plannedPages,
                  pagesClaimedBeforeRun + (Number(progress.crawling.total) || 0),
                  maxPagesQueued,
                ),
              },
            };
            maxPagesQueued = Math.max(maxPagesQueued, Number(progressState.crawling.total) || 0);
            reportCrawlProgress({
              stageLabel: 'Finding linked pages…',
              currentUrl: urls[0],
              pagesVisited: pagesClaimed,
              pagesQueued: maxPagesQueued,
            });
          }
        }));
        const results = await raceWithSignal(crawlPromise, options.signal);
        throwIfAborted(options.signal);
        for (const result of results || []) {
          if (result.success === false) {
            try {
              if (await recoverInBrowser(result)) {
                runResults.push({ url: result.url, title: result.title || '', success: true, depth: pageDepthOverride ?? Math.min(1, depth) });
                continue;
              }
            } catch (error) {
              logCrawlerError('browser-fallback-recovery', error, { url: result.url });
            }
          }
          runResults.push(pageDepthOverride === null ? result : { ...result, depth: pageDepthOverride });
        }
      }
      return runResults;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      const message = error?.message || 'Mdream could not complete the page crawl.';
      logCrawlerError(isResolution ? 'resolve-destination' : 'scan-pages', error, { urls, depth, maxPages: limit });
      warnings.push(message);
      return [...runResults, { url: urls[0], title: '', success: false, error: message, depth }];
    } finally {
      await renderer.close();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  };

  // Resolve short links and redirects in a rendered browser. In single-page
  // mode, bypass Mdream's crawl/storage setup and reuse this one rendered DOM
  // as the page being analyzed.
  let resolutionResults;
  if (options.singlePageOnly) {
    const renderer = createBrowserHtmlRenderer(launchPlaywright, ofetch, options);
    try {
      const rendered = await renderer.renderLive(requestedUrl);
      throwIfAborted(options.signal);
      finalUrl = normalizeUrl(rendered.url).toString();
      resolvedPageData = {
        url: finalUrl,
        status: rendered.status,
        headers: rendered.headers || {},
        title: rendered.title,
        html: rendered.html,
        externalScripts: rendered.externalScripts || [],
        metadata: { title: rendered.title, links: [] },
      };
      foundKeys.add(pageKey(finalUrl));
      console.log('[debun-plus:crawl] page found', { stage: 'single-page', url: finalUrl });
      resolutionResults = [{ url: finalUrl, title: rendered.title || '', success: true, depth: 0 }];
    } finally {
      await renderer.close();
    }
  } else {
    resolutionResults = await runCrawl([requestedUrl], 0, 1, true);
  }
  throwIfAborted(options.signal);
  const resolution = resolutionResults.find((entry) => entry.success) || resolutionResults[0];
  if (!resolution?.success) {
    console.log('[debun-plus:crawl] destination resolution failed', { requestedUrl, error: resolution?.error || 'Unknown crawl error' });
    const failure = makeFailedPage(requestedUrl, resolution?.error || 'The starting URL could not be rendered.', 0, true);
    if (typeof options.onPageScanned === 'function') await options.onPageScanned(failure, { pagesVisited: 1, pagesQueued: 1, maxPages, maxDepth });
    return {
      pages: [failure], requestedUrl, finalUrl: requestedUrl, dashboardUrl,
      discoveredCount: 0, pagesQueued: 1, maxPages, maxDepth, maxLinksPerPage,
      delayMs: 0,
      stoppedReason: failure.error,
      warnings,
    };
  }

  finalUrl = normalizeUrl(resolution.url).toString();
  dashboardUrl = options.singlePageOnly ? finalUrl : new URL('/', finalUrl).toString();
  reportCrawlProgress({ stageLabel: 'Checking site permissions…', currentUrl: finalUrl, pagesQueued: 1 });
  console.log('[debun-plus:crawl] destination resolved', { requestedUrl, finalUrl, dashboardUrl });

  try {
    const origin = new URL(finalUrl).origin;
    const robotsResponse = await ofetch.raw(`${origin}/robots.txt`, {
      responseType: 'text',
      retry: 0,
      timeout: Math.min(timeout, Number(options.robotsTimeout) || (options.singlePageOnly ? 1200 : 5000)),
      ignoreResponseError: true,
      signal: options.signal,
    });
    robotsText = String(robotsResponse._data || '');
    if (robotsResponse.status >= 200 && robotsResponse.status < 300) robotsRules = parseRobots(robotsResponse._data);
    else if (![404, 410].includes(robotsResponse.status)) {
      followLinks = false;
      console.log('[debun-plus:crawl] robots.txt limited page discovery', { status: robotsResponse.status, url: `${origin}/robots.txt` });
      warnings.push(`robots.txt returned HTTP ${robotsResponse.status}; linked-page crawling is limited to the destination root and submitted URL.`);
    }
  } catch (error) {
    throwIfAborted(options.signal);
    followLinks = false;
    logCrawlerError('read-robots', error, { url: new URL('/', finalUrl).origin });
    warnings.push(`Could not read robots.txt; linked-page crawling is limited to the destination root and submitted URL (${error.message}).`);
  }

  const dashboard = new URL(dashboardUrl);
  if (!isAllowedByRobots(`${dashboard.pathname}${dashboard.search}`, robotsRules)) {
    console.log('[debun-plus:crawl] scan target blocked by robots.txt', { dashboardUrl });
    const failure = makeFailedPage(
      dashboardUrl,
      options.singlePageOnly ? 'The submitted page is disallowed by robots.txt.' : 'The dashboard URL is disallowed by robots.txt.',
      0,
      true,
    );
    if (typeof options.onPageScanned === 'function') await options.onPageScanned(failure, { pagesVisited: 1, pagesQueued: 1, maxPages, maxDepth });
    return {
      pages: [failure], requestedUrl, finalUrl, dashboardUrl, discoveredCount: 0,
      pagesQueued: 0, maxPages, maxDepth, maxLinksPerPage, delayMs: 0,
      stoppedReason: failure.error, warnings,
    };
  }

  if (Array.isArray(resolvedPageData?.metadata?.links)) {
    resolvedPageData.metadata.links = resolvedPageData.metadata.links
      .slice(0, maxLinksPerPage)
      .filter((link) => {
        try {
          const next = new URL(link);
          return next.origin === new URL(finalUrl).origin &&
            isAllowedByRobots(`${next.pathname}${next.search}`, robotsRules);
        } catch (_) {
          return false;
        }
      });
  }

  if (options.singlePageOnly) {
    throwIfAborted(options.signal);
    const pageData = {
      ...resolvedPageData,
      metadata: { ...(resolvedPageData?.metadata || {}), links: [] },
    };
    const renderedPage = await makeRenderedPage(pageData, 0, loadScript, options);
    renderedPage.links = [];
    renderedPage.linksFound = 0;
    pagesClaimed = 1;
    scannedKeys.add(pageKey(finalUrl));
    maxPagesQueued = 1;
    reportCrawlProgress({
      stageLabel: 'Analyzing submitted page…',
      currentUrl: finalUrl,
      pagesVisited: 1,
      pagesQueued: 1,
    });
    let analysisResult;
    if (typeof options.onPageScanned === 'function') {
      try {
        analysisResult = await options.onPageScanned(renderedPage, {
          pagesVisited: 1,
          pagesQueued: 1,
          maxPages: 1,
          maxDepth: 0,
        });
      } catch (error) {
        if (isAbortError(error, options.signal)) throw error;
        logCrawlerError('report-single-page-progress', error, { url: finalUrl });
        warnings.push(`Could not report progress for ${finalUrl}: ${error.message}`);
      }
    }
    pages.push({ renderedPage, analysisResult });
    console.log('[debun-plus:crawl] single-page analysis finished', {
      url: finalUrl,
      scanCompleted: analysisResult?.scanCompleted ?? false,
      packages: analysisResult?.packageCount ?? 0,
      errors: analysisResult?.errors || [],
    });
    return {
      pages: pages.map((entry) => entry.renderedPage),
      requestedUrl,
      finalUrl,
      dashboardUrl,
      discoveredCount: 0,
      pagesQueued: 1,
      maxPages: 1,
      maxDepth: 0,
      maxLinksPerPage: 0,
      delayMs: 0,
      warnings,
    };
  }

  let sitemapLinks = [];
  if (maxDepth > 0 && followLinks && resolvedPageData) {
    sitemapLinks = await discoverSitemapLinks(finalUrl, robotsText, robotsRules, ofetch, {
      signal: options.signal,
      sitemapTimeout: options.sitemapTimeout,
    });
    for (const link of sitemapLinks) discoveredLinks.add(pageKey(link));
    const mergedLinks = [...(resolvedPageData.metadata?.links || []), ...sitemapLinks];
    resolvedPageData.metadata ||= {};
    const uniqueLinkKeys = [...new Set(mergedLinks.map((link) => pageKey(link)))];
    resolvedPageData.metadata.links = uniqueLinkKeys
      .map((key) => mergedLinks.find((link) => pageKey(link) === key))
      .filter(Boolean)
      .slice(0, maxLinksPerPage);
    if (sitemapLinks.length) console.log('[debun-plus:crawl] sitemap links added', { url: finalUrl, count: sitemapLinks.length });
  }

  // The root is always the first crawl seed. Mdream then follows rendered,
  // same-site links to the configured depth and page cap.
  const requestedIsRoot = pageKey(finalUrl) === pageKey(dashboardUrl);
  const reserveRequestedPage = !requestedIsRoot && maxDepth > 0 && maxPages > 1 ? 1 : 0;
  const rootLimit = Math.max(1, maxPages - reserveRequestedPage);
  const crawlDepth = followLinks ? maxDepth : 0;
  const reuseRenderedRoot = requestedIsRoot && maxDepth <= 1 && resolvedPageData;
  if (reuseRenderedRoot) {
    throwIfAborted(options.signal);
    const rootKey = pageKey(finalUrl);
    scannedKeys.add(rootKey);
    pagesClaimed++;
    for (const link of resolvedPageData.metadata?.links || []) discoveredLinks.add(pageKey(link));
    const renderedRoot = await makeRenderedPage(resolvedPageData, 0, loadScript, options);
    renderedRoot.isDashboard = true;
    if (renderedRoot.challenge) {
      resolvedPageData.metadata.links = [];
      warnings.push('The destination root returned a browser or access challenge.');
    }
    const childUrls = renderedRoot.scanBlocked
      ? []
      : uniqueUnscannedLinks(resolvedPageData.metadata?.links || [], scannedKeys).slice(0, maxLinksPerPage);
    const childLimit = Math.max(0, Math.min(maxPages - pagesClaimed, childUrls.length));
    maxPagesQueued = Math.max(maxPagesQueued, pagesClaimed + childLimit);
    reportCrawlProgress({
      stageLabel: 'Analyzing destination page…',
      currentUrl: finalUrl,
      pagesVisited: pagesClaimed,
      pagesQueued: maxPagesQueued,
    });
    let rootAnalysis;
    if (typeof options.onPageScanned === 'function') {
      try {
        rootAnalysis = await options.onPageScanned(renderedRoot, {
          pagesVisited: pagesClaimed,
          pagesQueued: Math.max(maxPagesQueued, pagesClaimed),
          maxPages,
          maxDepth,
        });
      } catch (error) {
        if (isAbortError(error, options.signal)) throw error;
        logCrawlerError('report-page-progress', error, { url: finalUrl });
        warnings.push(`Could not report progress for ${finalUrl}: ${error.message}`);
      }
    }
    pages.push({ renderedPage: renderedRoot, analysisResult: rootAnalysis });
    if (crawlDepth > 0 && followLinks && childLimit > 0 && childUrls.length > 0) {
      crawlResults.push(...await runCrawl(childUrls, 0, childLimit, false, 1));
    }
  } else {
    const rootResults = await runCrawl([dashboardUrl], 0, 1);
    throwIfAborted(options.signal);
    crawlResults.push(...rootResults);
    const rootRecord = pages.find((entry) => entry.renderedPage.isDashboard);
    const childUrls = rootRecord && !rootRecord.renderedPage.scanBlocked
      ? uniqueUnscannedLinks([...rootRecord.renderedPage.links, ...sitemapLinks], scannedKeys).slice(0, maxLinksPerPage)
      : [];
    const childLimit = Math.max(0, Math.min(rootLimit - 1, maxPages - pagesClaimed));
    if (crawlDepth > 0 && followLinks && childLimit > 0 && childUrls.length > 0) {
      crawlResults.push(...await runCrawl(childUrls, 0, childLimit, false, 1));
    }
  }

  const crawledKeys = new Set(pages.map((entry) => pageKey(entry.renderedPage.finalUrl)));
  const dashboardPage = pages.find((entry) => entry.renderedPage.isDashboard);
  const dashboardUsable = dashboardPage && !dashboardPage.renderedPage.error && !dashboardPage.renderedPage.scanBlocked;
  const requestedPath = new URL(finalUrl);
  const requestedAllowed = isAllowedByRobots(`${requestedPath.pathname}${requestedPath.search}`, robotsRules);
  if (!requestedIsRoot && (maxDepth > 0 || options.includeRequestedPage === true) && requestedAllowed && dashboardUsable && pagesClaimed < maxPages && !crawledKeys.has(pageKey(finalUrl))) {
    const requestedResults = await runCrawl([finalUrl], 0, 1, false, 1);
    crawlResults.push(...requestedResults);
  }

  // Add failed page results returned by Mdream so the UI can show per-page
  // failures alongside successfully rendered pages.
  for (const result of crawlResults) {
    throwIfAborted(options.signal);
    if (result.success !== false) continue;
    const key = pageKey(result.url);
    if (scannedKeys.has(key) || pagesClaimed >= maxPages) continue;
    scannedKeys.add(key);
    const pageOrdinal = ++pagesClaimed;
    const failed = makeFailedPage(result.url, result.error, result.depth || 0, key === pageKey(dashboardUrl));
    const analysisResult = typeof options.onPageScanned === 'function'
      ? await options.onPageScanned(failed, {
          pagesVisited: pageOrdinal,
          pagesQueued: Math.max(maxPagesQueued, pageOrdinal),
          maxPages,
          maxDepth,
        })
      : undefined;
    pages.push({ renderedPage: failed, analysisResult });
    warnings.push(`Could not render ${result.url}: ${result.error}`);
  }

  const rootRecordIndex = pages.findIndex((entry) => entry.renderedPage.isDashboard);
  if (rootRecordIndex > 0) {
    const [rootRecord] = pages.splice(rootRecordIndex, 1);
    pages.unshift(rootRecord);
  }

  const rootFailure = pages.find((entry) => entry.renderedPage.isDashboard && (entry.renderedPage.error || entry.renderedPage.scanBlocked));
  const stoppedReason = rootFailure
    ? rootFailure.renderedPage.error || (rootFailure.renderedPage.challenge
      ? `The destination returned an access or browser challenge (HTTP ${rootFailure.renderedPage.status || 'unknown'}). Package and vulnerability scanning could not be completed for this response.`
      : 'Crawl stopped because the destination root could not be scanned.')
    : undefined;

  return {
    pages: pages.map((entry) => entry.renderedPage),
    requestedUrl,
    finalUrl,
    dashboardUrl,
    discoveredCount: discoveredLinks.size,
    pagesQueued: Math.max(maxPagesQueued, pages.length),
    maxPages,
    maxDepth,
    maxLinksPerPage,
    delayMs: 0,
    stoppedReason,
    warnings,
  };
}

module.exports = { crawlSiteWithMdream, createIsolatedCrawlerConfiguration, fetchNavigationHtml, pageKey, runtimeMarkers, applyScriptBudget, uniqueUnscannedLinks, sitemapUrlsFromRobots, discoverSitemapLinks };
