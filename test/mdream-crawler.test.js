'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { Configuration, SessionPool } = require('crawlee');
const { applyScriptBudget, createIsolatedCrawlerConfiguration, crawlSiteWithMdream, fetchNavigationHtml, pageKey, uniqueUnscannedLinks } = require('../src/mdream-crawler');
const { analyzeSite } = require('../src/site-analyze');

test('page script budget skips oversized sources before expensive package inference', () => {
  const halfMiB = 'x'.repeat(512 * 1024);
  const budget = applyScriptBudget(
    Array.from({ length: 7 }, (_, index) => ({ url: `/bundle-${index}.js`, code: halfMiB })),
    [{ content: 'x'.repeat(512 * 1024 + 1) }],
    { maxScriptBytes: 512 * 1024, maxExternalScriptBytes: 1024 * 1024, maxInlineScriptBytes: 512 * 1024 },
  );

  assert.equal(budget.externalScripts.length, 2);
  assert.equal(budget.inlineScripts.length, 0);
  assert.equal(budget.externalBytes, 1024 * 1024);
  assert.equal(budget.skippedExternal, 5);
  assert.equal(budget.skippedInline, 1);
});

test('child crawl queue removes links to scanned pages and duplicate URL variants', () => {
  const scanned = new Set([pageKey('https://example.test/')]);
  const pending = uniqueUnscannedLinks([
    'https://example.test/#top',
    'https://example.test/child?b=2&a=1',
    'https://example.test/child?a=1&b=2',
  ], scanned);
  assert.deepEqual(pending, ['https://example.test/child?b=2&a=1']);
});

