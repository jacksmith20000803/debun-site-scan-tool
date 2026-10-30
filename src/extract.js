'use strict';

const cheerio = require('cheerio');
const { resolveUrl } = require('./util/url');

const EXECUTABLE_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jscript',
  'text/x-javascript',
  'application/x-javascript',
]);

function isExecutableScriptType(type) {
  if (type == null) return true;
  const value = String(type).trim().toLowerCase();
  if (!value) return true;
  if (EXECUTABLE_TYPES.has(value)) return true;
  return value.includes('javascript') || value.includes('ecmascript');
}

/**
 * Extract JavaScript resources and page metadata from an HTML document.
 *
 * @returns {{
 *   scripts: Array<{kind:'external'|'preload', url:string, type?:string, rel?:string, as?:string}>,
 *   inlineScripts: Array<{kind:'inline', content:string, type?:string}>,
 *   assets: string[],
 *   meta: {title?:string, generator?:string, lang?:string, description?:string}
 * }}
 */
function extractFromHtml(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const scripts = [];
  const inlineScripts = [];
  const assets = [];
  const seenScripts = new Set();
  const seenAssets = new Set();

  const pushScript = (entry) => {
    if (!entry.url || seenScripts.has(entry.url)) return;
    seenScripts.add(entry.url);
    scripts.push(entry);
  };

  $('script').each((_, element) => {
    const $el = $(element);
    const src = $el.attr('src');
    const type = $el.attr('type');

    if (src) {
      const absolute = resolveUrl(baseUrl, src);
      if (absolute) {
        pushScript({ kind: 'external', url: absolute, type: type || undefined });
      }
      return;
    }

    if (!isExecutableScriptType(type)) return;
    const content = $el.html() || '';
    if (!content.trim()) return;
    inlineScripts.push({ kind: 'inline', content, type: type || undefined });
  });

  $('link').each((_, element) => {
    const $el = $(element);
    const rel = ($el.attr('rel') || '').trim().toLowerCase();
    const as = ($el.attr('as') || '').trim().toLowerCase();
    const href = $el.attr('href');
    if (!href) return;

    if (rel === 'modulepreload' || (rel === 'preload' && as === 'script')) {
      const absolute = resolveUrl(baseUrl, href);
      if (absolute) {
        pushScript({
          kind: 'preload',
          url: absolute,
          rel: rel || undefined,
          as: as || undefined,
        });
      }
      return;
    }

    if (['stylesheet', 'icon', 'manifest'].includes(rel)) {
      const absolute = resolveUrl(baseUrl, href);
      if (absolute && !seenAssets.has(absolute)) {
        seenAssets.add(absolute);
        assets.push(absolute);
      }
    }
  });

  const meta = {
    title: ($('title').first().text() || '').trim() || undefined,
    generator: ($('meta[name="generator"]').attr('content') || '').trim() || undefined,
    description: ($('meta[name="description"]').attr('content') || '').trim() || undefined,
    lang: ($('html').attr('lang') || '').trim() || undefined,
  };

  return { scripts, inlineScripts, assets, meta };
}

/** Extract `sourceMappingURL` references from JavaScript source. */
function extractSourceMappingUrls(code) {
  const urls = [];
  const pattern = /(?:^|\n)\s*(?:\/\/[#@]\s*sourceMappingURL\s*=\s*([^\s'"]+)|\/\*[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)\s*\*\/)/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const value = match[1] || match[2];
    if (value) urls.push(value.trim());
  }
  return urls;
}

module.exports = { extractFromHtml, extractSourceMappingUrls, isExecutableScriptType };
