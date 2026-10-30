'use strict';

const path = require('node:path');
const electronVersion = require('electron/package.json').version;

async function main() {
  const { rebuild } = await import('@electron/rebuild');
  console.log(`[debun-plus:desktop-build] rebuilding better-sqlite3 for Electron ${electronVersion}`);
  await rebuild({
    buildPath: path.resolve(__dirname, '..'),
    electronVersion,
    onlyModules: ['better-sqlite3'],
    force: true,
  });
  console.log('[debun-plus:desktop-build] Electron native rebuild finished');
}

main().catch((error) => {
  console.error('[debun-plus:desktop-build] Electron native rebuild failed', error);
  process.exitCode = 1;
});
