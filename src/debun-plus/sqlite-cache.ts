declare const require: (name: string) => any;
declare const process: { cwd(): string };

import {
  CorpusCache,
  CachedVersionCorpus,
  FingerprintVector,
  LiteralIndexBuildStats,
  LiteralIndexFragment,
  LiteralIndexMatch,
  RegistryResourceCacheEntry,
} from './types';
import { indexableFeatures } from './features';

const EMPTY_VECTOR: FingerprintVector = {
  ngrams: [], astHashes: [], identifiers: [], stringLiterals: [], properties: [],
  cssClasses: [], runtimeGlobals: [], metaFrameworkReads: [],
};
const FINGERPRINT_REVISION = 2;

export class SqliteCorpusCache implements CorpusCache {
  private db: any;

  constructor(filename = `${process.cwd()}/storage/debun-plus.sqlite`) {
    const fs = require('node:fs');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS corpus_versions (
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (name, version)
      );
      CREATE TABLE IF NOT EXISTS feature_index (
        feature TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (feature, name, version)
      );
      CREATE TABLE IF NOT EXISTS registry_packuments (
        name TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registry_resources (
        cache_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        resource_url TEXT NOT NULL,
        body_gzip BLOB NOT NULL,
        etag TEXT,
        last_modified TEXT,
        content_type TEXT,
        integrity TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS literal_index_meta (
        tier TEXT PRIMARY KEY,
        packages_indexed INTEGER NOT NULL,
        versions_indexed INTEGER NOT NULL,
        literals_indexed INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS literal_index_frequency (
        tier TEXT NOT NULL,
        literal TEXT NOT NULL,
        package_frequency INTEGER NOT NULL,
        idf REAL NOT NULL,
        PRIMARY KEY (tier, literal)
      );
      CREATE TABLE IF NOT EXISTS literal_index_postings (
        tier TEXT NOT NULL,
        literal TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        idf REAL NOT NULL,
        PRIMARY KEY (tier, literal, name, version)
      );
      CREATE INDEX IF NOT EXISTS literal_index_lookup ON literal_index_postings(tier, literal);
      CREATE TABLE IF NOT EXISTS literal_index_document_staging (
        build_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (build_id, name, version)
      );
      CREATE TABLE IF NOT EXISTS literal_index_staging (
        build_id TEXT NOT NULL,
        literal TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (build_id, literal, name, version)
      );
      CREATE INDEX IF NOT EXISTS feature_index_name ON feature_index(name, version);
    `);
  }

  getVersion(name: string, version: string): CachedVersionCorpus | null {
    const row = this.db.prepare('SELECT payload FROM corpus_versions WHERE name = ? AND version = ?').get(name, version);
    if (!row) return null;
    try {
      const value = JSON.parse(row.payload) as CachedVersionCorpus;
      return value.fingerprintRevision === FINGERPRINT_REVISION ? value : null;
    } catch (_) { return null; }
  }

  putVersion(value: CachedVersionCorpus): void {
    const stored = { ...value, fingerprintRevision: FINGERPRINT_REVISION };
    const transaction = this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO corpus_versions(name, version, payload) VALUES (?, ?, ?)')
        .run(stored.name, stored.version, JSON.stringify(stored));
      this.db.prepare('DELETE FROM feature_index WHERE name = ? AND version = ?').run(value.name, value.version);
      const insert = this.db.prepare('INSERT OR IGNORE INTO feature_index(feature, name, version) VALUES (?, ?, ?)');
      const features = [...new Set(indexableFeatures(stored.vector))].slice(0, 5000);
      for (const feature of features) insert.run(feature, stored.name, stored.version);
    });
    transaction();
  }

  getPackument(name: string): any | null {
    const row = this.db.prepare('SELECT payload, updated_at FROM registry_packuments WHERE name = ?').get(name);
    if (!row || Date.now() - row.updated_at > 24 * 60 * 60 * 1000) return null;
    try { return JSON.parse(row.payload); } catch (_) { return null; }
  }

  putPackument(name: string, value: any): void {
    this.db.prepare('INSERT OR REPLACE INTO registry_packuments(name, payload, updated_at) VALUES (?, ?, ?)')
      .run(name, JSON.stringify(value), Date.now());
  }

  getRegistryResource(key: string): RegistryResourceCacheEntry | null {
    const row = this.db.prepare(`
      SELECT cache_key, kind, resource_url, body_gzip, etag, last_modified, content_type, integrity, updated_at
      FROM registry_resources WHERE cache_key = ?
    `).get(key);
    if (!row) return null;
    return {
      key: row.cache_key,
      kind: row.kind,
      url: row.resource_url,
      bodyGzip: require('node:buffer').Buffer.from(row.body_gzip),
      etag: row.etag || undefined,
      lastModified: row.last_modified || undefined,
      contentType: row.content_type || undefined,
      integrity: row.integrity || undefined,
      updatedAt: row.updated_at,
    };
  }

  putRegistryResource(value: RegistryResourceCacheEntry): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO registry_resources
        (cache_key, kind, resource_url, body_gzip, etag, last_modified, content_type, integrity, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.key,
      value.kind,
      value.url,
      require('node:buffer').Buffer.from(value.bodyGzip),
      value.etag || null,
      value.lastModified || null,
      value.contentType || null,
      value.integrity || null,
      value.updatedAt,
    );
  }

  beginLiteralIndexBuild(buildId: string, _tier: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM literal_index_staging WHERE build_id = ?').run(buildId);
      this.db.prepare('DELETE FROM literal_index_document_staging WHERE build_id = ?').run(buildId);
    });
    transaction();
  }

  addLiteralIndexDocument(buildId: string, name: string, version: string, literals: string[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO literal_index_document_staging(build_id, name, version) VALUES (?, ?, ?)')
        .run(buildId, name, version);
      const insert = this.db.prepare('INSERT OR IGNORE INTO literal_index_staging(build_id, literal, name, version) VALUES (?, ?, ?, ?)');
      for (const literal of new Set(literals)) {
        if (literal) insert.run(buildId, literal, name, version);
      }
    });
    transaction();
  }

  publishLiteralIndex(buildId: string, tier: string): LiteralIndexBuildStats {
    const packagesIndexed = Number(this.db.prepare('SELECT COUNT(DISTINCT name) AS count FROM literal_index_document_staging WHERE build_id = ?').get(buildId)?.count || 0);
    const versionsIndexed = Number(this.db.prepare('SELECT COUNT(*) AS count FROM literal_index_document_staging WHERE build_id = ?').get(buildId)?.count || 0);
    const indexedAt = new Date().toISOString();
    let literalsIndexed = 0;
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM literal_index_postings WHERE tier = ?').run(tier);
      this.db.prepare('DELETE FROM literal_index_frequency WHERE tier = ?').run(tier);
      this.db.prepare('DELETE FROM literal_index_meta WHERE tier = ?').run(tier);
      if (packagesIndexed > 0) {
        const rows = this.db.prepare(`
          SELECT literal, COUNT(DISTINCT name) AS frequency
          FROM literal_index_staging WHERE build_id = ? GROUP BY literal
        `).all(buildId);
        const insertFrequency = this.db.prepare(`
          INSERT INTO literal_index_frequency(tier, literal, package_frequency, idf) VALUES (?, ?, ?, ?)
        `);
        const insertPosting = this.db.prepare(`
          INSERT INTO literal_index_postings(tier, literal, name, version, idf)
          SELECT ?, literal, name, version, ? FROM literal_index_staging WHERE build_id = ? AND literal = ?
        `);
        for (const row of rows) {
          const frequency = Number(row.frequency);
          if (frequency / packagesIndexed > 0.05) continue;
          const idf = Math.log((packagesIndexed + 1) / (frequency + 1)) + 1;
          insertFrequency.run(tier, row.literal, frequency, idf);
          insertPosting.run(tier, idf, buildId, row.literal);
          literalsIndexed++;
        }
      }
      this.db.prepare(`
        INSERT INTO literal_index_meta(tier, packages_indexed, versions_indexed, literals_indexed, indexed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(tier, packagesIndexed, versionsIndexed, literalsIndexed, indexedAt);
      this.db.prepare('DELETE FROM literal_index_staging WHERE build_id = ?').run(buildId);
      this.db.prepare('DELETE FROM literal_index_document_staging WHERE build_id = ?').run(buildId);
    });
    transaction();
    return { tier, packagesIndexed, versionsIndexed, literalsIndexed, indexedAt };
  }

  abortLiteralIndexBuild(buildId: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM literal_index_staging WHERE build_id = ?').run(buildId);
      this.db.prepare('DELETE FROM literal_index_document_staging WHERE build_id = ?').run(buildId);
    });
    transaction();
  }

