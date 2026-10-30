'use strict';

const { randomUUID } = require('node:crypto');

const TERMINAL_STATES = new Set(['complete', 'stopped', 'failed']);

function createScanJobManager(execute, { retentionMs = 60 * 60 * 1000 } = {}) {
  const jobs = new Map();

  function cleanup() {
    const cutoff = Date.now() - retentionMs;
    for (const [id, job] of jobs) {
      if (TERMINAL_STATES.has(job.status) && job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
    }
  }

  function snapshot(job) {
    return {
      id: job.id,
      kind: job.urls.length === 1 ? 'single' : 'batch',
      urls: job.urls,
      scanMode: job.scanMode,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      progress: job.progress,
      siteResults: job.siteResults,
      result: job.result,
      error: job.error || null,
    };
  }

  function start(urls, { scanMode = 'deep' } = {}) {
    cleanup();
    const active = [...jobs.values()].find((job) => !TERMINAL_STATES.has(job.status));
    if (active) {
      const error = new Error('A scan is already running. Stop it before starting another one.');
      error.statusCode = 409;
      error.activeJob = snapshot(active);
      throw error;
    }

    const job = {
      id: randomUUID(),
      urls: [...urls],
      scanMode: scanMode === 'shallow' ? 'shallow' : 'deep',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: { type: 'progress', stageLabel: 'Waiting to start…', pagesScanned: 0, pagesAttempted: 0, totalPages: 1 },
      siteResults: [],
      result: null,
      error: null,
      controller: new AbortController(),
    };
    jobs.set(job.id, job);

    Promise.resolve().then(() => job.status === 'running' ? execute({
      urls: job.urls,
      scanMode: job.scanMode,
      signal: job.controller.signal,
      updateProgress(event) { if (job.status === 'running') job.progress = event; },
      addSiteResult(result) { if (job.status === 'running') job.siteResults.push(result); },
    }) : null).then((result) => {
      if (job.status !== 'running') return;
      job.result = result;
      job.status = 'complete';
      job.finishedAt = new Date().toISOString();
      job.progress = { ...job.progress, type: 'complete', stageLabel: 'Analysis complete' };
    }, (error) => {
      if (job.status !== 'running') return;
      job.error = error?.message || String(error);
      job.status = job.controller.signal.aborted ? 'stopped' : 'failed';
      job.finishedAt = new Date().toISOString();
      job.progress = { ...job.progress, type: 'complete', stageLabel: job.status === 'stopped' ? 'Scan stopped' : 'Scan failed' };
    });

    return snapshot(job);
  }

  function get(id) {
    cleanup();
    const job = jobs.get(id);
    return job ? snapshot(job) : null;
  }

  function stop(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status === 'running') {
      job.status = 'stopped';
      job.finishedAt = new Date().toISOString();
      job.progress = { ...job.progress, type: 'stopped', stageLabel: 'Scan stopped by user' };
      job.controller.abort(new Error('Scan stopped by user.'));
    }
    return snapshot(job);
  }

  return { start, get, stop };
}

module.exports = { createScanJobManager, TERMINAL_STATES };
