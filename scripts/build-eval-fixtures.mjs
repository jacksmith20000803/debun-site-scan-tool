#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minify } from 'terser';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evaluationRoot = path.join(root, 'test', 'evaluation');
const appsDir = path.join(evaluationRoot, 'apps');
const bundlesDir = path.join(evaluationRoot, 'bundles');

const fixturePlans = [
  { id: 'webpack-01', bundler: 'webpack', packages: ['lodash'] },
  { id: 'webpack-02', bundler: 'webpack', packages: ['jquery'] },
  { id: 'webpack-03', bundler: 'webpack', packages: ['lodash', 'jquery'] },
  { id: 'esbuild-01', bundler: 'esbuild', packages: ['lodash'] },
  { id: 'esbuild-02', bundler: 'esbuild', packages: ['jquery'] },
  { id: 'esbuild-03', bundler: 'esbuild', packages: ['lodash', 'jquery'] },
  { id: 'rollup-01', bundler: 'rollup', packages: ['lodash'] },
  { id: 'rollup-02', bundler: 'rollup', packages: ['jquery'] },
  { id: 'vite-01', bundler: 'vite', packages: ['lodash'] },
  { id: 'vite-02', bundler: 'vite', packages: ['jquery'] },
];

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function collectPackageSources(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'test', 'tests', 'docs', 'examples'].includes(entry.name.toLowerCase())) await visit(absolute);
      } else if (entry.isFile() && /\.(?:c|m)?js$/i.test(entry.name)) {
        const content = await fs.readFile(absolute, 'utf8');
        if (content.length && content.length <= 1_500_000) files.push({ name: path.relative(directory, absolute).split(path.sep).join('/'), content });
      }
    }
  }
  await visit(directory);
  return files.slice(0, 80);
}

async function seedEvaluationCache(packages) {
  const { createSqliteCache } = require('../dist/src/debun-plus/sqlite-cache.js');
  const { fingerprintCode, mergeVectors } = require('../dist/src/debun-plus/features.js');
  const { prepareCorpusVariants } = require('../dist/src/debun-plus/corpus.js');
  const cachePath = path.join(evaluationRoot, 'cache.sqlite');
  const cache = createSqliteCache(cachePath);
  try {
    for (const pkg of packages) {
      const versions = await prepareCorpusVariants(await collectPackageSources(pkg.packageRoot));
      const vectors = await Promise.all(versions.map((source) => fingerprintCode(source)));
      cache.putPackument(pkg.name, {
        name: pkg.name,
        'dist-tags': { latest: pkg.version },
        versions: { [pkg.version]: { name: pkg.name, version: pkg.version } },
      });
      cache.putVersion({
        fingerprintRevision: 2,
        name: pkg.name,
        version: pkg.version,
        dependencies: {},
        peerDependencies: {},
        optionalDependencies: {},
        vector: mergeVectors(vectors),
        moduleVectors: vectors.slice(0, 16),
      });
      console.log(`[eval-fixtures] seeded offline corpus ${pkg.name}@${pkg.version}: ${vectors.length} variant(s)`);
    }
  } finally {
    cache.close();
  }
}

function resolvePackage(name) {
  const manifestPath = require.resolve(`${name}/package.json`, { paths: [root] });
  const manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8'));
  const packageRoot = path.dirname(manifestPath);
  const entry = name === 'jquery' ? (manifest.browser || manifest.main) : manifest.main;
  if (!entry) throw new Error(`Package ${name} has no browser or main entry.`);
  return { name, version: manifest.version, packageRoot, entry: path.resolve(packageRoot, entry) };
}

async function writeApp(fixture, packages) {
  const appDir = path.join(appsDir, fixture.id);
  const sourceDir = path.join(appDir, 'src');
  const appVendorDir = path.join(appDir, 'vendor');
  await ensureDirectory(sourceDir);
  await ensureDirectory(appVendorDir);
  const imports = [];
  for (const pkg of packages) {
    const vendoredName = `${pkg.name.replace(/[^a-z0-9]+/gi, '-')}-${pkg.version}.js`;
    const vendored = path.join(appVendorDir, vendoredName);
    await fs.copyFile(pkg.entry, vendored);
    imports.push(`import '../vendor/${vendoredName}';`);
  }
  const exercise = packages.map((pkg, index) => pkg.name === 'lodash'
    ? `globalThis.__evalResult${index} = globalThis._ && globalThis._.camelCase('fixture package detector ${fixture.id}');`
    : `globalThis.__evalResult${index} = (globalThis.jQuery || globalThis.$) && (globalThis.jQuery || globalThis.$).fn.jquery;`).join('\n');
  const source = [
    `// Evaluation fixture ${fixture.id}; dependencies are recorded in package.json.`,
    ...imports,
    `globalThis.__evalFixture = '${fixture.id}';`,
    exercise,
    '',
  ].join('\n');
  const sourcePath = path.join(sourceDir, 'main.js');
  await fs.writeFile(sourcePath, source, 'utf8');
  const manifest = {
    name: `debun-plus-eval-${fixture.id}`,
    version: '1.0.0',
    private: true,
    dependencies: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version])),
  };
  await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { appDir, sourcePath };
}

async function writeEsbuild(sourcePath, outputPath) {
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    entryPoints: [sourcePath], bundle: true, minify: true, legalComments: 'inline',
    platform: 'browser', format: 'iife', target: ['es2020'], write: false,
  });
  await fs.writeFile(outputPath, result.outputFiles[0].text, 'utf8');
}

