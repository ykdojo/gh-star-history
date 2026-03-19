#!/usr/bin/env node

const { execSync, exec: execCb } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(execCb);

// --- Argument parsing ---

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--style' && args[i + 1]) {
    flags.style = args[++i];
  } else if (args[i].startsWith('--style=')) {
    flags.style = args[i].split('=')[1];
  } else if (args[i] === '--output' || args[i] === '-o') {
    flags.output = args[++i];
  } else if (args[i].startsWith('--output=')) {
    flags.output = args[i].split('=')[1];
  } else if (args[i] === '--no-open') {
    flags.noOpen = true;
  } else if (args[i] === '--no-cache') {
    flags.noCache = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    flags.help = true;
  } else {
    positional.push(args[i]);
  }
}

if (flags.help || positional.length === 0) {
  console.log(`
  gh-star-history - Visualize GitHub star history

  Usage:
    npx gh-star-history <owner/repo or URL> ... [options]

  Options:
    --style <name>   Chart style: blue (default), green, purple (single repo only)
    --output <path>  Output file path (default: star-history.html)
    --no-open        Don't auto-open the browser
    --no-cache       Skip cache and fetch fresh data
    -h, --help       Show this help

  Examples:
    npx gh-star-history ykdojo/claude-code-tips
    npx gh-star-history https://github.com/ykdojo/claude-code-tips
    npx gh-star-history ykdojo/claude-code-tips --style green
    npx gh-star-history vuejs/vue withastro/astro sveltejs/svelte

  Requires: GitHub CLI (gh) must be installed and authenticated.
`);
  process.exit(flags.help ? 0 : 1);
}

// Parse repos - accept both "owner/repo" and full GitHub URLs
const repos = positional.map(arg => {
  const ghUrl = arg.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
  const normalized = ghUrl ? ghUrl[1] : arg;
  if (!/^[^/]+\/[^/]+$/.test(normalized)) {
    console.error(`Error: Invalid repo format "${arg}". Use owner/repo or a GitHub URL.`);
    process.exit(1);
  }
  return normalized;
});

// Deduplicate
const repoList = [...new Set(repos)];
if (repoList.length !== repos.length) {
  console.log('Note: Duplicate repos removed.');
}

if (repoList.length > 10) {
  console.error('Error: Maximum 10 repos supported for comparison.');
  process.exit(1);
}

const multiMode = repoList.length > 1;

const style = flags.style || 'blue';
const outputPath = flags.output || 'star-history.html';

const validStyles = ['blue', 'green', 'purple'];
if (!multiMode && !validStyles.includes(style)) {
  console.error(`Error: Unknown style "${style}". Choose from: ${validStyles.join(', ')}`);
  process.exit(1);
}

// --- Check gh CLI ---

try {
  execSync('gh --version', { stdio: 'pipe' });
} catch {
  console.error('Error: GitHub CLI (gh) is not installed.');
  console.error('Install it: https://cli.github.com/');
  process.exit(1);
}

// --- Cache (one file per repo) ---

const cacheDir = path.join(os.homedir(), '.gh-star-history');

function repoCacheFile(repo) {
  return path.join(cacheDir, repo.replace('/', '__') + '.json');
}

function loadRepoCache(repo) {
  try {
    return JSON.parse(fs.readFileSync(repoCacheFile(repo), 'utf8'));
  } catch {
    return null;
  }
}

function saveRepoCache(repo, data) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(repoCacheFile(repo), JSON.stringify(data));
  } catch {
    // Ignore write errors - cache is best-effort
  }
}

// --- Progress display ---

function shortNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// Shared progress state for multi-mode
const progress = {};
let progressRendered = false;

function renderProgress() {
  // Move cursor up to overwrite previous lines
  if (progressRendered) {
    process.stdout.write(`\x1b[${repoList.length}A`);
  }
  for (const repo of repoList) {
    const p = progress[repo];
    let status;
    if (!p) status = 'waiting...';
    else if (p.done) status = `${shortNum(p.total)} done`;
    else if (p.error) status = `error: ${p.error}`;
    else status = `${shortNum(p.fetched)} / ${p.total ? p.total.toLocaleString() : '?'}${p.cached ? ' (cached)' : ''}`;
    process.stdout.write(`\r  ${repo}: ${status}\x1b[K\n`);
  }
  progressRendered = true;
}

