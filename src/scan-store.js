'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_DIRECTORY = path.join(
  process.env.DEBUN_STORAGE_DIR || path.join(__dirname, '..', 'storage'),
  'saved-scans',
);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function scanSummary(result, id, createdAt) {
  const packages = Array.isArray(result.packages) ? result.packages : [];
  const pages = Array.isArray(result.pages) ? result.pages : [];
  return {
    id,
    createdAt,
    url: result.url || result.report?.websiteUrl || result.finalUrl || '',
    finalUrl: result.finalUrl || result.report?.finalUrl || result.url || '',
    framework: result.framework || 'unknown',
    bundler: result.bundler || 'unknown',
    pagesScanned: Number(result.report?.pagesScanned) || pages.filter((page) => page.scanCompleted === true).length,
    pageCount: pages.length,
    dependencyCount: Number(result.report?.totalDependencies) || packages.length,
    scanCompleted: result.scanCompleted === true,
    reportEligible: result.reportEligible === true,
  };
}

function createScanStore(directory = DEFAULT_DIRECTORY) {
  const ensureDirectory = () => fs.mkdirSync(directory, { recursive: true });
  const fileFor = (id) => {
    if (!ID_PATTERN.test(String(id || ''))) return null;
    return path.join(directory, `${id}.json`);
  };
  const summaryFileFor = (id) => {
    if (!ID_PATTERN.test(String(id || ''))) return null;
    return path.join(directory, `${id}.summary.json`);
  };

  function writeAtomic(filename, contents) {
    const temporary = `${filename}.tmp`;
    try {
      fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, filename);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) { /* No temporary file to clean up. */ }
      throw error;
    }
  }

  function read(id) {
    const filename = fileFor(id);
    if (!filename || !fs.existsSync(filename)) return null;
    try {
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function readSummary(id) {
    const filename = summaryFileFor(id);
    if (!filename) return null;
    if (fs.existsSync(filename)) {
      try {
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
      } catch (_) {
        return null;
      }
    }

    // Migrate older full-report records to a compact list entry on first access.
    const record = read(id);
    if (!record) return null;
    const summary = scanSummary(record.scanResult || record, id, record.createdAt);
    try { writeAtomic(filename, `${JSON.stringify(summary)}\n`); } catch (_) { /* The full record remains usable. */ }
    return summary;
  }

  function save(result) {
    ensureDirectory();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const record = {
      ...scanSummary(result || {}, id, createdAt),
      report: result?.report || null,
      reportReason: result?.reportReason || null,
      scanResult: result || {},
    };
    const destination = fileFor(id);
    const summaryDestination = summaryFileFor(id);
    writeAtomic(destination, `${JSON.stringify(record, null, 2)}\n`);
    try {
      writeAtomic(summaryDestination, `${JSON.stringify(scanSummary(result || {}, id, createdAt))}\n`);
    } catch (error) {
      try { fs.unlinkSync(destination); } catch (_) { /* Preserve the original write error. */ }
      throw error;
    }
    return { id, createdAt, fileName: `${id}.json` };
  }

  function list({ page = 1, pageSize = 25, search = '' } = {}) {
    ensureDirectory();
    const normalizedPage = Math.max(1, Math.floor(Number(page) || 1));
    const normalizedPageSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 25)));
    const needle = String(search || '').trim().toLowerCase();
    const records = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.summary.json'))
      .map((entry) => readSummary(entry.name.slice(0, -5)))
      .filter(Boolean)
      .filter((record) => !needle || [record.url, record.finalUrl, record.framework, record.bundler]
        .some((value) => String(value || '').toLowerCase().includes(needle)))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const total = records.length;
    const offset = (normalizedPage - 1) * normalizedPageSize;
    return {
      items: records.slice(offset, offset + normalizedPageSize).map(({ scanResult: _scanResult, report: _report, reportReason: _reason, ...summary }) => summary),
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total,
      pageCount: Math.ceil(total / normalizedPageSize),
    };
  }

  function remove(id) {
    const filename = fileFor(id);
    const summaryFilename = summaryFileFor(id);
    if (!filename || !summaryFilename) return false;
    const exists = fs.existsSync(filename) || fs.existsSync(summaryFilename);
    if (!exists) return false;
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    if (fs.existsSync(summaryFilename)) fs.unlinkSync(summaryFilename);
    return true;
  }

  return { save, list, read, remove };
}

module.exports = { createScanStore, DEFAULT_DIRECTORY };
