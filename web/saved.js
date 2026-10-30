'use strict';

const rows = document.querySelector('#saved-rows');
const searchInput = document.querySelector('#saved-search');
const pageIndicator = document.querySelector('#page-indicator');
const previousButton = document.querySelector('#previous-page');
const nextButton = document.querySelector('#next-page');
const countLabel = document.querySelector('#saved-count');
const emptyState = document.querySelector('#history-empty');
const errorState = document.querySelector('#history-error');
const jsonPanel = document.querySelector('#saved-json-panel');
const jsonOutput = document.querySelector('#saved-json-output');
const savedFileName = document.querySelector('#saved-file-name');
const PAGE_SIZE = 25;
let page = 1;
let pageCount = 0;
let currentRecord = null;
let searchTimer = null;

function cellText(value, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value || '—';
  return cell;
}

function makeAction(label, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    action(event);
  });
  return button;
}

function reportHref(record) {
  return `/?savedScan=${encodeURIComponent(record.id)}#results`;
}

function makeRow(record) {
  const row = document.createElement('tr');
  row.className = 'saved-scan-row';
  row.tabIndex = 0;
  row.setAttribute('aria-label', `Open scan report for ${record.url || 'saved website'}`);
  row.title = 'Open scan report';
  row.addEventListener('click', (event) => {
    if (event.target.closest('a, button')) return;
    window.location.assign(reportHref(record));
  });
  row.addEventListener('keydown', (event) => {
    if (event.target === row && event.key === 'Enter') window.location.assign(reportHref(record));
  });
  const urlCell = document.createElement('td');
  const urlLink = document.createElement('a');
  urlLink.className = 'history-url-link';
  urlLink.href = reportHref(record);
  urlLink.title = 'Open scan report';
  urlLink.textContent = record.url || 'URL unavailable';
  urlCell.append(urlLink);
  row.append(urlCell);

  const scannedCell = document.createElement('td');
  scannedCell.className = 'history-scanned-at';
  const scannedDate = new Date(record.createdAt);
  if (record.createdAt && !Number.isNaN(scannedDate.valueOf())) {
    const timestamp = document.createElement('span');
    timestamp.className = 'history-timestamp';
    const dateLabel = document.createElement('span');
    dateLabel.className = 'history-date';
    dateLabel.textContent = scannedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = document.createElement('span');
    timeLabel.className = 'history-time';
    timeLabel.textContent = scannedDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    timestamp.append(dateLabel, timeLabel);
    scannedCell.append(timestamp);
  } else {
    scannedCell.textContent = '—';
  }
  row.append(scannedCell);
  row.append(cellText(`${record.framework || 'unknown'} / ${record.bundler || 'unknown'}`, 'technical-value'));
  row.append(cellText(String(record.pagesScanned ?? 0)));
  row.append(cellText(String(record.dependencyCount ?? 0)));

  const statusCell = document.createElement('td');
  const status = document.createElement('span');
  status.className = `scan-status ${record.scanCompleted ? 'complete' : 'incomplete'}`;
  status.textContent = record.scanCompleted ? 'COMPLETE' : 'INCOMPLETE';
  statusCell.append(status);
  row.append(statusCell);

  const actions = document.createElement('td');
  const actionGroup = document.createElement('div');
  actionGroup.className = 'saved-actions';
  const rescan = document.createElement('a');
  rescan.className = 'small-action-button';
  rescan.href = `/?url=${encodeURIComponent(record.url || '')}&scan=1`;
  rescan.textContent = 'Rescan';
  rescan.addEventListener('click', (event) => event.stopPropagation());
  actionGroup.append(rescan);
  actionGroup.append(makeAction('Delete', 'danger-action-button', () => deleteRecord(record)));
  actions.append(actionGroup);
  row.append(actions);
  return row;
}

async function loadRecords() {
  errorState.classList.add('hidden');
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), search: searchInput.value.trim() });
  try {
    const response = await fetch(`/api/scans?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Could not load saved scans (${response.status}).`);
    rows.replaceChildren(...data.items.map(makeRow));
    page = data.page;
    pageCount = data.pageCount;
    countLabel.textContent = `${data.total} saved ${data.total === 1 ? 'scan' : 'scans'} · newest first`;
    pageIndicator.textContent = `Page ${page} of ${Math.max(pageCount, 1)}`;
    previousButton.disabled = page <= 1;
    nextButton.disabled = page >= pageCount;
    emptyState.classList.toggle('hidden', data.total !== 0);
    if (data.total === 0 && page > 1) {
      page = 1;
      return loadRecords();
    }
  } catch (error) {
    rows.replaceChildren();
    errorState.textContent = error.message;
    errorState.classList.remove('hidden');
    countLabel.textContent = 'Saved scans unavailable';
  }
}

