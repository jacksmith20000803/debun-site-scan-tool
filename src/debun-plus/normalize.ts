declare const require: (name: string) => any;

import { parseSource, walkAst } from './parser';
import { BundleSource, NormalizedBundle } from './types';

const LICENSE_COMMENT = /(?:@license|@preserve|SPDX-License-Identifier|^!|\bMIT License\b|\bApache License\b)/i;
const { findBundlerHints } = require('../bundler-patterns');

export function extractLicenseComments(source: string): string[] {
  const comments: string[] = [];
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const content = match[0].replace(/^\/\*+|\*\/$|^\/\//g, '').trim();
    if (LICENSE_COMMENT.test(content)) comments.push(match[0]);
  }
  return [...new Set(comments)];
}

function functionLike(node: any): boolean {
  return node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
}

function methodLike(node: any): boolean {
  return functionLike(node) || node?.type === 'ObjectMethod';
}

function factoryText(source: string, node: any): string {
  const content = source.slice(node.start, node.end).trim();
  return node.type === 'ObjectMethod' ? `({${content}})` : `(${content})`;
}

function spreadSample<T>(values: T[], count: number): T[] {
  if (count >= values.length) return values;
  if (count <= 0 || values.length === 0) return [];
  if (count === 1) return [values[Math.floor((values.length - 1) / 2)]];
  const result: T[] = [];
  for (let i = 0; i < count; i++) result.push(values[Math.round(i * (values.length - 1) / (count - 1))]);
  return result;
}

export interface ModuleSlices {
  coarse: string[];
  fine: string[];
  structuralRegistry: boolean;
  confidence: number;
  evidence: string[];
}

function functionArity(node: any): number {
  return Array.isArray(node?.params) ? node.params.length : 0;
}

function registryCandidateScore(factories: any[]): number {
  const arities = new Map<number, number>();
  for (const factory of factories) arities.set(functionArity(factory), (arities.get(functionArity(factory)) || 0) + 1);
  const repeatedArity = Math.max(0, ...arities.values());
  const commonRuntimeArity = [...arities.entries()].some(([arity, count]) => (arity === 3 || arity === 4) && count >= 2);
  return factories.length * 4 + repeatedArity * 3 + (commonRuntimeArity ? 5 : 0);
}

/** Detect repeated executable factory shapes without requiring bundler-specific names. */
export async function sliceModules(source: string, parsedInput?: any): Promise<ModuleSlices> {
  const parsed = parsedInput || await parseSource(source);
  const registryCandidates: Array<{ score: number; factories: any[]; kind: string }> = [];
  const allFunctions: any[] = [];

  walkAst(parsed.program, (node) => {
    if (functionLike(node)) allFunctions.push(node);
    if (node.type === 'ObjectExpression' && Array.isArray(node.properties)) {
      const factories = node.properties
        .filter((property: any) => ['Property', 'ObjectMethod'].includes(property?.type) && methodLike(property.value || property))
        .map((property: any) => property.value || property)
        .filter((factory: any) => functionLike(factory));
      if (factories.length >= 2) registryCandidates.push({ score: registryCandidateScore(factories), factories, kind: 'function-record' });
    }
    if (node.type === 'ArrayExpression' && Array.isArray(node.elements)) {
      const factories = node.elements.filter((item: any) => functionLike(item));
      if (factories.length >= 2) registryCandidates.push({ score: registryCandidateScore(factories), factories, kind: 'registration-array' });
    }
  });

  registryCandidates.sort((a, b) => b.score - a.score);
  const selectedRegistry = registryCandidates[0];
  const selectedFactories = spreadSample(selectedRegistry?.factories || [], 400);
  const coarse = selectedFactories
    .map((node) => factoryText(source, node))
    .filter((value) => value.length >= 24);
  const fine: string[] = [];
  for (const factory of selectedFactories) {
    const factoryFunctions: any[] = [];
    walkAst(factory.body, (node) => {
      if (functionLike(node) && node !== factory) factoryFunctions.push(node);
    });
    const nested = spreadSample(factoryFunctions.filter((node) => Number.isInteger(node.start) && Number.isInteger(node.end)), 2)
      .map((node) => factoryText(source, node))
      .filter(Boolean);
    fine.push(...(nested.length ? nested : [source.slice(factory.start, factory.end).trim()]));
    if (fine.length >= 800) break;
  }

  if (coarse.length === 0) {
    // ESM and newer runtimes can keep module code in top-level declarations or
    // lazy callbacks instead of a named CommonJS factory table.
    const topLevelBlocks: string[] = ((parsed.program.body || []) as any[])
      .filter((statement: any) => !['ImportDeclaration', 'EmptyStatement'].includes(statement.type))
      .map((statement: any) => source.slice(statement.start, statement.end).trim())
      .filter((value: string) => value.length >= 40)
      .slice(0, 400);
    const functionBodies = allFunctions
      .filter((node) => Number.isInteger(node.start) && Number.isInteger(node.end))
      .map((node) => factoryText(source, node))
      .filter((value) => value.length >= 80)
      .slice(0, 200);
    const blocks = topLevelBlocks.length ? topLevelBlocks : functionBodies;
    return {
      coarse: [...new Set(blocks)],
      fine: [...new Set(functionBodies)],
      structuralRegistry: false,
      confidence: blocks.length ? 0.42 : 0.08,
      evidence: blocks.length ? ['top-level declaration or lazy function slices'] : ['no parseable content slices'],
    };
  }
  return {
    coarse,
    fine: [...new Set(fine)],
    structuralRegistry: true,
    confidence: selectedFactories.length >= 4 ? 0.92 : 0.78,
    evidence: [`${selectedRegistry.kind} with ${selectedFactories.length} callable entries`, 'repeated executable factory structure'],
  };
}

