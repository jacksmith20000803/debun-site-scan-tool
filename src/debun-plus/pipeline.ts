import { fingerprintBundle, fingerprintCode, fingerprintCss, indexableFeatures, intrinsicCandidates, mergeVectors } from './features';
import { normalizeBundle } from './normalize';
import { createRegistryClient, mapBounded, withBoundedRegistry } from './registry';
import { discriminateVersions, rangeForVersion, scoreVectors } from './scoring';
import { compareSemver, satisfies } from './semver';
import { createSqliteCache } from './sqlite-cache';
import { matchLiteralFragments, normalizeIndexedLiteral } from './literal-index';
import { detectPhase1Signals, phase1CandidateEvidence, validatePublishedSignalVersions } from './signals';
import { packageSourceFiles, prepareCorpusVariants } from './corpus';
import { collectDependencyLayer, dependencyRecord, selectConstraintVersion } from './transitive';
import {
  BundleSource,
  BundleFormatSummary,
  CachedVersionCorpus,
  CandidateEvidence,
  CorpusCache,
  DebunPlusOptions,
  DebunPlusResult,
  FingerprintVector,
  PackageCandidate,
  PackageDependencyTree,
  PackageDetection,
  RegistryClient,
  RegistryPackument,
  RegistryVersion,
} from './types';

const DEFAULTS = { concurrency: 4, maxCandidates: 20, maxVersionsPerPackage: 4, maxFingerprintSlices: 256, maxTransitiveDepth: 3 };
const MINIMUM_AST_ONLY_POSSIBLE_SCORE = 0.25;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('The scan was stopped.');
  error.name = 'AbortError';
  throw error;
}

/** Reject low-scoring possible verdicts when the only lead is a broad AST-property index hit. */
export function shouldReportPossibleCandidate(evidence: CandidateEvidence[], score: number): boolean {
  return evidence.some((item) => item.source !== 'ast-property') || score >= MINIMUM_AST_ONLY_POSSIBLE_SCORE;
}

function addEvidence(target: Map<string, PackageCandidate>, name: string, evidence: CandidateEvidence): void {
  const normalized = name.trim();
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(normalized)) return;
  const key = normalized.toLowerCase();
  let candidate = target.get(key);
  if (!candidate) {
    candidate = { name: normalized, evidence: [] };
    target.set(key, candidate);
  }
  if (!candidate.evidence.some((item) => item.source === evidence.source && item.detail === evidence.detail && item.version === evidence.version)) {
    candidate.evidence.push(evidence);
  }
}

function stableVersions(packument: RegistryPackument): RegistryVersion[] {
  return Object.values(packument.versions || {})
    .filter((version) => /^\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(version.version))
    .sort((a, b) => compareSemver(b.version, a.version));
}

function versionsToCompare(candidate: PackageCandidate, packument: RegistryPackument, limit: number): RegistryVersion[] {
  const all = stableVersions(packument);
  const exactHints = candidate.evidence.map((item) => item.version).filter((value): value is string => Boolean(value));
  const selected = new Map<string, RegistryVersion>();
  const targetCount = Math.max(limit, Math.min(limit + exactHints.length, limit + 3));
  const add = (version: RegistryVersion | undefined) => {
    if (version && selected.size < targetCount) selected.set(version.version, version);
  };

  // Preserve exact versions found in banners, URLs, manifests, or the legacy
  // POG engine before sampling the registry history.
  for (const version of exactHints) {
    const match = packument.versions?.[version];
    add(match);
  }

  // A declared semver range is useful evidence too. Compare a few newest
  // published releases that satisfy it instead of treating the range as an
  // invalid exact-version string.
  const rangeHints = exactHints.filter((hint) => !packument.versions?.[hint] && /[~^<>=*x|\s]/i.test(hint));
  for (const hint of rangeHints) {
    let matched = 0;
    for (const version of all) {
      if (satisfies(version.version, hint)) {
        add(version);
        if (++matched >= Math.min(3, targetCount)) break;
      }
    }
  }

  // Keep the two newest releases for adjacent-version comparison, then sample
  // evenly from the rest of stable history. This preserves a current baseline
  // and gives older shipped bundles a chance to match their release era.
  for (const version of all.slice(0, Math.min(2, targetCount))) add(version);
  const slots = Math.max(0, targetCount - selected.size);
  const older = all.slice(2);
  for (let sample = 0; sample < slots; sample++) {
    const index = slots <= 1
      ? older.length - 1
      : Math.round((sample * (older.length - 1)) / (slots - 1));
    add(older[index]);
  }
  for (const version of all) add(version);
  return [...selected.values()].slice(0, targetCount);
}

