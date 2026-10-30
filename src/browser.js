'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { log } = require('./util/log');
const { normalizeUrl, isHttpUrl } = require('./util/url');
const { findBundlerHints, preferredBundlerHint } = require('./bundler-patterns');

/**
 * Optional headless-browser crawler. Static HTML parsing misses scripts that a
 * single-page app injects at runtime; a real browser executes the page and we
 * capture every script response body.
 *
 * Uses Puppeteer's managed browser when installed, then falls back to a system
 * Chrome/Chromium/Edge executable. PUPPETEER_EXECUTABLE_PATH can override it.
 */
function loadPuppeteer() {
  const candidates = ['puppeteer', 'debun-cli/node_modules/puppeteer'];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_) {
      /* try next */
    }
  }
  throw new Error('Browser mode requires Puppeteer. Install the project dependencies with `npm install`.');
}

function browserExecutableCandidates() {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(localAppData ? [path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

function browserLaunchOptions(puppeteer, options = {}) {
  const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  if (configuredPath && !fs.existsSync(configuredPath)) {
    throw new Error(`The configured browser executable does not exist: ${configuredPath}`);
  }

  let bundledPath;
  try {
    bundledPath = puppeteer.executablePath();
  } catch (_) {
    /* The Puppeteer-managed browser may not have been installed. */
  }
  const executablePath = configuredPath ||
    (bundledPath && fs.existsSync(bundledPath) ? bundledPath : null) ||
    browserExecutableCandidates().find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      'No Chrome or Chromium executable was found. Install one with `npx puppeteer browsers install chrome`, ' +
      'or set PUPPETEER_EXECUTABLE_PATH to an installed Chrome/Chromium executable.'
    );
  }

  return {
    headless: options.headless !== false,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
}

async function crawlWithBrowser(url, options = {}) {
  const puppeteer = loadPuppeteer();
  const timeout = options.timeout ?? 45000;
  const maxScripts = options.maxScripts ?? 60;

  const browser = await puppeteer.launch(browserLaunchOptions(puppeteer, options));
  try {
    const page = await browser.newPage();
    const captured = new Map();
    const captureTasks = new Set();

    page.on('response', (response) => {
      const task = (async () => {
        try {
          const request = response.request();
          if (request.resourceType() !== 'script') return;
          const scriptUrl = response.url();
          if (captured.has(scriptUrl) || captured.size >= maxScripts) return;
          const contentType = response.headers()['content-type'] || '';
          const code = await response.text();
          captured.set(scriptUrl, { url: scriptUrl, code, contentType });
        } catch (_) {
          /* ignore individual response failures */
        }
      })();
      captureTasks.add(task);
      task.finally(() => captureTasks.delete(task));
    });

    log.step(`browser: navigating to ${url}`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // Wait for the document to finish rendering, then allow client hydration and
    // its script requests to settle before collecting evidence.
    await page.waitForFunction(() => document.readyState === 'complete', { timeout }).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: Math.min(timeout, 12000) }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.allSettled([...captureTasks]);

    const inline = await page.$$eval('script:not([src])', (nodes) =>
      nodes.map((node) => node.textContent || '').filter((text) => text.trim())
    );

    const html = await page.content();
    const runtime = await page.evaluate(() => ({
      nextData: Boolean(document.getElementById('__NEXT_DATA__')),
      nextRoot: Boolean(document.querySelector('#__next')),
      bundlerGlobals: Object.getOwnPropertyNames(window),
      nextFlight: Boolean(window.__next_f) || /__next_f\.push/.test(document.documentElement.innerHTML),
      nextScripts: [...document.scripts].map((script) => script.src).filter((src) => src.includes('/_next/')),
      nextAssets: [...document.querySelectorAll('script[src],link[href]')]
        .map((element) => element.src || element.href)
        .filter((src) => /\/_next\//i.test(src)),
      nuxt: Boolean(window.__NUXT__ || document.querySelector('[data-nuxt-data], [data-nuxt-app]')),
      gatsby: Boolean(window.___gatsby || document.querySelector('#___gatsby')),
      remix: Boolean(window.__remixContext || document.querySelector('[data-remix-run]')),
      angular: Boolean(document.querySelector('[ng-version]') || window.ng),
      react: Boolean(document.querySelector('[data-reactroot]')) || [...document.querySelectorAll('body *')].slice(0, 1200).some((element) => Object.keys(element).some((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactContainer$'))),
      vue: Boolean(window.__VUE__ || document.querySelector('[data-v-app]') || [...document.querySelectorAll('#app, [id^="app-"]')].some((element) => element.__vue_app__ || element.__vueParentComponent)),
      svelteKit: Boolean(document.querySelector('[data-sveltekit-preload-data], [data-sveltekit-hydrate]')),
      svelte: Boolean(document.querySelector('[data-svelte-h], [class*="svelte-"]')),
      astro: Boolean(document.querySelector('astro-island')),
      webflow: Boolean(document.querySelector('[data-wf-page], [data-wf-site]')) ||
        [...document.scripts].some((script) => /\/webflow(?:\.min)?\.js(?:\?|$)/i.test(script.src)),
    }));

    const technology = classifyTechnology(runtime, captured.values(), html, response ? response.headers() : {});

    return {
      finalUrl: page.url(),
      status: response ? response.status() : 0,
      html,
      externalScripts: [...captured.values()],
      inlineScripts: inline.map((content) => ({ kind: 'inline', content })),
      technology,
    };
  } finally {
    await browser.close();
  }
}

function classifyTechnology(runtime, scripts, html = '', responseHeaders = {}) {
  const sources = [...scripts];
  const urls = sources.map((source) => source.url || '');
  const code = sources.map((source) => source.code || '').join('\n');
  const poweredBy = Object.entries(responseHeaders).find(([name]) => name.toLowerCase() === 'x-powered-by')?.[1] || '';
  const poweredByNext = /(?:^|[,;\s])next\.js(?:$|[,;\s])/i.test(poweredBy);
  const hasNext = runtime.nextData || runtime.nextRoot || poweredByNext || urls.some((url) => /\/_next\//i.test(url)) ||
    (runtime.nextScripts || []).length > 0 || (runtime.nextAssets || []).length > 0 || runtime.nextFlight ||
    /\/_next\/static\//i.test(html) || /__next_f\.push/.test(html);
  const hasVue = runtime.vue || runtime.nuxt || /(?:Vue\.createApp|createApp\([^)]*\)\.mount|__VUE__|__VUE_DEVTOOLS_GLOBAL_HOOK__)/i.test(code);
  const hasReact = runtime.react || runtime.gatsby || runtime.remix || /(?:ReactDOM\.createRoot|ReactDOM\.render|react-dom\/client|__REACT_DEVTOOLS_GLOBAL_HOOK__)/i.test(code);
  const hasAngular = runtime.angular || /(?:ng\.core|ɵɵdefineComponent|zone\.js)/i.test(code);
  const hasSvelte = runtime.svelteKit || runtime.svelte || /(?:__sveltekit|svelte_internal|svelte\/internal)/i.test(`${code}\n${html}`);
  const framework = hasNext ? 'next.js'
    : runtime.nuxt ? 'nuxt'
      : runtime.gatsby ? 'gatsby'
        : runtime.remix ? 'remix'
            : runtime.astro ? 'astro'
            : hasAngular ? 'angular'
              : hasVue ? 'vue'
                : hasReact ? 'react'
                  : hasSvelte ? 'svelte'
                    : runtime.webflow ? 'webflow'
                      : 'unknown';
  const bundlerHints = findBundlerHints(`${code}\n${(runtime.bundlerGlobals || []).join('\n')}`, urls, html);
  const selectedBundler = preferredBundlerHint(bundlerHints);
  const bundler = selectedBundler?.name || 'unknown';
  const evidence = [];
  if (framework !== 'unknown') evidence.push(`${framework} runtime markers were found.`);
  if (bundler !== 'unknown') {
    evidence.push(`${bundler} pattern hints${selectedBundler.version ? ` (pattern version ${selectedBundler.version})` : ''} were found.`);
  }
  if (!evidence.length) evidence.push('The rendered page did not expose recognizable framework or bundler markers.');
  return {
    framework,
    bundler,
    reason: evidence.join(' '),
  };
}

module.exports = { crawlWithBrowser, loadPuppeteer, browserLaunchOptions, classifyTechnology };