async function viewRecord(id) {
  try {
    const response = await fetch(`/api/scans/${encodeURIComponent(id)}`);
    const record = await response.json();
    if (!response.ok) throw new Error(record.error || 'Could not load the saved JSON file.');
    currentRecord = record;
    const fileContents = JSON.stringify(record, null, 2);
    jsonOutput.textContent = fileContents;
    savedFileName.textContent = record.id ? `${record.id}.json` : '';
    jsonPanel.classList.remove('hidden');
    jsonPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    errorState.textContent = error.message;
    errorState.classList.remove('hidden');
  }
}

async function deleteRecord(record) {
  if (!window.confirm(`Delete the saved scan for ${record.url}?`)) return;
  try {
    const response = await fetch(`/api/scans/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not delete the saved scan.');
    if (currentRecord?.id === record.id) {
      currentRecord = null;
      jsonPanel.classList.add('hidden');
    }
    await loadRecords();
  } catch (error) {
    errorState.textContent = error.message;
    errorState.classList.remove('hidden');
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 1;
    loadRecords();
  }, 180);
});
previousButton.addEventListener('click', () => { if (page > 1) { page--; loadRecords(); } });
nextButton.addEventListener('click', () => { if (page < pageCount) { page++; loadRecords(); } });

document.querySelector('#download-saved-json').addEventListener('click', () => {
  if (!currentRecord) return;
  const blob = new Blob([JSON.stringify(currentRecord, null, 2)], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${currentRecord.id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
});

document.querySelector('#copy-saved-json').addEventListener('click', async (event) => {
  if (!currentRecord) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(currentRecord, null, 2));
    event.currentTarget.textContent = 'Copied';
    setTimeout(() => { event.currentTarget.textContent = 'Copy JSON'; }, 1500);
  } catch (_) {
    errorState.textContent = 'Clipboard access is unavailable in this browser.';
    errorState.classList.remove('hidden');
  }
});

loadRecords();

const ACTIVE_JOB_KEY = 'debun-plus-active-scan-job';
const activeBanner = document.querySelector('#active-scan-banner');
const activeLabel = document.querySelector('#active-scan-label');
const activeTarget = document.querySelector('#active-scan-target');
const activePercent = document.querySelector('#active-scan-percent');
const activeMeter = document.querySelector('#active-scan-meter');
const activeFill = document.querySelector('#active-scan-fill');
const activeStop = document.querySelector('#active-scan-stop');
let activeJobId = localStorage.getItem(ACTIVE_JOB_KEY);
let polling = false;

function showActiveJob(job) {
  if (!job || !['running', 'stopping'].includes(job.status)) {
    activeBanner.classList.add('hidden');
    activeJobId = null;
    localStorage.removeItem(ACTIVE_JOB_KEY);
    if (job && ['complete', 'stopped', 'failed'].includes(job.status)) void loadRecords();
    return false;
  }
  activeJobId = job.id;
  localStorage.setItem(ACTIVE_JOB_KEY, job.id);
  const progress = job.progress || {};
  const processed = Math.max(Number(progress.pagesAttempted) || 0, Number(progress.pagesScanned) || 0);
  const total = Math.max(Number(progress.totalPages) || 1, processed);
  const percent = job.status === 'stopping' ? Math.floor(100 * processed / total) : Math.min(95, Math.floor(100 * processed / total));
  activeLabel.textContent = job.status === 'stopping' ? 'Stopping scan…' : (progress.stageLabel || 'Scan in progress');
  activeTarget.textContent = job.urls?.length === 1 ? job.urls[0] : `${job.urls?.length || 0} URLs in this scan`;
  activePercent.textContent = `${percent}%`;
  activeMeter.setAttribute('aria-valuenow', String(percent));
  activeFill.style.width = `${percent}%`;
  activeStop.disabled = job.status !== 'running';
  activeBanner.classList.remove('hidden');
  return true;
}

async function pollActiveJob() {
  if (!activeJobId || polling) return;
  polling = true;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}`, { cache: 'no-store' });
    const job = await response.json();
    if (!response.ok) {
      activeBanner.classList.add('hidden');
      localStorage.removeItem(ACTIVE_JOB_KEY);
      activeJobId = null;
      return;
    }
    showActiveJob(job);
  } catch (error) {
    activeLabel.textContent = `Scan status unavailable: ${error.message}`;
  } finally {
    polling = false;
  }
}

activeStop.addEventListener('click', async () => {
  if (!activeJobId) return;
  activeStop.disabled = true;
  activeLabel.textContent = 'Stopping scan…';
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}/stop`, { method: 'POST' });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not stop the scan.');
    showActiveJob(job);
  } catch (error) {
    activeLabel.textContent = error.message;
    activeStop.disabled = false;
  }
});

if (activeJobId) {
  void pollActiveJob();
  setInterval(pollActiveJob, 450);
}
