'use strict';

const axios = require('axios');
const { URL } = require('node:url');

const client = axios.create({
  timeout: 5000,
  maxRedirects: 3,
  maxContentLength: 256 * 1024,
  headers: { 'User-Agent': 'WebScan-Safe-Exposure-Check/1.0', Accept: 'application/json,text/plain,*/*' },
  validateStatus: () => true,
  transformResponse: [(body) => body],
});

function safeSameOriginUrl(base, pathname) {
  const target = new URL(pathname, base);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== new URL(base).origin) return null;
  return target;
}

async function readOnlyGet(url, signal, headers = {}) {
  const response = await client.get(url.href, { signal, responseType: 'text', headers });
  return {
    status: response.status,
    contentType: String(response.headers?.['content-type'] || ''),
    body: typeof response.data === 'string' ? response.data.slice(0, 256 * 1024) : '',
    headers: response.headers || {},
  };
}

/** Safe, read-only website checks. No exploit payloads, form submissions, or writes. */
async function checkSiteSecurity(baseUrl, options = {}) {
  const findings = [];
  const checks = [];
  const add = (id, category, severity, title, detail, evidence, url) => findings.push({ id, category, severity, title, detail, evidence, url });
  const run = async (id, path, inspect) => {
    if (options.signal?.aborted) throw options.signal.reason || new Error('Scan stopped.');
    const url = safeSameOriginUrl(baseUrl, path);
    if (!url) return;
    try {
      const response = await readOnlyGet(url, options.signal);
      const result = inspect(response, url);
      checks.push({ id, status: result ? 'finding' : 'no-exposure-detected', url: url.href });
      if (result) add(id, result.category, result.severity, result.title, result.detail, result.evidence, url.href);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      checks.push({ id, status: 'unavailable', url: url.href, detail: error.message });
    }
  };

  if (options.includeWordPress && options.includeSiteWideChecks !== false) await run('wordpress-rest-users-public', '/wp-json/wp/v2/users?per_page=3&_fields=id,name,slug,link', (response, url) => {
    if (response.status !== 200 || !/json/i.test(response.contentType)) return null;
    let users;
    try { users = JSON.parse(response.body); } catch (_) { return null; }
    if (!Array.isArray(users) || !users.some((user) => user && (user.id || user.slug || user.name))) return null;
    return {
      category: 'User enumeration', severity: 'low', title: 'Public WordPress user directory',
      detail: 'The unauthenticated REST users endpoint returned public account identifiers. This may be intentional; review whether author names/slugs should be public.',
      evidence: `${users.length} user record(s) exposed by a read-only request; names and identifiers are not copied into the report.`,
    };
  });

  if (options.includeWordPress && options.includeSiteWideChecks !== false) await run('wordpress-xmlrpc-exposed', '/xmlrpc.php', (response, url) => {
    const body = response.body.toLowerCase();
    if (!([200, 405].includes(response.status) && /xml-rpc|xmlrpc|method.*post/i.test(body))) return null;
    return {
      category: 'Attack surface', severity: 'info', title: 'XML-RPC endpoint is reachable',
      detail: 'The WordPress XML-RPC endpoint is enabled or responds publicly. This is exposure information, not proof of an exploitable vulnerability.',
      evidence: `HTTP ${response.status} response from ${url.pathname}.`,
    };
  });

  const headerChecks = [
    ['strict-transport-security', 'HSTS'],
    ['content-security-policy', 'Content-Security-Policy'],
    ['x-content-type-options', 'X-Content-Type-Options'],
    ['referrer-policy', 'Referrer-Policy'],
  ];
  const inspectHeaders = (response, root, canProbeCors) => {
    for (const [header, label] of headerChecks) {
      checks.push({ id: `header-${header}`, status: response.headers[header] ? 'present' : 'missing', url: root.href });
      if (!response.headers[header]) add(`missing-${header}`, 'Security headers', 'info', `${label} header is absent`, `The public response did not include ${label}. Missing headers are hardening observations and do not alone prove a vulnerability.`, `Header not present on HTTP ${response.status} response.`, root.href);
    }
    const allowOrigin = String(response.headers['access-control-allow-origin'] || '').trim();
    const allowCredentials = String(response.headers['access-control-allow-credentials'] || '').trim().toLowerCase() === 'true';
    if (allowOrigin === '*' || (canProbeCors && allowOrigin === 'https://webscan.invalid')) {
      const reflected = allowOrigin === 'https://webscan.invalid';
      const severity = reflected && allowCredentials ? 'low' : 'info';
      checks.push({ id: 'cors-untrusted-origin', status: 'finding', url: root.href });
      add('cors-untrusted-origin', 'CORS policy', severity,
        reflected ? 'CORS reflects an arbitrary origin' : 'CORS allows any origin',
        reflected && allowCredentials
          ? 'The response reflects an arbitrary Origin and allows credentials. Review whether sensitive authenticated responses share this policy; this root-page probe alone does not confirm data exposure.'
          : 'The probed response is readable cross-origin for public content. This is not by itself a vulnerability unless sensitive data is exposed under the same policy.',
        `Access-Control-Allow-Origin: ${allowOrigin}${allowCredentials ? '; Access-Control-Allow-Credentials: true' : ''}.`, root.href);
    } else checks.push({ id: 'cors-untrusted-origin', status: canProbeCors ? 'not-detected' : 'not-tested', url: root.href });
  };
  if (options.includeSiteWideChecks === false && options.responseHeaders) {
    const pageUrl = safeSameOriginUrl(baseUrl, baseUrl);
    inspectHeaders({ headers: options.responseHeaders, status: options.responseStatus || 200 }, pageUrl, false);
  } else {
    try {
      const root = safeSameOriginUrl(baseUrl, options.includeSiteWideChecks === false ? baseUrl : '/');
      const response = await readOnlyGet(root, options.signal, { Origin: 'https://webscan.invalid' });
      inspectHeaders(response, root, true);
    } catch (error) {
      checks.push({ id: 'security-headers', status: 'unavailable', detail: error.message });
    }
  }

  if (options.includeSiteWideChecks !== false) {
    await run('security-txt-missing', '/.well-known/security.txt', (response, url) => {
      if (response.status === 200 && /^\s*Contact:\s*\S+/im.test(response.body)) return null;
      return {
        category: 'Security contact', severity: 'info', title: 'security.txt was not found',
        detail: 'No valid security.txt Contact directive was available at the standard path. Publishing one helps researchers report security issues; its absence is not an exploitable vulnerability.',
        evidence: `HTTP ${response.status} from ${url.pathname}.`,
      };
    });
  }

  return {
    checks,
    findings,
    notTested: [
      { category: 'SQL injection', status: 'not-tested', reason: 'Active payload testing can alter data or impose load; this scanner only performs non-invasive checks.' },
      { category: 'Cross-site scripting', status: 'not-tested', reason: 'No executable payloads are submitted; reflected or stored XSS requires controlled, authorized testing.' },
      { category: 'Command injection', status: 'not-tested', reason: 'No shell metacharacters or execution payloads are submitted.' },
      { category: 'XXE', status: 'not-tested', reason: 'No crafted XML or external-entity payloads are submitted.' },
    ],
    methodology: options.includeSiteWideChecks === false
      ? 'Passive assessment uses the submitted page response headers only. No extra paths or requests are used; CORS is not actively probed. No exploit payloads, form submissions, or writes. Findings describe observable exposure and require human review; they are not exploit confirmation.'
      : 'Passive, unauthenticated, same-origin GET checks only (root headers/CORS and security.txt; WordPress REST users and XML-RPC when detected). No exploit payloads, form submissions, or writes. Findings describe observable exposure and require human review; they are not exploit confirmation.',
  };
}

async function checkWordPressExposure(baseUrl, options = {}) {
  return checkSiteSecurity(baseUrl, { ...options, includeWordPress: true });
}

module.exports = { checkSiteSecurity, checkWordPressExposure };
