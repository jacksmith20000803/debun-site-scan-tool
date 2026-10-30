declare const require: (name: string) => any;

import {
  CorpusCache,
  DownloadedTarball,
  PackageDependencyTree,
  RegistryClient,
  RegistryPackument,
  RegistryResourceCacheEntry,
  RegistryResourceKind,
  RegistryVersion,
} from './types';
import { compareSemver, satisfies } from './semver';
import { createSqliteCache } from './sqlite-cache';

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const BufferImpl = require('node:buffer').Buffer;

type FetchLike = (input: string, init?: any) => Promise<any>;

export interface RegistryClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxRetryMs?: number;
  concurrency?: number;
  databasePath?: string;
  tempDir?: string;
  cache?: CorpusCache;
}

export interface NpmRegistryClient extends RegistryClient {
  getPackageMeta(name: string, signal?: AbortSignal): Promise<RegistryPackument | null>;
  downloadTarball(name: string, version: string, signal?: AbortSignal): Promise<DownloadedTarball>;
  getVersionList(name: string, signal?: AbortSignal): Promise<string[]>;
  getDependencyTree(name: string, version: string, maxDepth?: number, signal?: AbortSignal): Promise<PackageDependencyTree>;
  close(): void;
}

const DEFAULTS = { timeoutMs: 15_000, retries: 2, backoffMs: 350, maxRetryMs: 8_000, concurrency: 8 };
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;
const MAX_TAR_ARCHIVE_BYTES = MAX_EXTRACTED_BYTES + 12 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 20_000;
const RETRYABLE_STATUS = new Set([408, 425, 429]);

export function registryMetadataCacheKey(name: string): string {
  return `npm-metadata:${name.trim().toLowerCase()}`;
}

