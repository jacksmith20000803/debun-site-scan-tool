import { parseSource, walkAst } from './parser';
import { FingerprintVector, NormalizedBundle } from './types';

const EMPTY_VECTOR = (): FingerprintVector => ({
  ngrams: [], astHashes: [], identifiers: [], stringLiterals: [], properties: [],
  cssClasses: [], runtimeGlobals: [], metaFrameworkReads: [],
});

const RUNTIME_GLOBALS: Array<[RegExp, string, string]> = [
  [/\bReact(?:DOM)?\b|__REACT_DEVTOOLS_GLOBAL_HOOK__/i, 'react', 'React runtime global'],
  [/\b(?:Vue|__VUE__|__VUE_DEVTOOLS_GLOBAL_HOOK__)\b/i, 'vue', 'Vue runtime global'],
  [/\bangular\b|ɵɵdefineComponent|ng\.core/i, '@angular/core', 'Angular runtime marker'],
  [/\b(?:jQuery|\$\.fn\.jquery)\b/i, 'jquery', 'jQuery runtime global'],
  [/\b(?:moment|moment\.version)\b/i, 'moment', 'Moment.js runtime global'],
  [/\b(?:dayjs|Dayjs)\b/i, 'dayjs', 'Day.js runtime global'],
  [/\b(?:lodash|_\.VERSION)\b/i, 'lodash', 'Lodash runtime global'],
];

const FRAMEWORK_READS: Array<[RegExp, string, string]> = [
  [/__NEXT_DATA__|__next_f|__next_require__|next\/dist\/client/i, 'next', 'Next.js runtime read'],
  [/__NUXT__|__NUXT_DATA__|nuxt\/dist/i, 'nuxt', 'Nuxt runtime read'],
  [/__sveltekit|svelte\/internal/i, '@sveltejs/kit', 'SvelteKit runtime read'],
  [/astro-island|astro\/runtime/i, 'astro', 'Astro runtime read'],
];

const CSS_SIGNATURES: Array<[RegExp, string, string]> = [
  [/\b(?:Mui[A-Z][A-Za-z0-9]*|MuiButton-root)\b/, '@mui/material', 'MUI CSS class'],
  [/\bant-(?:btn|input|select|table|modal|icon)\b/, 'antd', 'Ant Design CSS class'],
  [/\b(?:btn-primary|navbar-expand-|container-fluid)\b/, 'bootstrap', 'Bootstrap CSS class'],
  [/\bfa-(?:solid|regular|brands|[a-z][a-z0-9-]+)\b/, '@fortawesome/fontawesome-free', 'Font Awesome CSS class'],
  [/\b(?:chakra-ui|css-[a-z0-9]+)\b/, '@chakra-ui/react', 'Chakra UI class'],
];

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function stringLiteralFourGrams(strings: Iterable<string>): string[] {
  const result = new Set<string>();
  for (const literal of strings) {
    const chars = Array.from(literal.normalize('NFKC').toLowerCase());
    for (let i = 0; i + 3 < chars.length; i++) result.add(chars.slice(i, i + 4).join(''));
  }
  return [...result];
}

function nodeTag(node: any): string {
  const fields: string[] = [String(node?.type || 'Unknown')];
  if (node?.operator) fields.push(`op:${node.operator}`);
  if (node?.kind) fields.push(`kind:${node.kind}`);
  if (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression' || node?.computed != null) {
    fields.push(`computed:${Boolean(node.computed)}`);
  }
  if (/^(?:Literal|StringLiteral|NumericLiteral|BooleanLiteral|NullLiteral|BigIntLiteral)$/.test(node?.type || '')) {
    fields.push(`literal:${typeof node.value}`);
  }
  if (node?.async) fields.push('async');
  if (node?.generator) fields.push('generator');
  return fields.join(':');
}

/** A shallow AST subtree encoding: root and direct child node tags, with names normalized. */
function serializeAstSubtree(node: any): string {
  const children: string[] = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (['loc', 'start', 'end', 'range', 'comments', 'tokens', 'parent', 'extra'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === 'object' && typeof child.type === 'string') children.push(nodeTag(child));
    } else if (value && typeof value === 'object' && typeof (value as any).type === 'string') {
      children.push(nodeTag(value));
    }
  }
  return `${nodeTag(node)}[${children.join(',')}]`;
}

