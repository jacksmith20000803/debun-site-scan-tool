'use strict';

const chalk = require('chalk');

const TIER_COLOR = {
  high: chalk.green,
  medium: chalk.yellow,
  low: chalk.dim,
};

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function truncate(value, width) {
  const text = String(value ?? '');
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function renderTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length))
  );
  const headerLine = headers.map((header, index) => chalk.bold(pad(header, widths[index]))).join('  ');
  const separator = chalk.dim(widths.map((width) => '─'.repeat(width)).join('  '));
  const body = rows
    .map((row) => row.map((cell, index) => pad(cell, widths[index])).join('  '))
    .join('\n');
  return [headerLine, separator, body].join('\n');
}

/** Human-readable report. */
function renderText(result, { color = true } = {}) {
  if (!color || process.env.NO_COLOR) {
    chalk.level = 0;
  }
  const lines = [];

  lines.push(chalk.bold.cyan('debun-plus') + chalk.dim(' · page-deps compatible package & version inference'));
  lines.push('');
  lines.push(`${chalk.bold('Target')}     ${result.url}`);
  if (result.finalUrl !== result.url) lines.push(`${chalk.bold('Resolved')}   ${result.finalUrl}`);
  lines.push(`${chalk.bold('Crawler')}    ${result.crawler}${result.page.status ? ` · HTTP ${result.page.status}` : ''}`);
  if (result.page.title) lines.push(`${chalk.bold('Title')}      ${truncate(result.page.title, 100)}`);
  if (result.page.generator) lines.push(`${chalk.bold('Generator')}  ${result.page.generator}`);
  lines.push(
    `${chalk.bold('Scanned')}    ${result.stats.sourcesAnalyzed} script source(s) · ` +
      `${(result.stats.scriptBytes / 1024).toFixed(1)} KiB · ${result.elapsedMs} ms`
  );
  lines.push('');

  if (result.project && result.project.name) {
    lines.push(
      `${chalk.bold('Project')}    ${chalk.cyan(result.project.name)}${
        result.project.version ? chalk.dim(`@${result.project.version}`) : ''
      }${result.project.source ? chalk.dim(`  (${result.project.source})`) : ''}`
    );
    lines.push('');
  }

  if (result.packages.length === 0) {
    lines.push(chalk.yellow('No packages detected.'));
  } else {
    lines.push(chalk.bold.green(`Detected packages (${result.packages.length})`));
    const rows = result.packages.map((pkg) => {
      const tier = (TIER_COLOR[pkg.tier] || chalk.dim)(pkg.confidence.toFixed(2));
      let version = pkg.version ? chalk.yellow(pkg.version) : chalk.dim('unknown');
      if (pkg.alternatives && pkg.alternatives.length) {
        version += chalk.dim(` (alt ${pkg.alternatives.join(', ')})`);
      }
      const signals = pkg.signals.join(',');
      const firstEvidence = pkg.evidence[0] ? truncate(pkg.evidence[0].detail, 64) : '';
      return [pkg.name, version, `${tier} ${pkg.tier}`, truncate(signals, 40), firstEvidence];
    });
    lines.push(renderTable(['Package', 'Version', 'Confidence', 'Signals', 'Primary evidence'], rows));
  }
  lines.push('');

  const declaredNames = Object.keys(result.declaredDependencies || {});
  if (declaredNames.length > 0) {
    lines.push(chalk.bold(`Declared dependencies from manifests (${declaredNames.length})`));
    const rows = declaredNames.map((name) => {
      const resolved = result.packages.find((pkg) => pkg.name === name && pkg.version);
      return [name, result.declaredDependencies[name] || '', resolved ? resolved.version : chalk.dim('not bundled')];
    });
    lines.push(renderTable(['Dependency', 'Declared range', 'Detected version'], rows));
    lines.push('');
  }

  lines.push(
    chalk.dim(
      'Confidence: high ≥ 0.85, medium ≥ 0.60, low < 0.60. ' +
      'Signals: debun (POG), registry fingerprint, URL, banner, global, source map, manifest.'
    )
  );

  if (result.errors && result.errors.length) {
    lines.push('');
    lines.push(chalk.bold.yellow(`Warnings (${result.errors.length})`));
    for (const error of result.errors.slice(0, 12)) lines.push(`  ${chalk.dim('·')} ${error}`);
  }

  return `${lines.join('\n')}\n`;
}

/** Machine-readable report. */
function toJson(result) {
  return JSON.stringify(
    {
      url: result.url,
      finalUrl: result.finalUrl,
      crawler: result.crawler,
      fetchedAt: result.fetchedAt,
      elapsedMs: result.elapsedMs,
      page: result.page,
      project: result.project,
      technology: result.technology,
      stats: result.stats,
      debunPlus: result.debunPlus,
      packageCount: result.packageCount,
      packages: result.packages,
      packageLeads: result.packageLeads || [],
      declaredDependencies: result.declaredDependencies,
      errors: result.errors,
    },
    null,
    2
  );
}

module.exports = { renderText, toJson };
