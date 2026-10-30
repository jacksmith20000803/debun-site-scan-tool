declare const require: (name: string) => any;

import type { BundleSource, PackageDetection } from './types';
import { satisfies } from './semver';
import { parseWithBabel, walkAst } from './parser';

const cheerio = require('cheerio');
const crypto = require('node:crypto');
const BufferCtor = require('node:buffer').Buffer;

const DEFAULT_ASSET_LIMIT = 50 * 1024 * 1024;
const MAX_ASSETS = 2_000;
const MAX_REDIRECTS = 8;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CrawlSiteOptions {
  depth?: number;
  allowDomains?: string[];
  maxAssetBytes?: number;
  pageConcurrency?: number;
  assetConcurrency?: number;
  requestDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string, init?: any) => Promise<any>;
  onLog?: (message: string) => void;
}

export interface CrawlAsset {
  hash: string;
  code: string;
  sourceFile: string;
  byteLength: number;
  urls: string[];
  pages: string[];
}

export interface CrawlPage {
  url: string;
  depth: number;
  title: string | null;
  linksDiscovered: number;
  assetHashes: string[];
  packages?: PackageDetection[];
  error?: string;
}

export interface CrawlResult {
  requestedUrl: string;
  depth: number;
  maxPages: number;
  maxAssetBytes: number;
  assetBytes: number;
  assets: CrawlAsset[];
  pages: CrawlPage[];
  linksDiscovered: number;
  stoppedReason: string | null;
  warnings: string[];
  urlNormalization: string;
}

export interface PackagePageFinding extends PackageDetection {
  pagesSeen: string[];
  versionConsensus: 'consistent' | 'inconsistent' | 'unknown';
  conflictingVersions?: string[];
}

export interface CrawlAnalysisResult extends CrawlResult {
  packages: PackagePageFinding[];
  assetsAnalyzed: number;
}

type MutablePage = CrawlPage & { assetHashSet: Set<string> };

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value as number)) : fallback;
}

/** Strip fragments; sort query pairs by key then value, retaining repeated pairs. */
export function normalizeCrawlUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    const pairs = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = '';
    for (const [key, item] of pairs) url.searchParams.append(key, item);
    return url.toString();
  } catch (_) {
    return null;
  }
}

