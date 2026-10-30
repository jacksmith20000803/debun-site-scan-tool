# Turbopack Resilience Audit — Findings

**Audit date:** 2026-10-19  
**Scope:** `deban-package` source, tests, fixtures, and a temporary pair of generated Next.js applications. No production code was changed during this audit.

## Executive finding

The current scanner recognizes the latest stable and canary bundles as Next.js + Turbopack, but the version matcher does not reliably identify packages inside those bundles. The root cause is module-boundary loss: normalization expects Webpack-like object tables or a short list of named wrapper calls, while current Turbopack emits factory functions through a global array registration protocol. It falls back to generic function fragments, allowing runtime and framework code to influence package/version scoring.

On the stable fixture, the known `lodash@4.18.1` dependency was reported as **`lodash@4.16.4` exact**; the known `react@19.2.0` dependency was reported as **`react@^16.6.3` range**. The canary fixture produced the same wrong Lodash and React verdicts. Next.js itself remained a `possible` candidate with an unknown version. This confirms that the issue reaches version discrimination, not just bundler labeling.

## 1. Turbopack-specific coupling inventory

Active project references:

| File and lines | Current coupling | Audit finding |
| --- | --- | --- |
| [`src/browser.js:130-131`](src/browser.js#L130) | Reads `window.__turbopack_load__` and `window.TURBOPACK`. | `__turbopack_load__` is absent from both current generated builds. The `TURBOPACK` fallback happened to recognize both versions. |
| [`src/browser.js:174-175`](src/browser.js#L174) | Checks the runtime flag, `turbopack` in asset URLs, `__turbopack_load__`, and literal `TURBOPACK`. | Label detection succeeds for the sample because current emitted code contains `globalThis.TURBOPACK`; reliance on a particular global spelling remains brittle. |
| [`src/browser.js:177`](src/browser.js#L177) | Webpack is recognized through `webpackChunk_N_E`, `webpackJsonp`, `__webpack_require__`, or `webpackBootstrap`. | Current Turbopack emitted a `__webpack_hash__` property in one chunk. The current classifier did not mistake that alone for Webpack, but other broad `__webpack_*` handling does treat it as a runtime identifier. |
| [`src/mdream-crawler.js:305`](src/mdream-crawler.js#L305) | Static HTML marker regex recognizes `__turbopack_load__` or `TURBOPACK`. | It has the same exact-token dependency; it does not model registration behavior or evidence strength. |
| [`src/debun-plus/phase0.ts:18`](src/debun-plus/phase0.ts#L18) | Runtime-name exclusion list is explicitly enumerated for Webpack, esbuild/Vite, and Parcel, with no Turbopack family. | The generic `__webpack_*` prefix also classified and removed `__webpack_hash__` from both Turbopack fixture summaries. This is a false bundler attribution in Phase 0 metadata. |
| [`src/debun-plus/phase0.ts:128-129`](src/debun-plus/phase0.ts#L128) | Module-registration detection only recognizes `webpackChunk*`/`webpackJsonp` `.push(...)` forms. | It cannot recognize the current Turbopack registration envelope. |
| [`src/debun-plus/normalize.ts:7-10`](src/debun-plus/normalize.ts#L7) | Wrapper and helper lists contain named Webpack/esbuild/Vite/Parcel helpers, but no Turbopack knowledge. | Exact-name expansion would repeat the brittle pattern described in the task. |
| [`src/debun-plus/normalize.ts:54-103`](src/debun-plus/normalize.ts#L54) | `sliceModules` searches numeric-keyed object factories and recognized wrapper calls; if neither exists, it falls back to independent function bodies. | This is the confirmed module-boundary breakage point. |
| [`src/debun-plus/normalize.ts:111-138`](src/debun-plus/normalize.ts#L111) | `stripBundlerScaffolding` unwraps IIFEs or removes known named declarations. | It does not interpret Turbopack's registration array or distinguish runtime factory functions from package factories. |
| [`src/debun-plus/normalize.ts:157`](src/debun-plus/normalize.ts#L157) | No module factories means normalization falls back to stripping the original full source. | Runtime and Next.js framework code remain mixed into the coarse fingerprint target. |

No Turbopack identifier or fixture exists under the active `test/` tree. `test/evaluation/bundles` contains 10 fixtures split across Webpack, esbuild, Rollup, and Vite only; `EVAL-REPORT.md` reports no Turbopack measurements. The purported frozen Turbopack fixture is therefore absent from this project tree, so there was no historical fixture to diff.

There is also an older sibling copy at `../New folder/src/browser.js:89-90,273,376-388` that repeats exact `__turbopack_load__`/`TURBOPACK` assumptions. It is outside the active `deban-package` application and its package tree; it should not be mistaken for active runtime code.

## 2. Current stable/canary fixture comparison

Current npm tags were queried on the audit date: [`next@latest`](https://registry.npmjs.org/next/latest) resolved to **16.4.2** and [`next@canary`](https://registry.npmjs.org/next/canary) to **16.5.0-canary.17**. Both temporary apps used `next build --turbopack`, imported Lodash 4.18.1 and React 19.2.0, and built successfully. The generated minimal apps and client chunks are preserved under [`test/fixtures/turbopack`](test/fixtures/turbopack/README.md); app dependencies were not added to the main manifest. No historical frozen Turbopack fixture existed before this audit.

| Observation | Next.js 16.4.2 stable | Next.js 16.5.0-canary.17 |
| --- | --- | --- |
| Client JS chunks | 7, 638,959 bytes total | 7, 637,509 bytes total |
| Global registration token | `globalThis.TURBOPACK` | `globalThis.TURBOPACK` |
| `__turbopack_load__` | Not present | Not present |
| `__turbopack_context__` / `__turbopack_require__` | Not present | Not present |
| Module registration shape | `globalThis.TURBOPACK.push([currentScript, chunkId, factory, ...])`; factories use minified runtime calls such as `n.i(moduleId)` and `n.s(...)`. | Same broad array/push and factory protocol. Runtime implementation details and minified helper names differ. |
| Runtime cache detail | The inspected runtime starts with a `WeakMap` module cache. | The inspected runtime adds a `Map`, checks cached module errors, and rethrows them. |
| Chunk names | Hash-like names plus `turbopack-<hash>.js` runtime chunk. | Hash-like names plus a different `turbopack-<hash>.js` runtime chunk. Six of seven corresponding chunk filenames changed; one chunk retained the same name. |
| AST normalization | All 7 chunks parsed, but 0 coarse module factories were identified. Generic function slicing produced 796 module/function slices in `debun-plus`. | All 7 chunks parsed, but 0 coarse module factories were identified. Generic function slicing produced 794 slices. |

Module boundaries shifted in implementation details, but the broad chunk-registration shape stayed array-based. The stable and canary runtime helper identifiers and chunk hashes changed. The full function-fragment counts changed by two, showing that current function slicing is sensitive to those internal changes even though both builds parse.

## 3. Reproduced breakage by pipeline stage

1. **Technology classification:** Passed on both builds: browser-side classification returned `next.js` + `turbopack`. This relied on the broad `TURBOPACK` marker, not `__turbopack_load__`.
2. **Source collection and parsing:** Passed on the generated local chunks: 7 of 7 parsed, zero Phase 0 parse failures.
3. **Scaffolding removal and boundaries:** Failed to identify a module table on every chunk. The normalizer returned no coarse module slices and used generic function fragments instead. The Phase 0 identifier collector also recorded `__webpack_hash__` as a removed runtime identifier despite the build being Turbopack.
4. **Package candidate generation:** Found the three expected package leads (`next`, `react`, and `lodash`) in the registry-backed stable run. So the fixture did not fail solely because a package name was never proposed.
5. **Version discrimination:** Failed materially. Stable output reported `lodash@4.16.4` exact although the generated app installed `lodash@4.18.1`, and React as `^16.6.3` although the fixture installed React 19.2.0. Canary output repeated both wrong results. The tested scanner cache had registry data available; this was not the earlier no-network/no-metadata failure mode.
6. **Evaluation coverage:** The existing bundler-split harness has no Turbopack fixture, so its 100% numbers do not cover this failure mode.

The current stable CLI docs identify Turbopack as Next.js 16's default bundler and document `--webpack` as the opt-out, consistent with the generated fixture command: [Next.js CLI reference](https://nextjs.org/docs/app/api-reference/cli/next), [Turbopack version changes](https://nextjs.org/docs/app/api-reference/turbopack).

## 4. Proposed targeted fixes for Step 2

| Breakage point | Fix that applies |
| --- | --- |
| Hardcoded runtime token assumptions in browser/HTML detection | Use a renewable, versioned signature data file for candidate Turbopack evidence, with multiple independent signatures and provenance. Keep generic structural evidence (registration behavior and chunk naming) as the durable baseline; do not make one exact helper name a requirement. |
| `__webpack_hash__` misclassified by the Phase 0 exclusion regex | Separate bundler-family signatures from generic runtime-name exclusions. Exclude a runtime identifier only when its enclosing structure is positively recognized as that bundler's scaffold; retain ambiguous names as package evidence. |
| Zero Turbopack coarse module slices and lossy fallback | Extend Phase 0's AST-based structural slicer to recognize array `.push(...)` chunk registration and associate module IDs with adjacent factory functions. Keep the slicer based on AST/call/argument structure, while loading optional volatile tokens from the renewable data file. Preserve module factories as coarse units and inner functions as fine units. |
| Wrong exact package versions when runtime and package code are mixed | Score package-associated module fragments independently; exclude recognized runtime/bootstrap fragments from package version targets; aggregate only coherent package fragment evidence across chunks. Add a regression assertion that exact never selects a version other than the known fixture version. |
| No Turbopack evaluation coverage | Add stable and canary fixtures with provenance/version metadata to the bundler-split harness. Assert framework/bundler classification, module-boundary coverage, package name/version results, and stable/canary compatibility; report Turbopack metrics separately. |

## Limitations

The historical frozen Turbopack fixture mentioned in the task was not present in the active project, so the direct old-fixture diff is unavailable. The report instead compares two fresh production builds from the current stable and canary npm tags. The generated app is a compact controlled fixture; production applications with a wider module graph should be added to evaluation coverage after the proposed changes.

## 5. Step 2 implementation status

The structural slicer now recognizes repeated callable entries in object records and registration arrays. It does not require a known runtime name; the added generic registration test contains no bundler signature and still produces module fragments. When there is no recognized registry, ESM top-level declaration blocks and functions remain available for generic fingerprinting, and the result is labeled `unrecognized(<hints>)` with confidence and evidence rather than silently looking like a recognized empty scan.

Current verification generated stable Next.js 16.4.2 and canary 16.5.0-canary.17 chunks again. The pipeline structurally recognized 20 of the 24 JavaScript files in the refreshed Turbopack and four-bundler evaluation fixture set; the other four were explicitly labeled `unrecognized(unknown)` and still passed through generic slicing. Dynamic chunk lookup tables are tested with a fixture where a loader call references a JS-path map. Package scoring consumes package-level fragments and does not retain module IDs or module-name labels.

Bundler signatures and observed versions now live in [`patterns/bundlers.json`](patterns/bundlers.json). `npm run refresh-fixtures` builds fresh stable and canary apps, refreshes the other bundler evaluation fixtures, runs the analysis pipeline, and writes [`PATTERNS-DIFF.md`](PATTERNS-DIFF.md). A weekly GitHub Actions workflow reruns it and fails if fixture or signature data changes, making drift visible for review. Pattern hints are evidence only; the generic structural path works without them.

Validation at implementation time: the refresh command completed on Windows; `npm run build` and the full test suite passed (48 Vitest tests and 42 Node tests). The Windows EXE and NSIS installer were rebuilt with the updated pattern file included in `app.asar`. The refresh pipeline used an offline registry stub for package scoring so fixture generation does not depend on registry access. Turbopack version accuracy is not claimed from this structural regression check alone; the existing registry-backed evaluation remains responsible for package/version scoring quality.