// --- Fetch star data ---

async function fetchRepoStars(repo, onProgress) {
  const [owner, name] = repo.split('/');

  // Load cache - cursor is required to resume; without it, start fresh
  const cachedEntry = flags.noCache ? null : loadRepoCache(repo);
  let cursor = (cachedEntry && cachedEntry.cursor) || null;
  const dates = cursor ? [...(cachedEntry.dates || [])] : [];
  let starCount = (cachedEntry && cachedEntry.starCount) || null;

  onProgress({ fetched: dates.length, total: starCount, cached: dates.length > 0 });

  let batch = 0;

  while (true) {
    const afterArg = cursor ? `, after: "${cursor}"` : '';
    const query = `{ repository(owner: "${owner}", name: "${name}") { stargazers(first: 100${afterArg}) { totalCount pageInfo { hasNextPage endCursor } edges { starredAt } } } }`;

    let stdout;
    try {
      const result = await execAsync(
        `gh api graphql -f query='${query}'`,
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      stdout = result.stdout;
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      if (dates.length > 0) {
        saveRepoCache(repo, { dates: dates.sort(), starCount: starCount || dates.length, cursor });
      }
      if (stderr.includes('Could not resolve')) {
        throw new Error(`Repository "${repo}" not found.`);
      } else if (stderr.includes('401') || stderr.includes('403')) {
        throw new Error('Authentication failed. Run "gh auth login" first.');
      } else {
        throw new Error(`Fetch error: ${stderr || err.message}`);
      }
    }

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error(`Failed to parse API response for "${repo}".`);
    }

    const stargazers = data.data && data.data.repository && data.data.repository.stargazers;
    if (!stargazers) {
      const errors = data.errors;
      if (errors && errors.length > 0) {
        throw new Error(`GraphQL error for "${repo}": ${errors[0].message}`);
      }
      throw new Error(`Unexpected API response for "${repo}".`);
    }

    starCount = stargazers.totalCount;
    const edges = stargazers.edges || [];
    const pageInfo = stargazers.pageInfo;

    if (edges.length === 0) break;

    for (const edge of edges) {
      if (edge.starredAt) dates.push(edge.starredAt);
    }

    cursor = pageInfo.endCursor;
    batch++;

    // Save cache after every batch
    saveRepoCache(repo, { dates: dates.sort(), starCount, cursor });

    onProgress({ fetched: dates.length, total: starCount });

    if (!pageInfo.hasNextPage) break;
  }

  dates.sort();
  const displayCount = starCount || dates.length;

  // Extend to present so the chart line doesn't stop at the last star
  const now = new Date().toISOString();
  dates.push(now);
  const cumulative = dates.map((_, i) => Math.min(i + 1, displayCount));

  // Aggregate daily
  const dailyCounts = {};
  for (const d of dates) {
    const day = d.slice(0, 10);
    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
  }
  const dailyDates = Object.keys(dailyCounts).sort();
  const dailyValues = dailyDates.map(d => dailyCounts[d]);

  // Aggregate hourly
  const hourlyCounts = {};
  for (const d of dates) {
    const hour = d.slice(0, 13);
    hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
  }
  const hourlyDates = Object.keys(hourlyCounts).sort().map(h => h + ':00:00Z');
  const hourlyValues = Object.keys(hourlyCounts).sort().map(h => hourlyCounts[h]);

  return { dates, cumulative, dailyDates, dailyValues, hourlyDates, hourlyValues, displayCount };
}

