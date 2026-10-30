import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { analyzeCrawledSite, crawlSite, normalizeCrawlUrl } from '../src/debun-plus/crawl';
import { runAnalysisCli } from '../src/debun-plus/analysis-cli';
import { createStaticServer } from './helpers/server';
import type { PackageDetection } from '../src/debun-plus/types';

let temporaryDirectory = '';
let server: ReturnType<typeof createStaticServer> | null = null;
let secondServer: ReturnType<typeof createStaticServer> | null = null;

afterEach(async () => {
  if (server) await server.close();
  if (secondServer) await secondServer.close();
  server = null;
  secondServer = null;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = '';
});

function detection(name: string, version = '1.2.3'): PackageDetection {
  return {
    name,
    version,
    tier: 'exact',
    score: 0.9,
    margin: 0.4,
    evidence: [{ source: 'script-url', detail: 'fixture package' }],
    dependencies: {},
  };
}

function runRootCli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/debun-plus.js', ...args], { cwd: process.cwd(), windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

async function makeFixtureSite(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'debun-crawl-'));
  await mkdir(join(temporaryDirectory, 'assets'), { recursive: true });
  await writeFile(join(temporaryDirectory, 'index.html'), `<!doctype html><title>Home</title>
    <script src="/assets/common.js"></script><script src="/assets/home.js"></script>
    <link rel="modulepreload" href="/assets/module.js">
    <script>fetch('/assets/xhr.js'); const request=new XMLHttpRequest(); request.open('GET','/assets/fetch-xhr.js');</script>
    <a href="/about#top">About</a><a href="/contact?b=2&a=1">Contact</a>`);
  await writeFile(join(temporaryDirectory, 'about.html'), '<!doctype html><title>About</title><script src="/assets/common.js"></script><a href="/contact?a=1&b=2">Contact</a>');
  await writeFile(join(temporaryDirectory, 'contact.html'), '<!doctype html><title>Contact</title><script src="/assets/common.js"></script>');
  await writeFile(join(temporaryDirectory, 'about'), await (await import('node:fs/promises')).readFile(join(temporaryDirectory, 'about.html')));
  await writeFile(join(temporaryDirectory, 'contact'), await (await import('node:fs/promises')).readFile(join(temporaryDirectory, 'contact.html')));
  await writeFile(join(temporaryDirectory, 'assets', 'common.js'), `globalThis.common='COMMON_BUNDLE'; import('./shared-chunk.js');`);
  await writeFile(join(temporaryDirectory, 'assets', 'shared-chunk.js'), `globalThis.sharedChunk='SHARED_CHUNK';`);
  await writeFile(join(temporaryDirectory, 'assets', 'home.js'), `globalThis.home='HOME_ONLY';`);
  await writeFile(join(temporaryDirectory, 'assets', 'module.js'), `globalThis.module='MODULE_PRELOAD';`);
  await writeFile(join(temporaryDirectory, 'assets', 'xhr.js'), `globalThis.xhr='FETCH_XHR';`);
  await writeFile(join(temporaryDirectory, 'assets', 'fetch-xhr.js'), `globalThis.xhr='OPEN_XHR';`);
  server = createStaticServer(temporaryDirectory);
  return server.listen();
}

