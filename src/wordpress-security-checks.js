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

async function readOnlyGet(url, signal) {
  const response = await client.get(url.href, { signal, responseType: 'text' });
  return {
    status: response.status,
    contentType: String(response.headers?.['content-type'] || ''),
    body: typeof response.data === 'string' ? response.data.slice(0, 256 * 1024) : '',
    headers: response.headers || {},
  };
}

/** Safe, read-only WordPress exposure checks. No exploit payloads or writes. */
async function checkWordPressExposure(baseUrl, options = {}) {
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

  await run('wordpress-rest-users-public', '/wp-json/wp/v2/users?per_page=3&_fields=id,name,slug,link', (response, url) => {
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

  await run('wordpress-xmlrpc-exposed', '/xmlrpc.php', (response, url) => {
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
  try {
    const root = safeSameOriginUrl(baseUrl, '/');
    const response = await readOnlyGet(root, options.signal);
    for (const [header, label] of headerChecks) {
      checks.push({ id: `header-${header}`, status: response.headers[header] ? 'present' : 'missing', url: root.href });
      if (!response.headers[header]) add(`missing-${header}`, 'Security headers', 'info', `${label} header is absent`, `The public response did not include ${label}. Missing headers are hardening observations and do not alone prove a vulnerability.`, `Header not present on HTTP ${response.status} response.`, root.href);
    }
  } catch (error) {
    checks.push({ id: 'security-headers', status: 'unavailable', detail: error.message });
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
    methodology: 'Passive, unauthenticated, same-origin GET checks only. Findings describe observable exposure and require human review; they are not exploit confirmation.',
  };
}

module.exports = { checkWordPressExposure };
