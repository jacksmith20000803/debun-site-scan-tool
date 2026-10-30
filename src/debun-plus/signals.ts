import { parseSource } from './parser';
import { CandidateEvidence, Phase1SignalEvidence, Phase1SignalName, RegistryPackument } from './types';

type PackageIdentity = { name: string; weight: number; signal: Phase1SignalName; detail: string };

const KNOWN_PACKAGE_NAMES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /^(?:jquery|jQuery)$/i, name: 'jquery' },
  { pattern: /^(?:moment(?:\.js)?)$/i, name: 'moment' },
  { pattern: /^(?:lodash|_)$/i, name: 'lodash' },
  { pattern: /^(?:react)$/i, name: 'react' },
  { pattern: /^(?:react-dom|ReactDOM)$/i, name: 'react-dom' },
  { pattern: /^(?:vue(?:\.js)?)$/i, name: 'vue' },
  { pattern: /^(?:angular|angularjs)$/i, name: '@angular/core' },
  { pattern: /^(?:next|next\.js)$/i, name: 'next' },
  { pattern: /^(?:nuxt|nuxt\.js)$/i, name: 'nuxt' },
  { pattern: /^(?:core-js)$/i, name: 'core-js' },
  { pattern: /^(?:bootstrap)$/i, name: 'bootstrap' },
  { pattern: /^(?:moment-timezone)$/i, name: 'moment-timezone' },
];

const BANNER_BOILERPLATE = new Set([
  'license', 'licence', 'copyright', 'contributors', 'contributor', 'the', 'and', 'version', 'v',
  'mit', 'apache', 'bsd', 'isc', 'unlicense', 'mozilla', 'openjs', 'foundation', 'all', 'rights',
]);

const VERSION_PATTERN = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;

function normalizePackageName(raw: string): string | null {
  const value = raw.replace(/\.js$/i, '').trim();
  if (!value || BANNER_BOILERPLATE.has(value.toLowerCase())) return null;
  const known = KNOWN_PACKAGE_NAMES.find((entry) => entry.pattern.test(value));
  const normalized = known?.name || value;
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(normalized) ? normalized : null;
}

function pushSignal(
  target: Map<string, Phase1SignalEvidence>,
  signal: Phase1SignalName,
  packageName: string,
  weight: number,
  detail: string,
  version?: string,
): void {
  const normalized = normalizePackageName(packageName);
  if (!normalized) return;
  const key = `${signal}\0${normalized.toLowerCase()}\0${version || ''}`;
  const existing = target.get(key);
  if (existing) {
    existing.weight = Math.max(existing.weight, weight);
    if (!existing.detail.includes(detail)) existing.detail += `; ${detail}`;
    return;
  }
  target.set(key, {
    signal,
    package: normalized,
    ...(version ? { version } : {}),
    weight: Math.max(0, Math.min(1, weight)),
    detail,
  });
}

function commentText(comment: any): string {
  return typeof comment?.value === 'string' ? comment.value.replace(/^\*/, '') : '';
}

function extractLicenseCommentPairs(text: string): Array<{ name: string; version?: string }> {
  const found = new Map<string, { name: string; version?: string }>();
  const versionPair = new RegExp(
    String.raw`(?:^|[\s*|,;:])(@[\w.-]+\/[\w.-]+|[A-Za-z][\w.-]*)(?:\.js)?\s*(?:@\s*|v(?:ersion)?\s*[:=]?\s*|\s+)(${VERSION_PATTERN})(?=$|[\s|,;*)])`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = versionPair.exec(text))) {
    const name = normalizePackageName(match[1]);
    if (!name) continue;
    found.set(`${name.toLowerCase()}@${match[2]}`, { name, version: match[2] });
  }

  const scopedPackage = /(?:^|[\s*|,;:])(@[\w.-]+\/[\w.-]+)(?=$|[\s|,;*)])/g;
  while ((match = scopedPackage.exec(text))) {
    const name = normalizePackageName(match[1]);
    if (name && ![...found.values()].some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      found.set(`${name.toLowerCase()}@`, { name });
    }
  }

  // Some license headers identify a package without publishing a version.
  // Keep known names only here; generic license prose is too noisy.
  for (const entry of KNOWN_PACKAGE_NAMES) {
    const literal = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const candidatePattern = new RegExp(`(?:^|[^\\w.-])${literal}(?:$|[^\\w.-])`, 'i');
    if (candidatePattern.test(text) && ![...found.values()].some((item) => item.name.toLowerCase() === entry.name.toLowerCase())) {
      found.set(`${entry.name.toLowerCase()}@`, { name: entry.name });
    }
  }
  return [...found.values()];
}

