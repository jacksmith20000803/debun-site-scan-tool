import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeBundles } from '../src/debun-plus/pipeline';
import { fingerprintBundle } from '../src/debun-plus/features';
import { normalizeBundle } from '../src/debun-plus/normalize';
import type {
  BundleSource,
  CachedVersionCorpus,
  CorpusCache,
  FingerprintVector,
  PackageDependencyTree,
  RegistryClient,
  RegistryPackument,
  RegistryVersion,
} from '../src/debun-plus/types';

class MemoryCache implements CorpusCache {
  private readonly corpora = new Map<string, CachedVersionCorpus>();
  private readonly packuments = new Map<string, RegistryPackument>();

  getVersion(name: string, version: string) { return this.corpora.get(`${name.toLowerCase()}@${version}`) || null; }
  putVersion(value: CachedVersionCorpus) { this.corpora.set(`${value.name.toLowerCase()}@${value.version}`, value); }
  getPackument(name: string) { return this.packuments.get(name.toLowerCase()) || null; }
  putPackument(name: string, value: RegistryPackument) { this.packuments.set(name.toLowerCase(), value); }
  findCandidateNames() { return []; }
}

function emptyVector(): FingerprintVector {
  return { ngrams: [], astHashes: [], identifiers: [], stringLiterals: [], properties: [], cssClasses: [], runtimeGlobals: [], metaFrameworkReads: [] };
}

function makePackument(name: string, versions: RegistryVersion[]): RegistryPackument {
  return { name, versions: Object.fromEntries(versions.map((version) => [version.version, version])) };
}

function putCorpus(cache: MemoryCache, name: string, version: string, vector: FingerprintVector): void {
  cache.putVersion({
    name,
    version,
    dependencies: {},
    peerDependencies: {},
    optionalDependencies: {},
    vector,
    moduleVectors: [vector],
  });
}

async function loadTrees(): Promise<Record<string, PackageDependencyTree>> {
  const contents = await readFile(resolve(process.cwd(), 'test/fixtures/transitive/dependency-trees.json'), 'utf8');
  return JSON.parse(contents) as Record<string, PackageDependencyTree>;
}