async function writeRollup(sourcePath, outputPath) {
  const { rollup } = require('rollup');
  const bundle = await rollup({ input: sourcePath, treeshake: false, onwarn: (warning) => { if (warning.code !== 'CIRCULAR_DEPENDENCY') console.warn(warning.message); } });
  try {
    const result = await bundle.generate({ format: 'iife', name: 'DebunPlusFixture', inlineDynamicImports: true });
    const js = result.output.find((item) => item.type === 'chunk')?.code || '';
    const compressed = await minify(js, { format: { comments: /@license|@preserve|^!/i } });
    await fs.writeFile(outputPath, compressed.code || js, 'utf8');
  } finally {
    await bundle.close();
  }
}

async function writeVite(sourcePath, appDir, outputPath) {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const output = await build({
    root: appDir,
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: 'esbuild',
      sourcemap: false,
      lib: { entry: sourcePath, formats: ['iife'], name: 'DebunPlusFixture' },
      rollupOptions: { treeshake: false },
    },
  });
  const chunks = Array.isArray(output) ? output.flatMap((item) => item.output || []) : output.output || [];
  const chunk = chunks.find((item) => item.type === 'chunk');
  if (!chunk) throw new Error(`Vite did not emit a JavaScript chunk for ${sourcePath}.`);
  await fs.writeFile(outputPath, chunk.code, 'utf8');
}

async function writeWebpack(fixture, sourcePath, outputPath) {
  let webpack;
  try { webpack = require('webpack'); } catch (_) { webpack = null; }
  if (!webpack) {
    await writeEsbuild(sourcePath, `${outputPath}.inner.js`);
    const inner = await fs.readFile(`${outputPath}.inner.js`, 'utf8');
    await fs.unlink(`${outputPath}.inner.js`);
    const chunkId = Number.parseInt(fixture.id.replace(/\D/g, ''), 10) || 1;
    const wrapped = `(self.webpackChunkDebunPlusEval=self.webpackChunkDebunPlusEval||[]).push([[${chunkId}],{\n` +
      `  ${chunkId}: function(module,exports,__webpack_require__){\n${inner}\n  }\n}]);\n`;
    await fs.writeFile(outputPath, wrapped, 'utf8');
    return 'esbuild wrapped in a Webpack JSONP module fixture (Webpack package unavailable)';
  }
  const outputDir = path.dirname(outputPath);
  await new Promise((resolve, reject) => webpack({
    mode: 'production',
    target: 'web',
    entry: sourcePath,
    output: { path: outputDir, filename: path.basename(outputPath), chunkFormat: 'array-push', chunkLoadingGlobal: 'webpackChunkDebunPlusEval' },
    devtool: false,
  }, (error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    resolve();
  }));
  return 'webpack';
}

async function main() {
  await Promise.all([ensureDirectory(appsDir), ensureDirectory(bundlesDir)]);
  const packageCache = new Map();
  const buildMethods = new Map();
  for (const plan of fixturePlans) {
    const packages = plan.packages.map((name) => {
      if (!packageCache.has(name)) packageCache.set(name, resolvePackage(name));
      return packageCache.get(name);
    });
    const { appDir, sourcePath } = await writeApp(plan, packages);
    const outputPath = path.join(bundlesDir, `${plan.id}.js`);
    let builder = plan.bundler;
    if (plan.bundler === 'webpack') builder = await writeWebpack(plan, sourcePath, outputPath);
    else if (plan.bundler === 'esbuild') await writeEsbuild(sourcePath, outputPath);
    else if (plan.bundler === 'rollup') await writeRollup(sourcePath, outputPath);
    else await writeVite(sourcePath, appDir, outputPath);
    buildMethods.set(plan.id, builder);
    console.log(`[eval-fixtures] ${plan.id}: ${builder} -> ${path.relative(root, outputPath)}`);
  }
  const webpackFallbackUsed = fixturePlans.some((fixture) => fixture.bundler === 'webpack') && !(() => { try { require.resolve('webpack'); return true; } catch (_) { return false; } })();
  const builderInfo = {
    webpackFallbackUsed,
    note: webpackFallbackUsed
      ? 'Webpack fixture files use a deterministic Webpack JSONP wrapper around esbuild output because Webpack is not installed; the builder uses actual Webpack automatically when available.'
      : 'All fixtures were built with the named bundlers.',
  };
  const groundTruth = {
    schemaVersion: 1,
    builderInfo,
    fixtures: fixturePlans.map((fixture) => ({
      id: fixture.id,
      bundler: fixture.bundler,
      buildMethod: buildMethods.get(fixture.id),
      bundle: `${fixture.id}.js`,
      packages: fixture.packages.map((name) => {
        const pkg = packageCache.get(name);
        return { name: pkg.name, version: pkg.version };
      }),
    })),
  };
  await fs.writeFile(path.join(evaluationRoot, 'truth.json'), `${JSON.stringify(groundTruth, null, 2)}\n`, 'utf8');
  await seedEvaluationCache([...packageCache.values()]);
  await fs.writeFile(path.join(evaluationRoot, 'builder-info.json'), `${JSON.stringify(builderInfo, null, 2)}\n`, 'utf8');
  console.log(`[eval-fixtures] created ${fixturePlans.length} bundles and ${path.join(evaluationRoot, 'truth.json')}`);
}

main().catch((error) => {
  console.error(`[eval-fixtures] failed: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
