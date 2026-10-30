# debun-plus evaluation

Generated: 2026-10-18T12:01:09.688Z
Fixtures: 10
Bundles: `E:\New folder (2)\deban\deban-package\test\evaluation\bundles`
Ground truth: `E:\New folder (2)\deban\deban-package\test\evaluation\truth.json`

Precision and recall are computed per fixture/package pair. For version scoring, an exact verdict must equal the truth version; a range verdict is correct when it includes the truth version; a possible verdict must equal it exactly.
Tier-specific recall measures the share of all ground-truth package/version pairs recovered at that tier.
Builder note: Webpack fixture files use a deterministic Webpack JSONP wrapper around esbuild output because Webpack is not installed; the builder uses actual Webpack automatically when available.

| Scope | Measure | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| overall | name | 12 | 0 | 0 | 100.0% | 100.0% |
| overall | version | 12 | 0 | 0 | 100.0% | 100.0% |

## By tier

| Tier | Measure | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| exact | name | 12 | 0 | 0 | 100.0% | 100.0% |
| exact | version | 12 | 0 | 0 | 100.0% | 100.0% |
| range | name | 0 | 0 | 12 | n/a | 0.0% |
| range | version | 0 | 0 | 12 | n/a | 0.0% |
| possible | name | 0 | 0 | 12 | n/a | 0.0% |
| possible | version | 0 | 0 | 12 | n/a | 0.0% |

## By bundler

| Bundler | Measure | TP | FP | FN | Precision | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| esbuild | name | 4 | 0 | 0 | 100.0% | 100.0% |
| esbuild | version | 4 | 0 | 0 | 100.0% | 100.0% |
| rollup | name | 2 | 0 | 0 | 100.0% | 100.0% |
| rollup | version | 2 | 0 | 0 | 100.0% | 100.0% |
| vite | name | 2 | 0 | 0 | 100.0% | 100.0% |
| vite | version | 2 | 0 | 0 | 100.0% | 100.0% |
| webpack | name | 4 | 0 | 0 | 100.0% | 100.0% |
| webpack | version | 4 | 0 | 0 | 100.0% | 100.0% |

## Fixture details

| Fixture | Bundler / build method | Truth packages | Detected packages |
| --- | --- | --- | --- |
| webpack-01 | webpack (esbuild wrapped in a Webpack JSONP module fixture (Webpack package unavailable)) | lodash@4.18.1 | lodash@4.18.1 (exact) |
| webpack-02 | webpack (esbuild wrapped in a Webpack JSONP module fixture (Webpack package unavailable)) | jquery@3.7.1 | jquery@3.7.1 (exact) |
| webpack-03 | webpack (esbuild wrapped in a Webpack JSONP module fixture (Webpack package unavailable)) | lodash@4.18.1, jquery@3.7.1 | jquery@3.7.1 (exact), lodash@4.18.1 (exact) |
| esbuild-01 | esbuild (esbuild) | lodash@4.18.1 | lodash@4.18.1 (exact) |
| esbuild-02 | esbuild (esbuild) | jquery@3.7.1 | jquery@3.7.1 (exact) |
| esbuild-03 | esbuild (esbuild) | lodash@4.18.1, jquery@3.7.1 | jquery@3.7.1 (exact), lodash@4.18.1 (exact) |
| rollup-01 | rollup (rollup) | lodash@4.18.1 | lodash@4.18.1 (exact) |
| rollup-02 | rollup (rollup) | jquery@3.7.1 | jquery@3.7.1 (exact) |
| vite-01 | vite (vite) | lodash@4.18.1 | lodash@4.18.1 (exact) |
| vite-02 | vite (vite) | jquery@3.7.1 | jquery@3.7.1 (exact) |

## Tuning changelog

| Iteration | Diagnosis and targeted change | Thresholds / filter | Name precision | Name recall | Version precision | Version recall |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Baseline | Eight false positives were AST-property-only possible detections (scores 0.2160–0.2434); no fixture false negatives. | Existing exact/range minimum fused score: 0.25; no separate gate for possible AST-only results. | 60.0% | 100.0% | 60.0% | 100.0% |
| 1 | Suppress a possible verdict only when its evidence is exclusively `ast-property` and its fused score is below the existing minimum. Corroborated candidates remain eligible. | AST-only possible minimum: 0.25. | 100.0% | 100.0% | 100.0% | 100.0% |

The fixture target was met after iteration 1. Residual gap on this fixture set: none measured. Results are limited to the 10 generated fixtures (12 package instances); the Webpack-labelled fixtures use the documented JSONP wrapper around esbuild output because Webpack was unavailable when they were generated.
