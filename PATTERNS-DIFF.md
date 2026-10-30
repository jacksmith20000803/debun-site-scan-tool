# Renewable Bundler Pattern Refresh

Generated: 2026-10-19T04:25:11.363Z

## Version changes

| Bundler | Previous pattern version | Refreshed version |
| --- | --- | --- |
| webpack | 5.x | 5.112.0 |
| esbuild | 0.25.x | 0.28.2 |
| rollup | 4.x | 4.64.10 |
| vite | 6.x | 8.3.4 |
| turbopack | 16.4.2+16.5.0-canary.17 | Next.js 16.4.2 stable; 16.5.0-canary.17 canary |
| parcel | 2.x | 2.16.4 |

## Fresh fixture builds

- Stable: Next.js 16.4.2, 7 chunks.
- Canary: Next.js 16.5.0-canary.17, 7 chunks.
- Other bundler fixtures: regenerated from current npm registry versions for webpack, esbuild, rollup, vite, @parcel/core.

## Pipeline run

- JavaScript files passed through analysis: 24.
- recognized(module-registry): 20 file(s).
- unrecognized(unknown): 4 file(s).
- Package scoring uses package-level fragments; module identifiers are not retained as package identities.

Raw pipeline summary: `test/fixtures/turbopack/pipeline-results.json` (regenerate with this command).