function normalizedDomain(value: string): string | null {
  const text = String(value || '').trim().replace(/^\*\./, '');
  if (!text) return null;
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function isAllowedUrl(value: string, startOrigin: string, allowedDomains: Set<string>): boolean {
  try {
    const url = new URL(value);
    if (url.origin === startOrigin) return true;
    const hostname = url.hostname.toLowerCase();
    return [...allowedDomains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch (_) {
    return false;
  }
}

function isPageLink(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return !/\.(?:7z|avi|bmp|css|csv|docx?|eot|gif|gz|ico|jpe?g|mp[34]|pdf|png|pptx?|rar|svg|tar|ttf|txt|wasm|webm|webp|woff2?|xlsx?|xml|zip)$/.test(pathname);
  } catch (_) {
    return false;
  }
}

function isJavaScriptUrl(value: string): boolean {
  try { return /\.(?:c|m)?js$/i.test(new URL(value).pathname); } catch (_) { return false; }
}

function javascriptUrl(value: string, baseUrl: string): string | null {
  const normalized = normalizeCrawlUrl(value, baseUrl);
  return normalized && isJavaScriptUrl(normalized) ? normalized : null;
}

function extractJsReferences(code: string, baseUrl: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"])([^'"]+)\1\s*\)/g,
    /\bfetch\s*\(\s*(['"])([^'"]+\.m?js(?:\?[^'"]*)?)\1/g,
    /\.(?:open)\s*\(\s*['"][^'"]+['"]\s*,\s*(['"])([^'"]+\.m?js(?:\?[^'"]*)?)\1/gi,
    /(?:src|chunk|chunkName|chunkUrl|chunkURL)\s*[:=]\s*(['"])([^'"]+\.m?js(?:\?[^'"]*)?)\1/gi,
    /(['"])((?:https?:\/\/|\/|\.\.?\/|(?:static|assets|chunks?)\/)[^'"]+\.m?js(?:\?[^'"]*)?)\1/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
      const raw = match[2];
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) continue;
      const candidate = /\.m?js(?:[?#]|$)/i.test(raw) ? raw : /^\.{1,2}\//.test(raw) ? `${raw}.js` : null;
      if (!candidate) continue;
      const resolved = javascriptUrl(candidate, baseUrl);
      if (resolved) found.add(resolved);
    }
  }

  // Some runtimes store chunk paths in lookup tables and pass an ID to a
  // generic loader. Collect JS path literals from those tables when a call
  // references the table; module IDs remain implementation details and are
  // never exposed to package scoring.
  try {
    const parsed = parseWithBabel(code);
    const tables = new Map<string, string[]>();
    const candidateStrings = (node: any): string[] => {
      const values = new Set<string>();
      walkAst(node, (child) => {
        const value = child?.type === 'StringLiteral' || child?.type === 'Literal' && typeof child.value === 'string'
          ? child.value
          : child?.type === 'TemplateLiteral' && child.expressions?.length === 0 ? child.quasis?.[0]?.value?.cooked : undefined;
        if (typeof value === 'string' && /\.m?js(?:[?#]|$)/i.test(value)) values.add(value);
      });
      return [...values];
    };
    walkAst(parsed.program, (node) => {
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init
        && ['ObjectExpression', 'ArrayExpression'].includes(node.init.type)) {
        const values = candidateStrings(node.init);
        if (values.length) tables.set(node.id.name, values);
      }
    });
    walkAst(parsed.program, (node) => {
      if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
      for (const raw of candidateStrings(node)) {
        if (!raw.startsWith('data:') && !raw.startsWith('blob:')) {
          const resolved = javascriptUrl(raw, baseUrl);
          if (resolved) found.add(resolved);
        }
      }
      const argumentIdentifiers = new Set<string>();
      for (const argument of node.arguments || []) walkAst(argument, (child) => {
        if (child.type === 'Identifier') argumentIdentifiers.add(child.name);
      });
      for (const identifier of argumentIdentifiers) {
        for (const raw of tables.get(identifier) || []) {
          const resolved = javascriptUrl(raw, baseUrl);
          if (resolved) found.add(resolved);
        }
      }
    });
  } catch (_) {
    // Regex extraction above still handles explicit static paths when parsing fails.
  }
  return [...found];
}

function extractHtml(html: string, baseUrl: string): { links: string[]; assets: string[]; inlineScripts: string[]; title: string | null } {
  const $ = cheerio.load(html || '');
  const links = new Set<string>();
  const assets = new Set<string>();
  const inlineScripts: string[] = [];
  $('a[href]').each((_index: number, element: any) => {
    const value = normalizeCrawlUrl($(element).attr('href') || '', baseUrl);
    if (value && isPageLink(value)) links.add(value);
  });
  $('script').each((_index: number, element: any) => {
    const src = $(element).attr('src');
    if (src) {
      const value = normalizeCrawlUrl(src, baseUrl);
      if (value) assets.add(value);
    } else {
      const code = $(element).html() || '';
      if (code.trim()) inlineScripts.push(code);
    }
  });
  $('link[href]').each((_index: number, element: any) => {
    const rel = String($(element).attr('rel') || '').toLowerCase().split(/\s+/);
    const as = String($(element).attr('as') || '').toLowerCase();
    const type = String($(element).attr('type') || '').toLowerCase();
    const href = $(element).attr('href') || '';
    const moduleExtension = /\.(?:css|json|wasm|woff2?|ttf)(?:[?#]|$)/i.test(href);
    const isModulePreload = rel.includes('modulepreload') && !moduleExtension;
    const isScriptPreload = rel.includes('preload') && (as === 'script' || /javascript|ecmascript/.test(type) || /\.(?:c|m)?js(?:[?#]|$)/i.test(href));
    if (!isModulePreload && !isScriptPreload) return;
    const value = normalizeCrawlUrl(href, baseUrl);
    if (value) assets.add(value);
  });
  const pageOrigin = new URL(baseUrl).origin;
  for (const script of inlineScripts) {
    for (const value of extractJsReferences(script, baseUrl)) {
      if (new URL(value).origin === pageOrigin) assets.add(value);
    }
  }
  return {
    links: [...links],
    assets: [...assets],
    inlineScripts,
    title: $('title').first().text().trim() || null,
  };
}

function parseRobots(text: string): Array<{ allow: boolean; path: string }> {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }>; hasRules: boolean }> = [];
  let group: (typeof groups)[number] | null = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    if (!line) continue;
    const split = line.indexOf(':');
    if (split < 0) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
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
  const exact = groups.filter((entry) => entry.agents.includes('debun-plus'));
  const selected = exact.length ? exact : groups.filter((entry) => entry.agents.includes('*'));
  return selected.flatMap((entry) => entry.rules);
}

function robotsAllows(url: string, rules: Array<{ allow: boolean; path: string }>): boolean {
  let winner: { allow: boolean; path: string } | null = null;
  const target = `${new URL(url).pathname}${new URL(url).search}`;
  for (const rule of rules) {
    const anchored = rule.path.endsWith('$');
    const raw = anchored ? rule.path.slice(0, -1) : rule.path;
    const escaped = raw.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*');
    if (!new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(target)) continue;
    if (!winner || raw.length > winner.path.length || (raw.length === winner.path.length && rule.allow && !winner.allow)) winner = { ...rule, path: raw };
  }
  return !winner || winner.allow;
}

class PoliteScheduler {
  private tails = new Map<string, Promise<unknown>>();
  private lastStarted = new Map<string, number>();
  constructor(private readonly delayMs: number) {}
  async run<T>(hostname: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(hostname) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const waitMs = this.delayMs - (Date.now() - (this.lastStarted.get(hostname) || 0));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastStarted.set(hostname, Date.now());
      return work();
    });
    this.tails.set(hostname, current.catch(() => undefined));
    return current;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await work(items[index], index);
    }
  }));
  return output;
}