function packageManifest(version: RegistryVersion, vectors: FingerprintVector[]): CachedVersionCorpus {
  return {
    fingerprintRevision: 2,
    name: version.name,
    version: version.version,
    dependencies: version.dependencies || {},
    peerDependencies: version.peerDependencies || {},
    optionalDependencies: version.optionalDependencies || {},
    vector: mergeVectors(vectors),
    moduleVectors: vectors.slice(0, 16),
  };
}

async function getPackument(
  name: string,
  registry: RegistryClient,
  cache: CorpusCache,
  stats: DebunPlusResult['stats'],
  signal?: AbortSignal,
): Promise<RegistryPackument | null> {
  const cached = cache.getPackument?.(name);
  if (cached) { stats.cacheHits++; return cached; }
  stats.registryRequests++;
  const value = await registry.getPackument(name, signal);
  if (value) cache.putPackument?.(name, value);
  return value;
}

async function fetchCorpus(
  name: string,
  version: RegistryVersion,
  registry: RegistryClient,
  cache: CorpusCache,
  stats: DebunPlusResult['stats'],
  signal?: AbortSignal,
): Promise<CachedVersionCorpus | null> {
  const cached = cache.getVersion(name, version.version);
  if (cached) { stats.cacheHits++; return cached; }
  const tarball = version.dist?.tarball;
  if (!tarball) return null;
  stats.registryRequests++;
  const bytes = await registry.getTarball(tarball, signal, version.dist?.integrity, version.dist?.shasum);
  if (!bytes) return null;
  const packageFiles = packageSourceFiles(bytes);
  if (!packageFiles.length) return null;
  const sources = await prepareCorpusVariants(packageFiles);
  if (!sources.length) return null;
  const vectors = await mapBounded(sources, 4, fingerprintCode);
  const corpus = packageManifest(version, vectors);
  cache.putVersion(corpus);
  return corpus;
}

function compareAgainstTargets(version: string, corpus: CachedVersionCorpus, targets: FingerprintVector[]) {
  const corpusVectors = corpus.moduleVectors?.length ? corpus.moduleVectors : [corpus.vector];
  return targets.flatMap((target) => corpusVectors.map((vector) => ({ version, target, corpus: vector })));
}

async function candidatesFromBundles(bundles: BundleSource[], codeByBundle: string[], signal?: AbortSignal): Promise<Map<string, PackageCandidate>> {
  const candidates = new Map<string, PackageCandidate>();
  for (const [index, bundle] of bundles.entries()) {
    throwIfAborted(signal);
    const code = codeByBundle[index] || bundle.code;
    for (const hit of intrinsicCandidates(code, bundle.url)) {
      const sources: Record<string, CandidateEvidence['source']> = {
        'bundle-string': 'bundle-string', 'license-banner': 'license-banner', 'embedded-version': 'embedded-version',
        'runtime-global': 'runtime-global', 'meta-framework': 'meta-framework', 'css-class': 'css-class', 'script-url': 'script-url',
      };
      addEvidence(candidates, hit.name, { source: sources[hit.source] || 'bundle-string', detail: hit.detail, version: hit.version });
    }
    for (const hit of await detectPhase1Signals(code)) addEvidence(candidates, hit.package, phase1CandidateEvidence(hit));
  }
  return candidates;
}

function vectorCandidates(vectors: FingerprintVector[], candidateMap: Map<string, PackageCandidate>, cache: CorpusCache, limit: number): void {
  const merged = mergeVectors(vectors);
  const names = cache.findCandidateNames(indexableFeatures(merged), limit);
  for (const item of names) addEvidence(candidateMap, item.name, { source: 'ast-property', detail: `SQLite inverted feature index matched ${item.matches} bundle signatures` });
}

