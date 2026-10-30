import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { analyzeBundles } from '../src/debun-plus/pipeline';
import { buildLiteralIndex, extractIndexedStringLiterals, matchLiteralFragments, parsePackageList } from '../src/debun-plus/literal-index';
import { SqliteCorpusCache } from '../src/debun-plus/sqlite-cache';

const fixtureRoot = resolve(process.cwd(), 'test/fixtures/string-index');
let tempDirs: string[] = [];

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), 'utf8');
}

async function makeIndex(): Promise<{ cache: SqliteCorpusCache; dbPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'debun-literal-index-'));
  tempDirs.push(directory);
  const dbPath = join(directory, 'index.sqlite');
  const cache = new SqliteCorpusCache(dbPath);
  const packages: Array<{ name: string; version: string; sources: string[] }> = [
    { name: 'lodash', version: '4.17.21', sources: [await fixture('lodash-package.js'), 'const shared = "shared string across package corpus";'] },
    { name: 'moment', version: '2.30.1', sources: [await fixture('moment-package.js'), 'const shared = "shared string across package corpus";'] },
  ];
  for (let index = 0; index < 18; index++) {
    packages.push({
      name: `fixture-package-${index}`,
      version: '1.0.0',
      sources: [`function filler${index}(){return "unique starter literal for package ${index}"}`],
    });
  }
  const packageRoots = new Map<string, string>();
  for (const pkg of packages) {
    const packageRoot = join(directory, 'packages', pkg.name.replace(/[\\/]/g, '_'));
    await mkdir(packageRoot, { recursive: true });
    const sourceFile = join(packageRoot, 'index.js');
    await writeFile(sourceFile, pkg.sources.join('\n'), 'utf8');
    packageRoots.set(pkg.name, sourceFile);
  }
  const registry = {
    async getPackageMeta(name: string) {
      const pkg = packages.find((entry) => entry.name === name);
      return pkg ? { 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: { name, version: pkg.version } } } : null;
    },
    async getPackument(name: string) { return this.getPackageMeta(name); },
    async downloadTarball(name: string, version: string) {
      const sourceFile = packageRoots.get(name);
      if (!sourceFile) throw new Error(`No fixture tarball for ${name}.`);
      return { name, version, directory: join(directory, 'packages', name.replace(/[\\/]/g, '_')), packageRoot: join(directory, 'packages', name.replace(/[\\/]/g, '_')), files: [sourceFile], cacheKey: `${name}@${version}` };
    },
  };
  await buildLiteralIndex({
    packages: packages.map(({ name, version }) => name === 'lodash' ? { name } : ({ name, version })),
    cache,
    registry,
    tier: 'topN',
    cleanupExtractedTarballs: false,
    concurrency: 4,
  });
  return { cache, dbPath };
}

afterEach(async () => {
  for (const directory of tempDirs) await rm(directory, { recursive: true, force: true });
  tempDirs = [];
});

describe('Phase 1.1 string-literal fingerprint index', () => {
  it('parses package list lines including scoped package versions', () => {
    expect(parsePackageList('# popular packages\nlodash\n@scope/ui-kit@2.3.4\nlodash\nlodash@4.17.21\ninvalid package')).toEqual([
      { name: 'lodash' },
      { name: '@scope/ui-kit', version: '2.3.4' },
      { name: 'lodash', version: '4.17.21' },
    ]);
  });

  it('extracts static string and template literals while discarding short and boilerplate values', async () => {
    const result = await extractIndexedStringLiterals(`const a = 'specific literal value'; const b = 'short'; const c = 'Expected a function'; const d = \`static template message\`;`);
    expect(result.parseFailed).toBe(false);
    expect(result.literals).toContain('specific literal value');
    expect(result.literals).toContain('static template message');
    expect(result.literals).not.toContain('short');
    expect(result.literals).not.toContain('expected a function');
  });

  it('ranks lodash and moment from a combined bundle and guards against clean-bundle false positives', async () => {
    const { cache } = await makeIndex();
    try {
      expect(cache.getLiteralIndexInfo('topN')).toMatchObject({ packagesIndexed: 20, versionsIndexed: 20 });
      const combined = await extractIndexedStringLiterals(await fixture('lodash-moment-bundle.js'));
      const matches = matchLiteralFragments([{ sourceFile: 'lodash-moment-bundle.js', stringLiterals: combined.literals }], cache, 'topN');
      const strong = matches.filter((match) => match.strong);
      expect(new Set(strong.slice(0, 2).map((match) => match.name))).toEqual(new Set(['lodash', 'moment']));
      expect(strong.find((match) => match.name === 'lodash')).toMatchObject({ version: '4.17.21', matchedLiteralCount: 3 });
      expect(strong.find((match) => match.name === 'moment')).toMatchObject({ version: '2.30.1', matchedLiteralCount: 4 });
      expect(matchLiteralFragments([{ sourceFile: 'common', stringLiterals: ['shared string across package corpus'] }], cache, 'topN')).toEqual([]);

      const clean = await extractIndexedStringLiterals(await fixture('clean-bundle.js'));
      const cleanMatches = matchLiteralFragments([{ sourceFile: 'clean-bundle.js', stringLiterals: clean.literals }], cache, 'topN');
      expect(cleanMatches.filter((match) => match.strong)).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it('adds strong literal-index hits as the first Phase 1 candidate evidence', async () => {
    const { cache } = await makeIndex();
    const code = await fixture('lodash-moment-bundle.js');
    const registry = {
      async getPackument(name: string) {
        const version = name === 'lodash' ? '4.17.21' : name === 'moment' ? '2.30.1' : null;
        return version ? { versions: { [version]: { name, version } } } : { versions: {} };
      },
      async getTarball() { return null; },
    };
    try {
      const result = await analyzeBundles([{ url: 'fixture://combined', code }], { cache, registry, maxCandidates: 10 });
      for (const packageName of ['lodash', 'moment']) {
        const candidate = result.candidates.find((item) => item.name === packageName);
        expect(candidate?.evidence[0]?.source).toBe('literal-index');
        expect(candidate?.evidence[0]?.version).toBe(packageName === 'lodash' ? '4.17.21' : '2.30.1');
      }
    } finally {
      cache.close();
    }
  });
});