// Fetch all repos
async function main() {
  const repoData = [];

  if (multiMode) {
    // Fetch in parallel with shared progress line
    const results = await Promise.allSettled(
      repoList.map(repo => {
        progress[repo] = { fetched: 0, total: null };
        return fetchRepoStars(repo, (p) => {
          progress[repo] = p;
          renderProgress();
        }).then(data => {
          progress[repo] = { done: true, total: data.displayCount };
          renderProgress();
          return data;
        }).catch(err => {
          progress[repo] = { error: err.message };
          renderProgress();
          throw err;
        });
      })
    );
    for (let i = 0; i < repoList.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        if (result.value.dates.length === 0) {
          console.error(`Warning: No stars found for "${repoList[i]}". Skipping.`);
          continue;
        }
        repoData.push({ repo: repoList[i], ...result.value });
      } else {
        console.error(`Warning: ${result.reason.message} Skipping.`);
      }
    }
  } else {
    // Single repo - simple per-page progress
    const repo = repoList[0];
    try {
      const data = await fetchRepoStars(repo, (p) => {
        const fetched = shortNum(p.fetched);
        const total = p.total ? p.total.toLocaleString() : '?';
        const cached = p.cached ? ' (cached)' : '';
        process.stdout.write(`\r  ${repo}: ${fetched} / ${total} stars${cached}\x1b[K`);
      });
      process.stdout.write('\n');
      if (data.dates.length === 0) {
        console.error(`Error: No stars found for "${repo}".`);
        process.exit(1);
      }
      repoData.push({ repo, ...data });
    } catch (err) {
      process.stdout.write('\n');
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  if (repoData.length === 0) {
    console.error('Error: No star data retrieved for any repo.');
    process.exit(1);
  }

  console.log('Generating chart...');

// --- Style definitions ---

const styles = {
  blue: {
    lineColor: '#58a6ff',
    fillColor: 'rgba(88,166,255,0.08)',
    barColor: 'rgba(88,166,255,0.15)',
  },
  green: {
    lineColor: '#3fb950',
    fillColor: 'rgba(63,185,80,0.08)',
    barColor: 'rgba(63,185,80,0.15)',
  },
  purple: {
    lineColor: '#bc8cff',
    fillColor: 'rgba(188,140,255,0.1)',
    barColor: 'rgba(188,140,255,0.18)',
  },
};

const multiColors = [
  '#58a6ff', '#3fb950', '#bc8cff', '#f78166', '#e3b341',
  '#f97583', '#56d4dd', '#db61a2', '#7ee787', '#79c0ff',
];

// --- Generate HTML ---

const s = multiMode ? null : styles[style];
const d0 = repoData[0]; // first repo (used for single-mode)

const chartTitle = multiMode
  ? 'Star history comparison'
  : `<a href="https://github.com/${d0.repo}" target="_blank">${d0.repo}</a>`;

const chartSubtitle = multiMode
  ? repoData.map(d => `<a href="https://github.com/${d.repo}" target="_blank" style="color:#8b949e">${d.repo}</a>`).join(' vs ')
  : `${d0.displayCount.toLocaleString()} stars`;

const granularityToggle = multiMode ? '' : `
    <span style="margin-left: 12px; border-left: 1px solid #30363d; padding-left: 16px;">
      <button class="range-btn active" data-granularity="daily">Daily</button>
      <button class="range-btn" data-granularity="hourly">Hourly</button>
    </span>`;

// Build client-side data
const clientRepoData = JSON.stringify(repoData.map((d, i) => ({
  repo: d.repo,
  dates: d.dates,
  cumulative: d.cumulative,
  dailyDates: d.dailyDates,
  dailyValues: d.dailyValues,
  hourlyDates: d.hourlyDates,
  hourlyValues: d.hourlyValues,
  color: multiMode ? multiColors[i % multiColors.length] : s.lineColor,
  fillColor: multiMode ? 'transparent' : s.fillColor,
  barColor: multiMode ? null : s.barColor,
})));

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Star History${multiMode ? ' - Comparison' : ` - ${d0.repo}`}</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { text-align: center; font-size: 22px; margin: 20px 0 4px 0; color: #e6edf3; }
  h1 a { color: #e6edf3; text-decoration: none; }
  h1 a:hover { text-decoration: underline; }
  .subtitle { text-align: center; color: #8b949e; font-size: 14px; margin-bottom: 20px; }
  .subtitle a { color: #8b949e; text-decoration: none; }
  .subtitle a:hover { text-decoration: underline; }
  #chart { width: 100%; }
  .range-buttons { text-align: center; margin-bottom: 12px; }
  .range-btn {
    background: #161b22; color: #c9d1d9; border: 1px solid #30363d;
    padding: 6px 16px; margin: 0 4px; border-radius: 6px; cursor: pointer;
    font-size: 13px; font-family: inherit;
  }
  .range-btn:hover { border-color: #58a6ff; }
  .range-btn.active { background: #21262d; border-color: #58a6ff; color: #e6edf3; }
  .footer { text-align: center; color: #484f58; font-size: 12px; margin-top: 16px; }
  .footer a { color: #58a6ff; text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <h1>${chartTitle}</h1>
  <div class="subtitle">${chartSubtitle}</div>
  <div class="range-buttons">
    <button class="range-btn active" data-range="all">All Time</button>
    <button class="range-btn" data-range="year">Past Year</button>
    <button class="range-btn" data-range="month">Past Month</button>
    <button class="range-btn" data-range="week">Past Week</button>
    <button class="range-btn" data-range="day">Past 24h</button>${granularityToggle}
  </div>
  <div id="chart"></div>
  <div class="footer">Generated by <a href="https://github.com/ykdojo/gh-star-history" target="_blank">ykdojo/gh-star-history</a></div>
</div>

<script>
const repoData = ${clientRepoData};
const multiMode = ${multiMode};

// Convert UTC dates to local timezone for display
function utcToLocal(isoStr) {
  const d = new Date(isoStr);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + 'T' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
}
repoData.forEach(d => {
  d.dates = d.dates.map(utcToLocal);
  // Re-aggregate daily/hourly in local timezone
  if (d.dailyDates) {
    const dailyCounts = {};
    d.dates.forEach(t => {
      const day = t.slice(0, 10);
      dailyCounts[day] = (dailyCounts[day] || 0) + 1;
    });
    d.dailyDates = Object.keys(dailyCounts).sort();
    d.dailyValues = d.dailyDates.map(k => dailyCounts[k]);
  }
  if (d.hourlyDates) {
    const hourlyCounts = {};
    d.dates.forEach(t => {
      const hour = t.slice(0, 13);
      hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
    });
    const sortedHours = Object.keys(hourlyCounts).sort();
    d.hourlyDates = sortedHours.map(h => h + ':00:00');
    d.hourlyValues = sortedHours.map(h => hourlyCounts[h]);
  }
});

const chartEl = document.getElementById('chart');

// Build traces
const traces = [];
repoData.forEach(d => {
  traces.push({
    x: d.dates,
    y: d.cumulative,
    fill: multiMode ? 'none' : 'tozeroy',
    fillcolor: d.fillColor,
    line: { color: d.color, width: 2.5 },
    name: multiMode ? d.repo : 'Total Stars',
    hovertemplate: multiMode
      ? d.repo + '<br>%{x|%b %d, %Y}<br>%{y:,} stars<extra></extra>'
      : '%{x|%b %d, %Y %H:%M}<br>%{y:,} stars<extra></extra>'
  });
});

// Bar traces (single-repo only)
if (!multiMode) {
  const d = repoData[0];
  traces.push({
    x: d.dailyDates,
    y: d.dailyValues,
    type: 'bar',
    marker: { color: d.barColor },
    name: 'Stars / Day',
    yaxis: 'y2',
    hovertemplate: '%{x|%b %d, %Y}<br>%{y} stars that day<extra></extra>'
  });
}

const baseLayout = {
  template: 'plotly_dark',
  paper_bgcolor: '#0d1117',
  plot_bgcolor: '#0d1117',
  xaxis: {
    gridcolor: '#21262d',
    color: '#8b949e',
  },
  yaxis: {
    title: { text: 'Total Stars', font: { color: '#8b949e' } },
    gridcolor: '#21262d',
    color: '#8b949e'
  },
  hovermode: 'x unified',
  showlegend: multiMode,
  legend: multiMode ? { font: { color: '#c9d1d9' }, bgcolor: 'transparent' } : undefined,
  margin: { t: 40, r: 60, b: 50, l: 60 },
  height: 500,
};

if (!multiMode) {
  baseLayout.yaxis2 = {
    title: { text: '', font: { color: '#8b949e' } },
    overlaying: 'y',
    side: 'right',
    gridcolor: '#21262d',
    color: '#8b949e'
  };
}

const plotConfig = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d']
};

// Compute lastDate across all repos
const allDates = repoData.flatMap(d => d.dates).sort();
const lastDateStr = allDates[allDates.length - 1];
const lastDate = new Date(lastDateStr).getTime();
const ranges = {
  all: null,
  year: [utcToLocal(new Date(lastDate - 365*24*60*60*1000).toISOString()), lastDateStr],
  month: [utcToLocal(new Date(lastDate - 30*24*60*60*1000).toISOString()), lastDateStr],
  week: [utcToLocal(new Date(lastDate - 7*24*60*60*1000).toISOString()), lastDateStr],
  day: [utcToLocal(new Date(lastDate - 24*60*60*1000).toISOString()), lastDateStr],
};

// Initial render
Plotly.newPlot(chartEl, traces, baseLayout, plotConfig);

// Granularity (single-repo only)
let currentBar = 'daily';

if (!multiMode) {
  const d = repoData[0];
  const barIndex = traces.length - 1;

  function setGranularity(granularity) {
    if (granularity === currentBar) return;
    if (granularity === 'hourly') {
      Plotly.restyle(chartEl, { x: [d.hourlyDates], y: [d.hourlyValues], name: 'Stars / Hour', hovertemplate: '%{x|%b %d %H:00}<br>%{y} stars that hour<extra></extra>' }, [barIndex]);
    } else {
      Plotly.restyle(chartEl, { x: [d.dailyDates], y: [d.dailyValues], name: 'Stars / Day', hovertemplate: '%{x|%b %d, %Y}<br>%{y} stars that day<extra></extra>' }, [barIndex]);
    }
    currentBar = granularity;
    document.querySelectorAll('[data-granularity]').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector('[data-granularity="' + granularity + '"]');
    if (activeBtn) activeBtn.classList.add('active');
  }

  // Granularity toggle handlers
  document.querySelectorAll('[data-granularity]').forEach(btn => {
    btn.addEventListener('click', () => {
      setGranularity(btn.dataset.granularity);
      requestAnimationFrame(() => {
        const y2Title = currentBar === 'hourly' ? 'Stars / Hour' : 'Stars / Day';
        Plotly.relayout(chartEl, { 'yaxis2.title.text': y2Title });
      });
    });
  });

  // Range button handlers (with granularity auto-switch)
  document.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const r = btn.dataset.range;
      const autoGranularity = (r === 'day' || r === 'week') ? 'hourly' : 'daily';
      setGranularity(autoGranularity);
      requestAnimationFrame(() => {
        const y2Title = currentBar === 'hourly' ? 'Stars / Hour' : 'Stars / Day';
        if (ranges[r]) {
          Plotly.relayout(chartEl, { 'xaxis.autorange': false, 'xaxis.range': ranges[r], 'yaxis2.title.text': y2Title });
        } else {
          Plotly.relayout(chartEl, { 'xaxis.autorange': true, 'yaxis2.title.text': y2Title });
        }
      });
    });
  });
} else {
  // Range button handlers (multi-mode, no granularity)
  document.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const r = btn.dataset.range;
      requestAnimationFrame(() => {
        if (ranges[r]) {
          Plotly.relayout(chartEl, { 'xaxis.autorange': false, 'xaxis.range': ranges[r] });
        } else {
          Plotly.relayout(chartEl, { 'xaxis.autorange': true });
        }
      });
    });
  });
}
<\/script>
</body>
</html>`;

fs.writeFileSync(outputPath, html);
console.log(`Saved to ${outputPath}`);

// --- Open in browser ---

if (!flags.noOpen) {
    const platform = os.platform();
    try {
      if (platform === 'darwin') {
        execSync(`open "${outputPath}"`);
      } else if (platform === 'win32') {
        execSync(`start "" "${outputPath}"`);
      } else {
        execSync(`xdg-open "${outputPath}" 2>/dev/null || sensible-browser "${outputPath}" 2>/dev/null || true`);
      }
    } catch {
      // Silently ignore if browser can't be opened
    }
  }
}

main();