function propertyKeyName(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if ((node.type === 'Literal' || node.type === 'StringLiteral' || node.type === 'NumericLiteral') &&
      (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  return null;
}

function memberChain(node: any): string | null {
  const parts: string[] = [];
  let current = node;
  while (current?.type === 'MemberExpression' || current?.type === 'OptionalMemberExpression') {
    const property = current.computed ? current.property?.value : current.property?.name;
    if (property == null) break;
    parts.unshift(String(property));
    current = current.object;
  }
  if (current?.type === 'Identifier') parts.unshift(current.name);
  return parts.length >= 2 ? parts.join('.') : null;
}

export async function fingerprintCode(source: string): Promise<FingerprintVector> {
  const vector = EMPTY_VECTOR();
  const strings = new Set<string>();
  const identifiers = new Set<string>();
  const properties = new Set<string>();
  const astShapes: string[] = [];

  try {
    const parsed = await parseSource(source);
    walkAst(parsed.program, (node) => {
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        const chain = memberChain(node);
        if (chain) properties.add(chain);
        const key = propertyKeyName(node.property);
        if (key) identifiers.add(key);
      }
      if (node.key && /(?:Property|Method|Field|Element|Accessor)/.test(node.type)) {
        const key = propertyKeyName(node.key);
        if (key) identifiers.add(key);
      }
      astShapes.push(serializeAstSubtree(node));
      if (node.type === 'Literal' && typeof node.value === 'string') strings.add(node.value);
      if (node.type === 'StringLiteral' && typeof node.value === 'string') strings.add(node.value);
    });
  } catch (_) {
    // Token, string, banner, and class features still work on partially invalid chunks.
  }

  const astHashes = new Set<string>();
  // Rolling AST hash window is 5 consecutive normalized subtree serializations.
  // Tiny fragments use one whole-fragment window so they remain comparable.
  if (astShapes.length > 0 && astShapes.length < 5) astHashes.add(fnv1a(astShapes.join('/')));
  for (let i = 0; i + 5 <= astShapes.length; i++) astHashes.add(fnv1a(astShapes.slice(i, i + 5).join('/')));

  const cssClasses = new Set<string>();
  for (const value of strings) {
    for (const match of value.matchAll(/(?:^|\s)([A-Za-z_][\w-]{2,})(?=\s|$)/g)) cssClasses.add(match[1]);
  }
  const classPattern = /\.([A-Za-z_][\w-]{2,})/g;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classPattern.exec(source))) cssClasses.add(classMatch[1]);

  const runtimeGlobals = new Set<string>();
  const metaFrameworkReads = new Set<string>();
  for (const [pattern, name] of RUNTIME_GLOBALS) if (pattern.test(source)) runtimeGlobals.add(name);
  for (const [pattern, name] of FRAMEWORK_READS) if (pattern.test(source)) metaFrameworkReads.add(name);

  vector.ngrams = stringLiteralFourGrams(strings);
  vector.astHashes = [...astHashes];
  vector.identifiers = [...identifiers];
  vector.stringLiterals = [...strings].filter((value) => value.length >= 3).slice(0, 10000);
  vector.properties = [...properties];
  vector.cssClasses = [...cssClasses];
  vector.runtimeGlobals = [...runtimeGlobals];
  vector.metaFrameworkReads = [...metaFrameworkReads];
  return vector;
}

export function fingerprintCss(source: string): FingerprintVector {
  const vector = EMPTY_VECTOR();
  const classes = new Set<string>();
  const selector = /\.([A-Za-z_][\w-]{2,})/g;
  let match: RegExpExecArray | null;
  while ((match = selector.exec(source))) classes.add(match[1]);
  for (const classList of source.matchAll(/class(?:Name)?\s*[:=]\s*["']([^"']+)["']/g)) {
    for (const value of classList[1].split(/\s+/)) if (/^[A-Za-z_][\w-]{2,}$/.test(value)) classes.add(value);
  }
  vector.cssClasses = [...classes];
  return vector;
}

function spreadSample<T>(values: T[], count: number): T[] {
  if (count >= values.length) return values;
  if (count <= 0 || values.length === 0) return [];
  if (count === 1) return [values[Math.floor((values.length - 1) / 2)]];
  const result: T[] = [];
  for (let i = 0; i < count; i++) result.push(values[Math.round(i * (values.length - 1) / (count - 1))]);
  return result;
}

export async function fingerprintBundle(bundle: NormalizedBundle, maxSlices = 32): Promise<FingerprintVector[]> {
  const budget = Math.max(1, Math.floor(maxSlices) || 1);
  const moduleBudget = Math.max(0, budget - 1);
  const coarseCount = Math.min(bundle.coarseModules.length, Math.ceil(moduleBudget / 2));
  const fineCount = Math.min(bundle.fineModules.length, moduleBudget - coarseCount);
  const remaining = moduleBudget - coarseCount - fineCount;
  const coarse = spreadSample(bundle.coarseModules, coarseCount + Math.min(remaining, bundle.coarseModules.length - coarseCount));
  const remainingAfterCoarse = moduleBudget - coarse.length;
  const fine = spreadSample(bundle.fineModules, Math.min(bundle.fineModules.length, remainingAfterCoarse));
  const sources = [bundle.code, ...coarse, ...fine].filter((source) => source.length >= 40);
  const unique = [...new Set(sources)];
  return Promise.all(unique.map(fingerprintCode));
}

