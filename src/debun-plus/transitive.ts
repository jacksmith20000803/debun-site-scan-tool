import { compareSemver, intersectConstraints } from './semver';
import { CachedVersionCorpus, DependencyStatus, FingerprintVector, PackageDetection, RegistryPackument, RegistryVersion } from './types';

export interface DependencyRequirement {
  name: string;
  ranges: string[];
  depth: number;
  parents: string[];
}

function mergedDependencies(version: RegistryVersion): Record<string, string> {
  return {
    ...(version.dependencies || {}),
    ...(version.optionalDependencies || {}),
    ...(version.peerDependencies || {}),
  };
}

export function collectDependencyLayer(
  versions: Array<{ name: string; version: RegistryVersion; depth: number }>,
  nextDepth: number,
): DependencyRequirement[] {
  const requirements = new Map<string, DependencyRequirement>();
  for (const entry of versions) {
    if (entry.depth >= nextDepth) continue;
    for (const [name, range] of Object.entries(mergedDependencies(entry.version))) {
      const current = requirements.get(name) || { name, ranges: [], depth: nextDepth, parents: [] };
      if (!current.ranges.includes(range)) current.ranges.push(range);
      if (!current.parents.includes(entry.name)) current.parents.push(entry.name);
      requirements.set(name, current);
    }
  }
  return [...requirements.values()];
}

export function selectConstraintVersion(packument: RegistryPackument, ranges: string[]): { version: string | null; range: string } {
  const versions = Object.keys(packument.versions || {}).filter((version) => !/-/.test(version));
  const intersection = intersectConstraints(ranges, versions);
  if (intersection?.selectedVersion) return { version: intersection.selectedVersion, range: intersection.range };
  if (ranges.length > 0) return { version: null, range: intersection?.range || ranges.join(' ') };
  const latest = packument['dist-tags']?.latest;
  return { version: latest || versions.sort((a, b) => compareSemver(b, a))[0] || null, range: ranges.join(' ') || '*' };
}

export function dependencyRecord(
  name: string,
  ranges: string[],
  score: number,
  verifiedVersion: string | null,
  evidence: PackageDetection['evidence'],
  dependencyStatus: DependencyStatus = 'inferred',
): PackageDetection {
  const range = ranges.length ? ranges.join(' ') : '*';
  if (verifiedVersion && score >= 0.25) {
    return {
      name,
      version: verifiedVersion,
      tier: 'exact',
      score,
      margin: 0,
      evidence: [...evidence, { source: 'transitive-registry', detail: `registry dependency constraints intersect at ${range}` }],
      dependencies: {},
      dependencyStatus,
    };
  }
  return {
    name,
    version: range === '*' ? 'unknown' : range,
    tier: 'possible',
    score,
    margin: 0,
    evidence: [...evidence, { source: 'transitive-registry', detail: `transitive dependency constraints: ${range}` }],
    dependencies: {},
    dependencyStatus,
  };
}

export function bestFingerprintScore(targets: FingerprintVector[], corpus: CachedVersionCorpus, score: (a: FingerprintVector, b: FingerprintVector) => number): number {
  let best = 0;
  for (const target of targets) best = Math.max(best, score(target, corpus.vector));
  return best;
}
