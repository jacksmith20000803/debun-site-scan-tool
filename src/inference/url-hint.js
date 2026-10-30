'use strict';

const { normalizeKey } = require('./naming');

const VERSION = String.raw`\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?`;
const SCOPE_OR_NAME = String.raw`(?:@[^/\s]+/)?[^/@\s]+`;

/**
 * CDN / registry URL patterns that embed a package name and often a version.
 * Ordered from most specific to most generic.
 */
const REGISTRY_PATTERNS = [
  {
    registry: 'unpkg',
    re: new RegExp(`unpkg\\.com/(${SCOPE_OR_NAME})(?:@(${VERSION}))?`, 'i'),
  },
  {
    registry: 'jsdelivr-npm',
    re: new RegExp(`cdn\\.jsdelivr\\.net/npm/(${SCOPE_OR_NAME})(?:@(${VERSION}))?`, 'i'),
  },
  {
    registry: 'jsdelivr-gh',
    re: new RegExp(`cdn\\.jsdelivr\\.net/gh/([^/@\\s]+/[^/@\\s]+)(?:@(${VERSION}))?`, 'i'),
  },
  {
    registry: 'esm.sh',
    re: new RegExp(`esm\\.sh/(${SCOPE_OR_NAME})(?:@(${VERSION}))?`, 'i'),
  },
  {
    registry: 'skypack',
    re: new RegExp(`cdn\\.skypack\\.dev/(${SCOPE_OR_NAME})(?:@(${VERSION}))?`, 'i'),
  },
  {
    registry: 'jspm',
    re: new RegExp(`(?:ga\\.jspm\\.io/npm:|jspm\\.dev/)((?:@[^/\\s]+/)?[^/@\\s]+)(?:@(${VERSION}))?`, 'i'),
  },
  {
    registry: 'cdnjs',
    re: new RegExp(`cdnjs\\.cloudflare\\.com/ajax/libs/([^/\\s]+)/(${VERSION})`, 'i'),
  },
  {
    registry: 'jsdelivr-combine',
    re: new RegExp(`cdn\\.jsdelivr\\.net/combine/(?:gh|npm)/(${SCOPE_OR_NAME})(?:@(${VERSION}))?`, 'i'),
  },
];

/** Generic `<name>@<version>` or `<name>/<version>` appearing anywhere. */
const VERSION_STRICT = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
const GENERIC_AT = new RegExp(`\\b((?:@[^/\\s]+/)?[a-z][a-z0-9._-]*[a-z0-9])@(${VERSION_STRICT})\\b`, 'i');
const GENERIC_SLASH_VERSION = new RegExp(`/((?:@[^/\\s]+/)?[a-z][a-z0-9._-]*[a-z0-9])/(${VERSION_STRICT})/`, 'i');

/** Path segments that look like a name/version pair but are not packages. */
const BLOCKED_SEGMENTS = new Set([
  'docs', 'doc', 'static', 'assets', 'asset', 'images', 'image', 'img', 'css', 'fonts', 'font',
  'media', 'page', 'pages', 'blog', 'cdn', 'dist', 'build', 'vendor', 'vendors', 'src', 'lib',
  'libs', 'js', 'javascript', 'node_modules', 'chunks', 'chunk', 'app', 'public', 'content',
  'api', 'static', 'themes', 'theme', 'plugins', 'plugin', 'modules', 'module', 'styles',
  'scripts', 'files', 'file', 'download', 'downloads', 'releases', 'release', 'v', 'www',
  '_next', '_nuxt', '_astro', 'wp-content', 'wp-includes',
]);

function isBlockedName(name) {
  if (!name) return true;
  return BLOCKED_SEGMENTS.has(String(name).toLowerCase());
}

/** Query-string hints: `?v=1.2.3`, `?version=1.2.3`, `?ver=1.2.3`. */
const QUERY_VERSION = new RegExp(`[?&](?:v|ver|version)=(${VERSION})`, 'i');

function firstVersionMatch(re, text) {
  const match = re.exec(text);
  if (!match) return null;
  return { name: match[1] ? decodeURIComponent(match[1]) : undefined, version: match[2] };
}

/**
 * Infer a package (and optionally a version) from a resource URL.
 * @returns {{name:string, version?:string, registry:string, evidence:string}|null}
 */
function inferFromUrl(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return null;
  }

  // WordPress asset cache keys and directory names are not npm identity or
  // package-version evidence. They are handled by the WordPress detector.
  if (/\/wp-(?:content|includes)\//i.test(url.pathname)) return null;

  // Ignore first-party-agnostic analytics hosts early.
  const hostAndPath = `${url.host}${url.pathname}`;

  for (const pattern of REGISTRY_PATTERNS) {
    const match = firstVersionMatch(pattern.re, hostAndPath);
    if (match && match.name) {
      return {
        name: normalizeKey(match.name),
        version: match.version || undefined,
        registry: pattern.registry,
        evidence: `${pattern.registry}: ${hostAndPath}`,
      };
    }
  }

  // Code.jquery.com and similar `<name>-<version>.js` filenames.
  const file = url.pathname.split('/').pop() || '';
  const fileMatch = /^([a-z][a-z0-9._-]*?)[-.](\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:\.min)?\.js$/i.exec(file);
  if (fileMatch) {
    const candidate = normalizeKey(fileMatch[1]);
    if (!isBlockedName(candidate) && !/^(index|main|app|bundle|vendor|runtime|polyfills|chunk|page)([.-]\w+)*$/i.test(candidate)) {
      return {
        name: candidate,
        version: fileMatch[2],
        registry: 'filename',
        evidence: `filename: ${file}`,
      };
    }
  }

  const genericAt = GENERIC_AT.exec(hostAndPath);
  if (genericAt) {
    const candidate = normalizeKey(genericAt[1]);
    if (!isBlockedName(candidate) && (!candidate.includes('.') || candidate.startsWith('@'))) {
      return {
        name: candidate,
        version: genericAt[2],
        registry: 'generic',
        evidence: `url segment: ${genericAt[0]}`,
      };
    }
  }

  const genericSlash = GENERIC_SLASH_VERSION.exec(hostAndPath);
  if (genericSlash && !isBlockedName(genericSlash[1])) {
    return {
      name: normalizeKey(genericSlash[1]),
      version: genericSlash[2],
      registry: 'generic',
      evidence: `url path: /${genericSlash[1]}/${genericSlash[2]}/`,
    };
  }

  const query = QUERY_VERSION.exec(url.search);
  if (query) {
    // Only trust a query version when the path gives us a plausible name.
    const pathName = /([a-z][a-z0-9._-]*)\.(?:min\.)?js$/i.exec(file);
    if (pathName && !isBlockedName(pathName[1])) {
      return {
        name: normalizeKey(pathName[1]),
        version: query[1],
        registry: 'query',
        evidence: `query string version on ${file}`,
      };
    }
  }

  return null;
}

module.exports = { inferFromUrl, VERSION, isBlockedName };