test('blocked challenge pages report the actual reason instead of a generic root crawl failure', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const result = await crawlSiteWithMdream(url, { maxPages: 1, maxDepth: 0, waitForNetworkIdle: false, renderLoadTimeout: 1500, renderSettleMs: 0 });
    assert.equal(result.pages[0].challenge, true);
    assert.match(result.stoppedReason, /access or browser challenge \(HTTP 200\)/);
    assert.match(result.stoppedReason, /Package and vulnerability scanning could not be completed/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('shallow crawl checks the destination root and submitted page without following links', async () => {
  const visited = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    visited.push(request.url);
    const title = request.url === '/' ? 'Root' : request.url === '/requested' ? 'Requested' : 'Linked';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><a href="/linked">Linked page</a></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const scanned = [];
  try {
    const crawl = await crawlSiteWithMdream(`${baseUrl}/requested`, {
      maxPages: 2,
      maxDepth: 0,
      includeRequestedPage: true,
      onPageScanned: async (page) => { scanned.push(new URL(page.url).pathname); },
    });
    assert.deepEqual(scanned, ['/', '/requested']);
    assert.equal(crawl.pages.length, 2);
    assert.equal(visited.includes('/linked'), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('single-page shallow mode scans only the final submitted page', async () => {
  const visits = [];
  const server = http.createServer((request, response) => {
    visits.push(request.url);
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const title = request.url === '/' ? 'Root' : request.url === '/requested' ? 'Requested' : 'Linked';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><a href="/linked">Linked page</a></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await analyzeSite(`${baseUrl}/requested`, {
      scanMode: 'shallow',
      singlePageOnly: true,
      maxPages: 1,
      maxDepth: 0,
      waitForNetworkIdle: false,
      renderLoadTimeout: 1500,
      renderSettleMs: 0,
      useDebun: false,
      fetchRootManifest: false,
      includeSourceMaps: false,
    });

    assert.equal(result.pages.length, 1);
    assert.equal(new URL(result.pages[0].url).pathname, '/requested');
    assert.equal(result.pages[0].title, 'Requested');
    assert.equal(result.reportEligible, true);
    assert.equal(result.report.pagesScanned, 1);
    assert.equal(result.dashboardScan.websiteUrl, `${baseUrl}/requested`);
    assert.equal(visits.filter((url) => url === '/requested').length, 1);
    assert.equal(visits.includes('/'), false);
    assert.equal(visits.includes('/linked'), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('navigation fallback retries with Axios when Undici reports fetch failed', async () => {
  let fallbackRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/page' }).end();
      return;
    }
    fallbackRequests++;
    assert.match(request.headers['user-agent'], /Chrome/);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><title>Recovered via Axios</title></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/redirect`;
  let undiciAttempts = 0;

  try {
    const result = await fetchNavigationHtml(url, {
      raw: async () => {
        undiciAttempts++;
        throw new Error('[GET] "test": <no response> fetch failed');
      },
    }, { timeout: 3000 });

    assert.equal(undiciAttempts, 1);
    assert.equal(fallbackRequests, 1);
    assert.equal(result.transport, 'axios');
    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, `http://127.0.0.1:${address.port}/page`);
    assert.match(result.html, /Recovered via Axios/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('browser-loaded script responses are reused as package analysis inputs', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') return response.writeHead(404).end();
    if (request.url === '/bundle.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return response.end('window.fixtureLibrary = "browser-captured";');
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Browser capture</title><script src="/bundle.js"></script></head><body>Ready</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const crawl = await crawlSiteWithMdream(url, {
      singlePageOnly: true,
      maxPages: 1,
      maxDepth: 0,
      timeout: 5000,
      renderLoadTimeout: 1500,
      waitForNetworkIdle: false,
      renderSettleMs: 100,
      maxScripts: 10,
    });
    assert.equal(crawl.pages.length, 1);
    assert.ok(crawl.pages[0].externalScripts.some((source) => source.url.endsWith('/bundle.js') && source.code.includes('browser-captured')));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('crawler session state stays isolated when Crawlee persistence is enabled in the environment', async () => {
  const previousPersistence = process.env.CRAWLEE_PERSIST_STORAGE;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'debun-plus-test-'));
  const storageDirectory = path.join(temporaryDirectory, 'crawler-storage');
  process.env.CRAWLEE_PERSIST_STORAGE = 'true';

  try {
    const config = createIsolatedCrawlerConfiguration(Configuration, storageDirectory);
    const storageClient = config.getStorageClient();

    assert.equal(storageClient.persistStorage, false);
    assert.equal(storageClient.localDataDirectory, storageDirectory);

    const sessionPool = await SessionPool.open({}, config);
    assert.equal(sessionPool.isInitialized, true);
    await sessionPool.teardown({ persistState: false });
  } finally {
    if (previousPersistence === undefined) delete process.env.CRAWLEE_PERSIST_STORAGE;
    else process.env.CRAWLEE_PERSIST_STORAGE = previousPersistence;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rendered local site scan follows hydrated links with Crawlee persistence enabled', async () => {
  const previousPersistence = process.env.CRAWLEE_PERSIST_STORAGE;
  process.env.CRAWLEE_PERSIST_STORAGE = 'true';
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/child') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Child page</title></head><body><h1>Child rendered successfully</h1></body></html>');
      return;
    }
    if (request.url !== '/') {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Local Scan Fixture</title></head><body><h1>Rendered successfully</h1><a href="https://example.net/offsite">External link</a><script>document.body.insertAdjacentHTML("beforeend", "<a href=\'/child\'>Hydrated child link</a>")</script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    const result = await analyzeSite(url, {
      maxPages: 3,
      maxDepth: 1,
      maxLinksPerPage: 5,
      timeout: 5000,
      fetchRootManifest: false,
    });

    assert.equal(result.reportEligible, true, result.reportReason);
    assert.equal(result.report.websiteUrl, url);
    assert.equal(result.report.pagesScanned, 2);
    assert.equal(result.crawl.linksDiscovered, 1);
    assert.deepEqual(result.report.dependencies, []);
    assert.deepEqual(result.pages.map((page) => new URL(page.finalUrl).pathname), ['/', '/child']);
  } finally {
    if (previousPersistence === undefined) delete process.env.CRAWLEE_PERSIST_STORAGE;
    else process.env.CRAWLEE_PERSIST_STORAGE = previousPersistence;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('linked-page requests use a small bounded batch instead of Mdream’s default burst', async () => {
  let activeChildRequests = 0;
  let maxConcurrentChildRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/') {
      const links = Array.from({ length: 5 }, (_, index) => `<a href="/child-${index + 1}">Child ${index + 1}</a>`).join('');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Batch fixture</title></head><body><h1>Root</h1>${links}</body></html>`);
      return;
    }
    if (/^\/child-\d+$/.test(request.url)) {
      activeChildRequests++;
      maxConcurrentChildRequests = Math.max(maxConcurrentChildRequests, activeChildRequests);
      response.once('finish', () => activeChildRequests--);
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>${request.url}</title></head><body><h1>Rendered ${request.url}</h1></body></html>`);
      }, 80);
      return;
    }
    response.writeHead(404).end('Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    const result = await analyzeSite(url, {
      maxPages: 4,
      maxDepth: 1,
      maxLinksPerPage: 5,
      crawlConcurrency: 2,
      requestDelayMs: 0,
      maxScripts: 1,
      timeout: 5000,
      fetchRootManifest: false,
    });

    assert.equal(result.reportEligible, true, result.reportReason);
    assert.equal(result.report.pagesScanned, 4);
    assert.equal(result.pages.filter((page) => page.scanCompleted).length, 4);
    assert.equal(maxConcurrentChildRequests, 2, 'no more than the configured two child requests should overlap');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('a submitted subpage scans its destination root before one-level links and the requested page', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const pages = {
      '/': '<!doctype html><html><head><title>Root</title></head><body><a href="/linked">Linked page</a></body></html>',
      '/linked': '<!doctype html><html><head><title>Linked</title></head><body><h1>Linked page</h1></body></html>',
      '/requested': '<!doctype html><html><head><title>Requested</title></head><body><h1>Requested page</h1></body></html>',
    };
    const body = pages[request.url];
    if (!body) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/requested`;

  try {
    const result = await analyzeSite(url, {
      maxPages: 4,
      maxDepth: 1,
      maxLinksPerPage: 5,
      crawlConcurrency: 2,
      requestDelayMs: 0,
      maxScripts: 1,
      timeout: 5000,
      fetchRootManifest: false,
    });
    const paths = result.pages.map((page) => new URL(page.finalUrl).pathname);

    assert.equal(result.reportEligible, true, result.reportReason);
    assert.deepEqual(paths, ['/', '/linked', '/requested']);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(result.report.pagesScanned, 3);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('progress totals remain cumulative when the resolved root is reused', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const body = request.url === '/'
      ? '<!doctype html><html><head><title>Root</title></head><body><a href="/child">Child</a></body></html>'
      : '<!doctype html><html><head><title>Child</title></head><body><h1>Child page</h1></body></html>';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const progress = [];

  try {
    const result = await analyzeSite(url, {
      maxPages: 4,
      maxDepth: 1,
      maxLinksPerPage: 5,
      crawlConcurrency: 2,
      requestDelayMs: 0,
      maxScripts: 1,
      timeout: 5000,
      fetchRootManifest: false,
      onProgress: (event) => progress.push(event),
    });
    const totals = progress.filter((event) => event.type === 'progress').map((event) => event.totalPages);

    assert.equal(result.reportEligible, true, result.reportReason);
    assert.equal(result.pages.filter((page) => page.scanCompleted).length, 2);
    assert.ok(totals.every((total, index) => index === 0 || total >= totals[index - 1]), `expected cumulative page totals, got ${totals.join(', ')}`);
    assert.equal(totals.at(-1), 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('browser fallback recovers child pages rejected by the crawler HTTP user agent', async () => {
  let crawlerRequests = 0;
  let browserChildRequests = 0;
  const server = http.createServer((request, response) => {
    const browserNavigation = request.headers['sec-fetch-mode'] === 'navigate';
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/child' && !browserNavigation) {
      crawlerRequests++;
      request.socket.destroy();
      return;
    }
    if (request.url === '/child') browserChildRequests++;
    const pages = {
      '/': '<!doctype html><html><head><title>Root</title></head><body><a href="/child">Child</a></body></html>',
      '/child': '<!doctype html><html><head><title>Recovered child</title></head><body><h1>Recovered in Chromium</h1></body></html>',
    };
    const body = pages[request.url];
    if (!body) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    const result = await analyzeSite(url, {
      maxPages: 2,
      maxDepth: 1,
      maxLinksPerPage: 2,
      crawlConcurrency: 2,
      requestDelayMs: 0,
      maxScripts: 1,
      timeout: 5000,
      fetchRootManifest: false,
    });

    assert.ok(crawlerRequests >= 1, 'the fixture should reject the crawler HTTP client');
    assert.equal(browserChildRequests, 1, 'Chromium should retry the child page once');
    assert.equal(result.reportEligible, true, result.reportReason);
    assert.equal(result.report.pagesScanned, 2);
    assert.deepEqual(result.pages.map((page) => page.title).sort(), ['Recovered child', 'Root']);
    assert.equal(result.pages.every((page) => page.scanCompleted), true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('a transient empty browser response is retried once and still produces a report', async () => {
  let emptyBrowserResponses = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/' && request.headers['sec-fetch-mode'] === 'navigate') {
      if (emptyBrowserResponses++ === 0) {
        request.socket.destroy();
        return;
      }
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Recovered page</title></head><body><h1>Recovered after a transient empty response</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    const result = await analyzeSite(url, {
      maxPages: 1,
      maxDepth: 0,
      maxLinksPerPage: 5,
      maxScripts: 1,
      timeout: 5000,
      fetchRootManifest: false,
    });

    assert.equal(emptyBrowserResponses, 2, 'the browser should retry after one net::ERR_EMPTY_RESPONSE');
    assert.equal(result.reportEligible, true, result.reportReason);
    assert.equal(result.report.pagesScanned, 1);
    assert.equal(result.dashboardScan.title, 'Recovered page');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('browser fallback remains available after two empty navigation responses', async () => {
  let emptyBrowserResponses = 0;
  let successfulFetches = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/' && request.headers['sec-fetch-mode'] === 'navigate') {
      emptyBrowserResponses++;
      request.socket.destroy();
      return;
    }
    successfulFetches++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Recovered by fallback</title></head><body><h1>Fetched HTML fallback</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    const result = await analyzeSite(url, {
      maxPages: 1,
      maxDepth: 0,
      maxLinksPerPage: 5,
      maxScripts: 1,
      timeout: 5000,
      fetchRootManifest: false,
    });

    assert.equal(emptyBrowserResponses, 2, 'both direct browser attempts should fail before fallback');
    assert.ok(successfulFetches >= 1, 'the HTTP fallback should retrieve the page HTML');
    assert.equal(result.reportEligible, true, result.reportReason);
    assert.equal(result.report.pagesScanned, 1);
    assert.equal(result.dashboardScan.title, 'Recovered by fallback');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('many stalled bundle requests stay within the bounded page script budget', async () => {
  const slowRequestTimers = new Set();
  const scriptTags = Array.from({ length: 60 }, (_, index) => `<script src="/slow-${index}.js"></script>`).join('');
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Slow bundle fixture</title>${scriptTags}</head><body><h1>Rendered</h1></body></html>`);
      return;
    }
    if (/^\/slow-\d+\.js$/.test(request.url) && request.headers['sec-fetch-dest'] === 'script') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.fixture = true;');
      return;
    }
    const timer = setTimeout(() => {
      slowRequestTimers.delete(timer);
      if (!response.destroyed) response.end('/* slow script */');
    }, 10000);
    slowRequestTimers.add(timer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const startedAt = Date.now();

  try {
    const result = await analyzeSite(url, {
      maxPages: 1,
      maxDepth: 0,
      maxLinksPerPage: 5,
      scriptTimeout: 1000,
      scriptConcurrency: 8,
      timeout: 5000,
      fetchRootManifest: false,
    });

    assert.equal(result.reportEligible, true, result.reportReason);
    assert.equal(result.report.pagesScanned, 1);
    assert.ok(Date.now() - startedAt < 12000, `scan took ${Date.now() - startedAt}ms`);
  } finally {
    for (const timer of slowRequestTimers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