describe('bounded multi-page crawl and shared bundle analysis', () => {
  it('analyzes shared content once and maps page-specific findings across three pages', async () => {
    const baseUrl = await makeFixtureSite();
    const crawled = await crawlSite(baseUrl, { depth: 1, requestDelayMs: 0 });
    expect(crawled.pages.map((page) => new URL(page.url).pathname).sort()).toEqual(['/', '/about', '/contact']);

    const analysisCalls = new Map<string, number>();
    const analyzed = await analyzeCrawledSite(crawled, async (source) => {
      analysisCalls.set(source.code, (analysisCalls.get(source.code) || 0) + 1);
      if (source.code.includes('COMMON_BUNDLE')) return [detection('common-package')];
      if (source.code.includes('HOME_ONLY')) return [detection('home-package')];
      return [];
    });

    expect(analysisCalls.get(`globalThis.common='COMMON_BUNDLE'; import('./shared-chunk.js');`)).toBe(1);
    expect(analyzed.assetsAnalyzed).toBe(crawled.assets.length);
    const commonHash = crawled.assets.find((asset) => asset.code.includes('COMMON_BUNDLE'))?.hash;
    expect(commonHash).toBeTruthy();
    expect(crawled.pages.filter((page) => page.assetHashes.includes(commonHash!))).toHaveLength(3);
    expect(analyzed.pages.find((page) => new URL(page.url).pathname === '/')?.packages?.map((item) => item.name).sort())
      .toEqual(['common-package', 'home-package']);
    expect(analyzed.pages.filter((page) => new URL(page.url).pathname !== '/')
      .every((page) => page.packages?.some((item) => item.name === 'common-package'))).toBe(true);
    expect(analyzed.packages.find((item) => item.name === 'common-package')?.pagesSeen).toHaveLength(3);
  });

  it('keeps depth zero to the requested page and normalizes URL variants deterministically', async () => {
    const baseUrl = await makeFixtureSite();
    const shallow = await crawlSite(baseUrl, { depth: 0, requestDelayMs: 0 });
    expect(shallow.pages).toHaveLength(1);
    expect(new URL(shallow.pages[0].url).pathname).toBe('/');
    expect(normalizeCrawlUrl(`${baseUrl}/about?b=2&a=3&a=1#section`))
      .toBe(`${baseUrl}/about?a=1&a=3&b=2`);
  });

  it('discovers chunk URLs from generic lazy-load mapping tables', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'debun-crawl-map-'));
    await mkdir(join(temporaryDirectory, 'assets'), { recursive: true });
    await writeFile(join(temporaryDirectory, 'index.html'), '<script src="/assets/loader.js"></script>');
    await writeFile(join(temporaryDirectory, 'assets', 'loader.js'), 'const chunkTable={"route":"/assets/lazy-route.js"}; loadChunk(chunkTable[requestedRoute]);');
    await writeFile(join(temporaryDirectory, 'assets', 'lazy-route.js'), 'globalThis.lazyRoute="MAPPED_LAZY_CHUNK";');
    server = createStaticServer(temporaryDirectory);
    const crawled = await crawlSite(await server.listen(), { depth: 0, requestDelayMs: 0 });
    expect(crawled.assets.some((asset) => asset.urls.some((url) => url.endsWith('/assets/lazy-route.js')))).toBe(true);
    expect(crawled.assets.some((asset) => asset.code.includes('MAPPED_LAZY_CHUNK'))).toBe(true);
  });

  it('flags conflicting exact package versions found on different pages', async () => {
    const baseUrl = await makeFixtureSite();
    const crawled = await crawlSite(baseUrl, { depth: 1, requestDelayMs: 0 });
    const analyzed = await analyzeCrawledSite(crawled, async (source) => {
      if (source.code.includes('COMMON_BUNDLE')) return [detection('shared-package', '1.2.3')];
      if (source.code.includes('HOME_ONLY')) return [detection('shared-package', '2.0.0')];
      return [];
    });
    const shared = analyzed.packages.find((item) => item.name === 'shared-package');
    expect(shared).toMatchObject({ version: 'unknown', tier: 'possible', versionConsensus: 'inconsistent' });
    expect(shared?.conflictingVersions).toEqual(['1.2.3', '2.0.0']);
  });

  it('obeys robots rules and crosses origins only when a domain is explicitly allowed', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'debun-crawl-scope-'));
    const mainDirectory = join(temporaryDirectory, 'main');
    const otherDirectory = join(temporaryDirectory, 'other');
    await mkdir(mainDirectory, { recursive: true });
    await mkdir(otherDirectory, { recursive: true });
    await writeFile(join(mainDirectory, 'index.html'), '<a href="/blocked.html">Blocked by robots</a><a href="EXTERNAL_URL">Allowed only by domain option</a>');
    await writeFile(join(mainDirectory, 'robots.txt'), 'User-agent: *\nDisallow: /blocked');
    await writeFile(join(mainDirectory, 'blocked.html'), '<title>blocked</title>');
    await writeFile(join(otherDirectory, 'index.html'), '<title>external</title>');
    server = createStaticServer(mainDirectory);
    secondServer = createStaticServer(otherDirectory);
    const mainUrl = await server.listen();
    const otherUrl = await secondServer.listen();
    await writeFile(join(mainDirectory, 'index.html'), `<a href="/blocked.html">Blocked by robots</a><a href="${otherUrl}/">Allowed only by domain option</a>`);

    const restricted = await crawlSite(mainUrl, { depth: 1, requestDelayMs: 0 });
    expect(restricted.pages).toHaveLength(1);
    const extended = await crawlSite(mainUrl, { depth: 1, requestDelayMs: 0, allowDomains: ['127.0.0.1'] });
    expect(extended.pages.map((page) => page.url)).toContain(`${otherUrl}/`);
    expect(extended.pages.some((page) => page.url.includes('blocked.html'))).toBe(false);
  });

  it('stops page and asset expansion at the configured byte cap', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'debun-crawl-cap-'));
    await writeFile(join(temporaryDirectory, 'index.html'), '<script src="/large.js"></script><a href="/child">Child</a>');
    await writeFile(join(temporaryDirectory, 'child'), '<title>child</title>');
    await writeFile(join(temporaryDirectory, 'large.js'), 'globalThis.largeBundle = "more bytes than the test cap";');
    server = createStaticServer(temporaryDirectory);
    const result = await crawlSite(await server.listen(), { depth: 1, maxAssetBytes: 8, requestDelayMs: 0 });
    expect(result.pages).toHaveLength(1);
    expect(result.stoppedReason).toContain('Asset byte cap reached');
  });

  it('writes a multi-page JSON report from the analyze CLI flags', async () => {
    const baseUrl = await makeFixtureSite();
    const output = join(temporaryDirectory, 'crawl-report.json');
    const database = join(temporaryDirectory, 'crawl-cache.sqlite');
    const exitCode = await runAnalysisCli([
      baseUrl, '--depth', '1', '--offline', '--database', database, '--output', output,
    ]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.crawl).toMatchObject({ depth: 1, pagesVisited: 3 });
    expect(report.pages.map((page: any) => new URL(page.url).pathname).sort()).toEqual(['/', '/about', '/contact']);
    expect(report.pages.find((page: any) => new URL(page.url).pathname === '/')?.packages).toBeDefined();

    const rootEntryOutput = join(temporaryDirectory, 'root-entry-report.json');
    const rootEntryDatabase = join(temporaryDirectory, 'root-entry-cache.sqlite');
    const rootEntry = await runRootCli([
      baseUrl, '--depth', '1', '--offline', '--database', rootEntryDatabase, '--request-delay-ms', '0', '--output', rootEntryOutput,
    ]);
    expect(rootEntry.code, rootEntry.output).toBe(0);
    const rootEntryReport = JSON.parse(await readFile(rootEntryOutput, 'utf8'));
    expect(rootEntryReport.pages).toHaveLength(3);
  }, 20_000);
});