export function mergeVectors(vectors: FingerprintVector[]): FingerprintVector {
  const result = EMPTY_VECTOR();
  for (const key of Object.keys(result) as Array<keyof FingerprintVector>) {
    result[key] = [...new Set(vectors.flatMap((vector) => vector[key]))];
  }
  return result;
}

export function indexableFeatures(vector: FingerprintVector): string[] {
  return [
    ...vector.properties.slice(0, 1000).map((value) => `p:${value}`),
    ...vector.runtimeGlobals.map((value) => `g:${value}`),
    ...vector.metaFrameworkReads.map((value) => `m:${value}`),
    ...vector.cssClasses.slice(0, 500).map((value) => `c:${value}`),
    ...vector.stringLiterals.slice(0, 1500).map((value) => `s:${value.toLowerCase()}`),
    ...vector.identifiers.filter((value) => value.length >= 4).slice(0, 1500).map((value) => `i:${value}`),
  ].slice(0, 5000);
}

export function intrinsicCandidates(source: string, url?: string): Array<{ name: string; source: string; detail: string; version?: string }> {
  const found = new Map<string, { name: string; source: string; detail: string; version?: string }>();
  const push = (name: string, signal: string, detail: string, version?: string) => {
    if (!name || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return;
    const key = `${name.toLowerCase()}|${signal}|${version || ''}`;
    if (!found.has(key)) found.set(key, { name, source: signal, detail, version });
  };

  for (const match of source.matchAll(/(?:node_modules\/|node_modules\\)((?:@[\w.-]+\/)?[\w.-]+)/g)) {
    push(match[1], 'bundle-string', `package path in bundle: ${match[1]}`);
  }
  const knownNames: Record<string, string> = {
    react: 'react', vue: 'vue', jquery: 'jquery', lodash: 'lodash', moment: 'moment',
    bootstrap: 'bootstrap', antd: 'antd', 'font awesome': '@fortawesome/fontawesome-free',
    'sveltekit': '@sveltejs/kit', 'next.js': 'next',
  };
  const licenseComments = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g) || [];
  for (const comment of licenseComments) {
    const normalized = comment.toLowerCase();
    for (const [label, name] of Object.entries(knownNames)) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`\\b${escaped}\\b(?:\\s+v?([0-9]+\\.[0-9]+\\.[0-9]+(?:-[\\w.-]+)?))?`, 'i').exec(comment);
      if (match && /license|@preserve|@license|copyright|^\/\*!/i.test(normalized)) {
        push(name, 'license-banner', `license banner identifies ${label}`, match[1]);
      }
    }
  }
  for (const [pattern, name, detail] of RUNTIME_GLOBALS) if (pattern.test(source)) push(name, 'runtime-global', detail);
  for (const [pattern, name, detail] of FRAMEWORK_READS) if (pattern.test(source)) push(name, 'meta-framework', detail);
  for (const [pattern, name, detail] of CSS_SIGNATURES) if (pattern.test(source)) push(name, 'css-class', detail);

  const versionSignals: Array<[RegExp, string, string]> = [
    [/\bjQuery(?:\.fn)?\.jquery\s*=\s*["']([0-9]+\.[0-9]+\.[0-9]+[^"']*)["']/i, 'jquery', 'jQuery version assignment'],
    [/\bVue\.version\s*=\s*["']([0-9]+\.[0-9]+\.[0-9]+[^"']*)["']/i, 'vue', 'Vue version assignment'],
    [/\bReact\.version\s*=\s*["']([0-9]+\.[0-9]+\.[0-9]+[^"']*)["']/i, 'react', 'React version assignment'],
    [/\b(?:moment|_moment)\.version\s*=\s*["']([0-9]+\.[0-9]+\.[0-9]+[^"']*)["']/i, 'moment', 'Moment.js version assignment'],
    [/\b(?:lodash|_)\.VERSION\s*=\s*["']([0-9]+\.[0-9]+\.[0-9]+[^"']*)["']/i, 'lodash', 'Lodash version assignment'],
  ];
  for (const [pattern, name, detail] of versionSignals) {
    const match = pattern.exec(source);
    if (match) push(name, 'embedded-version', detail, match[1]);
  }

  if (url) {
    const match = /\/npm\/((?:@[^/]+\/)?[^/@]+)@([^/]+)/.exec(url);
    if (match) push(match[1], 'script-url', `npm script URL ${url}`, match[2]);
  }
  return [...found.values()];
}
