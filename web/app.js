'use strict';

const singleTab = document.querySelector('#single-tab');
const batchTab = document.querySelector('#batch-tab');
const singlePanel = document.querySelector('#single-panel');
const batchPanel = document.querySelector('#batch-panel');
const scanModeInputs = [...document.querySelectorAll('input[name="scan-mode"]')];
const scanModeDescription = document.querySelector('#scan-mode-description');
const progress = document.querySelector('#progress');
const progressLabel = document.querySelector('#progress-label');
const progressCounter = document.querySelector('#progress-counter');
const progressPercent = document.querySelector('#progress-percent');
const progressMeter = document.querySelector('#progress-meter');
const progressFill = document.querySelector('#progress-fill');
const progressPages = document.querySelector('#progress-pages');
const notice = document.querySelector('#notice');
const results = document.querySelector('#results');
const dashboardWarning = document.querySelector('#dashboard-warning');
const sitesTableBody = document.querySelector('#sites-table-body');
const technologyTableBody = document.querySelector('#technology-table-body');
const technologyResultsCount = document.querySelector('#technology-results-count');
const packageLeadsBody = document.querySelector('#package-leads-body');
const packageLeadsCount = document.querySelector('#package-leads-count');
const packageTableBody = document.querySelector('#package-table-body');
const pluginTableBody = document.querySelector('#plugin-table-body');
const vulnerabilityTableBody = document.querySelector('#vulnerability-table-body');
const vulnerabilityResultsCount = document.querySelector('#vulnerability-results-count');
const pageTableBody = document.querySelector('#pages-table-body');
const siteResultsCount = document.querySelector('#site-results-count');
const packageResultsCount = document.querySelector('#package-results-count');
const pagesSummary = document.querySelector('#pages-summary');
const pagesTotal = document.querySelector('#pages-total');
const jsonOutput = document.querySelector('#json-output');
const jsonPanel = document.querySelector('.json-panel');
const downloadButton = document.querySelector('#download-json');
const scanSweep = document.querySelector('#scan-sweep');

let currentJson = '';
const ACTIVE_JOB_KEY = 'debun-plus-active-scan-job';
let activeJobId = null;
let activeJobKind = 'single';
let lastDisplayedSiteResults = 0;
let progressCounterAnimation = null;
let completedSiteCount = 0;
let completedPackageCount = 0;
let completedPageCount = 0;
let completedTechnologyCount = 0;
let completedPackageLeadCount = 0;
let liveSiteData = [];
let latestScanPayload = null;

function setMode(mode) {
  const single = mode === 'single';
  singleTab.classList.toggle('active', single);
  batchTab.classList.toggle('active', !single);
  singleTab.setAttribute('aria-selected', String(single));
  batchTab.setAttribute('aria-selected', String(!single));
  singlePanel.hidden = !single;
  batchPanel.hidden = single;
}

function selectedScanMode() {
  return scanModeInputs.find((input) => input.checked)?.value === 'shallow' ? 'shallow' : 'deep';
}

function restoreScanMode(mode) {
  const selected = mode === 'shallow' ? 'shallow' : 'deep';
  for (const input of scanModeInputs) input.checked = input.value === selected;
  scanModeDescription.textContent = selected === 'shallow'
    ? 'Shallow mode scans only the rendered final URL and skips the site root and linked pages.'
    : 'Deep mode follows first-level links after checking the destination root and requested page.';
}

scanModeInputs.forEach((input) => input.addEventListener('change', () => restoreScanMode(input.value)));
restoreScanMode('deep');

singleTab.addEventListener('click', () => { if (!activeJobId) setMode('single'); });
batchTab.addEventListener('click', () => { if (!activeJobId) setMode('batch'); });

function setBusy(busy, label = 'Resolving destination…', { kind = activeJobKind, reset = false } = {}) {
  activeJobKind = kind;
  progress.classList.toggle('hidden', !busy);
  progress.classList.remove('is-complete');
  scanSweep.classList.toggle('active', busy);
  progressLabel.textContent = label;
  singleTab.disabled = busy;
  batchTab.disabled = busy;
  for (const input of scanModeInputs) input.disabled = busy;
  for (const [formId, defaultLabel] of [['single-form', 'Analyze Site'], ['batch-form', 'Analyze list']]) {
    const button = document.querySelector(`#${formId} .primary-button[type="submit"]`);
    const activeButton = busy && ((kind === 'single' && formId === 'single-form') || (kind === 'batch' && formId === 'batch-form'));
    button.disabled = busy && (!activeButton || !activeJobId);
    button.classList.toggle('is-stop-button', activeButton);
    button.title = activeButton ? 'Stop the current scan' : '';
    const buttonLabel = button.querySelector('.primary-button-label');
    if (buttonLabel) buttonLabel.textContent = activeButton ? 'Stop scan' : defaultLabel;
    const buttonIcon = button.querySelector('.primary-button-icon');
    if (buttonIcon) buttonIcon.classList.toggle('hidden', activeButton);
  }
  if (busy && reset) {
    notice.classList.add('hidden');
    progressCounter.textContent = '0 / 1 pages scanned';
    progressCounter.dataset.scanned = '0';
    progressPercent.textContent = '0%';
    progressPercent.dataset.progress = '0';
    progressPercent.dataset.siteIndex = '';
    progressMeter.setAttribute('aria-valuenow', '0');
    progressFill.style.width = '0%';
    progressPages.replaceChildren();
    lastDisplayedSiteResults = 0;
  }
}