class AssetByteLimitError extends Error {}

async function readResponse(response: any, maxBytes: number, consume?: (bytes: number) => boolean): Promise<Uint8Array> {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new AssetByteLimitError(`Response exceeds ${maxBytes} byte limit.`);
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes || (consume && !consume(data.byteLength))) throw new AssetByteLimitError('The asset byte cap was reached.');
    return data;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (size + chunk.byteLength > maxBytes || (consume && !consume(chunk.byteLength))) {
        await reader.cancel().catch(() => undefined);
        throw new AssetByteLimitError('The asset byte cap was reached.');
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function crawlSite(startUrl: string, options: CrawlSiteOptions = {}): Promise<CrawlResult> {
  const depth = clampInteger(options.depth, 0, 0, 3);
  if (depth !== (options.depth ?? 0)) throw new Error('--depth must be an integer from 0 to 3.');
  const requestedUrl = normalizeCrawlUrl(startUrl);
  if (!requestedUrl) throw new Error(`Invalid HTTP(S) URL: ${startUrl}`);
  const startOrigin = new URL(requestedUrl).origin;
  const normalizedDomains = (options.allowDomains || []).map(normalizedDomain);
  if (normalizedDomains.some((value) => !value)) throw new Error('Every --allow-domain value must be a valid hostname or HTTP(S) URL.');
  const allowedDomains = new Set(normalizedDomains.filter((value): value is string => Boolean(value)));
  const maxPages = depth === 0 ? 1 : depth * 20;
  const maxAssetBytes = Number.isFinite(options.maxAssetBytes) && (options.maxAssetBytes as number) > 0
    ? Math.floor(options.maxAssetBytes as number) : DEFAULT_ASSET_LIMIT;
  const pageConcurrency = clampInteger(options.pageConcurrency, 4, 1, 4);
  const assetConcurrency = clampInteger(options.assetConcurrency, 8, 1, 8);
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60_000);
  const requestDelayMs = Math.max(0, Number.isFinite(options.requestDelayMs) ? options.requestDelayMs as number : 250);
  const fetchImpl = options.fetchImpl || globalThis.fetch as any;
  const onLog = options.onLog || (() => undefined);
  const scheduler = new PoliteScheduler(requestDelayMs);
  const robotsCache = new Map<string, Promise<Array<{ allow: boolean; path: string }>>>();
  const pages: MutablePage[] = [];
  const pagesByKey = new Map<string, MutablePage>();
  const requestedAliases = new Set<string>();
  const assetsByHash = new Map<string, CrawlAsset>();
  const assetOwners = new Map<string, Set<string>>();
  const urlToHash = new Map<string, string>();
  const dynamicChildren = new Map<string, Set<string>>();
  const fetchedAssetUrls = new Set<string>();
  const warnings: string[] = [];
  const discoveredPageLinks = new Set<string>();
  let assetBytes = 0;
  let assetCapReached = false;
  let assetCountLimitReached = false;

  const assertScope = (url: string) => {
    if (!isAllowedUrl(url, startOrigin, allowedDomains)) throw new Error(`Skipped out-of-scope URL: ${url}`);
  };

  const politeFetch = async (url: string, init: any) => scheduler.run(new URL(url).hostname.toLowerCase(), () => fetchImpl(url, init));

  const request = async (url: string, kind: 'page' | 'asset' | 'robots', budget?: number): Promise<{ finalUrl: string; response: any; bytes: Uint8Array }> => {
    let current = normalizeCrawlUrl(url);
    if (!current) throw new Error(`Invalid request URL: ${url}`);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      assertScope(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: any;
      try {
        response = await politeFetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'debun-plus/1.0 (+https://npmjs.com/package/debun-plus)', accept: kind === 'page' ? 'text/html,application/xhtml+xml,*/*;q=0.5' : '*/*' },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get?.('location');
          await response.body?.cancel?.().catch?.(() => undefined);
          if (!location) throw new Error(`Redirect from ${current} did not include a Location header.`);
          const next = normalizeCrawlUrl(location, current);
          if (!next) throw new Error(`Redirect from ${current} used an unsupported URL.`);
          assertScope(next);
          current = next;
          continue;
        }
        const max = kind === 'page' ? MAX_PAGE_BYTES : kind === 'robots' ? MAX_ROBOTS_BYTES : Math.max(0, budget || 0);
        const bytes = await readResponse(response, max, kind === 'asset' ? (size) => {
          if (assetBytes + size > maxAssetBytes) {
            assetCapReached = true;
            return false;
          }
          assetBytes += size;
          if (assetBytes >= maxAssetBytes) assetCapReached = true;
          return true;
        } : undefined);
        return { finalUrl: current, response, bytes };
      } catch (error) {
        if (kind === 'asset' && error instanceof AssetByteLimitError) assetCapReached = true;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Too many redirects while loading ${url}.`);
  };

  const rulesFor = (url: string): Promise<Array<{ allow: boolean; path: string }>> => {
    const origin = new URL(url).origin;
    let promise = robotsCache.get(origin);
    if (!promise) {
      promise = (async () => {
        const robotsUrl = new URL('/robots.txt', origin).toString();
        try {
          const result = await request(robotsUrl, 'robots', MAX_ROBOTS_BYTES);
          if (result.response.status === 404 || result.response.status === 410 || (result.response.status >= 400 && result.response.status < 500)) return [];
          if (!result.response.ok) throw new Error(`robots.txt returned HTTP ${result.response.status}.`);
          return parseRobots(BufferCtor.from(result.bytes).toString('utf8'));
        } catch (error) {
          warnings.push(`Could not read robots.txt for ${origin}; pages on that origin were skipped: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      })();
      robotsCache.set(origin, promise);
    }
    return promise;
  };

  const allowedByRobots = async (url: string): Promise<boolean> => {
    try { return robotsAllows(url, await rulesFor(url)); }
    catch (_) { return false; }
  };

  const addOwner = (assetUrl: string, ownerKeys: Iterable<string>): void => {
    const normalized = normalizeCrawlUrl(assetUrl);
    if (!normalized) return;
    let owners = assetOwners.get(normalized);
    if (!owners) { owners = new Set(); assetOwners.set(normalized, owners); }
    const newlyAdded: string[] = [];
    for (const owner of ownerKeys) if (!owners.has(owner)) { owners.add(owner); newlyAdded.push(owner); }
    const hash = urlToHash.get(normalized);
    if (hash && newlyAdded.length) {
      for (const owner of newlyAdded) {
        const page = pagesByKey.get(owner);
        if (page) page.assetHashSet.add(hash);
        const asset = assetsByHash.get(hash);
        if (asset && page && !asset.pages.includes(page.url)) asset.pages.push(page.url);
      }
      const children = dynamicChildren.get(normalized) || new Set<string>();
      for (const child of children) {
        const scopedOwners = newlyAdded.filter((owner) => {
          const page = pagesByKey.get(owner);
          return page && new URL(child).origin === new URL(page.url).origin;
        });
        if (scopedOwners.length) addOwner(child, scopedOwners);
      }
    }
  };

  const registerInline = (code: string, page: MutablePage, index: number): void => {
    const bytes = BufferCtor.byteLength(code, 'utf8');
    if (assetBytes + bytes > maxAssetBytes) {
      assetCapReached = true;
      return;
    }
    assetBytes += bytes;
    if (assetBytes >= maxAssetBytes) assetCapReached = true;
    const content = new Uint8Array(BufferCtor.from(code, 'utf8'));
    const hash = sha256(content);
    let asset = assetsByHash.get(hash);
    if (!asset) {
      asset = { hash, code, sourceFile: `${page.url}#inline-${index}`, byteLength: bytes, urls: [], pages: [page.url] };
      assetsByHash.set(hash, asset);
    } else if (!asset.pages.includes(page.url)) asset.pages.push(page.url);
    page.assetHashSet.add(hash);
    const refs = extractJsReferences(code, page.url).filter((value) => new URL(value).origin === new URL(page.url).origin);
    const synthetic = `${page.url}#inline-${index}`;
    dynamicChildren.set(synthetic, new Set(refs));
    for (const ref of refs) addOwner(ref, [page.url]);
  };

  const processAssets = async (initialUrls: string[]): Promise<void> => {
    let pending = [...new Set(initialUrls)];
    while (pending.length && !assetCapReached && !assetCountLimitReached) {
      const unfetched = pending.filter((url) => !fetchedAssetUrls.has(url));
      const assetCapacity = Math.max(0, MAX_ASSETS - fetchedAssetUrls.size);
      const batch = unfetched.slice(0, assetCapacity);
      if (unfetched.length > batch.length) assetCountLimitReached = true;
      if (!batch.length) {
        if (unfetched.length) assetCountLimitReached = true;
        break;
      }
      for (const url of batch) fetchedAssetUrls.add(url);
      const outcomes = await mapLimit(batch, assetConcurrency, async (url) => {
        try {
          assertScope(url);
          if (!await allowedByRobots(url)) throw new Error(`Blocked by robots.txt: ${url}`);
          const result = await request(url, 'asset', maxAssetBytes);
          if (!result.response.ok) throw new Error(`HTTP ${result.response.status} while loading ${url}.`);
          const type = String(result.response.headers?.get?.('content-type') || '').toLowerCase();
          const code = BufferCtor.from(result.bytes).toString('utf8').replace(/^\uFEFF/, '');
          if (!/(?:javascript|ecmascript)/.test(type) && !isJavaScriptUrl(result.finalUrl) && !isJavaScriptUrl(url)) return { url, finalUrl: result.finalUrl, code: null, bytes: result.bytes.byteLength };
          return { url, finalUrl: result.finalUrl, code, bytes: result.bytes.byteLength };
        } catch (error) {
          if (!(error instanceof AssetByteLimitError) && !assetCapReached) warnings.push(`Could not load JavaScript asset ${url}: ${error instanceof Error ? error.message : String(error)}`);
          return { url, finalUrl: url, code: null, bytes: 0 };
        }
      });
      const next = new Set<string>();
      for (const result of outcomes) {
        if (!result.code) continue;
        const bytes = new Uint8Array(BufferCtor.from(result.code, 'utf8'));
        const hash = sha256(bytes);
        urlToHash.set(result.url, hash);
        urlToHash.set(result.finalUrl, hash);
        const ownerSet = assetOwners.get(result.url) || new Set<string>();
        let asset = assetsByHash.get(hash);
        if (!asset) {
          asset = { hash, code: result.code, sourceFile: result.finalUrl, byteLength: result.bytes, urls: [], pages: [] };
          assetsByHash.set(hash, asset);
        }
        for (const value of [result.url, result.finalUrl]) if (!asset.urls.includes(value)) asset.urls.push(value);
        for (const owner of ownerSet) {
          const page = pagesByKey.get(owner);
          if (page) {
            page.assetHashSet.add(hash);
            if (!asset.pages.includes(page.url)) asset.pages.push(page.url);
          }
        }
        const dynamicRefs = extractJsReferences(result.code, result.finalUrl);
        dynamicChildren.set(result.url, new Set(dynamicRefs));
        dynamicChildren.set(result.finalUrl, new Set(dynamicRefs));
        for (const ref of dynamicRefs) {
          const scopedOwners = [...ownerSet].filter((owner) => {
            const page = pagesByKey.get(owner);
            return page && new URL(ref).origin === new URL(page.url).origin;
          });
          if (scopedOwners.length) {
            addOwner(ref, scopedOwners);
            if (!fetchedAssetUrls.has(ref)) next.add(ref);
          }
        }
      }
      pending = [...next];
      if (assetCountLimitReached) break;
    }
  };

  let frontier = [{ url: requestedUrl, depth: 0 }];
  while (frontier.length && pages.length < maxPages && !assetCapReached) {
    const remaining = maxPages - pages.length;
    const frontierBatch = frontier.filter(({ url }) => !requestedAliases.has(url)).slice(0, remaining);
    if (!frontierBatch.length) break;
    for (const item of frontierBatch) requestedAliases.add(item.url);
    const outcomes = await mapLimit(frontierBatch, pageConcurrency, async ({ url, depth: pageDepth }) => {
      try {
        assertScope(url);
        if (!await allowedByRobots(url)) throw new Error(`Blocked by robots.txt: ${url}`);
        const result = await request(url, 'page', MAX_PAGE_BYTES);
        if (!result.response.ok) throw new Error(`HTTP ${result.response.status} while loading ${url}.`);
        if (!await allowedByRobots(result.finalUrl)) throw new Error(`Blocked by robots.txt after redirect: ${result.finalUrl}`);
        const html = BufferCtor.from(result.bytes).toString('utf8');
        const extracted = extractHtml(html, result.finalUrl);
        return { requested: url, pageDepth, result, html, extracted, error: null as string | null };
      } catch (error) {
        return { requested: url, pageDepth, result: null, html: '', extracted: null, error: error instanceof Error ? error.message : String(error) };
      }
    });
    const nextFrontier = new Map<string, { url: string; depth: number }>();
    const assetUrls: string[] = [];
    for (const outcome of outcomes) {
      if (!outcome.result || !outcome.extracted) {
        const page: MutablePage = { url: outcome.requested, depth: outcome.pageDepth, title: null, linksDiscovered: 0, assetHashes: [], assetHashSet: new Set(), error: outcome.error || 'Page could not be scanned.' };
        if (!pagesByKey.has(page.url)) { pagesByKey.set(page.url, page); pages.push(page); }
        warnings.push(`Could not scan page ${outcome.requested}: ${outcome.error}`);
        continue;
      }
      const finalUrl = normalizeCrawlUrl(outcome.result.finalUrl) as string;
      const finalKey = finalUrl;
      requestedAliases.add(outcome.requested);
      if (pagesByKey.has(finalKey)) continue;
      const page: MutablePage = {
        url: finalUrl,
        depth: outcome.pageDepth,
        title: outcome.extracted.title,
        linksDiscovered: 0,
        assetHashes: [],
        assetHashSet: new Set(),
      };
      pagesByKey.set(finalKey, page);
      pagesByKey.set(outcome.requested, page);
      pages.push(page);
      const owner = [finalKey];
      for (const rawUrl of outcome.extracted.assets) {
        const value = normalizeCrawlUrl(rawUrl);
        if (!value || !isAllowedUrl(value, startOrigin, allowedDomains)) continue;
        addOwner(value, owner);
        assetUrls.push(value);
      }
      outcome.extracted.inlineScripts.forEach((script, index) => registerInline(script, page, index + 1));
      page.linksDiscovered = outcome.extracted.links.length;
      for (const rawLink of outcome.extracted.links) {
        const link = normalizeCrawlUrl(rawLink);
        if (!link || !isAllowedUrl(link, startOrigin, allowedDomains)) continue;
        discoveredPageLinks.add(link);
        if (outcome.pageDepth >= depth || pages.length + nextFrontier.size >= maxPages) continue;
        if (requestedAliases.has(link) || !await allowedByRobots(link)) continue;
        nextFrontier.set(link, { url: link, depth: outcome.pageDepth + 1 });
      }
    }
    await processAssets(assetUrls);
    if (assetCapReached || assetCountLimitReached) break;
    frontier = [...nextFrontier.values()];
  }

  if (assetCapReached) {
    const size = `${(maxAssetBytes / (1024 * 1024)).toFixed(1)} MB`;
    warnings.push(`Asset byte cap reached (${size}); additional asset and page expansion was aborted.`);
  }
  if (assetCountLimitReached) warnings.push(`Asset reference cap reached (${MAX_ASSETS}); additional asset expansion was aborted.`);
  const finalizedPages = pages.map((page) => {
    const { assetHashSet, ...item } = page;
    return { ...item, assetHashes: [...assetHashSet].sort() };
  });
  const finalizedAssets = [...assetsByHash.values()].map((asset) => ({ ...asset, urls: [...new Set(asset.urls)].sort(), pages: [...new Set(asset.pages)].sort() }));
  onLog(`Crawled ${finalizedPages.length} page(s), fetched ${finalizedAssets.length} unique JavaScript bundle(s), and read ${assetBytes} asset bytes.`);
  return {
    requestedUrl,
    depth,
    maxPages,
    maxAssetBytes,
    assetBytes,
    assets: finalizedAssets,
    pages: finalizedPages,
    linksDiscovered: discoveredPageLinks.size,
    stoppedReason: assetCapReached ? `Asset byte cap reached (${(maxAssetBytes / (1024 * 1024)).toFixed(1)} MB).` : assetCountLimitReached ? `Asset reference cap reached (${MAX_ASSETS}).` : null,
    warnings,
    urlNormalization: 'Fragments removed; query parameter pairs sorted by key then value; duplicate pairs retained; path and trailing slash preserved.',
  };
}

