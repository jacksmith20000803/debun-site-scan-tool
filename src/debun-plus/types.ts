export type DetectionTier = 'exact' | 'range' | 'possible';
/** Dependency presence confidence is separate from version-discrimination tier. */
export type DependencyStatus = 'inferred' | 'confirmed' | 'excluded';
export type EvidenceSource =
  | 'umd-global'
  | 'literal-index'
  | 'bundle-string'
  | 'license-banner'
  | 'embedded-version'
  | 'ast-property'
  | 'css-class'
  | 'runtime-global'
  | 'meta-framework'
  | 'debun-pog'
  | 'script-url'
  | 'registry-fingerprint'
  | 'transitive-registry';

export interface BundleSource {
  url?: string;
  code: string;
}

export interface CandidateEvidence {
  source: EvidenceSource;
  detail: string;
  version?: string;
  /** Structured Phase 1 signal name for machine-readable evidence. */
  signal?: string;
  /** Package identity as emitted by the Phase 1 signal detector. */
  package?: string;
  /** Relative signal weight in [0, 1], when produced by Phase 1 detectors. */
  weight?: number;
}

export type Phase1SignalName = 'license-banner' | 'embedded-version' | 'runtime-global' | 'umd-global' | 'meta-framework';

export interface Phase1SignalEvidence {
  signal: Phase1SignalName;
  package: string;
  version?: string;
  weight: number;
  detail: string;
}

export interface PackageCandidate {
  name: string;
  evidence: CandidateEvidence[];
}

export interface FingerprintVector {
  ngrams: string[];
  astHashes: string[];
  identifiers: string[];
  stringLiterals: string[];
  properties: string[];
  cssClasses: string[];
  runtimeGlobals: string[];
  metaFrameworkReads: string[];
}

export interface NormalizedBundle {
  url?: string;
  code: string;
  coarseModules: string[];
  fineModules: string[];
  licenseComments: string[];
  bundleFormat?: string;
  bundleFormatConfidence?: number;
  bundleFormatHints?: string[];
  bundleFormatEvidence?: string[];
}

export interface BundleFormatSummary {
  sourceFile: string;
  bundleFormat: string;
  confidence: number;
  hints: string[];
  evidence: string[];
}

export interface RegistryVersion {
  name: string;
  version: string;
  dist?: { tarball?: string; integrity?: string; shasum?: string; fileCount?: number; unpackedSize?: number };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface RegistryPackument {
  name?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, RegistryVersion>;
}

export interface RegistryClient {
  getPackument(name: string, signal?: AbortSignal): Promise<RegistryPackument | null>;
  getTarball(url: string, signal?: AbortSignal, integrity?: string, shasum?: string): Promise<Uint8Array | null>;
  getPackageMeta?(name: string, signal?: AbortSignal): Promise<RegistryPackument | null>;
  downloadTarball?(name: string, version: string, signal?: AbortSignal): Promise<DownloadedTarball>;
  getVersionList?(name: string, signal?: AbortSignal): Promise<string[]>;
  getDependencyTree?(name: string, version: string, maxDepth?: number, signal?: AbortSignal): Promise<PackageDependencyTree>;
  close?(): void;
}

export type RegistryResourceKind = 'metadata' | 'tarball';

export interface RegistryResourceCacheEntry {
  key: string;
  kind: RegistryResourceKind;
  url: string;
  bodyGzip: Uint8Array;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  integrity?: string;
  updatedAt: number;
}

export interface DownloadedTarball {
  name: string;
  version: string;
  directory: string;
  packageRoot: string;
  files: string[];
  cacheKey: string;
  integrity?: string;
}

export interface PackageDependencyTree {
  name: string;
  version: string;
  requestedRange?: string;
  dependencyType?: 'dependency' | 'optional' | 'peer';
  dependencies: Record<string, PackageDependencyTree>;
  unresolved?: boolean;
  circular?: boolean;
  truncated?: boolean;
}

export interface CachedVersionCorpus {
  fingerprintRevision?: number;
  name: string;
  version: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  vector: FingerprintVector;
  moduleVectors?: FingerprintVector[];
}

export interface CorpusCache {
  getVersion(name: string, version: string): CachedVersionCorpus | null;
  putVersion(value: CachedVersionCorpus): void;
  getPackument?(name: string): RegistryPackument | null;
  putPackument?(name: string, value: RegistryPackument): void;
  getRegistryResource?(key: string): RegistryResourceCacheEntry | null;
  putRegistryResource?(value: RegistryResourceCacheEntry): void;
  beginLiteralIndexBuild?(buildId: string, tier: string): void;
  addLiteralIndexDocument?(buildId: string, name: string, version: string, literals: string[]): void;
  publishLiteralIndex?(buildId: string, tier: string): LiteralIndexBuildStats;
  abortLiteralIndexBuild?(buildId: string): void;
  matchLiteralIndex?(tier: string, fragments: LiteralIndexFragment[]): LiteralIndexMatch[];
  getLiteralIndexInfo?(tier: string): LiteralIndexBuildStats | null;
  findCandidateNames(features: string[], limit: number): Array<{ name: string; matches: number }>;
  close?(): void;
}

export interface LiteralIndexFragment {
  sourceFile: string;
  stringLiterals: string[];
}

export interface LiteralIndexMatch {
  sourceFile: string;
  name: string;
  version: string;
  score: number;
  matchedLiteralCount: number;
  matchedLiterals: string[];
  strong: boolean;
}

export interface LiteralIndexBuildStats {
  tier: string;
  packagesIndexed: number;
  versionsIndexed: number;
  literalsIndexed: number;
  indexedAt: string;
}

export interface PackageDetection {
  name: string;
  version: string;
  tier: DetectionTier;
  score: number;
  margin: number;
  evidence: CandidateEvidence[];
  dependencies: Record<string, string>;
  /** Set for registry-propagated dependencies; direct detections omit it. */
  dependencyStatus?: DependencyStatus;
}

export interface DebunPlusOptions {
  registry?: RegistryClient;
  cache?: CorpusCache;
  databasePath?: string;
  concurrency?: number;
  registryTimeoutMs?: number;
  maxCandidates?: number;
  /** Limit vector-index-only candidates separately from direct bundle evidence. */
  maxAstCandidates?: number;
  maxVersionsPerPackage?: number;
  maxFingerprintSlices?: number;
  maxTransitiveDepth?: number;
  stringLiteralIndexTier?: string;
  candidateNames?: Array<{ name: string; evidence: CandidateEvidence[] }>;
  cssSources?: string[];
  signal?: AbortSignal;
}

export interface DebunPlusResult {
  packages: PackageDetection[];
  candidates: PackageCandidate[];
  bundleFormats: BundleFormatSummary[];
  stats: {
    bundlesNormalized: number;
    moduleSlices: number;
    fingerprintSlices: number;
    candidatesGenerated: number;
    versionsCompared: number;
    registryRequests: number;
    cacheHits: number;
  };
}
