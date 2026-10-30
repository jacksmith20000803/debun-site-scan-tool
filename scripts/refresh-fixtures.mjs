#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(root, 'test', 'fixtures', 'turbopack');
const patternsPath = path.join(root, 'patterns', 'bundlers.json');
const npm = process.env.npm_execpath || (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function run(command, args, cwd, extraEnv = {}) {
  const isNpmCli = command.endsWith('npm-cli.js');
  const windowsBatch = process.platform === 'win32' && command.endsWith('.cmd');
  const executable = isNpmCli ? process.execPath : windowsBatch ? command : command;
  const commandArgs = isNpmCli ? [command, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env: { ...process.env, ...extraEnv, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
    windowsHide: true,
    shell: windowsBatch,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}.`);
}

async function latest(name, tag = 'latest') {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, {
    headers: { accept: 'application/json', 'user-agent': 'debun-plus-fixture-refresh/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Could not resolve ${name}@${tag}: registry returned HTTP ${response.status}.`);
  const value = await response.json();
  if (!value.version) throw new Error(`Registry response for ${name}@${tag} has no version.`);
  return value;
}

async function ensureDirectory(value) { await fs.mkdir(value, { recursive: true }); }

async function copyJavaScript(source, destination) {
  let count = 0;
  async function visit(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      const input = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(input, rel);
      else if (entry.isFile() && /\.m?js$/i.test(entry.name)) {
        const output = path.join(destination, rel);
        await ensureDirectory(path.dirname(output));
        await fs.copyFile(input, output);
        count++;
      }
    }
  }
  await visit(source);
  return count;
}