function strongestIntegrity(integrity?: string): string | undefined {
  if (!integrity) return undefined;
  const priority = ['sha512-', 'sha384-', 'sha256-', 'sha1-'];
  const tokens = integrity.trim().split(/\s+/).filter(Boolean);
  for (const prefix of priority) {
    const token = tokens.find((candidate) => candidate.startsWith(prefix));
    if (token) return token;
  }
  return undefined;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function registryTarballCacheKey(integrity: string | undefined, shasum: string | undefined, url: string): string {
  const sri = strongestIntegrity(integrity);
  if (sri) return `npm-tarball:${sri}`;
  if (shasum) return `npm-tarball:sha1-${shasum.toLowerCase()}`;
  return `npm-tarball:url-sha256-${sha256(url)}`;
}

function verifyIntegrity(bytes: Uint8Array, integrity?: string, shasum?: string): boolean {
  const sri = strongestIntegrity(integrity);
  if (sri) {
    const separator = sri.indexOf('-');
    const algorithm = sri.slice(0, separator);
    const expected = sri.slice(separator + 1).split('?')[0];
    const actual = crypto.createHash(algorithm).update(BufferImpl.from(bytes)).digest('base64');
    return actual === expected;
  }
  if (shasum) {
    const actual = crypto.createHash('sha1').update(BufferImpl.from(bytes)).digest('hex');
    return actual.toLowerCase() === shasum.toLowerCase();
  }
  return true;
}

function packageNamePath(name: string): string {
  return encodeURIComponent(name).replace(/^%40/i, '@');
}

function headerValue(response: any, name: string): string | undefined {
  const value = response?.headers?.get?.(name);
  return value ? String(value) : undefined;
}

function boundedInteger(value: number | undefined, fallback: number, max?: number): number {
  const normalized = Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
  return max ? Math.min(max, normalized) : normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try { return await operation(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function readOctal(bytes: Uint8Array): number {
  const text = BufferImpl.from(bytes).toString('utf8').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  if (bytes[0] & 0x80) {
    let value = bytes[0] & 0x7f;
    for (let index = 1; index < bytes.length; index++) value = value * 256 + bytes[index];
    return value;
  }
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readTarString(header: Uint8Array, start: number, end: number): string {
  return BufferImpl.from(header.subarray(start, end)).toString('utf8').replace(/\0.*$/, '').trim();
}

function parsePax(data: Uint8Array): Record<string, string> {
  const text = BufferImpl.from(data).toString('utf8');
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space < 0) break;
    const recordLength = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isInteger(recordLength) || recordLength <= 0) break;
    const recordEnd = Math.min(text.length, offset + recordLength);
    const record = text.slice(space + 1, recordEnd).replace(/\n$/, '');
    const separator = record.indexOf('=');
    if (separator > 0) result[record.slice(0, separator)] = record.slice(separator + 1);
    offset = recordEnd;
  }
  return result;
}

function safeArchivePath(root: string, memberName: string): string | null {
  const normalized = memberName.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return null;
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  const target = path.resolve(root, ...parts);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return target;
}

async function extractTarGzip(
  bytes: Uint8Array,
  name: string,
  version: string,
  tempDir: string,
  cacheKey: string,
  integrity?: string,
): Promise<DownloadedTarball> {
  const archive = zlib.gunzipSync(BufferImpl.from(bytes), { maxOutputLength: MAX_TAR_ARCHIVE_BYTES });
  const safeName = name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 70) || 'package';
  const safeVersion = version.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 50) || 'version';
  const directory = await fs.mkdtemp(path.join(tempDir, `debun-plus-${safeName}-${safeVersion}-`));
  const files: string[] = [];
  let offset = 0;
  let extractedBytes = 0;
  let pendingPath: string | undefined;
  let pendingPax: Record<string, string> = {};

  try {
    while (offset + 512 <= archive.length) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte: number) => byte === 0)) break;
      const headerSize = readOctal(header.subarray(124, 136));
      const bodyStart = offset + 512;
      const bodyEnd = bodyStart + headerSize;
      if (bodyEnd > archive.length) throw new Error('Invalid tarball: member extends beyond archive.');
      const type = String.fromCharCode(header[156] || 48);
      const rawName = readTarString(header, 0, 100);
      const prefix = readTarString(header, 345, 500);
      let memberName = pendingPath || pendingPax.path || [prefix, rawName].filter(Boolean).join('/');
      const memberSize = pendingPax.size ? Number.parseInt(pendingPax.size, 10) : headerSize;
      if (!Number.isFinite(memberSize) || memberSize < 0 || bodyStart + memberSize > archive.length) {
        throw new Error('Invalid tarball: invalid member size.');
      }
      const body = archive.subarray(bodyStart, bodyStart + memberSize);

      if (type === 'x' || type === 'g') {
        pendingPax = { ...pendingPax, ...parsePax(body) };
      } else if (type === 'L') {
        pendingPath = BufferImpl.from(body).toString('utf8').replace(/\0.*$/, '').replace(/\n$/, '');
      } else if (type === '0' || type === '\0' || type === '5') {
        if (pendingPax.path) memberName = pendingPax.path;
        if (pendingPath) memberName = pendingPath;
        const target = safeArchivePath(directory, memberName);
        if (target) {
          if (type === '5' || memberName.endsWith('/')) {
            await fs.mkdir(target, { recursive: true });
          } else {
            extractedBytes += memberSize;
            if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('Tarball exceeds the extraction size limit.');
            if (files.length >= MAX_EXTRACTED_FILES) throw new Error('Tarball exceeds the extracted file count limit.');
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, body);
            files.push(target);
          }
        }
        pendingPath = undefined;
        pendingPax = {};
      } else {
        // Symlinks, hard links, devices and other special members are not materialized.
        pendingPath = undefined;
        pendingPax = {};
      }
      offset = bodyStart + Math.ceil(headerSize / 512) * 512;
    }
    if (!files.length) throw new Error('Tarball contained no extractable files.');
    files.sort();
    const packageFolder = path.join(directory, 'package');
    let packageRoot = directory;
    try { if ((await fs.stat(packageFolder)).isDirectory()) packageRoot = packageFolder; } catch (_) { /* Non-npm tar root. */ }
    return { name, version, directory, packageRoot, files, cacheKey, integrity };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function dependencyEntries(version: RegistryVersion): Array<{ name: string; range: string; type: 'dependency' | 'optional' | 'peer' }> {
  const entries = new Map<string, { name: string; range: string; type: 'dependency' | 'optional' | 'peer' }>();
  for (const [name, range] of Object.entries(version.dependencies || {})) entries.set(name, { name, range, type: 'dependency' });
  for (const [name, range] of Object.entries(version.optionalDependencies || {})) {
    if (!entries.has(name)) entries.set(name, { name, range, type: 'optional' });
  }
  for (const [name, range] of Object.entries(version.peerDependencies || {})) {
    if (!entries.has(name)) entries.set(name, { name, range, type: 'peer' });
  }
  return [...entries.values()];
}

