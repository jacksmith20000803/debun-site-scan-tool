declare const require: (name: string) => any;

export interface ParsedSource {
  program: any;
  comments: any[];
  parser: 'oxc-parser' | '@babel/parser';
}

export async function parseWithFallback(
  source: string,
  primary: (source: string) => Promise<ParsedSource>,
  fallback: (source: string) => ParsedSource,
): Promise<ParsedSource> {
  try { return await primary(source); }
  catch (_) { return fallback(source); }
}

export function parseWithBabel(source: string): ParsedSource {
  const babel = require('@babel/parser');
  const result = babel.parse(source, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    plugins: ['estree', 'jsx', 'typescript', 'decorators-legacy', 'importAttributes'],
  });
  return { program: result.program, comments: result.comments || [], parser: '@babel/parser' };
}

let oxcPromise: Promise<any> | undefined;

async function loadOxc(): Promise<any> {
  if (!oxcPromise) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    oxcPromise = dynamicImport('oxc-parser');
  }
  return oxcPromise;
}

export async function parseSource(source: string, filename = 'bundle.js'): Promise<ParsedSource> {
  return parseWithFallback(source, async (input) => {
    const oxc = await loadOxc();
    const result = oxc.parseSync(filename, input, { sourceType: 'unambiguous' });
    if (result?.program && !(result.errors || []).length) {
      return { program: result.program, comments: result.comments || [], parser: 'oxc-parser' };
    }
    throw new Error('oxc-parser returned no program');
  }, parseWithBabel);
}

export function walkAst(root: any, visit: (node: any) => void): void {
  const stack = [root];
  const seen = new Set<any>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.type === 'string') visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments' || key === 'parent') continue;
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          const child = value[i];
          if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child);
        }
      } else if (value && typeof value === 'object' && typeof (value as any).type === 'string') {
        stack.push(value);
      }
    }
  }
}