async function compareDirectCandidates(
  candidates: PackageCandidate[],
  targetVectors: FingerprintVector[],
  registry: RegistryClient,
  cache: CorpusCache,
  options: DebunPlusOptions & typeof DEFAULTS,
  stats: DebunPlusResult['stats'],
): Promise<{ detections: PackageDetection[]; candidates: PackageCandidate[]; selectedVersions: Map<string, RegistryVersion>; packuments: Map<string, RegistryPackument> }> {
  const packuments = new Map<string, RegistryPackument>();
  const versionRows = await mapBounded(candidates, options.concurrency, async (candidate) => {
    const packument = await getPackument(candidate.name, registry, cache, stats, options.signal);
    if (!packument) return { candidate, packument: null, rows: [] as Array<{ version: RegistryVersion; corpus: CachedVersionCorpus }> };
    packuments.set(candidate.name, packument);
    const versions = versionsToCompare(candidate, packument, options.maxVersionsPerPackage);
    const rows = await mapBounded(versions, options.concurrency, async (version) => {
      const corpus = await fetchCorpus(candidate.name, version, registry, cache, stats, options.signal);
      if (!corpus) return null;
      stats.versionsCompared++;
      return { version, corpus };
    });
    return { candidate, packument, rows: rows.filter((row): row is { version: RegistryVersion; corpus: CachedVersionCorpus } => Boolean(row)) };
  });

  const detections: PackageDetection[] = [];
  const acceptedCandidates: PackageCandidate[] = [];
  const selectedVersions = new Map<string, RegistryVersion>();
  for (const item of versionRows) {
    const { packument, rows } = item;
    const candidate = {
      ...item.candidate,
      evidence: validatePublishedSignalVersions(item.candidate.evidence, packument),
    };
    if (candidate.evidence.length) acceptedCandidates.push(candidate);
    if (!candidate.evidence.length) continue;
    if (!packument || rows.length === 0) {
      detections.push({
        name: candidate.name,
        version: 'unknown',
        tier: 'possible',
        score: 0,
        margin: 0,
        evidence: [...candidate.evidence, { source: 'registry-fingerprint', detail: 'registry corpus version fingerprints were unavailable for comparison' }],
        dependencies: {},
      });
      continue;
    }
    const comparisons = rows.flatMap(({ version, corpus }) => compareAgainstTargets(version.version, corpus, targetVectors));
    const result = discriminateVersions(comparisons);
    if (result.tier === 'possible' && !shouldReportPossibleCandidate(candidate.evidence, result.topScore)) continue;
    const selected = rows.find(({ version }) => version.version === result.scores[0]?.version)?.version;
    // Only exact verdicts are safe roots for dependency-tree expansion.
    if (selected && result.tier === 'exact') selectedVersions.set(candidate.name, selected);
    const evidence = [...candidate.evidence];
    if (result.tier !== 'possible') evidence.push({
      source: 'registry-fingerprint',
      detail: `fused AST ${result.scores[0]?.ast.toFixed(3)}, 4-gram ${result.scores[0]?.ngram.toFixed(3)}, identifier ${result.scores[0]?.ident.toFixed(3)}; ${result.scores[0]?.fragmentSupport || 0} supporting fragments; margin ${result.margin.toFixed(3)}`,
      version: result.scores[0]?.version,
    });
    const dependencies = selected ? {
      ...(selected.dependencies || {}), ...(selected.optionalDependencies || {}), ...(selected.peerDependencies || {}),
    } : {};
    detections.push({
      name: candidate.name,
      version: result.tier === 'exact' ? result.version : result.tier === 'range' ? result.version : 'unknown',
      tier: result.tier,
      score: Number(result.topScore.toFixed(4)),
      margin: Number(result.margin.toFixed(4)),
      evidence,
      dependencies,
    });
  }
  return { detections, candidates: acceptedCandidates, selectedVersions, packuments };
}

function rootVersionFromTree(version: RegistryVersion, tree: PackageDependencyTree): RegistryVersion {
  if (tree.name.toLowerCase() !== version.name.toLowerCase() || tree.version !== version.version) return version;
  const dependencySets: Record<'dependency' | 'optional' | 'peer', Record<string, string>> = {
    dependency: {}, optional: {}, peer: {},
  };
  for (const [name, dependency] of Object.entries(tree.dependencies || {})) {
    const range = dependency.requestedRange;
    if (!range || dependency.unresolved) continue;
    dependencySets[dependency.dependencyType || 'dependency'][name] = range;
  }
  return {
    ...version,
    dependencies: { ...(version.dependencies || {}), ...dependencySets.dependency },
    optionalDependencies: { ...(version.optionalDependencies || {}), ...dependencySets.optional },
    peerDependencies: { ...(version.peerDependencies || {}), ...dependencySets.peer },
  };
}

