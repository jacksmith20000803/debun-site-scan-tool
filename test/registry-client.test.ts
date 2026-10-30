import { afterEach, describe, expect, it } from 'vitest';
import { fetch as undiciFetch, MockAgent } from 'undici';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistryClient, registryMetadataCacheKey, registryTarballCacheKey } from '../src/debun-plus/registry';
import { SqliteCorpusCache } from '../src/debun-plus/sqlite-cache';
import type { RegistryPackument } from '../src/debun-plus/types';

const registryOrigin = 'https://registry.npmjs.org';
const agents: MockAgent[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

function makeAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  return agent;
}

function clientFetch(agent: MockAgent, record?: Array<{ url: string; headers: Record<string, string> }>) {
  return (url: string, init: any) => {
    record?.push({ url, headers: init.headers });
    return undiciFetch(url, { ...init, dispatcher: agent });
  };
}

function tarGzipFile(fileName: string, contents: string): Buffer {
  const body = Buffer.from(contents, 'utf8');
  const header = Buffer.alloc(512);
  header.write(fileName, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

function versionMeta(name: string, version: string, tarball: string, integrity?: string) {
  return { name, version, dist: { tarball, integrity } };
}

describe('npm RegistryClient', () => {
  it('reads complete package versions, revalidates metadata, caches gzip tarballs by integrity, and extracts safely', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'debun-registry-test-'));
    const extractRoot = join(temporaryRoot, 'extract');
    await mkdir(extractRoot);
    const tarball = tarGzipFile('package/index.js', 'module.exports = function lodashFixture(value) { return value + "lodash-cache-marker"; };');
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    const tarballUrl = `${registryOrigin}/lodash/-/lodash-4.17.21.tgz`;
    const packument: RegistryPackument = {
      name: 'lodash',
      'dist-tags': { latest: '4.17.21' },
      versions: {
        '4.17.20': versionMeta('lodash', '4.17.20', `${registryOrigin}/lodash/-/lodash-4.17.20.tgz`),
        '4.17.21': versionMeta('lodash', '4.17.21', tarballUrl, integrity),
      },
    };
    const agent = makeAgent();
    const pool = agent.get(registryOrigin);
    const metadataPath = '/lodash';
    pool.intercept({ path: metadataPath, method: 'GET' }).reply(200, JSON.stringify(packument), {
      headers: { 'content-type': 'application/json', etag: '"lodash-metadata-v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
    });
    for (let index = 0; index < 3; index++) {
      pool.intercept({ path: metadataPath, method: 'GET' }).reply(304, null, { headers: { etag: '"lodash-metadata-v1"' } });
    }
    pool.intercept({ path: '/lodash/-/lodash-4.17.21.tgz', method: 'GET' }).reply(200, tarball, {
      headers: { 'content-type': 'application/octet-stream' },
    });

    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const diskCachePath = join(temporaryRoot, 'registry.sqlite');
    const cache = new SqliteCorpusCache(diskCachePath);
    const client = createRegistryClient({
      cache,
      fetchImpl: clientFetch(agent, requests),
      retries: 0,
      concurrency: 8,
      tempDir: extractRoot,
    });
    let extractedDirectory = '';
    try {
      const metadata = await client.getPackageMeta('lodash');
      expect(Object.keys(metadata?.versions || {})).toEqual(['4.17.20', '4.17.21']);
      expect(await client.getVersionList('lodash')).toEqual(['4.17.20', '4.17.21']);
      const downloaded = await client.downloadTarball('lodash', '4.17.21');
      extractedDirectory = downloaded.directory;
      expect(downloaded.packageRoot).toBe(join(downloaded.directory, 'package'));
      expect(downloaded.files).toHaveLength(1);
      expect(downloaded.files[0]).toContain('index.js');
      expect(downloaded.cacheKey).toBe(registryTarballCacheKey(integrity, undefined, tarballUrl));
      expect(requests[1].headers['if-none-match']).toBe('"lodash-metadata-v1"');

      const compressedMetadata = cache.getRegistryResource(registryMetadataCacheKey('lodash'));
      const compressedTarball = cache.getRegistryResource(downloaded.cacheKey);
      expect(compressedMetadata).not.toBeNull();
      expect(compressedTarball).not.toBeNull();
      expect(gunzipSync(Buffer.from(compressedTarball!.bodyGzip))).toEqual(tarball);
      expect(JSON.parse(gunzipSync(Buffer.from(compressedMetadata!.bodyGzip)).toString('utf8')).name).toBe('lodash');
    } finally {
      client.close();
      cache.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('uses persistent cached metadata and tarballs when the registry is unavailable', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'debun-registry-offline-'));
    const extractRoot = join(temporaryRoot, 'extract');
    await mkdir(extractRoot);
    const archive = tarGzipFile('package/index.js', 'exports.offlineMarker = "cached-lodash";');
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    const tarballUrl = `${registryOrigin}/lodash/-/lodash-4.17.21.tgz`;
    const packument: RegistryPackument = {
      name: 'lodash',
      versions: { '4.17.21': versionMeta('lodash', '4.17.21', tarballUrl, integrity) },
    };
    const agent = makeAgent();
    const pool = agent.get(registryOrigin);
    pool.intercept({ path: '/lodash', method: 'GET' }).reply(200, JSON.stringify(packument), { headers: { etag: '"offline"' } });
    pool.intercept({ path: '/lodash/-/lodash-4.17.21.tgz', method: 'GET' }).reply(200, archive);
    const diskCachePath = join(temporaryRoot, 'registry.sqlite');
    const firstCache = new SqliteCorpusCache(diskCachePath);
    const firstClient = createRegistryClient({ cache: firstCache, fetchImpl: clientFetch(agent), retries: 0, tempDir: extractRoot });
    const firstDownload = await firstClient.downloadTarball('lodash', '4.17.21');
    firstClient.close();
    firstCache.close();

    const reopenedCache = new SqliteCorpusCache(diskCachePath);
    const offlineClient = createRegistryClient({
      cache: reopenedCache,
      fetchImpl: async () => { throw new Error('offline fixture: no network'); },
      retries: 0,
      tempDir: extractRoot,
    });
    try {
      const offlineMeta = await offlineClient.getPackageMeta('lodash');
      const offlineTarball = await offlineClient.downloadTarball('lodash', '4.17.21');
      expect(offlineMeta?.versions?.['4.17.21']).toBeDefined();
      expect(offlineTarball.files).toHaveLength(1);
      expect(offlineTarball.cacheKey).toBe(firstDownload.cacheKey);
      expect(reopenedCache.getRegistryResource(registryMetadataCacheKey('lodash'))).not.toBeNull();
    } finally {
      offlineClient.close();
      reopenedCache.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('resolves a bounded dependency tree from recorded registry responses', async () => {
    const rootMeta: RegistryPackument = {
      name: 'tree-root',
      versions: {
        '1.0.0': {
          name: 'tree-root', version: '1.0.0', dependencies: { 'tree-leaf': '^1.0.0' },
          optionalDependencies: { 'tree-optional': '~2.0.0' },
        },
      },
    };
    const leafMeta: RegistryPackument = {
      name: 'tree-leaf',
      versions: {
        '1.0.0': { name: 'tree-leaf', version: '1.0.0' },
        '1.4.0': { name: 'tree-leaf', version: '1.4.0' },
      },
    };
    const optionalMeta: RegistryPackument = {
      name: 'tree-optional',
      versions: { '2.0.3': { name: 'tree-optional', version: '2.0.3' } },
    };
    const agent = makeAgent();
    const pool = agent.get(registryOrigin);
    pool.intercept({ path: '/tree-root', method: 'GET' }).reply(200, JSON.stringify(rootMeta));
    pool.intercept({ path: '/tree-leaf', method: 'GET' }).reply(200, JSON.stringify(leafMeta));
    pool.intercept({ path: '/tree-optional', method: 'GET' }).reply(200, JSON.stringify(optionalMeta));
    const cache = new SqliteCorpusCache(':memory:');
    const client = createRegistryClient({ cache, fetchImpl: clientFetch(agent), retries: 0 });
    try {
      const tree = await client.getDependencyTree('tree-root', '1.0.0');
      expect(tree.dependencies['tree-leaf'].version).toBe('1.4.0');
      expect(tree.dependencies['tree-leaf'].requestedRange).toBe('^1.0.0');
      expect(tree.dependencies['tree-optional'].version).toBe('2.0.3');
      expect(tree.dependencies['tree-optional'].dependencyType).toBe('optional');
    } finally {
      client.close();
      cache.close();
    }
  });

  it('retries a rate limited response without allowing live network access', async () => {
    const packument: RegistryPackument = { name: 'retry-package', versions: { '1.0.0': { name: 'retry-package', version: '1.0.0' } } };
    const agent = makeAgent();
    const pool = agent.get(registryOrigin);
    pool.intercept({ path: '/retry-package', method: 'GET' }).reply(429, 'slow down', { headers: { 'retry-after': '0' } });
    pool.intercept({ path: '/retry-package', method: 'GET' }).reply(200, JSON.stringify(packument));
    const cache = new SqliteCorpusCache(':memory:');
    const client = createRegistryClient({ cache, fetchImpl: clientFetch(agent), retries: 1, backoffMs: 0 });
    try {
      expect((await client.getPackageMeta('retry-package'))?.versions?.['1.0.0']).toBeDefined();
    } finally {
      client.close();
      cache.close();
    }
  });

  it('treats an empty network response as a cache miss without throwing during retry delay', async () => {
    const cache = new SqliteCorpusCache(':memory:');
    const client = createRegistryClient({
      cache,
      fetchImpl: async () => { throw new Error('offline fixture'); },
      retries: 0,
      backoffMs: 0,
    });
    try {
      await expect(client.getPackageMeta('offline-package')).resolves.toBeNull();
    } finally {
      client.close();
      cache.close();
    }
  });

  it('caps simultaneous registry requests at eight even if configured higher', async () => {
    const agent = makeAgent();
    const pool = agent.get(registryOrigin);
    const packageNames = Array.from({ length: 12 }, (_, index) => `parallel-${index}`);
    for (const name of packageNames) {
      const response: RegistryPackument = { name, versions: { '1.0.0': { name, version: '1.0.0' } } };
      pool.intercept({ path: `/${name}`, method: 'GET' }).reply(200, JSON.stringify(response));
    }
    let active = 0;
    let peakActive = 0;
    const fetchImpl = async (url: string, init: any) => {
      active++;
      peakActive = Math.max(peakActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await undiciFetch(url, { ...init, dispatcher: agent });
      } finally { active--; }
    };
    const cache = new SqliteCorpusCache(':memory:');
    const client = createRegistryClient({ cache, fetchImpl, concurrency: 32, retries: 0 });
    try {
      const values = await Promise.all(packageNames.map((name) => client.getPackageMeta(name)));
      expect(values).toHaveLength(12);
      expect(values.every((value) => Boolean(value?.versions?.['1.0.0']))).toBe(true);
      expect(peakActive).toBe(8);
    } finally {
      client.close();
      cache.close();
    }
  });
});