async function buildNextFixture(stage, channel, version, dependencies) {
  const appDir = path.join(stage, `next-${version}`);
  const app = path.join(appDir, 'app');
  await ensureDirectory(app);
  await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify({
    name: `debun-plus-turbopack-${channel}-fixture`, version: '1.0.0', private: true,
    scripts: { build: 'next build --turbopack' }, dependencies: { next: version, ...dependencies },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(app, 'layout.js'), `export default function Layout({children}) { return <html><body>{children}</body></html> }\n`);
  await fs.writeFile(path.join(app, 'page.js'), `"use client";\nimport _ from 'lodash';\nexport default function Page() { return <main><h1>{_.kebabCase('Turbopack audit fixture')}</h1><button onClick={() => _.uniq([1,1,2])}>inspect</button></main> }\n`);
  run(npm, ['install', '--prefix', appDir, '--no-audit', '--no-fund', '--no-save', `next@${version}`, `react@${dependencies.react}`, `react-dom@${dependencies['react-dom']}`, `lodash@${dependencies.lodash}`], root);
  const nextCli = path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  run(process.execPath, [nextCli, 'build', '--turbopack'], appDir);
  const chunks = path.join(appDir, '.next', 'static', 'chunks');
  const chunkCount = await copyJavaScript(chunks, path.join(appDir, 'chunks'));
  if (!chunkCount) throw new Error(`Next ${version} did not emit browser chunks under .next/static/chunks.`);
  const installed = JSON.parse(await fs.readFile(path.join(appDir, 'node_modules', 'next', 'package.json'), 'utf8'));
  const react = JSON.parse(await fs.readFile(path.join(appDir, 'node_modules', 'react', 'package.json'), 'utf8'));
  const lodash = JSON.parse(await fs.readFile(path.join(appDir, 'node_modules', 'lodash', 'package.json'), 'utf8'));
  await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify({
    name: `debun-plus-turbopack-${channel}-fixture`, version: '1.0.0', private: true,
    dependencies: { next: installed.version, react: react.version, 'react-dom': dependencies['react-dom'], lodash: lodash.version },
  }, null, 2)}\n`);
  console.log(`[refresh-fixtures] built ${channel} Next ${installed.version}: ${chunkCount} chunks`);
  return { directory: appDir, version: installed.version, chunkCount };
}

async function analyzeFixtures(fixtureDirectories, outputDirectory) {
  const { analyzeBundles } = require('../dist/src/debun-plus/pipeline.js');
  const { createSqliteCache } = require('../dist/src/debun-plus/sqlite-cache.js');
  const sources = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /\.m?js$/i.test(entry.name)) sources.push({ url: full, code: await fs.readFile(full, 'utf8') });
    }
  }
  for (const directory of fixtureDirectories) await visit(directory);
  const cache = createSqliteCache(path.join(outputDirectory, 'refresh-cache.sqlite'));
  try {
    const result = await analyzeBundles(sources, {
      cache,
      maxCandidates: 20,
      registry: { async getPackument() { return null; }, async getTarball() { return null; } },
    });
    const bundleFormats = result.bundleFormats.map((item) => ({ ...item, sourceFile: path.basename(item.sourceFile) }));
    await fs.writeFile(path.join(outputDirectory, 'pipeline-results.json'), `${JSON.stringify({
      stats: result.stats,
      bundleFormats,
      packageCandidates: result.candidates.map((candidate) => candidate.name),
    }, null, 2)}\n`);
    return { sources: sources.length, bundleFormats };
  } finally {
    cache.close();
  }
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'debun-plus-refresh-'));
  const stage = path.join(temporaryRoot, 'turbopack');
  const toolsDir = path.join(temporaryRoot, 'tools');
  const reportDir = path.join(temporaryRoot, 'pipeline');
  await Promise.all([ensureDirectory(stage), ensureDirectory(toolsDir), ensureDirectory(reportDir)]);
  try {
    const previousPatterns = JSON.parse(await fs.readFile(patternsPath, 'utf8'));
    const [stableNext, canaryNext, react, lodash] = await Promise.all([
      latest('next', 'latest'), latest('next', 'canary'), latest('react'), latest('lodash'),
    ]);
    const previousVersions = Object.fromEntries(Object.entries(previousPatterns.bundlers).map(([name, value]) => [name, value.version]));
    const packageVersions = {};
    for (const entry of Object.values(previousPatterns.bundlers)) {
      if (entry.package === 'next') continue;
      const metadata = await latest(entry.package);
      packageVersions[entry.package] = metadata.version;
      entry.version = metadata.version;
    }
    const dependencies = { react: react.version, 'react-dom': react.version, lodash: lodash.version };
    const stable = await buildNextFixture(stage, 'stable', stableNext.version, dependencies);
    const canary = await buildNextFixture(stage, 'canary', canaryNext.version, dependencies);

    const toolsManifest = {
      name: 'debun-plus-refresh-tools', version: '1.0.0', private: true,
      dependencies: Object.fromEntries(Object.entries(previousPatterns.bundlers)
        .filter(([, value]) => value.package !== 'next')
        .map(([name, value]) => [value.package, packageVersions[value.package]])),
    };
    await fs.writeFile(path.join(toolsDir, 'package.json'), `${JSON.stringify(toolsManifest, null, 2)}\n`);
    run(npm, ['install', '--prefix', toolsDir, '--no-audit', '--no-fund', '--no-save', ...Object.entries(toolsManifest.dependencies).map(([name, version]) => `${name}@${version}`), 'lodash@' + lodash.version, 'jquery@latest'], root);
    const nodePath = [path.join(toolsDir, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    run(npm, ['run', 'eval:fixtures'], root, { NODE_PATH: nodePath });

    const stablePath = path.join(stage, `next-${stable.version}`);
    const canaryPath = path.join(stage, `next-${canary.version}`);
    const generated = await analyzeFixtures([
      path.join(stable.directory, 'chunks'), path.join(canary.directory, 'chunks'),
      path.join(root, 'test', 'evaluation', 'bundles'),
    ], reportDir);
    const updatedPatterns = {
      ...previousPatterns,
      bundlers: {
        ...previousPatterns.bundlers,
        turbopack: {
          ...previousPatterns.bundlers.turbopack,
          version: `Next.js ${stable.version} stable; ${canary.version} canary`,
          observedVersions: { stable: stable.version, canary: canary.version },
        },
      },
    };

    // Replace only generated Next fixture folders after both builds and pipeline validation succeeded.
    const oldEntries = await fs.readdir(fixtureRoot, { withFileTypes: true });
    for (const entry of oldEntries) if (entry.isDirectory() && entry.name.startsWith('next-')) {
      const target = path.resolve(fixtureRoot, entry.name);
      if (!target.startsWith(path.resolve(fixtureRoot) + path.sep)) throw new Error(`Refusing to remove fixture path outside the Turbopack fixture directory: ${target}`);
      await fs.rm(target, { recursive: true, force: true });
    }
    await fs.mkdir(fixtureRoot, { recursive: true });
    for (const value of [stablePath, canaryPath]) {
      const destination = path.join(fixtureRoot, path.basename(value));
      await fs.cp(value, destination, { recursive: true, force: true });
    }
    await fs.writeFile(patternsPath, `${JSON.stringify(updatedPatterns, null, 2)}\n`);
    const oldVersions = previousVersions;
    const newVersions = Object.fromEntries(Object.entries(updatedPatterns.bundlers).map(([name, value]) => [name, value.version]));
    const formatCounts = new Map();
    for (const item of generated.bundleFormats) formatCounts.set(item.bundleFormat, (formatCounts.get(item.bundleFormat) || 0) + 1);
    const report = [
      '# Renewable Bundler Pattern Refresh', '',
      `Generated: ${new Date().toISOString()}`, '',
      '## Version changes', '',
      '| Bundler | Previous pattern version | Refreshed version |', '| --- | --- | --- |',
      ...Object.keys(newVersions).map((name) => `| ${name} | ${oldVersions[name] || 'unset'} | ${newVersions[name]} |`), '',
      '## Fresh fixture builds', '',
      `- Stable: Next.js ${stable.version}, ${stable.chunkCount} chunks.`,
      `- Canary: Next.js ${canary.version}, ${canary.chunkCount} chunks.`,
      `- Other bundler fixtures: regenerated from current npm registry versions for ${Object.keys(packageVersions).join(', ')}.`, '',
      '## Pipeline run', '',
      `- JavaScript files passed through analysis: ${generated.sources}.`,
      ...[...formatCounts.entries()].map(([format, count]) => `- ${format}: ${count} file(s).`),
      '- Package scoring uses package-level fragments; module identifiers are not retained as package identities.', '',
      'Raw pipeline summary: `test/fixtures/turbopack/pipeline-results.json` (regenerate with this command).', '',
    ].join('\n');
    await fs.writeFile(path.join(fixtureRoot, 'README.md'), [
      '# Generated Turbopack resilience fixtures', '',
      'Stable and canary production chunks are regenerated from current npm tags by `npm run refresh-fixtures`.',
      'The output apps exercise Lodash and React; exact dependency versions and build provenance are stored in each fixture package.json.', '',
      '| Channel | Next.js | React | Lodash | Chunks |', '| --- | --- | --- | --- | --- |',
      `| stable | ${stable.version} | ${dependencies.react} | ${dependencies.lodash} | ${stable.chunkCount} |`,
      `| canary | ${canary.version} | ${dependencies.react} | ${dependencies.lodash} | ${canary.chunkCount} |`, '',
      'The detector summary is in `pipeline-results.json`; pattern/version changes are tracked in `PATTERNS-DIFF.md`.', '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'PATTERNS-DIFF.md'), report);
    await fs.copyFile(path.join(reportDir, 'pipeline-results.json'), path.join(fixtureRoot, 'pipeline-results.json'));
    console.log(`[refresh-fixtures] completed: ${generated.sources} JavaScript files analyzed; report at PATTERNS-DIFF.md`);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[refresh-fixtures] failed: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