  matchLiteralIndex(tier: string, fragments: LiteralIndexFragment[]): LiteralIndexMatch[] {
    const results: LiteralIndexMatch[] = [];
    for (const fragment of fragments) {
      const literals = [...new Set(fragment.stringLiterals)].filter(Boolean);
      const byPackage = new Map<string, LiteralIndexMatch>();
      for (let start = 0; start < literals.length; start += 400) {
        const batch = literals.slice(start, start + 400);
        if (!batch.length) continue;
        const statement = this.db.prepare(`
          SELECT literal, name, version, idf
          FROM literal_index_postings
          WHERE tier = ? AND literal IN (${batch.map(() => '?').join(',')})
        `);
        const rows = statement.all(tier, ...batch);
        for (const row of rows) {
          const key = `${row.name}\0${row.version}`;
          let item = byPackage.get(key);
          if (!item) {
            item = { sourceFile: fragment.sourceFile, name: row.name, version: row.version, score: 0, matchedLiteralCount: 0, matchedLiterals: [], strong: false };
            byPackage.set(key, item);
          }
          item.score += Number(row.idf);
          item.matchedLiteralCount++;
          item.matchedLiterals.push(row.literal);
        }
      }
      for (const item of byPackage.values()) {
        item.strong = item.matchedLiteralCount >= 2 && item.score >= 2.5;
        item.score = Number(item.score.toFixed(4));
        item.matchedLiterals.sort();
        results.push(item);
      }
    }
    return results.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || b.score - a.score || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  }

  getLiteralIndexInfo(tier: string): LiteralIndexBuildStats | null {
    const row = this.db.prepare('SELECT tier, packages_indexed, versions_indexed, literals_indexed, indexed_at FROM literal_index_meta WHERE tier = ?').get(tier);
    if (!row) return null;
    return {
      tier: row.tier,
      packagesIndexed: Number(row.packages_indexed),
      versionsIndexed: Number(row.versions_indexed),
      literalsIndexed: Number(row.literals_indexed),
      indexedAt: row.indexed_at,
    };
  }

  findCandidateNames(features: string[], limit: number): Array<{ name: string; matches: number }> {
    const unique = [...new Set(features)].slice(0, 4000);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT name, COUNT(DISTINCT feature) AS matches FROM feature_index WHERE feature IN (${placeholders}) GROUP BY name ORDER BY matches DESC, name ASC LIMIT ?`,
    ).all(...unique, limit);
  }

  close(): void { this.db.close(); }
}

export function createSqliteCache(filename?: string): CorpusCache {
  return new SqliteCorpusCache(filename);
}