function showNotice(message) {
  notice.textContent = message;
  notice.classList.remove('hidden');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberJob(id) {
  activeJobId = id || null;
  if (activeJobId) localStorage.setItem(ACTIVE_JOB_KEY, activeJobId);
  else localStorage.removeItem(ACTIVE_JOB_KEY);
}

async function fetchJob(id) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || `Could not read scan status (${response.status}).`);
  return job;
}

async function stopCurrentJob() {
  if (!activeJobId) return;
  const button = document.querySelector(`#${activeJobKind}-form .primary-button[type="submit"]`);
  if (button) button.disabled = true;
  progressLabel.textContent = 'Stopping scan…';
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}/stop`, { method: 'POST' });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not stop the scan.');
    applyJobSnapshot(job);
    if (job.status === 'stopped') await finishJob(job);
  } catch (error) {
    showNotice(error.message);
    if (button) button.disabled = false;
  }
}

document.querySelectorAll('.primary-button[type="submit"]').forEach((button) => {
  button.addEventListener('click', (event) => {
    const formKind = event.currentTarget.closest('#single-form') ? 'single' : 'batch';
    if (!activeJobId || formKind !== activeJobKind) return;
    event.preventDefault();
    event.stopPropagation();
    void stopCurrentJob();
  });
});

function applyJobSnapshot(job) {
  activeJobId = job.id;
  activeJobKind = job.kind || (job.urls?.length > 1 ? 'batch' : 'single');
  restoreScanMode(job.scanMode);
  setMode(activeJobKind);
  if (activeJobKind === 'single' && job.urls?.[0]) document.querySelector('#target-url').value = job.urls[0];
  latestScanPayload = activeJobKind === 'single'
    ? { url: job.urls?.[0] || '', scanMode: job.scanMode || 'deep' }
    : { urls: job.urls || [], scanMode: job.scanMode || 'deep' };
  setBusy(job.status === 'running' || job.status === 'stopping', job.progress?.stageLabel || 'Scanning…', { kind: activeJobKind });
  if (job.progress) updateProgress(job.progress);
  if (job.siteResults?.length) {
    if (lastDisplayedSiteResults === 0) beginResults();
    for (const site of job.siteResults.slice(lastDisplayedSiteResults)) {
      renderLiveSiteResult({ data: site, siteIndex: lastDisplayedSiteResults + 1 });
      lastDisplayedSiteResults++;
    }
  }
}

async function finishJob(job) {
  setBusy(false);
  rememberJob(null);
  if (job.status === 'complete' && job.result) {
    if (job.kind === 'single') {
      const { scanResult, jsonReport } = job.result;
      present(scanResult, { output: jsonReport });
      if (!scanResult.reportEligible) showNotice(scanResult.reportReason || scanResult.reason || 'No JSON report was produced.');
    } else {
      const { scanResults, jsonReport } = job.result;
      present(scanResults, { isBatch: true, output: jsonReport });
      const omitted = scanResults.length - jsonReport.length;
      if (omitted > 0) {
        const included = jsonReport.length;
        showNotice(included
          ? `${included} completed URL${included === 1 ? '' : 's'} included in the JSON. ${omitted} URL${omitted === 1 ? '' : 's'} did not produce a report.`
          : `${scanResults.length} URLs processed; none produced a package report.`);
      }
    }
    return;
  }
  if (job.siteResults?.length) {
    present(job.siteResults, { isBatch: job.kind === 'batch' });
  }
  if (job.status === 'stopped') {
    progressLabel.textContent = 'Scan stopped';
    showNotice(job.siteResults?.length
      ? 'Scan stopped. Results for URLs completed before stopping are shown below.'
      : 'Scan stopped.');
  } else if (job.error) {
    showNotice(job.error);
  }
}

async function monitorJob(id, initialJob) {
  let job = initialJob;
  if (job) applyJobSnapshot(job);
  while (true) {
    if (!job || job.status === 'running' || job.status === 'stopping') {
      await delay(350);
      try {
        job = await fetchJob(id);
      } catch (error) {
        rememberJob(null);
        setBusy(false);
        showNotice(error.message);
        return;
      }
      applyJobSnapshot(job);
    }
    if (job.status !== 'running' && job.status !== 'stopping') {
      await finishJob(job);
      return;
    }
  }
}

async function startJob(payload, kind) {
  if (activeJobId) return stopCurrentJob();
  beginResults();
  setBusy(true, 'Starting scan…', { kind, reset: true });
  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const job = await response.json();
    if (!response.ok) {
      if (job.activeJob?.id) {
        rememberJob(job.activeJob.id);
        applyJobSnapshot(job.activeJob);
        void monitorJob(job.activeJob.id, job.activeJob);
        return;
      }
      throw new Error(job.error || `Could not start the scan (${response.status}).`);
    }
    rememberJob(job.id);
    console.log('[debun-plus:ui] scan job started', { jobId: job.id, kind });
    await monitorJob(job.id, job);
  } catch (error) {
    rememberJob(null);
    setBusy(false);
    showNotice(error.message);
  }
}

function updateProgress(event) {
  const siteIndex = Number(event.siteIndex) || 0;
  const previousSiteIndex = Number(progressPercent.dataset.siteIndex) || 0;
  if (siteIndex && previousSiteIndex && siteIndex !== previousSiteIndex) {
    progressPercent.dataset.progress = '0';
    progressCounter.dataset.scanned = '0';
  }
  if (siteIndex) progressPercent.dataset.siteIndex = String(siteIndex);
  const scanned = Number(event.pagesScanned) || 0;
  const processed = Math.max(Number(event.pagesAttempted) || 0, scanned);
  const total = Math.max(Number(event.totalPages) || 1, scanned, processed);
  const complete = event.type === 'complete';
  const calculatedPercent = complete
    ? 100
    : Math.max(0, Math.min(95, Math.floor(100 * processed / total)));
  const percent = Math.max(Number(progressPercent.dataset.progress) || 0, calculatedPercent);
  progressPercent.dataset.progress = String(percent);
  progressPercent.textContent = `${percent}%`;
  progressMeter.setAttribute('aria-valuenow', String(percent));
  progressFill.style.width = `${percent}%`;
  const previousScanned = Number(progressCounter.dataset.scanned) || 0;
  progressCounter.textContent = `${processed} / ${total} pages processed · ${scanned} scanned`;
  if (scanned > previousScanned) {
    progressCounterAnimation?.cancel();
    progressCounterAnimation = progressCounter.animate([
      { transform: 'scale(.88)', opacity: .55 },
      { transform: 'scale(1.08)', opacity: 1, offset: .65 },
      { transform: 'scale(1)', opacity: 1 },
    ], { duration: 280, easing: 'ease-out' });
  }
  progressCounter.dataset.scanned = String(scanned);
  if (complete) {
    progress.classList.add('is-complete');
    progressLabel.textContent = event.siteIndex && event.siteIndex < event.siteCount
      ? `URL ${event.siteIndex} complete · moving to the next URL…`
      : 'Analysis complete';
  } else if (event.siteIndex) {
    progress.classList.remove('is-complete');
    progressLabel.textContent = `URL ${event.siteIndex} of ${event.siteCount} · ${event.siteUrl}`;
  }
  else if (event.stageLabel) progressLabel.textContent = event.stageLabel;
  else if (event.title) progressLabel.textContent = `Scanning ${event.title}`;
  else if (event.currentUrl) progressLabel.textContent = `Scanning ${event.currentUrl}`;

  if (typeof event.scanCompleted !== 'boolean' || !event.currentUrl) return;
  const item = document.createElement('li');
  item.className = `progress-page ${event.scanCompleted ? 'completed' : 'failed'}`;
  const link = document.createElement('a');
  link.href = event.currentUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = event.title ? `${event.title} · ${event.currentUrl}` : event.currentUrl;
  item.append(link);
  progressPages.append(item);
  while (progressPages.children.length > 12) progressPages.firstElementChild.remove();
}

function beginResults() {
  completedSiteCount = 0;
  completedPackageCount = 0;
  completedPageCount = 0;
  completedTechnologyCount = 0;
  completedPackageLeadCount = 0;
  liveSiteData = [];
  sitesTableBody.replaceChildren();
  technologyTableBody.replaceChildren();
  packageLeadsBody.replaceChildren();
  packageTableBody.replaceChildren();
  pluginTableBody.replaceChildren();
  vulnerabilityTableBody.replaceChildren();
  pageTableBody.replaceChildren();
  siteResultsCount.textContent = '';
  packageResultsCount.textContent = '';
  technologyResultsCount.textContent = '';
  packageLeadsCount.textContent = '';
  pagesTotal.textContent = '';
  pagesSummary.classList.add('hidden');
  dashboardWarning.classList.add('hidden');
  jsonPanel.classList.add('hidden');
  jsonOutput.textContent = '';
  currentJson = '';
  downloadButton.classList.add('hidden');
  document.querySelector('#save-report-button').disabled = true;
  results.classList.remove('hidden');
}

function makeTextCell(value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value || '—';
  return cell;
}

function addStatusCheck(status) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'status-check-icon');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm3 8.2 3 3 7-7');
  icon.append(path);
  status.prepend(icon);
}

function appendSiteRow(site, siteIndex) {
  const row = document.createElement('tr');
  const website = document.createElement('td');
  const anchor = document.createElement('a');
  anchor.className = 'table-url';
  anchor.href = site.url || site.finalUrl || '#';
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = site.url || site.finalUrl || 'Unknown URL';
  anchor.title = anchor.textContent;
  website.append(anchor);
  row.append(website);
  row.append(makeTextCell(site.framework || 'unknown'));
  row.append(makeTextCell(site.bundler || 'unknown'));
  const pageCount = Number.isInteger(site.pagesScanned)
    ? site.pagesScanned
    : Array.isArray(site.pages)
      ? site.pages.filter((page) => page.scanCompleted === true).length
      : Number(site.report?.pagesScanned) || 0;
  const dependencyCount = Array.isArray(site.packages)
    ? site.packages.filter((pkg) => pkg.ecosystem !== 'WordPress').length
    : Number(site.report?.totalDependencies) || 0;
  row.append(makeTextCell(String(pageCount)));
  row.append(makeTextCell(String(Number(site.scriptsDiscovered) || 0)));
  row.append(makeTextCell(String(Number(site.assetsDiscovered) || 0)));
  row.append(makeTextCell(String(dependencyCount)));
  const statusCell = document.createElement('td');
  const status = document.createElement('span');
  status.className = `scan-status ${site.scanCompleted === true ? 'complete' : 'incomplete'}`;
  status.textContent = site.scanCompleted === true ? 'COMPLETE' : 'INCOMPLETE';
  if (site.scanCompleted === true) addStatusCheck(status);
  statusCell.append(status);
  row.append(statusCell);
  if (siteIndex) row.dataset.siteIndex = String(siteIndex);
  sitesTableBody.append(row);
  completedSiteCount++;
  completedPackageCount += dependencyCount;
  siteResultsCount.textContent = `${completedSiteCount} ${completedSiteCount === 1 ? 'URL' : 'URLs'} processed`;
}

function evidenceText(pkg) {
  const values = pkg.evidenceSources || (pkg.evidence || []).map((item) => item.signal || item.source || item.detail).filter(Boolean);
  return [...new Set(values)].join(', ') || (pkg.declared ? 'Declared dependency' : 'Bundle fingerprint');
}

function appendPackageRows(site, packages) {
  for (const pkg of packages || []) {
    const isPlugin = pkg.ecosystem === 'WordPress';
    const row = document.createElement('tr');
    const siteCell = makeTextCell(site.url || site.finalUrl, 'technical-value table-url-cell');
    siteCell.title = site.url || site.finalUrl || '';
    row.append(siteCell);
    row.append(makeTextCell(pkg.name, 'package-name-cell'));
    row.append(makeTextCell(pkg.version || pkg.versionHint ? (pkg.version || `unknown (asset hint ${pkg.versionHint})`) : (pkg.declaredRanges?.length ? `declared ${pkg.declaredRanges.join(', ')}` : 'unknown'), 'technical-value'));
    if (isPlugin) row.append(makeTextCell(pkg.componentType || 'plugin'));
    else {
      const tierCell = document.createElement('td');
      const tier = document.createElement('span');
      tier.className = `tier ${String(pkg.tier || 'possible').toLowerCase()}`;
      tier.textContent = pkg.tier || 'possible';
      tierCell.append(tier);
      row.append(tierCell);
    }
    row.append(makeTextCell(`${Math.round((Number(pkg.confidence) || 0) * 100)}%`));
    const evidence = makeTextCell(evidenceText(pkg), 'evidence-cell');
    evidence.title = evidence.textContent;
    row.append(evidence);
    row.dataset.componentKind = isPlugin ? 'plugin' : 'package';
    (isPlugin ? pluginTableBody : packageTableBody).append(row);
  }
}

function updateDashboard(sites, { isBatch = false } = {}) {
  const packages = sites.flatMap((site) => site.packages || []);
  const uniquePackages = new Set(packages.filter((pkg) => pkg.ecosystem !== 'WordPress').map((pkg) => pkg.name)).size;
  const uniquePlugins = new Set(packages.filter((pkg) => pkg.ecosystem === 'WordPress').map((pkg) => `${pkg.componentType || 'plugin'}:${pkg.slug || pkg.name}`)).size;
  const vulnerabilities = packages.flatMap((pkg) => pkg.vulnerabilities || []);
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const vuln of vulnerabilities) severityCounts[severityDetails(vuln.severity).level || 'unknown']++;
  const pages = sites.reduce((n, site) => n + (site.pages?.filter((page) => page.scanCompleted === true).length || Number(site.report?.pagesScanned) || 0), 0);
  const allScansComplete = sites.length > 0 && sites.every((site) => site.scanCompleted === true && site.reportEligible === true);
  const urls = sites.length;
  const mode = sites.some((site) => site.scanMode === 'shallow') ? 'Shallow scan' : 'Deep scan';
  const firstUrl = sites[0]?.url || sites[0]?.finalUrl || '—';
  const summaryUrl = document.querySelector('#summary-url');
  summaryUrl.querySelector('span').textContent = firstUrl;
  summaryUrl.title = firstUrl;
  try {
    const parsedUrl = new URL(firstUrl);
    if (['http:', 'https:'].includes(parsedUrl.protocol)) summaryUrl.href = parsedUrl.href;
    else summaryUrl.removeAttribute('href');
  } catch (_) {
    summaryUrl.removeAttribute('href');
  }
  const completionStatus = document.querySelector('#scan-completion-status');
  const isComplete = sites.length > 0 && sites.every((site) => site.scanCompleted === true && site.reportEligible === true);
  completionStatus.classList.toggle('incomplete', !isComplete);
  const completionMark = completionStatus.querySelector('.completion-check');
  completionMark.classList.toggle('is-incomplete', !isComplete);
  if (isComplete) {
    if (!completionMark.querySelector('svg')) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm3.5 8.2 3 3 6-6.2');
      icon.append(path);
      completionMark.replaceChildren(icon);
    }
  } else {
    completionMark.textContent = '!';
  }
  document.querySelector('#scan-completion-label').textContent = isComplete ? 'Scan completed' : 'Scan incomplete';
  const completedAt = document.querySelector('#scan-completed-at');
  const timestamp = sites.map((site) => site.fetchedAt).filter(Boolean).sort().at(-1);
  const completedDate = timestamp ? new Date(timestamp) : null;
  completedAt.textContent = completedDate && !Number.isNaN(completedDate.valueOf())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(completedDate)
    : '';
  if (completedDate && !Number.isNaN(completedDate.valueOf())) completedAt.dateTime = completedDate.toISOString();
  else completedAt.removeAttribute('datetime');
  document.querySelector('#summary-packages').textContent = allScansComplete ? String(uniquePackages) : '—';
  document.querySelector('#summary-plugins').textContent = allScansComplete ? String(uniquePlugins) : '—';
  document.querySelector('#summary-vulnerabilities').textContent = allScansComplete ? String(vulnerabilities.length) : '—';
  for (const [tabName, count] of [['packages', uniquePackages], ['plugins', uniquePlugins], ['vulnerabilities', vulnerabilities.length]]) {
    const shortcut = document.querySelector(`.summary-shortcut[data-open-tab="${tabName}"]`);
    shortcut.hidden = !allScansComplete || count === 0;
  }
  document.querySelector('#overview-urls').textContent = String(urls);
  document.querySelector('#overview-packages').textContent = allScansComplete ? String(uniquePackages) : '—';
  document.querySelector('#overview-plugins').textContent = allScansComplete ? String(uniquePlugins) : '—';
  document.querySelector('#overview-mode').textContent = isBatch && new Set(sites.map((site) => site.scanMode || mode)).size > 1 ? 'Mixed' : mode;
  document.querySelector('#overview-pages').textContent = String(pages);
  const riskHeading = document.querySelector('#risk-heading');
  const riskSummary = document.querySelector('#risk-summary');
  const riskGauge = document.querySelector('#risk-gauge');
  const riskGaugeLevel = document.querySelector('#risk-gauge-level');
  const riskGaugeNeedle = document.querySelector('#risk-gauge-needle');
  const riskGaugeSvg = document.querySelector('#risk-gauge-svg');
  const riskGaugeCaption = document.querySelector('#risk-gauge-caption');
  riskHeading.textContent = vulnerabilities.length ? `${vulnerabilities.length} known ${vulnerabilities.length === 1 ? 'vulnerability' : 'vulnerabilities'}` : 'Vulnerability overview';
  riskSummary.textContent = vulnerabilities.length
    ? 'Version-matched advisories were returned for detected components.'
    : sites.some((site) => (site.packages || []).some((pkg) => pkg.vulnerabilityLookup === 'unavailable'))
      ? 'Some vulnerability lookups could not complete; review component lookup status.'
      : packages.length
        ? 'No matched advisories were returned. Some detected component versions may be unverified.'
        : sites.some((site) => site.reportEligible !== true)
          ? 'Vulnerability matching is unavailable because one or more pages could not be inspected.'
          : 'No components were detected for vulnerability matching.';
  const severityRisk = ['critical', 'high', 'medium', 'low'].find((level) => severityCounts[level]);
  const riskRanks = { good: 0, low: 1, medium: 2, high: 3, critical: 4 };
  // WordPress advisory feeds can return valid findings without CVSS metadata.
  // In that case, use finding volume as a conservative fallback so a large
  // set of unscored advisories is not incorrectly shown as "Unknown".
  const volumeRisk = severityCounts.unknown >= 50 ? 'critical'
    : severityCounts.unknown >= 10 ? 'high'
      : severityCounts.unknown >= 3 ? 'medium'
        : severityCounts.unknown > 0 ? 'low' : null;
  const volumeDeterminesRisk = Boolean(volumeRisk && (!severityRisk || riskRanks[volumeRisk] > riskRanks[severityRisk]));
  const assessedRisk = vulnerabilities.length === 0 ? 'good'
    : volumeDeterminesRisk ? volumeRisk
      : severityRisk;
  const gaugeLabels = { good: 'GOOD', critical: 'HIGH RISK', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
  const gaugeAngles = { good: -90, critical: 90, high: 45, medium: 0, low: -45 };
  riskGauge.className = `risk-gauge${assessedRisk ? ` has-assessment level-${assessedRisk}` : ''}`;
  riskGaugeLevel.textContent = assessedRisk ? gaugeLabels[assessedRisk] : 'UNKNOWN';
  riskGaugeNeedle.setAttribute('transform', `rotate(${assessedRisk ? gaugeAngles[assessedRisk] : 0} 110 112)`);
  riskGaugeSvg.setAttribute('aria-label', assessedRisk
    ? volumeDeterminesRisk
      ? `Site risk: ${gaugeLabels[assessedRisk]}, based on ${severityCounts.unknown} findings without severity data`
      : `Site risk: ${gaugeLabels[assessedRisk]}, highest matched vulnerability severity`
    : vulnerabilities.length ? 'Site risk is unknown because matched findings have no severity classification' : 'Site risk is good: no matched vulnerabilities reported');
  riskGaugeCaption.textContent = assessedRisk
    ? assessedRisk === 'good'
      ? 'No matched vulnerabilities reported.'
      : volumeDeterminesRisk
        ? `${severityCounts.unknown} findings lack severity data; risk is elevated based on finding volume.`
        : `Highest matched severity across ${vulnerabilities.length} ${vulnerabilities.length === 1 ? 'finding' : 'findings'}.`
    : vulnerabilities.length ? 'Matched findings do not include a classifiable severity.' : 'No matched vulnerabilities reported.';
  const stack = [...new Map(sites.flatMap((site) => site.technologyStack || []).map((technology) => [`${technology.category}:${technology.name}`, technology])).values()];
  const chips = document.querySelector('#stack-chips');
  chips.replaceChildren();
  if (!stack.length) {
    const empty = document.createElement('p'); empty.className = 'stack-empty'; empty.textContent = 'No public stack markers identified'; chips.append(empty);
  } else for (const technology of stack.slice(0, 10)) {
    const item = document.createElement('div'); item.className = 'stack-chip';
    const icon = document.createElement('span'); icon.className = 'stack-chip-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3.5 7.2 8.5 5 8.5-5M12 12.2V22"/></svg>';
    const copy = document.createElement('span'); copy.className = 'stack-chip-copy';
    const name = document.createElement('strong'); name.textContent = technology.name || 'Unknown technology';
    const category = document.createElement('small'); category.textContent = technology.category || 'Technology';
    copy.append(name, category); item.append(icon, copy);
    const confidence = Number(technology.confidence);
    if (Number.isFinite(confidence) && confidence > 0) {
      const badge = document.createElement('span'); badge.className = 'stack-confidence'; badge.textContent = `${Math.round(confidence * 100)}%`;
      item.append(badge);
    }
    item.title = `${technology.category || 'Technology'}${Number.isFinite(confidence) && confidence > 0 ? ` · ${Math.round(confidence * 100)}% confidence` : ''}`;
    chips.append(item);
  }
  document.querySelector('#plugin-results-count').textContent = `${uniquePlugins} detected`;
}

function setResultTab(tabName) {
  document.querySelectorAll('[data-result-tab]').forEach((button) => {
    const active = button.dataset.resultTab === tabName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-result-category]').forEach((section) => {
    section.classList.toggle('hidden', section.dataset.resultCategory !== tabName);
  });
  if (tabName === 'sites') pagesSummary.classList.toggle('hidden', completedPageCount === 0);
  else pagesSummary.classList.add('hidden');
}

document.querySelectorAll('[data-result-tab]').forEach((button, index, buttons) => {
  button.addEventListener('click', () => setResultTab(button.dataset.resultTab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); buttons[next].click();
  });
});
setResultTab('sites');
document.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', () => {
  const tab = document.querySelector(`[data-result-tab="${button.dataset.openTab}"]`);
  tab?.click(); tab?.focus();
}));

function appendTechnologyRows(site) {
  for (const technology of site.technologyStack || []) {
    const row = document.createElement('tr');
    row.append(makeTextCell(site.url || site.finalUrl, 'technical-value table-url-cell'));
    row.append(makeTextCell(technology.category || 'Technology'));
    row.append(makeTextCell(technology.name, 'package-name-cell'));
    row.append(makeTextCell(`${Math.round((Number(technology.confidence) || 0) * 100)}%`));
    const evidence = makeTextCell((technology.evidence || []).join('; ') || 'Public asset or response fingerprint', 'evidence-cell');
    evidence.title = evidence.textContent;
    row.append(evidence);
    technologyTableBody.append(row);
    completedTechnologyCount++;
  }
}

function appendPackageLeadRows(site) {
  for (const lead of site.packageLeads || []) {
    const row = document.createElement('tr');
    row.append(makeTextCell(site.url || site.finalUrl, 'technical-value table-url-cell'));
    row.append(makeTextCell(lead.name, 'package-name-cell'));
    row.append(makeTextCell(`${Math.round((Number(lead.confidence) || 0) * 100)}%`));
    const evidence = makeTextCell((lead.evidence || []).map((item) => `${item.source}: ${item.detail}`).join('; ') || 'Unverified bundle candidate', 'evidence-cell');
    evidence.title = evidence.textContent;
    row.append(evidence);
    packageLeadsBody.append(row);
    completedPackageLeadCount++;
  }
}

function appendVulnerabilityRows(site, packages) {
  for (const pkg of packages || []) {
    for (const vuln of pkg.vulnerabilities || []) {
      const row = document.createElement('tr');
      row.append(makeTextCell(pkg.name, 'package-name-cell'));
      row.append(makeTextCell(pkg.version || 'unknown', 'technical-value'));
      const severity = severityDetails(vuln.severity);
      const severityCell = document.createElement('td');
      const severityBadge = document.createElement('span');
      severityBadge.className = `severity-badge ${severity.level || 'unknown'}`;
      severityBadge.textContent = severity.label;
      severityCell.append(severityBadge); row.append(severityCell);
      const linkCell = document.createElement('td');
      const link = document.createElement('a');
      link.href = vuln.url || '#'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = vuln.id || 'Advisory'; linkCell.append(link); row.append(linkCell);
      row.append(makeTextCell(vuln.summary || 'No summary supplied'));
      row.append(makeTextCell(`${vuln.source || pkg.vulnerabilityDatabase || 'Database'} · ${vuln.match || 'version match'}`, 'evidence-cell'));
      vulnerabilityTableBody.append(row);
    }
  }
}

function severityDetails(value) {
  const text = String(value ?? '').trim();
  if (!text) return { level: 'unknown', label: 'Unknown severity' };
  const upper = text.toUpperCase();
  if (['CRITICAL', 'HIGH', 'MEDIUM', 'MODERATE', 'LOW'].includes(upper)) {
    const level = upper === 'MODERATE' ? 'medium' : upper.toLowerCase();
    return { level, label: upper === 'MODERATE' ? 'Medium' : upper };
  }
  const score = Number(text);
  if (!Number.isFinite(score)) return { level: 'unknown', label: 'Unknown severity' };
  const level = score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  return { level, label: `${level[0].toUpperCase()}${level.slice(1)} · ${score.toFixed(1)}` };
}

function appendPages(site) {
  for (const page of site.pages || []) {
    const row = document.createElement('tr');
    const urlCell = document.createElement('td');
    const anchor = document.createElement('a');
    anchor.className = 'table-url';
    anchor.href = page.finalUrl || page.url || '#';
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = page.finalUrl || page.url || 'Unknown URL';
    urlCell.append(anchor);
    row.append(urlCell);
    row.append(makeTextCell(page.title));
    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = `scan-status ${page.scanCompleted === true ? 'complete' : 'incomplete'}`;
    status.textContent = page.scanCompleted === true ? 'SCANNED' : 'FAILED';
    if (page.scanCompleted === true) addStatusCheck(status);
    statusCell.append(status);
    row.append(statusCell);
    pageTableBody.append(row);
    completedPageCount++;
  }
}

function renderLiveSiteResult(event) {
  const site = event.data;
  if (!site) return;
  results.classList.remove('hidden');
  liveSiteData.push(site);
  appendSiteRow(site, event.siteIndex);
  appendTechnologyRows(site);
  appendPackageLeadRows(site);
  appendPackageRows(site, site.packages || []);
  appendVulnerabilityRows(site, site.packages || []);
  appendPages(site);
  const hasIncompleteSites = liveSiteData.some((result) => result.reportEligible !== true);
  vulnerabilityResultsCount.textContent = hasIncompleteSites ? 'Unavailable' : `${vulnerabilityTableBody.children.length} findings`;
  technologyResultsCount.textContent = `${completedTechnologyCount} detected`;
  packageLeadsCount.textContent = `${completedPackageLeadCount} leads`;
  packageResultsCount.textContent = hasIncompleteSites ? 'Unavailable' : `${completedPackageCount} ${completedPackageCount === 1 ? 'dependency' : 'dependencies'}`;
  pagesTotal.textContent = `${completedPageCount} ${completedPageCount === 1 ? 'page' : 'pages'} visited`;
  pagesSummary.classList.toggle('hidden', completedPageCount === 0);
  updateDashboard(liveSiteData);
  if (completedSiteCount === 1) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function present(resultsData, { isBatch = false, output } = {}) {
  const sites = (Array.isArray(resultsData) ? resultsData : [resultsData]).filter(Boolean);
  const hasIncompleteSites = sites.some((site) => site.reportEligible !== true);
  const allScansComplete = sites.length > 0 && sites.every((site) => site.scanCompleted === true && site.reportEligible === true);
  beginResults();
  document.querySelector('#result-title').textContent = isBatch ? 'Batch scan results' : 'Scan results';
  for (const [index, site] of sites.entries()) {
    appendSiteRow(site, index + 1);
    appendTechnologyRows(site);
    appendPackageLeadRows(site);
    appendPackageRows(site, site.packages || []);
    appendVulnerabilityRows(site, site.packages || []);
    appendPages(site);
  }
  updateDashboard(sites, { isBatch });
  setResultTab('sites');
  if (!packageTableBody.children.length) {
    const row = document.createElement('tr');
    const empty = makeTextCell(sites.some((site) => site.scanCompleted)
      ? 'No dependencies were identified in the scanned pages.'
      : 'Package results are unavailable because the scan did not complete.', 'empty-table-cell');
    empty.colSpan = 6;
    row.append(empty);
    packageTableBody.append(row);
  }
  packageResultsCount.textContent = hasIncompleteSites ? 'Unavailable' : `${completedPackageCount} ${completedPackageCount === 1 ? 'dependency' : 'dependencies'}`;
  technologyResultsCount.textContent = `${completedTechnologyCount} detected`;
  packageLeadsCount.textContent = `${completedPackageLeadCount} leads`;
  vulnerabilityResultsCount.textContent = hasIncompleteSites ? 'Unavailable' : `${vulnerabilityTableBody.children.length} findings`;
  if (!vulnerabilityTableBody.children.length) {
    const row = document.createElement('tr');
    const lookupUnavailable = sites.some((site) => (site.packages || []).some((pkg) => pkg.vulnerabilityLookup === 'unavailable'));
    row.append(makeTextCell(lookupUnavailable
      ? 'Some vulnerability database lookups could not complete; those packages are marked unavailable in the JSON report.'
      : sites.some((site) => site.reportEligible !== true)
        ? 'Vulnerability results are unavailable because one or more pages could not be inspected.'
        : sites.some((site) => site.packages?.length)
        ? 'No matched advisories were returned for the detected components. Some versions may be unverified.'
        : 'No components were detected for vulnerability matching.', 'empty-table-cell'));
    row.firstChild.colSpan = 6;
    vulnerabilityTableBody.append(row);
  }
  siteResultsCount.textContent = `${sites.length} ${sites.length === 1 ? 'URL' : 'URLs'} processed`;
  pagesTotal.textContent = `${completedPageCount} ${completedPageCount === 1 ? 'page' : 'pages'} visited`;
  pagesSummary.classList.toggle('hidden', completedPageCount === 0);

  const failed = sites.filter((site) => !site.reportEligible);
  if (failed.length) {
    dashboardWarning.textContent = failed.length === sites.length
      ? failed[0].reportReason || failed[0].reason || 'No report was produced because the scan did not complete.'
      : `${failed.length} of ${sites.length} URLs did not produce a package report.`;
    dashboardWarning.classList.remove('hidden');
  }

  const outputValue = output === undefined ? null : output;
  const hasReport = outputValue !== null && (!Array.isArray(outputValue) || outputValue.length > 0);
  document.querySelector('#save-report-button').disabled = !hasReport;
  jsonPanel.classList.toggle('hidden', !hasReport);
  downloadButton.classList.toggle('hidden', !isBatch || !hasReport);
  document.querySelector('#json-title').textContent = isBatch ? 'JSON reports · completed URLs' : 'JSON report';
  currentJson = hasReport ? JSON.stringify(outputValue, null, 2) : '';
  jsonOutput.textContent = currentJson;
  const packageCount = sites.reduce((total, site) => total + (Number(site.packageCount) || site.packages?.length || 0), 0);
  const pageCount = sites.reduce((total, site) => total + (Number(site.report?.pagesScanned) || site.pages?.filter((page) => page.scanCompleted === true).length || 0), 0);
  const scanMode = sites.some((site) => site.scanMode === 'shallow') ? 'Shallow' : 'Deep';
  const leadCount = sites.reduce((total, site) => total + (site.packageLeads?.length || 0), 0);
  document.querySelector('#result-badge').textContent = `${scanMode} · ${sites.length} ${sites.length === 1 ? 'URL' : 'URLs'} · ${allScansComplete ? packageCount : 'unknown'} packages · ${leadCount} leads · ${pageCount} pages`;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadCurrentReport() {
  if (!currentJson) return;
  const blob = new Blob([currentJson], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = 'webscan-results.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

document.querySelector('#save-report-button').addEventListener('click', downloadCurrentReport);
document.querySelector('#rescan-button').addEventListener('click', async () => {
  if (!latestScanPayload || activeJobId) return;
  if (latestScanPayload.urls) await startJob({ ...latestScanPayload }, 'batch');
  else await startJob({ ...latestScanPayload }, 'single');
});

const targetUrlInput = document.querySelector('#target-url');
const urlValidationMessage = document.querySelector('#url-validation-message');
targetUrlInput.addEventListener('input', () => {
  targetUrlInput.setCustomValidity('');
  targetUrlInput.removeAttribute('aria-invalid');
  urlValidationMessage.textContent = '';
});

document.querySelector('#single-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeJobId) return stopCurrentJob();
  const value = targetUrlInput.value.trim();
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Use an HTTP or HTTPS website URL, such as https://example.com.');
  } catch (error) {
    const message = error.message.includes('Use an HTTP') ? error.message : 'Enter a complete website URL, including https://.';
    targetUrlInput.setCustomValidity(message);
    targetUrlInput.setAttribute('aria-invalid', 'true');
    urlValidationMessage.textContent = message;
    targetUrlInput.reportValidity();
    targetUrlInput.focus();
    return;
  }
  urlValidationMessage.textContent = '';
  targetUrlInput.removeAttribute('aria-invalid');
  const payload = { url: value, scanMode: selectedScanMode() };
  latestScanPayload = payload;
  await startJob(payload, 'single');
});

const fileInput = document.querySelector('#url-file');
fileInput.addEventListener('change', () => {
  document.querySelector('#file-name').textContent = fileInput.files[0]?.name || 'Choose a .txt file';
});

document.querySelector('#batch-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeJobId) return stopCurrentJob();
  const file = fileInput.files[0];
  if (!file) return showNotice('Choose a text file first.');
  if (!file.name.toLowerCase().endsWith('.txt')) return showNotice('Upload a .txt file containing one URL per line.');
  const urls = (await file.text()).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!urls.length) return showNotice('No URLs found. Add one URL per line in the text file.');
  if (urls.length > 25) return showNotice('This list has more than 25 sites. Split it into smaller files.');
  const payload = { urls, scanMode: selectedScanMode() };
  latestScanPayload = payload;
  await startJob(payload, 'batch');
});

downloadButton.addEventListener('click', downloadCurrentReport);

document.querySelector('#copy-json').addEventListener('click', async (event) => {
  if (!currentJson) return;
  try {
    await navigator.clipboard.writeText(currentJson);
    event.currentTarget.textContent = 'Copied';
    setTimeout(() => { event.currentTarget.textContent = 'Copy JSON'; }, 1500);
  } catch (_) {
    showNotice('Clipboard access is unavailable in this browser. Select and copy the JSON output.');
  }
});

const query = new URLSearchParams(window.location.search);
const savedScanId = query.get('savedScan');
if (savedScanId) {
  setMode('single');
  showNotice('Loading saved scan report…');
  void (async () => {
    try {
      const response = await fetch(`/api/scans/${encodeURIComponent(savedScanId)}`, { cache: 'no-store' });
      const record = await response.json();
      if (!response.ok) throw new Error(record.error || `Could not load saved scan (${response.status}).`);
      if (!record.scanResult || typeof record.scanResult !== 'object') throw new Error('The saved scan does not contain report details.');
      const scanResult = record.scanResult;
      restoreScanMode(scanResult.scanMode);
      targetUrlInput.value = scanResult.url || record.url || '';
      latestScanPayload = { url: targetUrlInput.value, scanMode: scanResult.scanMode === 'shallow' ? 'shallow' : 'deep' };
      notice.classList.add('hidden');
      present(scanResult, { output: record.report || null });
      if (!scanResult.reportEligible) showNotice(scanResult.reportReason || scanResult.reason || record.reportReason || 'No JSON report was produced for this saved scan.');
      requestAnimationFrame(() => results.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (error) {
      showNotice(error.message);
    }
  })();
}
const urlToScan = query.get('url');
if (urlToScan && !savedScanId) {
  document.querySelector('#target-url').value = urlToScan;
  if (query.get('scan') === '1') {
    history.replaceState(null, '', '/');
    const existingJobId = localStorage.getItem(ACTIVE_JOB_KEY);
    if (!existingJobId) document.querySelector('#single-form').requestSubmit();
  }
}

const rememberedJobId = localStorage.getItem(ACTIVE_JOB_KEY);
if (rememberedJobId && rememberedJobId !== activeJobId) {
  rememberJob(rememberedJobId);
  void monitorJob(rememberedJobId);
}