async function exactRootsWithRegistryTrees(
  selectedVersions: Map<string, RegistryVersion>,
  registry: RegistryClient,
  options: DebunPlusOptions & typeof DEFAULTS,
  stats: DebunPlusResult['stats'],
): Promise<Array<{ name: string; version: RegistryVersion; depth: number }>> {
  return mapBounded([...selectedVersions.entries()], options.concurrency, async ([name, version]) => {
    if (!registry.getDependencyTree) return { name, version, depth: 0 };
    try {
      stats.registryRequests++;
      const tree = await registry.getDependencyTree(name, version.version, options.maxTransitiveDepth + 1, options.signal);
      return { name, version: rootVersionFromTree(version, tree), depth: 0 };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Registry tree APIs are optional on injected test/offline clients. The
      // exact packument version still carries its direct dependency ranges.
      return { name, version, depth: 0 };
    }
  });
}

function hasStringLiteralFingerprint(targets: FingerprintVector[], corpora: CachedVersionCorpus[]): boolean {
  const bundleLiterals = new Set(targets.flatMap((target) => target.stringLiterals)
    .map(normalizeIndexedLiteral).filter((literal): literal is string => Boolean(literal)));
  if (!bundleLiterals.size) return false;
  return corpora.some((corpus) => {
    const literals = [
      ...corpus.vector.stringLiterals,
      ...(corpus.moduleVectors || []).flatMap((vector) => vector.stringLiterals),
    ];
    return literals.some((value) => {
      const literal = normalizeIndexedLiteral(value);
      return Boolean(literal && bundleLiterals.has(literal));
    });
  });
}

function detectionRank(detection: PackageDetection): number {
  return detection.tier === 'exact' ? 3 : detection.tier === 'range' ? 2 : 1;
}

function mergePackageDetections(...groups: PackageDetection[][]): PackageDetection[] {
  const merged = new Map<string, PackageDetection>();
  for (const group of groups) {
    for (const next of group) {
      const key = next.name.toLowerCase();
      const current = merged.get(key);
      if (!current) { merged.set(key, next); continue; }

      // Direct bundle detections take precedence over propagated records.
      if (current.dependencyStatus === undefined && next.dependencyStatus !== undefined) continue;
      if (current.dependencyStatus !== undefined && next.dependencyStatus === undefined) {
        merged.set(key, { ...next, evidence: [...current.evidence, ...next.evidence] });
        continue;
      }
      const stronger = detectionRank(next) > detectionRank(current) ||
        (detectionRank(next) === detectionRank(current) && next.score > current.score) ? next : current;
      const statuses = [current.dependencyStatus, next.dependencyStatus];
      const dependencyStatus = statuses.includes('confirmed') ? 'confirmed'
        : statuses.includes('inferred') ? 'inferred'
          : statuses.includes('excluded') ? 'excluded' : undefined;
      merged.set(key, {
        ...stronger,
        evidence: [...new Map([...current.evidence, ...next.evidence].map((item) => [
          `${item.source}|${item.detail}|${item.version || ''}`, item,
        ])).values()],
        ...(dependencyStatus ? { dependencyStatus } : {}),
      });
    }
  }
  return [...merged.values()];
}

function rootDetectionLeads(
  candidates: PackageCandidate[],
  detections: PackageDetection[],
  transitiveNames: Set<string>,
): PackageCandidate[] {
  const byName = new Map(detections.map((item) => [item.name.toLowerCase(), item]));
  return candidates.filter((candidate) => {
    const name = candidate.name.toLowerCase();
    const detection = byName.get(name);
    return Boolean(detection && detection.tier !== 'exact' && !transitiveNames.has(name) &&
      candidate.evidence.some((evidence) => evidence.source !== 'ast-property'));
  });
}

