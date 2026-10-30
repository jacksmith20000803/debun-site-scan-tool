#!/usr/bin/env node
'use strict';

if (process.env.DEBUN_LIVE_REGISTRY !== '1') {
  process.stderr.write('Live registry access is disabled. Set DEBUN_LIVE_REGISTRY=1 to run this smoke check.\n');
  process.exitCode = 2;
} else {
  const { createRegistryClient, registryMetadataCacheKey, registryTarballCacheKey } = require('../dist/src/debun-plus/registry');
  const { createSqliteCache } = require('../dist/src/debun-plus/sqlite-cache');

  const cache = createSqliteCache();
  const client = createRegistryClient({ cache, concurrency: 1, retries: 2 });
  (async () => {
    try {
      const metadata = await client.getPackageMeta('lodash');
      const version = metadata?.versions?.['4.17.21'];
      if (!version) throw new Error('lodash@4.17.21 was not present in the registry response.');
      const downloaded = await client.downloadTarball('lodash', '4.17.21');
      const metadataCached = Boolean(cache.getRegistryResource(registryMetadataCacheKey('lodash')));
      const tarballCached = Boolean(cache.getRegistryResource(registryTarballCacheKey(
        version.dist?.integrity,
        version.dist?.shasum,
        version.dist?.tarball || '',
      )));
      if (!metadataCached || !tarballCached) throw new Error('The metadata or tarball was not persisted in the SQLite registry cache.');
      console.log(`Resolved lodash@${version.version}; ${Object.keys(metadata.versions || {}).length} versions in metadata.`);
      console.log(`Extracted ${downloaded.files.length} files to ${downloaded.packageRoot}.`);
      console.log(`Cached metadata and tarball in storage/debun-plus.sqlite (${downloaded.cacheKey}).`);
    } catch (error) {
      console.error(`Registry smoke check failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      client.close();
      cache.close();
    }
  })();
}
