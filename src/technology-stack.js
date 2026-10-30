'use strict';

/**
 * Identify publicly observable technologies from page markup, asset URLs and
 * response headers. These are stack clues, not assertions about server-side
 * software that the public page does not expose.
 */
const RULES = [
  { category: 'CMS', name: 'WordPress', confidence: 0.99, test: (s) => /\/wp-(?:content|includes)\//i.test(s.all) || /wordpress/i.test(s.headers['x-powered-by'] || '') || /<meta[^>]+name=["']generator["'][^>]+wordpress/i.test(s.html) },
  { category: 'CMS', name: 'Shopify', confidence: 0.99, test: (s) => /cdn\.shopify\.com|shopify\.theme|Shopify\.routes/i.test(s.all) },
  { category: 'CMS', name: 'Wix', confidence: 0.98, test: (s) => /static\.wixstatic\.com|wixsite\.com|wix-code-sdk/i.test(s.all) },
  { category: 'CMS', name: 'Webflow', confidence: 0.98, test: (s) => /webflow\.com|data-wf-site|website-files\.com/i.test(s.all) },
  { category: 'CMS', name: 'Squarespace', confidence: 0.98, test: (s) => /static\.squarespace\.com|squarespace\.com\/static/i.test(s.all) },
  { category: 'CMS', name: 'Drupal', confidence: 0.96, test: (s) => /drupalSettings|\/sites\/default\/files\//i.test(s.all) },
  { category: 'CMS', name: 'Joomla', confidence: 0.95, test: (s) => /\/media\/system\/js\/|com_content|Joomla!/i.test(s.all) },
  { category: 'CMS', name: 'Ghost', confidence: 0.96, test: (s) => /ghost\.org|\/ghost\/api\//i.test(s.all) },
  { category: 'CMS', name: 'Adobe Commerce', confidence: 0.95, test: (s) => /mage\/cookie|Magento_Ui|\/static\/version\d+\//i.test(s.all) },
  { category: 'Framework', name: 'Next.js', confidence: 0.99, test: (s) => /\/_next\/(?:static|image)\//i.test(s.all) || /__NEXT_DATA__|__next_f/i.test(s.html) },
  { category: 'Framework', name: 'Nuxt', confidence: 0.98, test: (s) => /__NUXT__|\/__nuxt\//i.test(s.all) },
  { category: 'Framework', name: 'Gatsby', confidence: 0.97, test: (s) => /___gatsby|gatsby-chunk-mapping|gatsby-browser/i.test(s.all) },
  { category: 'Framework', name: 'Remix', confidence: 0.97, test: (s) => /__remixContext|\/build\/routes\/.*\.js/i.test(s.all) },
  { category: 'Framework', name: 'Astro', confidence: 0.97, test: (s) => /astro-island|\/\_astro\//i.test(s.all) },
  { category: 'Framework', name: 'Angular', confidence: 0.94, test: (s) => /ng-version=|ɵɵdefineComponent|zone\.js/i.test(s.all) },
  { category: 'Framework', name: 'Vue.js', confidence: 0.93, test: (s) => /data-v-app|__VUE__|vue\.runtime/i.test(s.all) },
  { category: 'Framework', name: 'React', confidence: 0.92, test: (s) => /react-dom(?:\.production)?\.min\.js|react\.production\.min\.js|__REACT_DEVTOOLS_GLOBAL_HOOK__/i.test(s.all) },
  { category: 'CDN', name: 'Cloudflare', confidence: 0.99, test: (s) => /cloudflare/i.test([s.headers.server, s.headers['cf-ray'], s.headers['cf-cache-status'], s.headers['cf-mitigated'], s.html.match(/https?:[^"'\s]*cloudflare[^"'\s]*/i)?.[0]].filter(Boolean).join(' ')) },
  { category: 'CDN', name: 'Fastly', confidence: 0.97, test: (s) => Boolean(s.headers['x-served-by']?.match(/cache-[a-z0-9]+-[A-Z]+/) || s.headers['x-fastly-request-id'] || s.headers.via?.match(/varnish/i)) },
  { category: 'CDN', name: 'Amazon CloudFront', confidence: 0.98, test: (s) => Boolean(s.headers['x-amz-cf-id'] || s.headers['x-amz-cf-pop'] || /cloudfront\.net/i.test(s.all)) },
  { category: 'CDN', name: 'Akamai', confidence: 0.98, test: (s) => Boolean(s.headers['akamai-grn'] || /akamaized\.net|akamaihd\.net/i.test(s.all)) },
  { category: 'CDN', name: 'Vercel', confidence: 0.98, test: (s) => Boolean(s.headers['x-vercel-id'] || /vercel\.app/i.test(s.all)) },
  { category: 'CDN', name: 'Netlify', confidence: 0.98, test: (s) => Boolean(s.headers['x-nf-request-id'] || /netlify\.app/i.test(s.all)) },
  { category: 'WAF', name: 'Cloudflare WAF / challenge layer', confidence: 0.94, test: (s) => Boolean(s.headers['cf-mitigated'] || /cf-chl-|challenge-platform/i.test(s.html)) },
  { category: 'WAF', name: 'DataDome', confidence: 0.97, test: (s) => Boolean(s.headers['x-datadome'] || /datadome\.co|ddjs\.net/i.test(s.all)) },
  { category: 'WAF', name: 'HUMAN (PerimeterX)', confidence: 0.96, test: (s) => Boolean(s.headers['x-px-captcha'] || /px-captcha|perimeterx\.net/i.test(s.all)) },
  { category: 'WAF', name: 'AWS WAF', confidence: 0.95, test: (s) => Boolean(s.headers['x-amzn-waf-action'] || s.headers['x-amzn-errortype']?.match(/waf|captcha|challenge/i)) },
  { category: 'WAF', name: 'Imperva', confidence: 0.97, test: (s) => Boolean(s.headers['x-iinfo'] || /incap_ses|visid_incap/i.test(s.all)) },
  { category: 'WAF', name: 'Sucuri', confidence: 0.97, test: (s) => Boolean(s.headers['x-sucuri-id'] || /sucuri\.net/i.test(s.all)) },
  { category: 'Analytics', name: 'Google Analytics', confidence: 0.96, test: (s) => /googletagmanager\.com\/gtag\/js|google-analytics\.com\/analytics\.js|\bgtag\s*\(/i.test(s.all) },
  { category: 'Tag manager', name: 'Google Tag Manager', confidence: 0.97, test: (s) => /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i.test(s.all) },
  { category: 'Analytics', name: 'Segment', confidence: 0.96, test: (s) => /cdn\.segment\.com|analytics\.load\s*\(/i.test(s.all) },
  { category: 'Analytics', name: 'Mixpanel', confidence: 0.95, test: (s) => /cdn\.mxpnl\.com|mixpanel\.init\s*\(/i.test(s.all) },
  { category: 'Payments', name: 'Stripe', confidence: 0.98, test: (s) => /js\.stripe\.com|stripe\.com\/v3/i.test(s.all) },
  { category: 'Payments', name: 'PayPal', confidence: 0.97, test: (s) => /paypal\.com\/sdk\/js|www\.paypalobjects\.com/i.test(s.all) },
];

function normalizedHeaders(headers = {}) {
  if (headers && typeof headers.entries === 'function') {
    try { headers = Object.fromEntries(headers.entries()); } catch (_) { /* retain plain-object fallback */ }
  }
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
}

function detectTechnologyStack({ html = '', urls = [], headers = {} } = {}) {
  const responseHeaders = normalizedHeaders(headers);
  const urlText = (urls || []).join('\n');
  const all = `${html}\n${urlText}\n${Object.entries(responseHeaders).map(([key, value]) => `${key}: ${value}`).join('\n')}`;
  const context = { html, urls, headers: responseHeaders, all };
  return RULES.flatMap((rule) => {
    if (!rule.test(context)) return [];
    let evidence = [];
    if (rule.category === 'CDN' || rule.category === 'WAF' || rule.category === 'Hosting') {
      evidence = Object.entries(responseHeaders).filter(([key, value]) => value && /server|via|cf-|x-amz|x-vercel|x-nf|akamai|fastly|sucuri|iinfo/i.test(key)).map(([key, value]) => `${key}: ${value}`);
    }
    if (!evidence.length) {
      const matchingUrls = (urls || []).filter((url) => /cloudflare|shopify|wix|webflow|squarespace|drupal|ghost|gatsby|astro|vercel|netlify|stripe|paypal|googletagmanager|segment|mxpnl|_next|_nuxt/i.test(url));
      evidence = matchingUrls.length
        ? matchingUrls.slice(0, 3).map((url) => `asset URL: ${url}`)
        : [`Public HTML or asset content matched the ${rule.name} fingerprint`];
    }
    return [{ category: rule.category, name: rule.name, confidence: rule.confidence, evidence }];
  });
}

module.exports = { detectTechnologyStack, normalizedHeaders };
