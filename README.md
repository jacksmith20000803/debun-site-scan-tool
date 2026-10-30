# debun-plus

The browser scan also detects publicly exposed WordPress plugin and theme slugs from asset URLs. WordPress plugin/theme advisories are checked with the free [WPVulnerability API](https://www.wpvulnerability.net/); versioned npm detections are checked in batches against [OSV.dev](https://google.github.io/osv.dev/post-v1-querybatch/). Reports include advisory IDs, source links, summaries, match status, and database lookup status. WordPress asset URLs frequently omit installed versions, so those component-level findings are explicitly marked `advisories-unverified` until an installed version is observable. These are public-surface detections and cannot enumerate private, inactive, or unreferenced components.

Deep scans now inspect a larger bounded set of browser-loaded scripts, stylesheets, source maps, and same-origin pages from both page links and sitemaps. The report separates versioned/verified package detections from **unverified package leads**. A public website does not expose all of its server-side dependencies or every module folded into minified bundles, so the tool does not present an inferred complete dependency tree as fact. It also reports evidence-backed public technology fingerprints such as CMS, framework, CDN/WAF, analytics, and payment services under `technologies`.

> Give it a URL. It retrieves the page's source and infers the npm packages —
> and their specific versions — that the site ships in the browser.
> In-depth, multi-signal inference built around the
> [**Debun**](https://www.npmjs.com/package/debun-cli) Property-Order-Graph engine,
> AST fingerprints, and cached npm registry corpora.

```
$ page-deps https://jquery.com/

page-deps · web package & version inference

Target     https://jquery.com/
Crawler    http · HTTP 200
Title      jQuery
Scanned    3 script source(s) · 86.6 KiB · 4211 ms

Detected packages (1)
Package  Version                   Confidence  Signals                                   Primary evidence
───────  ────────────────────────  ──────────  ────────────────────────────────────────  ─────────────────────────────
jquery   4.0.0 (alt 3.7.1, 3.7.0)  0.99 high   banner,debun-exact,debun-likely,debun-r…  filename: jquery-4.0.0.min.js
```

---

## Why this is more than a regex over URLs

A single heuristic is easy to fool:

* **URLs lie.** `jquery-4.0.0.min.js` can be a renamed 3.6 build; CDN paths are
  rewritten by bundlers.
* **Fingerprints have blind spots.** Debun's database ships ~70 libraries with
  per-version Property-Order-Graph (POG) hashes. When a version is newer than
  the database (jQuery 4.0.0 is not in it), the engine can return the nearest
  version it *does* know (3.7.1).
* **Comments get stripped.** Banners and `@license` blocks are removed by
  minifiers or changed by forkers.

`page-deps` doesn't pick a winner up front. It collects **independent evidence**
from five different families, then combines it: a package is reported only when
the signals agree, and disagreements are surfaced instead of hidden.

| Signal family | What it looks at | Typical strength |
| --- | --- | --- |
| `debun` | Property-Order-Graph fingerprint vs. debun's version database | exact / range / likely |
| `url` | CDN + registry paths (`unpkg`, `jsdelivr`, `esm.sh`, `skypack`, `cdnjs`, `jspm`, filenames, `?v=`) | high when a version is present |
| `banner` | `/*! Name v1.2.3 */`, `@license`, `@preserve`, `@version` | high |
| `global` | `jQuery.fn.jquery = "3.6.0"`, `Vue.version = …`, `X.VERSION = …` | medium |
| `sourcemap` | `sourceMappingURL` → `sources[]` / `sourcesContent[]` (`node_modules/<pkg>/<version>`, embedded `package.json`) | high |
| `manifest` | the site's own `package.json` (root **and** embedded) → declared dependencies | high for identity |

Versions are voted on **per family**, so two independent signals that agree
(URL *and* banner say 4.0.0) outrank one engine hit (debun says 3.7.1). The
losing candidate is still reported under `(alt …)`, so nothing is silently
discarded.

---

## Install

```bash
npm install
npm run build
```

> **Browser requirements.** The web interface uses `@mdream/crawl` with its
> Playwright driver and requires system Chrome. The CLI's optional `--browser`
> mode continues to use Puppeteer:
>
> ```bash
> npm install
> ```
>
> For the CLI's Puppeteer mode, install Chromium with:
>
> ```bash
> npx puppeteer browsers install chrome
> ```
>
> To select a specific installed browser, set `PUPPETEER_EXECUTABLE_PATH` to its executable path.

Requires Node **20+**. Both `debun-plus` and the retained `page-deps` command
name are available.

---

## Usage

```bash
page-deps <url> [options]
```

### Phase 0 fragment CLI

The installed `debun-plus <url-or-path>` command collects a JavaScript URL or
the script assets in a web page, reads one JavaScript file, or recursively
collects JavaScript files from a directory. It writes `fragments.json` by
default; use `--output` to choose another path. Collection and parsing use a
concurrency limit of eight, and failed HTTP requests retry with exponential
backoff.

```bash
npm run build
node bin/debun-plus.js https://example.com --output fragments.json
node bin/debun-plus.js ./vendor --output fragments.json
```

The intermediate JSON includes function and statement-block fragments, UTF-8
byte offsets, extracted string literals, preserved license comments, removed
bundler runtime identifiers, and parse/fetch failure records. The CLI prints
source and fragment counts after writing the file. When the Phase 1 literal
index exists, it also prints strong package/version candidates matched from
those fragments.

Pass `--depth 1..3` to opt into a multi-page package scan instead. This opt-in
uses the full analyzer and writes the aggregated package report; omitting the
flag or using `--depth 0` preserves the Phase 0 fragment workflow.

### Final analysis output and explanations

Use the additive `analyze` command to run the full bundle detector. It writes a
JSON report and prints a human-readable table with each package's `exact`,
`range`, or `possible` tier, confidence score, and evidence-source list. The
JSON includes the same evidence details. `--explain` prints every fired signal
and its evidence detail per verdict.

```bash
node bin/debun-plus.js analyze ./dist --output report.json --explain
node bin/debun-plus.js analyze https://example.com --offline --database storage/debun-plus.sqlite
node bin/debun-plus.js analyze https://example.com --depth 2 --allow-domain docs.example.com
node bin/debun-plus.js https://example.com --depth 2 --output report.json
```

`--offline` uses only the selected SQLite cache, so it is useful for repeatable
local analysis and evaluation runs. Without it, the registry client can fetch
missing metadata and package corpora.

Multi-page crawling stays on the starting origin unless `--allow-domain` is
repeated with additional domains; each listed domain includes its subdomains.
The crawler respects `robots.txt`, limits page concurrency to four and asset
fetch concurrency to eight, and spaces requests to each host by 250 ms. The
delay can be changed with `--request-delay-ms`.
page cap is 20 pages per requested depth (maximum depth 3). JavaScript assets
are capped at 50 MB total by default; override with `--max-asset-mb`. HTML
links, script assets, JavaScript preloads, inline fetch/XHR references, and
static chunk references are considered. Dynamic chunk URLs are followed only
when they are same-origin with the page that referenced them.

Asset URLs are normalized by removing fragments, sorting query pairs by key
then value while retaining duplicate pairs, and preserving the path and
trailing slash. Identical JavaScript bodies are SHA-256 deduplicated and
analyzed once, then their findings are shared by every page that references
them. Multi-page JSON reports include a `pages` mapping and a merged
`packages` view with `pagesSeen` and `versionConsensus`; conflicting exact
versions are reported as `possible` with the conflicting versions listed.
To prevent pathological pages from expanding into an unbounded number of tiny
chunks, the crawler also stops after 2,000 distinct asset URLs.

### Phase 1.1 string-literal index

Build the `topN` index from a newline-delimited package list. Lines may contain
package names (the registry's `latest` version is used) or explicit
`name@version` entries. For a scoped package, use `@scope/name` or
`@scope/name@version`. The list should be sorted by download popularity; by
default, only its first 2,000 entries are scanned. The build downloads package
tarballs with the bounded RegistryClient, reads production JavaScript, and
stores distinct string-literal postings and their IDF weights in the shared
SQLite database. It drops strings shorter than 8 characters, generated/runtime
boilerplate, and literals present in more than 5% of indexed packages.

```bash
debun-plus build-index --packages top-packages.txt --tier topN
```

Use `--limit` to set a smaller package count, `--concurrency` to tune downloads
(capped at 8), or `--database` to select a different SQLite file. Rebuilding a
tier replaces its postings. The matcher accepts `fragments.json` data through
the exported `matchLiteralFragments` API and returns per-fragment package,
version, weighted score, matched literals, and strong/possible status. Strong
matches are the first candidate signal in both `analyzeBundles` and the
`debun-plus <url-or-path>` output pipeline.

### Phase 1.2 evidence signals

The candidate pipeline also extracts structured `{ signal, package, version?,
weight }` evidence from preserved `/*! */` and `@license` banners, embedded
version properties, runtime globals, UMD global leaks, and meta-framework reads
such as `__NEXT_DATA__`, `__next_f`, and `__NUXT__`. Version claims from code or
license banners are kept only when the package metadata lists that exact npm
version. Signal detectors and version validation are exported from the
`debun-plus` module for independent use.

Registry cache smoke checks are opt-in and contact npm only when explicitly
enabled:

```bash
DEBUN_LIVE_REGISTRY=1 npm run registry:smoke
```

On PowerShell, set `$env:DEBUN_LIVE_REGISTRY = '1'` before running
`npm run registry:smoke`. The check resolves and caches `lodash@4.17.21` metadata
and its tarball in `storage/debun-plus.sqlite`.

### Web interface

Start the local web interface with `npm run web`, then open `http://127.0.0.1:4173`.
It accepts one URL or a `.txt` file with one URL per line (up to 25 sites).
Each submitted URL is rendered first to resolve redirects. `@mdream/crawl` then
scans the destination root and follows rendered same-origin links to the
configured depth. Framework
and bundler values are descriptive and do not gate the scan. Single-site reports
are shown in the browser; batch reports
are downloadable. Each report contains `websiteUrl`, `finalUrl`, `framework`,
`bundler`, `pagesScanned`, `totalDependencies`, and `dependencies` (dependency
`name` and `version`). The crawl scans up to 25 pages total by default, queueing
at most 24 direct links from each rendered page. The server console logs each
unique page URL found during crawling. It honors `robots.txt` allow/disallow
rules; if `robots.txt` cannot be read, it limits scanning to the destination
root and submitted URL.
Before starting a single-site or URL-list job, choose **Deep scan** or
**Shallow scan**. Deep mode keeps the default first-level linked-page crawl.
Shallow mode follows the Wappalyzer-style active-page approach: it checks the
rendered final URL for the submitted page exactly once and skips both the site
root (when different) and linked pages. It uses shorter render, script, and
registry budgets while retaining the package and version analysis pipeline.
The selected mode appears with the results and is stored with the scan record.
The web interface streams a page counter during analysis and lists each scanned URL
with the final total. `newlyDiscovered` highlights packages found on scanned
pages but not on the root. A page-rendering failure prevents a report for that site.

The web interface uses system Chrome through Playwright. The CLI's optional
`--browser` mode requires Puppeteer Chromium; install it with `npx puppeteer browsers install chrome`.

### Windows desktop app

The Electron desktop build wraps the web interface in a native Windows window
and uses `ico.ico` for the app and installer icons. From a Windows machine with
Node.js installed, run:

```bash
npm install
npm run desktop:build
```

The NSIS installer is written to `artifacts/electron/`. The installed app stores
saved scans and its SQLite cache in Electron's per-user data directory. Website
rendering uses the installed Google Chrome browser through Playwright.

```bash
# human-readable report
page-deps https://getbootstrap.com

# machine-readable JSON
page-deps https://vuejs.org --json --output report.json

# render JavaScript-heavy SPAs with a real browser (needs Chromium)
page-deps https://example.com --browser

# only keep high-confidence findings
page-deps https://example.com --min-confidence high

# keep every downloaded script for manual inspection
page-deps https://example.com --save-scripts ./saved-scripts
```

The enhanced registry-backed matcher is enabled by default in the CLI and web
app. It prefers shipped minified or production bundle files in each candidate
tarball; if none are present, it fingerprints the selected production files and
two Terser minification configurations. The corpus stores string-literal
4-grams, AST hashes, and property/key-name dictionaries in
`storage/debun-plus.sqlite`.

The AST scorer serializes each node with its direct child node shapes and
normalizes identifier and literal values, then hashes rolling windows of **five
consecutive subtree serializations**. Very small fragments use one hash for the
whole fragment. The other scorers use character 4-gram Jaccard over string
literals and Jaccard over static property/key names. Their fused score is
`0.45 × AST + 0.30 × 4-gram + 0.25 × identifier`. Scores from up to three
independent target fragments are combined (70% strongest match, 30% mean of
the next matches), so fragments that disagree weaken the version margin. A
version is exact only when its fused score is at least 0.25 and its margin over
the next version is at least 0.08; otherwise a supported candidate is emitted
as a range. Browser scans compare up to eight published versions per candidate,
including the latest releases and evenly sampled older releases, so bundles
from older deployments are not compared only with current npm versions. When a
score is below the exact/range cutoff, a major-line range is emitted only when
at least two releases in that line match across multiple scorer signals and
other major lines score meaningfully lower; otherwise the version remains
unknown. No source maps or auxiliary build files are required.

Use `--plus-database <file>` to select a fingerprint cache, including for a
repeat scan of a local fixture or site. Use `--no-plus` to run only the original
signals.

Or without installing globally:

```bash
node bin/page-deps.js https://react.dev --json
```

The direct `node` form assumes you have built the TypeScript detector with
`npm run build`; the `npm run start`, `npm run analyze`, and `npm run web`
commands build it automatically.

### Options

| Option | Description |
| --- | --- |
| `-j, --json` | emit JSON instead of text |
| `-o, --output <file>` | write the report to a file |
| `--browser` | render the page with headless Chromium (captures runtime-injected scripts) |
| `--no-debun` | disable the Debun POG engine |
| `--no-plus` | disable npm registry corpus matching |
| `--no-source-maps` | don't fetch/parse source maps |
| `--no-root-manifest` | don't try `<origin>/package.json` |
| `--max-scripts <n>` | cap external scripts downloaded (default 60) |
| `--max-source-maps <n>` | cap source maps parsed (default 12) |
| `--concurrency <n>` | parallel downloads (default 6) |
| `--timeout <ms>` | per-request timeout (default 20000) |
| `--min-confidence <level>` | `high` \| `medium` \| `low` \| `0..1` |
| `--save-scripts <dir>` | save analyzed script bodies to a directory |
| `--no-color` | disable ANSI colors |
| `-v, --verbose` | verbose progress on stderr |

---

## debun-plus detection phases

The registry-backed detector runs on production JavaScript bundles; it does not
need source maps or build metadata files.

1. **Normalize and slice:** Oxc parses each bundle (Babel Parser is the fallback).
   Terser normalizes syntax while preserving license banners. Webpack module
   factories and common esbuild/Rollup helpers are separated from runtime
   scaffolding; the detector fingerprints the full bundle plus coarse and fine
   module slices.
2. **Generate candidates:** a SQLite inverted index searches bundle string
   literals, AST property accesses, and CSS classes. License banners, embedded
   version strings, runtime globals, meta-framework reads, script URLs, and
   debun-cli matches contribute additional candidates.
3. **Discriminate versions:** the registry client fetches npm packuments and
   package tarballs with one shared concurrency cap. Fingerprints are cached in
   SQLite. Each version is scored as `0.45 × AST + 0.30 × 4-gram + 0.25 ×
   identifier`. A match is exact only at score `≥ 0.25` and margin `≥ 0.08`;
   otherwise a supported candidate is reported as a range or possible match.
   Registry metadata is conditionally revalidated, while tarballs are cached as
   gzip-compressed SQLite blobs keyed by npm integrity or shasum and verified
   before extraction. Registry requests share an eight-request maximum.
4. **Propagate dependency constraints:** registry dependency trees are traversed
   to a bounded depth. Constraints from all discovered paths are intersected;
   transitive candidates are checked against the bundle fingerprints before
   being reported as exact.
5. **Report tiers and evidence:** results are marked `exact`, `range`, or
   `possible`, with the signal details and comparison scores that support them.

The number of candidate packages, package versions, target bundle slices, and
parallel registry requests are capped to keep large pages from overwhelming the
scanner. The SQLite corpus cache is stored in `storage/debun-plus.sqlite`.

---

## How it works

```
      URL
       │
       ▼
 ┌───────────────┐    HTTP GET (axios)  ──── or ────  headless Chromium (--browser)
 │ 1. Retrieve   │    follows redirects, records content-type & final URL
 └───────┬───────┘
         ▼
 ┌───────────────┐    <script src>, inline <script>, modulepreload / preload,
 │ 2. Extract    │    data-URL handling, plus <meta> + asset discovery (cheerio)
 └───────┬───────┘
         ▼
 ┌───────────────┐    bounded-concurrency download of every JS resource
 │ 3. Download   │
 └───────┬───────┘
         ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ 4. Independent inference                                                   │
 │   • Debun POG engine      fingerprintCollector → evaluate (debun-cli)      │
 │   • URL / registry hints  unpkg, jsdelivr, esm.sh, skypack, cdnjs, jspm…   │
 │   • banners + globals     /*! Name v1.2.3 */, X.version = "…", @license    │
 │   • source maps           sources[], sourcesContent[], node_modules paths  │
 │   • manifests             <origin>/package.json + embedded package.json    │
 │   • debun-plus             normalized AST slices vs npm registry versions  │
 └───────┬───────────────────────────────────────────────────────────────────┘
         ▼
 ┌───────────────┐    canonical names, per-family version voting, cross-family
 │ 5. Merge      │    corroboration → confidence tiers + alternatives
 └───────┬───────┘
         ▼
 ┌───────────────┐    text table or JSON, plus declared dependencies
 │ 6. Report     │
 └───────────────┘
```

### How Debun is used

`debun-cli` is a black-box npm module that detects bundled libraries using
Property-Order Graphs. Its CLI only prints an ANSI box, so `page-deps` calls the
engine's primitives directly (`src/inference/debun.js`):

```js
const fingerprint = require('debun-cli/dist/fingerprint-collector/index.js').default;
const { evaluate } = require('debun-cli/dist/lib-scorer.js');

const hashes = groupByNodeCount(fingerprint(jsSource));   // { nodes: [hash, …] }
const scores = evaluate(hashes, { SCORE_THRESHOLD: 0.2, MIN_FUNCTION_COUNT: 5 });
// → [{ libName, type3Versions, type2Versions, topVersions }, …]
```

`type3Versions` maps to `debun-exact`, `type2Versions` to `debun-range` and
`topVersions` to `debun-likely`. This is the exact code path the `debun detect`
command runs — we just consume structured results instead of scraping stdout.

---

## Confidence

Confidence combines the strongest single signal with a bonus for corroboration
across *distinct* signal families (same-family signals don't double-count):

| Tier | Score | Meaning |
| --- | --- | --- |
| `high` | ≥ 0.85 | multiple independent families agree (e.g. URL + banner + fingerprint) |
| `medium` | ≥ 0.60 | a strong single signal, or a manifest declaration + a weak signal |
| `low` | < 0.60 | one weak signal only — treat as a lead, not a fact |

`--min-confidence high` is a good default when you only care about trustworthy
results.

---

## JSON output

```jsonc
{
  "url": "https://code.jquery.com/jquery-3.6.0.min.js",
  "finalUrl": "https://code.jquery.com/jquery-3.6.0.min.js",
  "crawler": "http",
  "page": { "status": 200, "contentType": "application/javascript", "bytes": 89501 },
  "project": { "name": "my-app", "version": "2.3.4", "source": "https://my-app.tld/package.json" },
  "stats": { "externalScripts": 1, "inlineScripts": 0, "sourceMapsParsed": 0, "debunLibraries": 2 },
  "packages": [
    {
      "name": "jquery",
      "version": "3.6.0",
      "versionIsExact": true,
      "confidence": 0.97,
      "tier": "high",
      "signals": ["banner", "debun-range", "url"],
      "alternatives": ["3.6.1", "3.6.4"],
      "versionCandidates": [
        { "version": "3.6.0", "weight": 2.17, "votes": 4, "exact": true }
      ],
      "evidence": [
        { "signal": "banner", "detail": "banner: /*! jQuery v3.6.0 … */", "version": "3.6.0" }
      ]
    }
  ],
  "declaredDependencies": { "react": "^18.3.1" }
}
```

---

## Programmatic API

```js
const { analyze, analyzeSite, mergeEvidence } = require('page-deps');

const result = await analyze('https://example.com', {
  browser: false,
  useDebun: true,
  includeSourceMaps: true,
  timeout: 20000,
});

// Render and scan linked pages on the same origin, then merge package evidence.
const siteResult = await analyzeSite('https://example.com', {
  maxPages: 25,
  maxDepth: 1,
  requestDelayMs: 500,
});

for (const pkg of result.packages.filter((p) => p.tier === 'high')) {
  console.log(`${pkg.name}@${pkg.version}`);
}
```

`mergeEvidence(evidenceList)` is exported separately if you want to feed your
own signals into the same scoring/merge model.

---

## Project layout

```
bin/page-deps.js              CLI entry point
bin/debun-plus.js             Phase 0 fragment CLI entry point
src/
  net.js                      IPv4 preference bootstrap (see Notes)
  fetch.js                    HTTP client, pooling, redirects
  extract.js                  HTML/script analysis, sourceMappingURL
  browser.js                  optional single-page Puppeteer renderer
  mdream-crawler.js           rendered site crawler using @mdream/crawl
  analyze.js                  pipeline orchestration
  report.js                   text + JSON renderers
  index.js                    programmatic API
  inference/
    debun.js                  Debun POG engine bridge
    url-hint.js               CDN / registry URL parsing
    banner.js                 license-banner & code signatures
    global-version.js         X.version = "…" assignments
    sourcemap.js              source-map package extraction
    embedded-manifest.js      embedded package.json + dependency lists
    naming.js                 name → npm package canonicalization
    merge.js                  evidence merge, scoring, confidence
test/
  heuristics.test.js          unit tests for each inference layer
  analyze.test.js             end-to-end against a local fixture site
  fixtures/site/              deterministic fixture page
  helpers/server.js           tiny static file server
```

---

## Testing

```bash
npm test
```

The suite is fully offline: it spins up a local static server and analyzes a
fixture page containing a real (vendored) Preact build, a banner-tagged Lodash,
an inline `package.json` and a source map, along with phase-specific fixtures.

### Evaluation harness

`debun-plus eval` reads one bundle per ground-truth entry and reports name-level
and version-level precision/recall overall, by verdict tier, and by bundler.
The fixture builder creates ten sample apps with exact dependency versions,
bundles them, writes `truth.json`, and seeds a small local fingerprint cache.

```bash
npm run eval:fixtures
node bin/debun-plus.js eval --bundles test/evaluation/bundles \
  --ground-truth test/evaluation/truth.json --offline \
  --database test/evaluation/cache.sqlite --output EVAL-REPORT.md
```

`EVAL-REPORT.md` records the generated baseline. If Webpack is installed, the
builder uses its compiler. Otherwise it writes a Webpack JSONP-style fixture
wrapper around esbuild output and records that limitation in `truth.json` and
the report; those fallback samples exercise Webpack scaffolding recognition,
not Webpack's compiler output.

---

## Notes & limitations

* **Fingerprint coverage.** Debun's database covers ~70 libraries. Anything
  outside it is only found via URL/banner/global/source-map/manifest evidence;
  a fully minified bundle of an unknown library may be invisible. Extend the
  database with `npx debun add <pkg>`.
* **Newer-than-database versions.** When a library is newer than the database,
  the POG engine may return the closest known version. Cross-family
  corroboration and the `(alt …)` list make this visible rather than hidden.
* **Source maps are often stripped** in production, so the `sourcemap` family
  frequently contributes nothing. That's expected.
* **SPAs.** Static HTML misses scripts injected at runtime; use `--browser`.
* **IPv4-first.** `src/net.js` prefers IPv4 and disables happy-eyeballs
  auto-selection. Some networks advertise IPv6 records without a working IPv6
  route, which makes Node HTTP clients hang; this makes them deterministic. It
  is harmless on networks with working IPv6.
* Only analysis of publicly reachable resources you are allowed to fetch is
  intended. Be mindful of rate limits.

## License

MIT — see [LICENSE](./LICENSE).