describe('Phase 3 dependency-tree propagation', () => {
  it('fetches exact-root trees, confirms literal matches, excludes absent dependencies, and intersects shared ranges', async () => {
    const trees = await loadTrees();
    const code = [
      'function rootA(){return "root alpha runtime marker"}',
      'function rootB(){return "root beta runtime marker"}',
      'function sharedCore(){return "shared core runtime marker"}',
      'function alphaExtra(){return "alpha extra runtime marker"}',
    ].join(';');
    const source: BundleSource = { url: 'https://fixture.test/app.js', code };
    const target = (await fingerprintBundle(await normalizeBundle(source), 1))[0];
    const cache = new MemoryCache();

    const packageVersions: Record<string, RegistryVersion[]> = {
      'root-a': [{ name: 'root-a', version: '1.0.0', dependencies: { 'shared-core': '^1.2.0', 'alpha-extra': '^2.0.0' } }],
      'root-b': [{ name: 'root-b', version: '1.0.0', dependencies: { 'shared-core': '>=1.3.0 <2.0.0' } }],
      'shared-core': [
        { name: 'shared-core', version: '1.4.0' },
        { name: 'shared-core', version: '1.3.0' },
        { name: 'shared-core', version: '2.0.0' },
      ],
      'alpha-extra': [{ name: 'alpha-extra', version: '2.1.0', dependencies: { 'leaf-lib': '^3.0.0' } }],
      'leaf-lib': [{ name: 'leaf-lib', version: '3.1.0' }],
    };
    for (const [name, versions] of Object.entries(packageVersions)) cache.putPackument(name, makePackument(name, versions));
    putCorpus(cache, 'root-a', '1.0.0', target);
    putCorpus(cache, 'root-b', '1.0.0', target);
    putCorpus(cache, 'shared-core', '1.4.0', target);
    putCorpus(cache, 'shared-core', '1.3.0', emptyVector());
    putCorpus(cache, 'alpha-extra', '2.1.0', target);
    putCorpus(cache, 'leaf-lib', '3.1.0', { ...emptyVector(), stringLiterals: ['leaf library marker absent from bundle'] });

    const treeRequests: string[] = [];
    const registry: RegistryClient = {
      async getPackument(name) { return packageVersions[name] ? makePackument(name, packageVersions[name]) : null; },
      async getTarball() { throw new Error('fixture corpora are already cached'); },
      async getDependencyTree(name, version) {
        treeRequests.push(`${name}@${version}`);
        return trees[name];
      },
    };
    const result = await analyzeBundles([source], {
      cache,
      registry,
      candidateNames: ['root-a', 'root-b'].map((name) => ({ name, evidence: [{ source: 'script-url', detail: 'known fixture root' }] })),
      maxCandidates: 8,
      maxFingerprintSlices: 1,
      maxVersionsPerPackage: 2,
      maxTransitiveDepth: 2,
    });

    expect(treeRequests.sort()).toEqual(['root-a@1.0.0', 'root-b@1.0.0']);
    const shared = result.packages.find((item) => item.name === 'shared-core');
    expect(shared).toMatchObject({ version: '1.4.0', tier: 'exact', dependencyStatus: 'confirmed' });
    expect(shared?.evidence.some((item) => item.detail.includes('^1.2.0 >=1.3.0 <2.0.0'))).toBe(true);
    expect(result.packages.find((item) => item.name === 'alpha-extra')).toMatchObject({ tier: 'exact', dependencyStatus: 'confirmed' });
    expect(result.packages.find((item) => item.name === 'leaf-lib')).toMatchObject({ dependencyStatus: 'excluded' });
  });

  it('reruns Phase 2 once for unexplained candidates and propagates newly exact roots', async () => {
    const trees = await loadTrees();
    const source: BundleSource = {
      url: 'https://fixture.test/root-lead.js',
      code: 'function exactRoot(){return "exact root marker"};function rootLead(){return "root lead implementation marker"}',
    };
    const target = (await fingerprintBundle(await normalizeBundle(source), 1))[0];
    const cache = new MemoryCache();
    const packageVersions: Record<string, RegistryVersion[]> = {
      'exact-root': [{ name: 'exact-root', version: '1.0.0' }],
      'root-lead': [
        { name: 'root-lead', version: '1.9.0' },
        { name: 'root-lead', version: '1.8.0' },
      ],
      'lead-child': [{ name: 'lead-child', version: '4.1.0' }],
    };
    for (const [name, versions] of Object.entries(packageVersions)) cache.putPackument(name, makePackument(name, versions));
    putCorpus(cache, 'exact-root', '1.0.0', target);
    putCorpus(cache, 'root-lead', '1.9.0', emptyVector());
    putCorpus(cache, 'root-lead', '1.8.0', target);

    const treeRequests: string[] = [];
    const registry: RegistryClient = {
      async getPackument(name) { return packageVersions[name] ? makePackument(name, packageVersions[name]) : null; },
      async getTarball() { throw new Error('fixture corpora are already cached'); },
      async getDependencyTree(name, version) {
        treeRequests.push(`${name}@${version}`);
        return trees[name];
      },
    };
    const result = await analyzeBundles([source], {
      cache,
      registry,
      candidateNames: ['exact-root', 'root-lead'].map((name) => ({ name, evidence: [{ source: 'script-url', detail: 'fixture candidate' }] })),
      maxCandidates: 8,
      maxFingerprintSlices: 1,
      maxVersionsPerPackage: 1,
      maxTransitiveDepth: 1,
    });

    expect(result.packages.find((item) => item.name === 'root-lead')).toMatchObject({ version: '1.8.0', tier: 'exact' });
    expect(treeRequests).toContain('exact-root@1.0.0');
    expect(treeRequests).toContain('root-lead@1.8.0');
    expect(result.packages.find((item) => item.name === 'lead-child')).toMatchObject({ dependencyStatus: 'inferred' });
  });
});
