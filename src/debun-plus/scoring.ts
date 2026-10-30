import { FingerprintVector } from './types';

function jaccard(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap++;
  const union = a.size + b.size - overlap;
  return union ? overlap / union : 0;
}

export interface FusedScore {
  ast: number;
  ngram: number;
  ident: number;
  score: number;
}

export function scoreVectors(target: FingerprintVector, corpus: FingerprintVector): FusedScore {
  const targetHashes = new Set(target.astHashes);
  const corpusHashes = new Set(corpus.astHashes);
  let found = 0;
  for (const hash of targetHashes) if (corpusHashes.has(hash)) found++;
  // AST score is directional target-hash coverage: the share of normalized
  // target windows found in this version's corpus.
  const ast = targetHashes.size ? found / targetHashes.size : 0;
  const ngram = jaccard(target.ngrams, corpus.ngrams);
  // FingerprintVector.identifiers is restricted to static property/object keys.
  const ident = jaccard(target.identifiers, corpus.identifiers);
  return { ast, ngram, ident, score: 0.45 * ast + 0.3 * ngram + 0.25 * ident };
}

export interface VersionScore {
  version: string;
  score: number;
  ast: number;
  ngram: number;
  ident: number;
  /** Distinct target fragments whose fused score passed the minimum threshold. */
  fragmentSupport?: number;
}

export interface Discrimination {
  version: string;
  tier: 'exact' | 'range' | 'possible';
  topScore: number;
  margin: number;
  scores: VersionScore[];
}

const MINIMUM_INFERRED_RANGE_SCORE = 0.12;
const SAME_MAJOR_SCORE_TOLERANCE = 0.08;
const OTHER_MAJOR_SEPARATION = 0.04;

function compareSemverDesc(left: string, right: string): number {
  const a = left.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
  const b = right.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
  if (!a || !b) return left.localeCompare(right);
  for (let i = 1; i <= 3; i++) {
    const delta = Number(b[i]) - Number(a[i]);
    if (delta) return delta;
  }
  if (a[4] && !b[4]) return 1;
  if (!a[4] && b[4]) return -1;
  return String(b[4] || '').localeCompare(String(a[4] || ''));
}

export function rangeForVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return '*';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 0 ? `~${major}.${minor}.${patch}` : `^${major}.${minor}.${patch}`;
}

export function discriminateVersions(
  comparisons: Array<{ version: string; target: FingerprintVector; corpus: FingerprintVector }>,
  thresholds: { minimumScore?: number; minimumMargin?: number } = {},
): Discrimination {
  const minimumScore = thresholds.minimumScore ?? 0.25;
  const minimumMargin = thresholds.minimumMargin ?? 0.08;
  const byVersion = new Map<string, Map<FingerprintVector, VersionScore>>();
  for (const candidate of comparisons) {
    const score = scoreVectors(candidate.target, candidate.corpus);
    const fragments = byVersion.get(candidate.version) || new Map<FingerprintVector, VersionScore>();
    const previous = fragments.get(candidate.target);
    if (!previous || score.score > previous.score) fragments.set(candidate.target, { version: candidate.version, ...score });
    byVersion.set(candidate.version, fragments);
  }
  const aggregateFragments = (version: string, fragments: Map<FingerprintVector, VersionScore>): VersionScore => {
    const ranked = [...fragments.values()].sort((a, b) => b.score - a.score);
    const strongest = ranked[0];
    const corroborating = ranked.slice(1, 3);
    const average = (key: 'score' | 'ast' | 'ngram' | 'ident') => {
      const primary = strongest?.[key] || 0;
      return corroborating.length
        ? 0.7 * primary + 0.3 * corroborating.reduce((sum, item) => sum + item[key], 0) / corroborating.length
        : primary;
    };
    return {
      version,
      score: average('score'),
      ast: average('ast'),
      ngram: average('ngram'),
      ident: average('ident'),
      fragmentSupport: ranked.filter((item) => item.score >= minimumScore).length,
    };
  };
  const scores = [...byVersion.entries()]
    .map(([version, fragments]) => aggregateFragments(version, fragments))
    .sort((a, b) => b.score - a.score || compareSemverDesc(a.version, b.version));
  const best = scores[0];
  const second = scores[1]?.score || 0;
  if (!best) return { version: 'unknown', tier: 'possible', topScore: 0, margin: 0, scores };
  const margin = best.score - second;
  const exact = best.score >= minimumScore && margin >= minimumMargin;
  const bestMajor = /^\d+/.exec(best.version)?.[0];
  const sameMajorCluster = bestMajor
    ? scores.filter((candidate) => {
      const major = /^\d+/.exec(candidate.version)?.[0];
      return major === bestMajor && candidate.score >= Math.max(MINIMUM_INFERRED_RANGE_SCORE, best.score - SAME_MAJOR_SCORE_TOLERANCE);
    })
    : [];
  const bestOtherMajor = bestMajor
    ? Math.max(0, ...scores
      .filter((candidate) => /^\d+/.exec(candidate.version)?.[0] !== bestMajor)
      .map((candidate) => candidate.score))
    : 0;
  const independentSignals = [best.ast, best.ngram, best.ident].filter((value) => value >= 0.05).length;
  // A lower-scoring candidate can still support a major-line range when
  // multiple published releases in that major independently match the bundle
  // and other majors are clearly weaker. This avoids turning a single
  // arbitrary top hit into a version while recovering real mid-confidence
  // matches that miss the exact-pin threshold.
  const inferredRange = best.score >= MINIMUM_INFERRED_RANGE_SCORE
    && independentSignals >= 2
    && sameMajorCluster.length >= 2
    && best.score - bestOtherMajor >= OTHER_MAJOR_SEPARATION;
  const range = !exact && (best.score >= minimumScore || inferredRange);
  return {
    version: exact ? best.version : range ? rangeForVersion(best.version) : 'unknown',
    tier: exact ? 'exact' : range ? 'range' : 'possible',
    topScore: best.score,
    margin,
    scores,
  };
}

export { jaccard };
