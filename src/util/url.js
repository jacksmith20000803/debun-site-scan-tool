'use strict';

/** URL helpers. */

function normalizeUrl(input) {
  if (!input || typeof input !== 'string' || !input.trim()) {
    throw new Error('A URL is required.');
  }
  let value = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url;
}

function resolveUrl(base, ref) {
  if (!ref) return null;
  const trimmed = String(ref).trim();
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('data:')) {
    return null;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch (_) {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/** Best-effort file extension of a URL pathname ('.js', '.mjs', ...). */
function urlExtension(value) {
  try {
    const pathname = new URL(value).pathname;
    const match = pathname.match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

module.exports = { normalizeUrl, resolveUrl, isHttpUrl, urlExtension };