function knownGlobalIdentitySignals(source: string): PackageIdentity[] {
  const identities: PackageIdentity[] = [];
  const add = (pattern: RegExp, name: string, detail: string, weight = 0.72) => {
    if (pattern.test(source)) identities.push({ name, signal: 'runtime-global', weight, detail });
  };
  add(/(?:\bReact\.(?:createElement|version|Component|Children)\b|\bwindow\s*(?:\.\s*React|\[\s*['"]React['"]\s*\])|\bglobalThis\.React\b)/, 'react', 'React runtime global read');
  add(/(?:\bjQuery\s*(?:\.\s*(?:fn|ajax|extend|version)|\()|\$\s*\.\s*fn\s*(?:\.|\[)|\bwindow\s*(?:\.\s*jQuery|\[\s*['"]jQuery['"]\s*\]))/i, 'jquery', 'jQuery runtime global read');
  add(/(?:\bmoment\s*\(|\bmoment\.version\b|\bwindow\.moment\b)/, 'moment', 'Moment runtime global read');
  add(/(?:\b_\.VERSION\b|\b_\.(?:map|each|assign|debounce|cloneDeep)\s*\(|\bwindow\._\b)/, 'lodash', 'Lodash runtime global read');
  add(/(?:\bVue\.(?:createApp|version|component|directive)\b|\bwindow\.Vue\b)/, 'vue', 'Vue runtime global read');
  add(/(?:\bangular\.module\s*\(|\bng\.(?:core|common)\b|\bɵɵdefineComponent\b)/, '@angular/core', 'Angular runtime global read');
  return identities;
}

function umdGlobalLeaks(source: string): PackageIdentity[] {
  const umdWrapper = /(?:typeof\s+(?:exports|module|define)\b|define\.amd|module\.exports|\bfactory\s*\()/i.test(source);
  if (!umdWrapper) return [];
  const patterns: Array<[RegExp, string, string]> = [
    [/(?:window|global|self|globalThis|root)\s*(?:\.\s*React|\[\s*['"]React['"]\s*\])\s*(?:=|\|\|\s*=)/i, 'react', 'UMD wrapper leaks a React global'],
    [/(?:window|global|self|globalThis|root)\s*(?:\.\s*(?:jQuery|\$)|\[\s*['"](?:jQuery|\$)['"]\s*\])\s*(?:=|\|\|\s*=)/i, 'jquery', 'UMD wrapper leaks a jQuery global'],
    [/(?:window|global|self|globalThis|root)\s*(?:\.\s*moment|\[\s*['"]moment['"]\s*\])\s*(?:=|\|\|\s*=)/i, 'moment', 'UMD wrapper leaks a Moment global'],
    [/(?:window|global|self|globalThis|root)\s*(?:\.\s*_|\[\s*['_']\s*\])\s*(?:=|\|\|\s*=)/i, 'lodash', 'UMD wrapper leaks a Lodash global'],
    [/(?:window|global|self|globalThis|root)\s*(?:\.\s*Vue|\[\s*['"]Vue['"]\s*\])\s*(?:=|\|\|\s*=)/i, 'vue', 'UMD wrapper leaks a Vue global'],
  ];
  return patterns.flatMap(([pattern, name, detail]) => pattern.test(source)
    ? [{ name, signal: 'umd-global' as const, weight: 0.88, detail }]
    : []);
}

function metaFrameworkReads(source: string): PackageIdentity[] {
  const reads: PackageIdentity[] = [];
  if (/\b__NEXT_DATA__\b|\b__next_f\b|\b__next_require__\b|next\/dist\/(?:client|shared)/i.test(source)) {
    reads.push({ name: 'next', signal: 'meta-framework', weight: 0.88, detail: 'Next.js framework runtime data/read marker' });
  }
  if (/\b__NUXT__\b|\b__NUXT_DATA__\b|\buseNuxtApp\b|nuxt\/dist\//i.test(source)) {
    reads.push({ name: 'nuxt', signal: 'meta-framework', weight: 0.88, detail: 'Nuxt framework runtime data/read marker' });
  }
  if (/\b__sveltekit\b|svelte\/internal/i.test(source)) {
    reads.push({ name: '@sveltejs/kit', signal: 'meta-framework', weight: 0.86, detail: 'SvelteKit framework runtime read marker' });
  }
  if (/\bastro-island\b|astro\/runtime/i.test(source)) {
    reads.push({ name: 'astro', signal: 'meta-framework', weight: 0.86, detail: 'Astro framework runtime read marker' });
  }
  return reads;
}

function embeddedVersionPairs(source: string, identities: PackageIdentity[]): Array<{ name: string; version: string; detail: string }> {
  const pairs: Array<{ name: string; version: string; detail: string }> = [];
  const uniqueIdentities = [...new Map(identities.map((item) => [item.name.toLowerCase(), item])).values()];
  const addMatches = (pattern: RegExp, name: string, detail: string) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) pairs.push({ name, version: match[1], detail });
  };
  addMatches(new RegExp(String.raw`\bjQuery(?:\.fn)?\.jquery\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'jquery', 'jQuery embedded version assignment');
  addMatches(new RegExp(String.raw`\b(?:moment|_moment)\.version\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'moment', 'Moment embedded version assignment');
  addMatches(new RegExp(String.raw`\b(?:lodash|_)\.VERSION\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'lodash', 'Lodash embedded VERSION assignment');
  addMatches(new RegExp(String.raw`\bReact\.version\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'react', 'React embedded version assignment');
  addMatches(new RegExp(String.raw`\bVue\.version\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'vue', 'Vue embedded version assignment');

  const genericPatterns: Array<[RegExp, string]> = [
    [new RegExp(String.raw`\bversion\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'version property'],
    [new RegExp(String.raw`\bVERSION\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'g'), 'VERSION property'],
    [new RegExp(String.raw`\bexports\.version\s*=\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'exports.version assignment'],
    [new RegExp(String.raw`\bmodule\.exports\.version\s*=\s*['"](${VERSION_PATTERN})['"]`, 'gi'), 'module.exports.version assignment'],
  ];
  if (uniqueIdentities.length === 1) {
    for (const [pattern, detail] of genericPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) pairs.push({ name: uniqueIdentities[0].name, version: match[1], detail });
    }
    if (uniqueIdentities[0].name.toLowerCase() === 'jquery') {
      const jqueryVersion = new RegExp(String.raw`\bjquery\s*[:=]\s*['"](${VERSION_PATTERN})['"]`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = jqueryVersion.exec(source))) pairs.push({ name: 'jquery', version: match[1], detail: 'jQuery embedded jquery version property' });
    }
  }

  const unique = new Map<string, { name: string; version: string; detail: string }>();
  for (const item of pairs) unique.set(`${item.name.toLowerCase()}@${item.version}`, item);
  return [...unique.values()];
}

export async function detectLicenseBannerSignals(source: string): Promise<Phase1SignalEvidence[]> {
  let comments: any[] = [];
  try { comments = (await parseSource(source)).comments || []; } catch (_) { return []; }
  const evidence = new Map<string, Phase1SignalEvidence>();
  for (const comment of comments) {
    const raw = source.slice(comment.start, comment.end);
    const text = commentText(comment);
    if (!(raw.startsWith('/*!') || /@license\b/i.test(text))) continue;
    for (const pair of extractLicenseCommentPairs(text)) {
      pushSignal(
        evidence,
        'license-banner',
        pair.name,
        pair.version ? 0.95 : 0.78,
        pair.version ? `license banner identifies ${pair.name}@${pair.version}` : `license banner identifies ${pair.name}`,
        pair.version,
      );
    }
  }
  return [...evidence.values()];
}

export function detectRuntimeGlobalSignals(source: string): Phase1SignalEvidence[] {
  const evidence = new Map<string, Phase1SignalEvidence>();
  for (const identity of knownGlobalIdentitySignals(source)) {
    pushSignal(evidence, 'runtime-global', identity.name, identity.weight, identity.detail);
  }
  return [...evidence.values()];
}

export function detectUmdGlobalSignals(source: string): Phase1SignalEvidence[] {
  const evidence = new Map<string, Phase1SignalEvidence>();
  for (const identity of umdGlobalLeaks(source)) {
    pushSignal(evidence, 'umd-global', identity.name, identity.weight, identity.detail);
  }
  return [...evidence.values()];
}

export function detectMetaFrameworkSignals(source: string): Phase1SignalEvidence[] {
  const evidence = new Map<string, Phase1SignalEvidence>();
  for (const identity of metaFrameworkReads(source)) {
    pushSignal(evidence, 'meta-framework', identity.name, identity.weight, identity.detail);
  }
  return [...evidence.values()];
}

export async function detectEmbeddedVersionSignals(source: string): Promise<Phase1SignalEvidence[]> {
  const banners = await detectLicenseBannerSignals(source);
  const identities = [
    ...banners.map((item) => ({ name: item.package, signal: 'license-banner' as const, weight: item.weight, detail: item.detail })),
    ...knownGlobalIdentitySignals(source),
    ...umdGlobalLeaks(source),
    ...metaFrameworkReads(source),
  ];
  const evidence = new Map<string, Phase1SignalEvidence>();
  for (const pair of embeddedVersionPairs(source, identities)) {
    pushSignal(evidence, 'embedded-version', pair.name, 0.98, pair.detail, pair.version);
  }
  return [...evidence.values()];
}

export async function detectPhase1Signals(source: string): Promise<Phase1SignalEvidence[]> {
  const groups = await Promise.all([
    detectLicenseBannerSignals(source),
    detectEmbeddedVersionSignals(source),
  ]);
  const otherGroups = [detectRuntimeGlobalSignals(source), detectUmdGlobalSignals(source), detectMetaFrameworkSignals(source)];
  const evidence = new Map<string, Phase1SignalEvidence>();
  for (const item of [...groups.flat(), ...otherGroups.flat()]) {
    pushSignal(evidence, item.signal, item.package, item.weight, item.detail, item.version);
  }
  return [...evidence.values()];
}

export function validatePublishedSignalVersions<T extends Pick<CandidateEvidence, 'version' | 'signal'>>(
  evidence: T[],
  packument: RegistryPackument | null | undefined,
): T[] {
  const published = packument?.versions || {};
  return evidence.filter((item) => !item.version || Object.prototype.hasOwnProperty.call(published, item.version));
}

export function phase1CandidateEvidence(item: Phase1SignalEvidence): CandidateEvidence {
  return {
    source: item.signal === 'umd-global' ? 'umd-global' : item.signal,
    detail: item.detail,
    ...(item.version ? { version: item.version } : {}),
    signal: item.signal,
    package: item.package,
    weight: item.weight,
  };
}
