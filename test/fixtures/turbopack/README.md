# Generated Turbopack resilience fixtures

Stable and canary production chunks are regenerated from current npm tags by `npm run refresh-fixtures`.
The output apps exercise Lodash and React; exact dependency versions and build provenance are stored in each fixture package.json.

| Channel | Next.js | React | Lodash | Chunks |
| --- | --- | --- | --- | --- |
| stable | 16.4.2 | 19.3.1 | 4.18.1 | 7 |
| canary | 16.5.0-canary.17 | 19.3.1 | 4.18.1 | 7 |

The detector summary is in `pipeline-results.json`; pattern/version changes are tracked in `PATTERNS-DIFF.md`.
