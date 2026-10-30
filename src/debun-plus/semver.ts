export interface ConstraintIntersection {
  range: string;
  satisfyingVersions: string[];
  selectedVersion: string | null;
}

function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareSemver(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) return left.localeCompare(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function comparatorSatisfied(version: string, expression: string): boolean {
  const versionParts = parts(version);
  if (!versionParts) return false;
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(expression.trim());
  if (!match) return expression === '*' || expression.toLowerCase() === 'latest';
  const operator = match[1] || '';
  const base = [Number(match[2]), match[3] && !/[x*]/i.test(match[3]) ? Number(match[3]) : 0, match[4] && !/[x*]/i.test(match[4]) ? Number(match[4]) : 0];
  const isWildcard = /[x*]/i.test(`${match[3] || ''}${match[4] || ''}`);
  const delta = versionParts[0] - base[0] || versionParts[1] - base[1] || versionParts[2] - base[2];
  if (operator === '^') {
    const upper = base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
    return delta >= 0 && (versionParts[0] < upper[0] || (versionParts[0] === upper[0] && versionParts[1] < upper[1]) || (versionParts[0] === upper[0] && versionParts[1] === upper[1] && versionParts[2] < upper[2]));
  }
  if (operator === '~') return delta >= 0 && versionParts[0] === base[0] && versionParts[1] === base[1];
  if (operator === '>') return delta > 0;
  if (operator === '>=') return delta >= 0;
  if (operator === '<') return delta < 0;
  if (operator === '<=') return delta <= 0;
  if (isWildcard) {
    if (match[3] && !/[x*]/i.test(match[3]) && versionParts[1] !== base[1]) return false;
    if (match[4] && !/[x*]/i.test(match[4]) && versionParts[2] !== base[2]) return false;
    return versionParts[0] === base[0];
  }
  return delta === 0;
}

export function satisfies(version: string, range: string): boolean {
  if (!parts(version)) return false;
  const alternatives = String(range || '*').split('||').map((part) => part.trim());
  return alternatives.some((alternative) => {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alternative);
    if (hyphen) return comparatorSatisfied(version, `>=${hyphen[1]}`) && comparatorSatisfied(version, `<=${hyphen[2]}`);
    const expressions = alternative.split(/\s+/).filter(Boolean);
    return expressions.every((expression) => comparatorSatisfied(version, expression));
  });
}

export function intersectConstraints(constraints: string[], availableVersions: string[]): ConstraintIntersection | null {
  const normalized = [...new Set(constraints.map((value) => value.trim()).filter(Boolean))];
  const range = normalized.length ? normalized.join(' ') : '*';
  const satisfyingVersions = availableVersions.filter((version) => normalized.every((constraint) => satisfies(version, constraint)));
  satisfyingVersions.sort((a, b) => compareSemver(b, a));
  if (normalized.length && satisfyingVersions.length === 0) return null;
  return { range, satisfyingVersions, selectedVersion: satisfyingVersions[0] || null };
}
