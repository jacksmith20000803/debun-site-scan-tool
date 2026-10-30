declare const require: (name: string) => any;

export interface PackageSourceFile {
  name: string;
  content: string;
}

export type MinifyPackageSource = (source: string, options: Record<string, unknown>) => Promise<string | null>;

const MAX_SOURCE_FILES = 80;
const MAX_SELECTED_FILES = 3;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_SOURCE_BYTES = 1_500_000;
const LICENSE_COMMENT = /@license|@preserve|SPDX-License-Identifier/i;

function sourceRank(name: string): number {
  const normalized = name.replace(/\\/g, '/').toLowerCase();
  if (/\.min\.(?:js|mjs|cjs)$/.test(normalized)) return 0;
  if (/(?:^|\/)(?:dist|build|bundles?|browser|umd)(?:\/|$)/.test(normalized)) return 1;
  if (/(?:^|\/)(?:lib|cjs|esm|module)(?:\/|$)/.test(normalized)) return 2;
  return 3;
}

/** Prefer shipped production bundles, especially explicit minified builds. */
export function selectProductionSources(files: PackageSourceFile[], limit = MAX_SELECTED_FILES): PackageSourceFile[] {
  const javascript = files
    .filter((file) => /\.(?:js|mjs|cjs)$/.test(file.name.toLowerCase()) && file.content.length > 0)
    .sort((a, b) => sourceRank(a.name) - sourceRank(b.name) || a.name.localeCompare(b.name));
  const minified = javascript.filter((file) => sourceRank(file.name) === 0);
  const preferred = minified.length ? minified : javascript;
  return preferred.slice(0, Math.max(1, Math.floor(limit)));
}

function isAlreadyMinified(file: PackageSourceFile): boolean {
  if (sourceRank(file.name) === 0) return true;
  const sample = file.content.slice(0, 16_000);
  const lineLengths = sample.split(/\r?\n/).map((line) => line.length);
  const longestLine = Math.max(0, ...lineLengths);
  const whitespace = (sample.match(/\s/g) || []).length;
  return sample.length > 4_000 && longestLine > 2_000 && whitespace / sample.length < 0.08;
}

async function minifyWithTerser(source: string, options: Record<string, unknown>): Promise<string | null> {
  const terser = require('terser');
  const result = await terser.minify(source, options);
  return typeof result.code === 'string' ? result.code : null;
}

const TERSER_CONFIGS: Array<Record<string, unknown>> = [
  { compress: true, mangle: true, format: { comments: LICENSE_COMMENT } },
  { compress: { passes: 2 }, mangle: { toplevel: false }, format: { comments: LICENSE_COMMENT } },
];

/**
 * Keep shipped minified builds as-is. When no minified build exists, fingerprint
 * the selected production sources and two deterministic Terser output variants.
 */
export async function prepareCorpusVariants(
  files: PackageSourceFile[],
  minify: MinifyPackageSource = minifyWithTerser,
): Promise<string[]> {
  const selected = selectProductionSources(files);
  const variants = new Set<string>();
  for (const [index, file] of selected.entries()) {
    variants.add(file.content);
    if (isAlreadyMinified(file)) continue;
    for (const config of TERSER_CONFIGS) {
      try {
        const code = await minify(file.content, config);
        if (code && code.length <= MAX_SINGLE_SOURCE_BYTES) variants.add(code);
      } catch (_) {
        // A package can contain syntax Terser does not support; keep its original.
      }
    }
    if (index + 1 >= MAX_SELECTED_FILES) break;
  }
  return [...variants].filter((source) => source.length <= MAX_SINGLE_SOURCE_BYTES).slice(0, 1 + MAX_SELECTED_FILES * 2);
}

/** Read production JavaScript entries from an npm gzip tarball without extracting it. */
export function packageSourceFiles(bytes: Uint8Array): PackageSourceFile[] {
  const zlib = require('node:zlib');
  const BufferImpl = require('node:buffer').Buffer;
  let archive: any;
  try { archive = zlib.gunzipSync(BufferImpl.from(bytes)); } catch (_) { return []; }
  const sourceFiles: PackageSourceFile[] = [];
  let offset = 0;
  let totalBytes = 0;
  while (offset + 512 <= archive.length && sourceFiles.length < MAX_SOURCE_FILES && totalBytes < MAX_SOURCE_BYTES) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte: number) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) break;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const lower = fullName.toLowerCase();
    const selectedPath = /\.(?:js|mjs|cjs)$/.test(lower) &&
      !/(?:^|\/)(?:test|tests|example|examples|demo|docs?|benchmark|benchmarks|types?)(?:\/|$)/.test(lower);
    if (selectedPath && size > 0 && size <= MAX_SINGLE_SOURCE_BYTES && bodyEnd <= archive.length) {
      sourceFiles.push({ name: fullName, content: archive.subarray(bodyStart, bodyEnd).toString('utf8') });
      totalBytes += size;
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return sourceFiles.sort((a, b) => sourceRank(a.name) - sourceRank(b.name) || a.name.localeCompare(b.name));
}
