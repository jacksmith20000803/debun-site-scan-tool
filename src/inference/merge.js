'use strict';

const { normalizeKey } = require('./naming');

/**
 * Evidence signals, their weight (single-signal confidence) and the "family"
 * used for corroboration counting. Multiple signals from the same family are
 * correlated, so they do not independently raise confidence.
 */
const SIGNAL_WEIGHT = {
  'debun-exact': () => 0.95,
  'debun-range': () => 0.72,
  'debun-likely': () => 0.45,
  'registry-exact': () => 0.98,
  'registry-range': () => 0.74,
  'registry-possible': () => 0.42,
  url: (hasVersion) => (hasVersion ? 0.85 : 0.5),
  banner: () => 0.8,
  global: () => 0.75,
  sourcemap: (hasVersion) => (hasVersion ? 0.8 : 0.55),
  manifest: (hasVersion) => (hasVersion ? 0.9 : 0.6),
  // A manifest declaration is not proof that the dependency is installed or shipped.
  'declared-dep': () => 0.35,
};

const SIGNAL_FAMILY = {
  'debun-exact': 'debun',
  'debun-range': 'debun',
  'debun-likely': 'debun',
  'registry-exact': 'registry-fingerprint',
  'registry-range': 'registry-fingerprint',
  'registry-possible': 'registry-fingerprint',
  url: 'url',
  banner: 'banner',
  global: 'global',
  sourcemap: 'sourcemap',
  manifest: 'manifest',
  'declared-dep': 'manifest',
};

function weightFor(signal, hasVersion) {
  const fn = SIGNAL_WEIGHT[signal];
  return fn ? fn(hasVersion) : 0.3;
}

function tierFor(confidence) {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function isConcreteVersion(version) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ''));
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((part) => (part.match(/^\d+$/) ? Number(part) : part));
  const pb = String(b).split(/[.+-]/).map((part) => (part.match(/^\d+$/) ? Number(part) : part));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i];
    const vb = pb[i];
    if (va === undefined) return -1;
    if (vb === undefined) return 1;
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return va - vb;
    } else {
      const sa = String(va);
      const sb = String(vb);
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Merge raw evidence items into canonical package records.
 *
 * @param {Array<{name:string, version?:string, signal:string, detail:string,
 *   scope?:'dependency'|'library'}>} evidenceList
 */
function mergeEvidence(evidenceList) {
  const byPackage = new Map();

  for (const raw of evidenceList) {
    if (!raw || !raw.name) continue;
    const key = normalizeKey(raw.name);
    if (!key) continue;

    let record = byPackage.get(key);
    if (!record) {
      record = {
        name: key,
        rawNames: new Set(),
        versionVotes: new Map(),
        signals: new Map(),
        evidence: [],
        evidenceKeys: new Set(),
        declared: false,
        observed: false,
        declaredRanges: new Set(),
      };
      byPackage.set(key, record);
    }

    const hasVersion = Boolean(raw.version);
    const weight = weightFor(raw.signal, hasVersion);
    record.rawNames.add(raw.name);
    record.signals.set(raw.signal, Math.max(record.signals.get(raw.signal) || 0, weight));
    const evidenceKey = `${raw.signal}|${raw.version || ''}|${raw.declaredRange || ''}|${raw.detail}`;
    if (!record.evidenceKeys.has(evidenceKey)) {
      record.evidenceKeys.add(evidenceKey);
      record.evidence.push({ signal: raw.signal, detail: raw.detail, version: raw.version, declaredRange: raw.declaredRange, weight });
    }
    if (raw.scope === 'dependency' || raw.signal === 'declared-dep') record.declared = true;
    else record.observed = true;
    if (raw.declaredRange) record.declaredRanges.add(raw.declaredRange);

    if (hasVersion) {
      let entry = record.versionVotes.get(raw.version);
      if (!entry) {
        entry = { version: raw.version, families: new Map(), count: 0 };
        record.versionVotes.set(raw.version, entry);
      }
      const family = SIGNAL_FAMILY[raw.signal] || raw.signal;
      entry.families.set(family, Math.max(entry.families.get(family) || 0, weight));
      entry.count += 1;
    }
  }

  const records = [];
  for (const record of byPackage.values()) {
    // Base confidence is the strongest single signal.
    let base = 0;
    for (const weight of record.signals.values()) base = Math.max(base, weight);

    // Corroboration bonus across distinct signal families.
    const families = new Set([...record.signals.keys()].map((signal) => SIGNAL_FAMILY[signal] || signal));
    const corroborating = Math.max(0, families.size - 1);
    const confidence = Math.min(0.99, base + corroborating * 0.06);

    const versionCandidates = [...record.versionVotes.values()]
      .map((entry) => ({
        version: entry.version,
        // Sum the strongest vote from each independent signal family so that
        // corroborating signals (URL + banner) can outrank a single engine hit.
        score: [...entry.families.values()].reduce((sum, value) => sum + value, 0),
        votes: entry.count,
      }))
      .sort((a, b) => {
        // Evidence strength must take precedence over formatting. Otherwise a
        // weak concrete guess from one signal can override a registry-backed
        // major range supported by stronger bundle fingerprint evidence.
        if (b.score !== a.score) return b.score - a.score;
        const aConcrete = isConcreteVersion(a.version);
        const bConcrete = isConcreteVersion(b.version);
        if (aConcrete !== bConcrete) return aConcrete ? -1 : 1;
        return compareVersions(b.version, a.version);
      });

    const bestVersion = versionCandidates[0];
    const chosen = bestVersion ? bestVersion.version : undefined;
    const alternatives = versionCandidates
      .filter((candidate) => candidate.version !== chosen && candidate.score >= 0.7)
      .slice(0, 3)
      .map((candidate) => candidate.version);
    records.push({
      name: record.name,
      rawNames: [...record.rawNames],
      version: chosen,
      versionIsExact: bestVersion ? isConcreteVersion(bestVersion.version) : false,
      confidence: Number(confidence.toFixed(2)),
      tier: tierFor(confidence),
      signals: [...record.signals.keys()].sort(),
      families: [...families].sort(),
      declared: record.declared,
      installationStatus: record.observed ? 'observed' : 'declared-only',
      declaredRanges: [...record.declaredRanges],
      alternatives,
      versionCandidates: versionCandidates.map((candidate) => ({
        version: candidate.version,
        weight: Number(candidate.score.toFixed(2)),
        votes: candidate.votes,
        exact: isConcreteVersion(candidate.version),
      })),
      evidence: record.evidence
        .slice()
        // Evidence agreeing with the chosen version is the most useful to show.
        .sort((a, b) => {
          const aMatch = a.version === chosen ? 1 : 0;
          const bMatch = b.version === chosen ? 1 : 0;
          if (aMatch !== bMatch) return bMatch - aMatch;
          return b.weight - a.weight;
        })
        .map((item) => ({ signal: item.signal, detail: item.detail, version: item.version, declaredRange: item.declaredRange })),
    });
  }

  records.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return records;
}

module.exports = { mergeEvidence, tierFor, compareVersions, isConcreteVersion, SIGNAL_WEIGHT, SIGNAL_FAMILY };