export function createRegistryClient(
  fetchImplOrOptions: FetchLike | RegistryClientOptions = globalThis.fetch as any,
  legacyTimeoutMs = DEFAULTS.timeoutMs,
): NpmRegistryClient {
  const options: RegistryClientOptions = typeof fetchImplOrOptions === 'function'
    ? { fetchImpl: fetchImplOrOptions, timeoutMs: legacyTimeoutMs }
    : fetchImplOrOptions || {};
  const fetchImpl = options.fetchImpl || globalThis.fetch as any;
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULTS.timeoutMs);
  const retries = Math.max(0, Number.isInteger(options.retries) ? options.retries as number : DEFAULTS.retries);
  const backoffMs = Math.max(0, Number.isFinite(options.backoffMs) ? options.backoffMs as number : DEFAULTS.backoffMs);
  const maxRetryMs = boundedInteger(options.maxRetryMs, DEFAULTS.maxRetryMs);
  const concurrency = boundedInteger(options.concurrency, DEFAULTS.concurrency, 8);
  const ownsCache = !options.cache;
  const cache = options.cache || createSqliteCache(options.databasePath);
  const memoryResources = new Map<string, RegistryResourceCacheEntry>();
  const semaphore = new Semaphore(concurrency);
  const metadataInFlight = new Map<string, Promise<RegistryPackument | null>>();
  const extractionInFlight = new Map<string, Promise<DownloadedTarball>>();

  function getResource(key: string): RegistryResourceCacheEntry | null {
    return cache.getRegistryResource?.(key) || memoryResources.get(key) || null;
  }

  function putResource(entry: RegistryResourceCacheEntry): void {
    memoryResources.set(entry.key, entry);
    cache.putRegistryResource?.(entry);
  }

  function cachedBytes(entry: RegistryResourceCacheEntry): Uint8Array {
    return new Uint8Array(zlib.gunzipSync(BufferImpl.from(entry.bodyGzip)));
  }

  async function responseBytes(response: any, limit = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
    const contentLength = Number(headerValue(response, 'content-length') || 0);
    if (contentLength > limit) throw new Error(`Registry response exceeds ${limit} bytes.`);
    let bytes: Uint8Array;
    if (typeof response.arrayBuffer === 'function') bytes = new Uint8Array(await response.arrayBuffer());
    else if (typeof response.text === 'function') bytes = new TextEncoder().encode(await response.text());
    else throw new Error('Registry response has no readable body.');
    if (bytes.byteLength > limit) throw new Error(`Registry response exceeds ${limit} bytes.`);
    return bytes;
  }

  function retryDelay(response: any, attempt: number): number {
    const retryAfter = headerValue(response, 'retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const dateDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(maxRetryMs, dateDelay);
    }
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(maxRetryMs, Math.round(backoffMs * (2 ** attempt) * jitter));
  }

  async function fetchResource(
    url: string,
    kind: RegistryResourceKind,
    key: string,
    signal?: AbortSignal,
    expectedIntegrity?: string,
    expectedShasum?: string,
  ): Promise<Uint8Array | null> {
    let cached = getResource(key);
    let cachedBody: Uint8Array | null = null;
    if (cached) {
      try {
        cachedBody = cachedBytes(cached);
        if (!verifyIntegrity(cachedBody, expectedIntegrity, expectedShasum)) {
          cached = null;
          cachedBody = null;
        }
      } catch (_) {
        cached = null;
        cachedBody = null;
      }
    }
    if (kind === 'tarball' && cached) {
      return cachedBody;
    }
    const headers: Record<string, string> = {
      accept: kind === 'metadata' ? 'application/vnd.npm.install-v1+json' : 'application/octet-stream',
      'user-agent': 'debun-plus/1.0 (npm registry corpus client)',
    };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

    let lastError: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) return null;
      const controller = new AbortController();
      const abortFromParent = () => controller.abort();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      signal?.addEventListener('abort', abortFromParent, { once: true });
      let response: any;
      try {
        const result = await semaphore.run(async () => {
          response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
          if (response.status === 304) return { status: 304, body: null as Uint8Array | null };
          if (!response.ok) {
            const error: any = new Error(`Registry returned HTTP ${response.status} for ${url}.`);
            error.status = response.status;
            throw error;
          }
          return { status: response.status, body: await responseBytes(response) };
        });
        if (result.status === 304) {
          if (!cached) throw new Error(`Registry returned 304 without a cached body for ${url}.`);
          const bytes = cachedBytes(cached);
          return verifyIntegrity(bytes, expectedIntegrity, expectedShasum) ? bytes : null;
        }
        const bytes = result.body as Uint8Array;
        if (!verifyIntegrity(bytes, expectedIntegrity, expectedShasum)) {
          throw new Error(`Registry integrity check failed for ${url}.`);
        }
        const compressed = zlib.gzipSync(BufferImpl.from(bytes));
        const entry: RegistryResourceCacheEntry = {
          key,
          kind,
          url,
          bodyGzip: compressed,
          etag: headerValue(response, 'etag'),
          lastModified: headerValue(response, 'last-modified'),
          contentType: headerValue(response, 'content-type'),
          integrity: expectedIntegrity || expectedShasum,
          updatedAt: Date.now(),
        };
        try { putResource(entry); } catch (_) { /* Do not fail a successful fetch if disk caching is unavailable. */ }
        return bytes;
      } catch (error) {
        lastError = error;
        const status = (error as any)?.status as number | undefined;
        const retryable = status === undefined || RETRYABLE_STATUS.has(status) || status >= 500;
        if (attempt >= retries || !retryable || signal?.aborted) break;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromParent);
      }
      await sleep(retryDelay(response, attempt));
    }

    if (signal?.aborted) return null;
    if (cached) {
      try {
        const bytes = cachedBytes(cached);
        if (verifyIntegrity(bytes, expectedIntegrity, expectedShasum)) return bytes;
      } catch (_) { /* Return a failed fetch when both cache and registry data are invalid. */ }
    }
    if (lastError) return null;
    return null;
  }

  async function loadPackageMeta(name: string, signal?: AbortSignal): Promise<RegistryPackument | null> {
    const normalizedName = name.trim();
    if (!normalizedName) return null;
    const key = registryMetadataCacheKey(normalizedName);
    const url = `https://registry.npmjs.org/${packageNamePath(normalizedName)}`;
    const bytes = await fetchResource(url, 'metadata', key, signal);
    if (!bytes) return null;
    try {
      const value = JSON.parse(BufferImpl.from(bytes).toString('utf8')) as RegistryPackument;
      if (!value || typeof value !== 'object' || !value.versions || typeof value.versions !== 'object') return null;
      return value;
    } catch (_) { return null; }
  }

  async function getPackageMeta(name: string, signal?: AbortSignal): Promise<RegistryPackument | null> {
    const key = name.trim().toLowerCase();
    const pending = metadataInFlight.get(key);
    if (pending) return pending;
    const request = loadPackageMeta(name, signal).finally(() => metadataInFlight.delete(key));
    metadataInFlight.set(key, request);
    return request;
  }

  async function getDependencyTree(name: string, version: string, maxDepth = 20, signal?: AbortSignal): Promise<PackageDependencyTree> {
    const metadata = await getPackageMeta(name, signal);
    const rootVersion = metadata?.versions?.[version];
    if (!metadata || !rootVersion) throw new Error(`Package metadata for ${name}@${version} was not found in the registry.`);

    async function buildNode(
      packageName: string,
      resolvedVersion: RegistryVersion,
      requestedRange: string | undefined,
      dependencyType: PackageDependencyTree['dependencyType'],
      depth: number,
      ancestors: Set<string>,
    ): Promise<PackageDependencyTree> {
      const identity = `${packageName.toLowerCase()}@${resolvedVersion.version}`;
      const node: PackageDependencyTree = {
        name: packageName,
        version: resolvedVersion.version,
        requestedRange,
        dependencyType,
        dependencies: {},
      };
      if (ancestors.has(identity)) { node.circular = true; return node; }
      if (depth >= Math.max(0, maxDepth)) { node.truncated = true; return node; }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(identity);
      const entries = dependencyEntries(resolvedVersion);
      const children = await Promise.all(entries.map(async (entry) => {
        const packument = await getPackageMeta(entry.name, signal);
        const versions = Object.values(packument?.versions || {})
          .filter((candidate) => satisfies(candidate.version, entry.range))
          .sort((left, right) => compareSemver(right.version, left.version));
        const selected = versions[0];
        if (!selected) {
          return [entry.name, {
            name: entry.name,
            version: entry.range,
            requestedRange: entry.range,
            dependencyType: entry.type,
            dependencies: {},
            unresolved: true,
          } satisfies PackageDependencyTree] as const;
        }
        return [entry.name, await buildNode(entry.name, selected, entry.range, entry.type, depth + 1, nextAncestors)] as const;
      }));
      node.dependencies = Object.fromEntries(children);
      return node;
    }

    return buildNode(name, rootVersion, undefined, undefined, 0, new Set());
  }

  async function downloadTarball(name: string, version: string, signal?: AbortSignal): Promise<DownloadedTarball> {
    const metadata = await getPackageMeta(name, signal);
    const versionMeta = metadata?.versions?.[version];
    const tarballUrl = versionMeta?.dist?.tarball;
    if (!versionMeta || !tarballUrl) throw new Error(`Tarball URL for ${name}@${version} is missing from registry metadata.`);
    const integrity = versionMeta.dist?.integrity;
    const shasum = versionMeta.dist?.shasum;
    const cacheKey = registryTarballCacheKey(integrity, shasum, tarballUrl);
    const activeExtraction = extractionInFlight.get(cacheKey);
    if (activeExtraction) return activeExtraction;
    const extraction = (async () => {
      const bytes = await fetchResource(tarballUrl, 'tarball', cacheKey, signal, integrity, shasum);
      if (!bytes) throw new Error(`Unable to download ${name}@${version} tarball from the registry.`);
      return extractTarGzip(bytes, name, version, options.tempDir || os.tmpdir(), cacheKey, integrity || shasum);
    })().finally(() => extractionInFlight.delete(cacheKey));
    extractionInFlight.set(cacheKey, extraction);
    return extraction;
  }

  const client: NpmRegistryClient = {
    getPackageMeta,
    async getPackument(name, signal) { return getPackageMeta(name, signal); },
    async getTarball(url, signal, integrity, shasum) {
      const key = registryTarballCacheKey(integrity, shasum, url);
      return fetchResource(url, 'tarball', key, signal, integrity, shasum);
    },
    async getVersionList(name, signal) {
      const metadata = await getPackageMeta(name, signal);
      return Object.keys(metadata?.versions || {});
    },
    downloadTarball,
    getDependencyTree,
    close() { if (ownsCache) cache.close?.(); },
  };
  return client;
}