function mergePagePackages(detections: PackageDetection[], pagesSeen: string[]): PackagePageFinding[] {
  const byName = new Map<string, PackageDetection[]>();
  for (const detection of detections) {
    const key = detection.name.toLowerCase();
    const group = byName.get(key) || [];
    group.push(detection);
    byName.set(key, group);
  }
  return [...byName.values()].map<PackagePageFinding>((group) => {
    const exactVersions = [...new Set(group.filter((item) => item.tier === 'exact').map((item) => item.version))].sort();
    const ranges = [...new Set(group.filter((item) => item.tier === 'range').map((item) => item.version))].sort();
    const exactConflictsWithRange = exactVersions.length === 1 && ranges.some((range) => !satisfies(exactVersions[0], range));
    const priorInconsistency = group.some((item) => (item as PackagePageFinding).versionConsensus === 'inconsistent');
    const inheritedVersions = group.flatMap((item) => (item as PackagePageFinding).conflictingVersions || []);
    const inconsistent = priorInconsistency || exactVersions.length > 1 || ranges.length > 1 || exactConflictsWithRange;
    const exact = !inconsistent && exactVersions.length === 1;
    const range = !inconsistent && !exact && ranges.length === 1;
    const best = [...group].sort((left, right) => right.score - left.score)[0];
    const versions = [...new Set([...exactVersions, ...ranges, ...inheritedVersions])].sort();
    const evidence = new Map<string, PackageDetection['evidence'][number]>();
    for (const item of group) for (const entry of item.evidence) evidence.set(`${entry.source}\0${entry.detail}\0${entry.version || ''}`, entry);
    if (inconsistent) {
      const name = best.name;
      const detail = `Conflicting page-level package versions: ${versions.join(', ') || 'incompatible ranges'}.`;
      evidence.set(`registry-fingerprint\0${detail}`, { source: 'registry-fingerprint', detail });
      return {
        ...best,
        name,
        version: 'unknown',
        tier: 'possible' as const,
        score: Math.max(...group.map((item) => item.score)),
        margin: Math.min(...group.map((item) => item.margin)),
        evidence: [...evidence.values()],
        dependencies: Object.assign({}, ...group.map((item) => item.dependencies)),
        pagesSeen: [...new Set(pagesSeen)].sort(),
        versionConsensus: 'inconsistent' as const,
        conflictingVersions: versions,
      };
    }
    return {
      ...best,
      version: exact ? exactVersions[0] : range ? ranges[0] : 'unknown',
      tier: exact ? 'exact' as const : range ? 'range' as const : 'possible' as const,
      score: Math.max(...group.map((item) => item.score)),
      margin: Math.min(...group.map((item) => item.margin)),
      evidence: [...evidence.values()],
      dependencies: Object.assign({}, ...group.map((item) => item.dependencies)),
      pagesSeen: [...new Set(pagesSeen)].sort(),
      versionConsensus: exact || range ? 'consistent' as const : 'unknown' as const,
    };
  }).sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

export async function analyzeCrawledSite(
  crawl: CrawlResult,
  analyzeSource: (source: BundleSource) => Promise<PackageDetection[]>,
  analysisConcurrency = 2,
): Promise<CrawlAnalysisResult> {
  const perAsset = await mapLimit(crawl.assets, Math.max(1, Math.min(4, analysisConcurrency)), async (asset) => ({
    hash: asset.hash,
    detections: await analyzeSource({ url: asset.sourceFile, code: asset.code }),
  }));
  const detectionsByHash = new Map(perAsset.map((item) => [item.hash, item.detections]));
  const pages = crawl.pages.map((page) => {
    const detections = page.assetHashes.flatMap((hash) => detectionsByHash.get(hash) || []);
    const packages = mergePagePackages(detections, [page.url]);
    return { ...page, packages };
  });
  const allDetections = pages.flatMap((page) => page.packages);
  const pagesByPackage = new Map<string, string[]>();
  for (const page of pages) for (const item of page.packages) {
    const key = item.name.toLowerCase();
    const found = pagesByPackage.get(key) || [];
    found.push(page.url);
    pagesByPackage.set(key, found);
  }
  const packages = mergePagePackages(allDetections, []).map((item) => ({
    ...item,
    pagesSeen: [...new Set(pagesByPackage.get(item.name.toLowerCase()) || [])].sort(),
  }));
  return { ...crawl, pages, packages, assetsAnalyzed: perAsset.length };
}