async function propagateTransitive(
  initial: PackageDetection[],
  selectedVersions: Map<string, RegistryVersion>,
  packuments: Map<string, RegistryPackument>,
  targetVectors: FingerprintVector[],
  registry: RegistryClient,
  cache: CorpusCache,
  options: DebunPlusOptions & typeof DEFAULTS,
  stats: DebunPlusResult['stats'],
): Promise<{ packages: PackageDetection[]; dependencyNames: Set<string> }> {
  const directNames = new Set(initial.map((item) => item.name.toLowerCase()));
  const all = [...initial];
  const dependencyNames = new Set<string>();
  let parents = await exactRootsWithRegistryTrees(selectedVersions, registry, options, stats);
  const constraintsByName = new Map<string, { name: string; ranges: string[]; parents: string[] }>();
  const processedConstraints = new Map<string, string>();

  for (let depth = 1; depth <= options.maxTransitiveDepth && parents.length; depth++) {
    const discovered = collectDependencyLayer(parents, depth);
    for (const requirement of discovered) {
      const key = requirement.name.toLowerCase();
      dependencyNames.add(key);
      const saved = constraintsByName.get(key) || { name: requirement.name, ranges: [], parents: [] };
      saved.ranges = [...new Set([...saved.ranges, ...requirement.ranges])];
      saved.parents = [...new Set([...saved.parents, ...requirement.parents])];
      constraintsByName.set(key, saved);
    }
    const frontier = discovered
      .map((requirement) => constraintsByName.get(requirement.name.toLowerCase())!)
      .filter((requirement) => {
        const signature = requirement.ranges.slice().sort().join(' & ');
        if (processedConstraints.get(requirement.name.toLowerCase()) === signature) return false;
        processedConstraints.set(requirement.name.toLowerCase(), signature);
        return true;
      });
    const nextParents: Array<{ name: string; version: RegistryVersion; depth: number }> = [];
    type ResolvedDependency = {
      requirement: { name: string; ranges: string[]; parents: string[] };
      packument: RegistryPackument | null;
      chosen: RegistryVersion | null;
      corpora: CachedVersionCorpus[];
    };
    const resolved: ResolvedDependency[] = await mapBounded(frontier, options.concurrency, async (requirement): Promise<ResolvedDependency> => {
      const packument = packuments.get(requirement.name) || await getPackument(requirement.name, registry, cache, stats, options.signal);
      if (packument) packuments.set(requirement.name, packument);
      if (!packument) return { requirement, packument: null, chosen: null, corpora: [] as CachedVersionCorpus[] };
      const selection = selectConstraintVersion(packument, requirement.ranges);
      const versions = stableVersions(packument).filter((version) => requirement.ranges.every((range) => satisfies(version.version, range)));
      const candidates = selection.version
        ? [packument.versions?.[selection.version], ...versions.filter((version) => version.version !== selection.version)].filter(Boolean).slice(0, options.maxVersionsPerPackage) as RegistryVersion[]
        : [];
      const corpora = await mapBounded(candidates, options.concurrency, async (version) => fetchCorpus(requirement.name, version, registry, cache, stats, options.signal));
      stats.versionsCompared += corpora.filter(Boolean).length;
      return { requirement, packument, chosen: candidates[0] || null, corpora: corpora.filter((corpus): corpus is CachedVersionCorpus => Boolean(corpus)) };
    });

    for (const item of resolved) {
      const { requirement, packument, chosen, corpora } = item;
      if (!packument) {
        if (!directNames.has(requirement.name.toLowerCase())) {
          const record = dependencyRecord(requirement.name, requirement.ranges, 0, null, [
            { source: 'transitive-registry', detail: `required by ${requirement.parents.join(', ')}, but registry metadata was unavailable` },
          ], 'inferred');
          const current = all.findIndex((entry) => entry.name.toLowerCase() === requirement.name.toLowerCase());
          if (current < 0) all.push(record); else all[current] = record;
        }
        continue;
      }
      if (!chosen) {
        if (!directNames.has(requirement.name.toLowerCase())) {
          const record = dependencyRecord(requirement.name, requirement.ranges, 0, null, [
            { source: 'transitive-registry', detail: `version constraints from ${requirement.parents.join(', ')} do not intersect` },
          ], 'inferred');
          const current = all.findIndex((entry) => entry.name.toLowerCase() === requirement.name.toLowerCase());
          if (current < 0) all.push(record); else all[current] = record;
        }
        continue;
      }
      const comparisons = corpora.flatMap((corpus) => compareAgainstTargets(corpus.version, corpus, targetVectors));
      const result = discriminateVersions(comparisons);
      const identity = requirement.name.toLowerCase();
      if (!directNames.has(identity)) {
        const verified = result.tier === 'exact' ? result.scores[0]?.version || null : null;
        const literalMatch = corpora.length > 0 && hasStringLiteralFingerprint(targetVectors, corpora);
        const dependencyStatus = corpora.length === 0 ? 'inferred' : literalMatch ? 'confirmed' : 'excluded';
        const fingerprintDetail = dependencyStatus === 'confirmed'
          ? 'bundle string-literal fingerprint matched the registry corpus'
          : dependencyStatus === 'excluded'
            ? 'no bundle string-literal fingerprint matched; excluded as tree-shaken'
            : 'registry corpus fingerprint unavailable; dependency remains inferred';
        const record = dependencyRecord(
          requirement.name,
          requirement.ranges,
          result.topScore,
          verified,
          [
            { source: 'transitive-registry', detail: `required by ${requirement.parents.join(', ')}` },
            { source: 'transitive-registry', detail: fingerprintDetail },
          ],
          dependencyStatus,
        );
        const current = all.findIndex((entry) => entry.name.toLowerCase() === identity);
        if (current < 0) all.push(record); else all[current] = record;
      }
      const nextVersion = packument.versions?.[result.scores[0]?.version || chosen.version] || chosen;
      // Tree-shaken dependencies are recorded as excluded and should not
      // contribute further descendants to later layers.
      const currentRecord = all.find((entry) => entry.name.toLowerCase() === requirement.name.toLowerCase());
      if (currentRecord?.dependencyStatus !== 'excluded') nextParents.push({ name: requirement.name, version: nextVersion, depth });
    }
    parents = nextParents;
  }
  return { packages: all, dependencyNames };
}