/** Unwrap a standalone wrapper; registry code is omitted later by fragment selection. */
export async function stripBundlerScaffolding(source: string): Promise<string> {
  try {
    const { program } = await parseSource(source);
    const body = program.body || [];
    if (body.length === 1 && body[0].type === 'ExpressionStatement') {
      const expression = body[0].expression;
      const callee = expression?.type === 'CallExpression' ? expression.callee : null;
      if ((functionLike(callee) || callee?.type === 'ParenthesizedExpression' && functionLike(callee.expression)) && callee.body?.type === 'BlockStatement') {
        return source.slice(callee.body.start + 1, callee.body.end - 1).trim();
      }
    }
    return source;
  } catch (_) {
    return source;
  }
}

async function terserNormalize(source: string): Promise<string> {
  try {
    const terser = require('terser');
    const result = await terser.minify(source, {
      compress: false,
      mangle: false,
      format: { comments: (node: any, comment: any) => LICENSE_COMMENT.test(comment.value || '') },
    });
    if (typeof result.code === 'string') return result.code;
  } catch (_) {
    // Leave malformed or newer-syntax bundles available to the AST fallback path.
  }
  return source;
}

export async function normalizeBundle(bundle: BundleSource): Promise<NormalizedBundle> {
  const source = String(bundle.code || '');
  const licenseComments = extractLicenseComments(source);
  const slices = await sliceModules(source).catch(() => ({ coarse: [], fine: [], structuralRegistry: false, confidence: 0, evidence: ['AST slicing failed'] }));
  const bundleUrls = bundle.url && /^https?:\/\//i.test(bundle.url) ? [bundle.url] : [];
  const hints = findBundlerHints(source, bundleUrls).map((item: any) => item.name);
  const normalizedBase = slices.coarse.length ? slices.coarse.map((moduleSource) => `${moduleSource};`).join('\n') : await stripBundlerScaffolding(source);
  const normalized = await terserNormalize(normalizedBase);
  const code = licenseComments.length ? `${licenseComments.join('\n')}\n${normalized}` : normalized;
  const bundleFormat = slices.structuralRegistry
    ? 'recognized(module-registry)'
    : `unrecognized(${hints.length ? hints.join(',') : 'unknown'})`;
  return {
    url: bundle.url,
    code,
    coarseModules: slices.coarse,
    fineModules: slices.fine,
    licenseComments,
    bundleFormat,
    bundleFormatConfidence: Math.min(0.97, slices.confidence + (hints.length ? 0.03 : 0)),
    bundleFormatHints: hints,
    bundleFormatEvidence: slices.evidence,
  };
}
