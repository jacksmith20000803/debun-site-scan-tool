export { analyzeBundles, DEBUN_PLUS_DEFAULTS } from './pipeline';
export { createDetectionReport, renderDetectionTable, renderExplain } from './report';
export { evaluateBundleDirectory, formatEvaluationMarkdown, listJavascriptBundles } from './evaluation';
export { normalizeBundle, sliceModules, extractLicenseComments, stripBundlerScaffolding } from './normalize';
export { parseSource, parseWithBabel, parseWithFallback, walkAst } from './parser';
export { fingerprintCode, fingerprintCss, fingerprintBundle, intrinsicCandidates, indexableFeatures, mergeVectors } from './features';
export { packageSourceFiles, prepareCorpusVariants, selectProductionSources } from './corpus';
export { discriminateVersions, scoreVectors, rangeForVersion } from './scoring';
export { satisfies, intersectConstraints, compareSemver } from './semver';
export { createRegistryClient, mapBounded, withBoundedRegistry, registryMetadataCacheKey, registryTarballCacheKey } from './registry';
export type { NpmRegistryClient, RegistryClientOptions } from './registry';
export { SqliteCorpusCache, createSqliteCache } from './sqlite-cache';
export {
  buildLiteralIndex,
  buildLiteralIndexFromSources,
  extractIndexedStringLiterals,
  getDefaultLiteralIndexTier,
  matchLiteralFragments,
  normalizeIndexedLiteral,
  parsePackageList,
  readPackageList,
} from './literal-index';
export type {
  LiteralIndexBuildOptions,
  LiteralIndexBuildResult,
  LiteralIndexPackageSources,
  LiteralIndexPackageSpec,
} from './literal-index';
export { collectDependencyLayer, selectConstraintVersion } from './transitive';
export { crawlSite, analyzeCrawledSite, normalizeCrawlUrl } from './crawl';
export type { CrawlSiteOptions, CrawlAsset, CrawlPage, CrawlResult, PackagePageFinding, CrawlAnalysisResult } from './crawl';
export {
  detectEmbeddedVersionSignals,
  detectLicenseBannerSignals,
  detectMetaFrameworkSignals,
  detectPhase1Signals,
  detectRuntimeGlobalSignals,
  detectUmdGlobalSignals,
  phase1CandidateEvidence,
  validatePublishedSignalVersions,
} from './signals';
export type * from './types';