export async function mapBounded<T, R>(values: T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(values.length, Math.floor(concurrency) || 1)) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function withBoundedRegistry(client: RegistryClient, concurrency: number): RegistryClient {
  const limit = Math.max(1, Math.min(8, Math.floor(concurrency) || 1));
  let active = 0;
  const waiters: Array<() => void> = [];
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiters.push(resolve));
    try { return await operation(); }
    finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  }
  return {
    getPackument: (name, signal) => run(() => client.getPackument(name, signal)),
    getTarball: (url, signal, integrity, shasum) => run(() => client.getTarball(url, signal, integrity, shasum)),
    ...(client.getPackageMeta ? { getPackageMeta: (name, signal) => run(() => client.getPackageMeta!(name, signal)) } : {}),
    ...(client.getVersionList ? { getVersionList: (name, signal) => run(() => client.getVersionList!(name, signal)) } : {}),
    ...(client.downloadTarball ? { downloadTarball: (name, version, signal) => run(() => client.downloadTarball!(name, version, signal)) } : {}),
    ...(client.getDependencyTree ? { getDependencyTree: (name, version, maxDepth, signal) => run(() => client.getDependencyTree!(name, version, maxDepth, signal)) } : {}),
    ...(client.close ? { close: () => client.close!() } : {}),
  };
}