export async function analyzeBundles(sources: BundleSource[], userOptions: DebunPlusOptions = {}): Promise<DebunPlusResult> {
  const options = { ...DEFAULTS, ...userOptions };
  const stats: DebunPlusResult['stats'] = {
    bundlesNormalized: 0, moduleSlices: 0, fingerprintSlices: 0, candidatesGenerated: 0, versionsCompared: 0, registryRequests: 0, cacheHits: 0,
  };
  throwIfAborted(options.signal);
  if (!sources.length) return { packages: [], candidates: [], bundleFormats: [], stats };

  const normalized = await mapBounded(sources, options.concurrency, async (source) => {
    throwIfAborted(options.signal);
    const bundle = await normalizeBundle(source);
    throwIfAborted(options.signal);
    return bundle;
  });
  throwIfAborted(options.signal);
  stats.bundlesNormalized = normalized.length;
  const bundleFormats: BundleFormatSummary[] = normalized.map((bundle, index) => ({
    sourceFile: bundle.url || sources[index]?.url || `bundle-${index + 1}`,
    bundleFormat: bundle.bundleFormat || 'unrecognized(unknown)',
    confidence: Number((bundle.bundleFormatConfidence || 0).toFixed(3)),
    hints: bundle.bundleFormatHints || [],
    evidence: bundle.bundleFormatEvidence || [],
  }));
  stats.moduleSlices = normalized.reduce((sum, bundle) => sum + bundle.coarseModules.length + bundle.fineModules.length, 0);
  const perBundleBudget = Math.max(1, Math.floor(options.maxFingerprintSlices / normalized.length));
  const vectorsByBundle = await mapBounded(normalized, options.concurrency, (bundle) => {
    throwIfAborted(options.signal);
    const vectors = fingerprintBundle(bundle, perBundleBudget);
    throwIfAborted(options.signal);
    return vectors;
  });
  throwIfAborted(options.signal);
  const targetVectors = vectorsByBundle.flat();
  stats.fingerprintSlices = targetVectors.length;
  const cssVectors = (userOptions.cssSources || []).map(fingerprintCss);
  const ownsCache = !userOptions.cache;
  const cache = userOptions.cache || createSqliteCache(userOptions.databasePath);
  try {
    const candidateMap = new Map<string, PackageCandidate>();
    const literalFragments = vectorsByBundle.map((vectors, index) => ({
      sourceFile: normalized[index].url || sources[index]?.url || `bundle-${index + 1}`,
      stringLiterals: [...new Set(vectors.flatMap((vector) => vector.stringLiterals))],
    }));
    const literalMatches = matchLiteralFragments(literalFragments, cache, userOptions.stringLiteralIndexTier || 'topN');
    for (const hit of literalMatches) {
      if (!hit.strong) continue;
      addEvidence(candidateMap, hit.name, {
        source: 'literal-index',
        version: hit.version,
        detail: `IDF string-literal index matched ${hit.matchedLiteralCount} literals (score ${hit.score.toFixed(3)}) in ${hit.sourceFile}`,
      });
    }

    const otherCandidates = await candidatesFromBundles(sources, sources.map((bundle) => bundle.code), options.signal);
    throwIfAborted(options.signal);
    for (const candidate of otherCandidates.values()) {
      for (const evidence of candidate.evidence) addEvidence(candidateMap, candidate.name, evidence);
    }
    for (const css of userOptions.cssSources || []) {
      for (const hit of intrinsicCandidates(css)) {
        if (hit.source === 'css-class') addEvidence(candidateMap, hit.name, { source: 'css-class', detail: hit.detail });
      }
    }
    const supplied = userOptions.candidateNames || [];
    for (const candidate of supplied) for (const evidence of candidate.evidence) addEvidence(candidateMap, candidate.name, evidence);

    vectorCandidates([...targetVectors, ...cssVectors], candidateMap, cache, userOptions.maxAstCandidates ?? Math.min(options.maxCandidates, 8));
    const candidates = [...candidateMap.values()]
      .sort((a, b) => b.evidence.length - a.evidence.length || a.name.localeCompare(b.name))
      .slice(0, options.maxCandidates);
    stats.candidatesGenerated = candidates.length;
    const registryClient = userOptions.registry || createRegistryClient({
      cache,
      timeoutMs: Math.max(1000, Math.min(userOptions.registryTimeoutMs || 12000, 20000)),
      concurrency: options.concurrency,
    });
    const registry = withBoundedRegistry(registryClient, options.concurrency);
    const direct = await compareDirectCandidates(candidates, targetVectors, registry, cache, options, stats);
    throwIfAborted(options.signal);
    const firstPropagation = await propagateTransitive(
      direct.detections,
      direct.selectedVersions,
      direct.packuments,
      targetVectors,
      registry,
      cache,
      options,
      stats,
    );
    throwIfAborted(options.signal);
    let packages = firstPropagation.packages;

    // One bounded recovery round retries unresolved direct candidates with a
    // wider registry-version window when no exact root dependency explains them.
    const leads = rootDetectionLeads(direct.candidates, direct.detections, firstPropagation.dependencyNames)
      .slice(0, Math.min(options.maxCandidates, 3));
    if (leads.length) {
      const rerunVersionLimit = Math.min(12, Math.max(options.maxVersionsPerPackage + 1, options.maxVersionsPerPackage * 2));
      const rerun = await compareDirectCandidates(
        leads,
        targetVectors,
        registry,
        cache,
        { ...options, maxVersionsPerPackage: rerunVersionLimit },
        stats,
      );
      throwIfAborted(options.signal);
      const mergedDirect = mergePackageDetections(direct.detections, rerun.detections);
      const newExactRoots = new Map([...rerun.selectedVersions.entries()]
        .filter(([name]) => !direct.selectedVersions.has(name)));

      if (newExactRoots.size) {
        const mergedPackuments = new Map([...direct.packuments, ...rerun.packuments]);
        const secondPropagation = await propagateTransitive(
          mergedDirect,
          newExactRoots,
          mergedPackuments,
          targetVectors,
          registry,
          cache,
          options,
          stats,
        );
        throwIfAborted(options.signal);
        packages = mergePackageDetections(firstPropagation.packages, secondPropagation.packages);
      } else {
        packages = mergePackageDetections(firstPropagation.packages, mergedDirect);
      }
    }
    packages.sort((a, b) => Number(b.tier === 'exact') - Number(a.tier === 'exact') || b.score - a.score || a.name.localeCompare(b.name));
    return { packages, candidates: direct.candidates, bundleFormats, stats };
  } finally {
    if (ownsCache) cache.close?.();
  }
}

export { DEFAULTS as DEBUN_PLUS_DEFAULTS, rangeForVersion, scoreVectors };
