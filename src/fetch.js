'use strict';

const axios = require('axios');
const https = require('node:https');
const { normalizeUrl } = require('./util/url');
const { log } = require('./util/log');

const DEFAULT_USER_AGENT =
  'page-deps/1.0 (+https://github.com/; dependency inference)';
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

// Only retry certificate validation failures. Network, HTTP, and timeout
// failures must retain the normal strict-TLS behavior. The insecure agent is
// request-local and is never used for registry/CVE or other unrelated calls.
function isCertificateValidationError(error) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = String(current.code || current.errno || '').toUpperCase();
    const message = String(current.message || '');
    if (/^(CERT_HAS_EXPIRED|ERR_CERT_DATE_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED)$/.test(code) ||
        /certificate has expired|certificate is not yet valid|self[- ]signed certificate|unable to verify the first certificate/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

async function getWithCertificateFallback(client, url, config = {}) {
  try {
    return { response: await client.get(url, config), tlsValidationBypassed: false };
  } catch (error) {
    if (!isCertificateValidationError(error) || config.signal?.aborted) throw error;
    const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    try {
      const response = await client.get(url, { ...config, httpsAgent: agent });
      return { response, tlsValidationBypassed: true };
    } finally {
      agent.destroy();
    }
  }
}

function createClient({ timeout = 20000, headers = {}, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return axios.create({
    timeout,
    maxRedirects: 5,
    maxContentLength: maxBytes,
    validateStatus: () => true,
    transformResponse: [(data) => data],
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      ...headers,
    },
  });
}

function finalUrlOf(response, fallback) {
  const request = response && response.request;
  const res = request && request.res;
  return (res && res.responseUrl) || (request && request._redirectable && request._redirectable._currentUrl) || fallback;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Fetch a document as text.
 * @returns {Promise<{requestedUrl:string, finalUrl:string, status:number, ok:boolean, headers:object, contentType:string, body:string}>}
 */
async function fetchDocument(url, options = {}) {
  const requestedUrl = normalizeUrl(url).toString();
  const client = createClient({
    timeout: options.timeout,
    headers: options.headers,
    maxBytes: options.maxBytes,
  });

  let response;
  let tlsValidationBypassed = false;
  try {
    const fetched = await getWithCertificateFallback(client, requestedUrl, {
      responseType: 'text',
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: options.signal,
    });
    response = fetched.response;
    tlsValidationBypassed = fetched.tlsValidationBypassed;
    if (fetched.tlsValidationBypassed) {
      log.warn(`TLS certificate validation failed for ${requestedUrl}; fetched only this scan target with certificate checks disabled.`);
    }
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') throw error;
    throw new Error(`Failed to fetch ${requestedUrl}: ${error.message}`);
  }

  const finalUrl = finalUrlOf(response, requestedUrl);
  const contentType = headerValue(response.headers, 'content-type') || '';
  return {
    requestedUrl,
    finalUrl,
    status: response.status,
    ok: response.status >= 200 && response.status < 400,
    headers: response.headers || {},
    contentType,
    body: typeof response.data === 'string' ? response.data : String(response.data ?? ''),
    tlsValidationBypassed,
  };
}

/**
 * Fetch an arbitrary text resource (JavaScript, source map, JSON).
 * Resolves to null instead of throwing so callers can keep going.
 */
async function fetchText(url, options = {}) {
  if (!url) return null;
  const client = createClient({
    timeout: options.timeout ?? 15000,
    headers: options.headers,
    maxBytes: options.maxBytes ?? 15 * 1024 * 1024,
  });
  try {
    const fetched = await getWithCertificateFallback(client, url, { responseType: 'text', signal: options.signal });
    const response = fetched.response;
    if (fetched.tlsValidationBypassed) {
      log.warn(`TLS certificate validation failed for ${url}; fetched only this scan target with certificate checks disabled.`);
    }
    const contentType = headerValue(response.headers, 'content-type') || '';
    if (response.status < 200 || response.status >= 400) {
      log.step(`HTTP ${response.status} for ${url}`);
      return null;
    }
    return {
      url: finalUrlOf(response, url),
      status: response.status,
      contentType,
      headers: response.headers || {},
      text: typeof response.data === 'string' ? response.data : String(response.data ?? ''),
      tlsValidationBypassed: Boolean(fetched.tlsValidationBypassed),
    };
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') throw error;
    log.step(`fetch failed for ${url}: ${error.message}`);
    return null;
  }
}

/** Run promise-returning tasks with bounded concurrency, preserving order. */
async function mapPool(items, limit, worker, options = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      if (options.signal?.aborted) {
        const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('The operation was stopped.');
        error.name = 'AbortError';
        throw error;
      }
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') throw error;
        results[index] = { error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { fetchDocument, fetchText, createClient, mapPool, DEFAULT_USER_AGENT, isCertificateValidationError };
