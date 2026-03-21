#!/usr/bin/env node

const { execSync, exec: execCb } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(execCb);

// Location-to-region mapping for region breakdown chart
const locationMapPath = path.join(os.homedir(), '.gh-star-history', 'location_region_map.json');
const locationMap = fs.existsSync(locationMapPath)
  ? JSON.parse(fs.readFileSync(locationMapPath, 'utf8'))
  : {};

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
  } else if (args[i] === '--top' && args[i + 1]) {
    flags.top = parseInt(args[++i], 10);
  } else if (args[i].startsWith('--top=')) {
    flags.top = parseInt(args[i].split('=')[1], 10);
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
    --output <path>  Output file path (default: ~/.gh-star-history/star-history.html)
    --no-open        Don't auto-open the browser
    --no-cache       Skip cache and fetch fresh data
    --top <n>        Number of top regions to show (default: 34)
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
const defaultFilename = repoList.map(r => r.replace('/', '__')).join('__') + '_regions.html';
const outputPath = flags.output || path.join(os.homedir(), '.gh-star-history', defaultFilename);

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
  return path.join(cacheDir, repo.replace('/', '__') + '__locations.json');
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
    else if (p.done) status = `${p.total.toLocaleString()} done`;
    else if (p.error) status = `error: ${p.error}`;
    else {
      const fetchedNum = p.total ? Math.min(p.fetched, p.total) : p.fetched;
      status = `${fetchedNum.toLocaleString()} / ${p.total ? p.total.toLocaleString() : '?'}${p.cached ? ' (cached)' : ''}`;
    }
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
  const locations = cursor ? [...(cachedEntry.locations || [])] : [];
  let starCount = (cachedEntry && cachedEntry.starCount) || null;

  onProgress({ fetched: dates.length, total: starCount, cached: dates.length > 0 });

  let batch = 0;

  while (true) {
    const afterArg = cursor ? `, after: "${cursor}"` : '';
    const query = `{ repository(owner: "${owner}", name: "${name}") { stargazers(first: 100${afterArg}) { totalCount pageInfo { hasNextPage endCursor } edges { starredAt node { location } } } } }`;

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
        // Sort dates and locations together
        const paired = dates.map((d, i) => [d, locations[i]]);
        paired.sort((a, b) => a[0] < b[0] ? -1 : 1);
        for (let j = 0; j < paired.length; j++) { dates[j] = paired[j][0]; locations[j] = paired[j][1]; }
        saveRepoCache(repo, { dates, locations, starCount: starCount || dates.length, cursor });
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
      if (edge.starredAt) {
        dates.push(edge.starredAt);
        locations.push((edge.node && edge.node.location) || '');
      }
    }

    cursor = pageInfo.endCursor;
    batch++;

    // Save cache after every batch - sort dates and locations together
    const paired = dates.map((d, i) => [d, locations[i]]);
    paired.sort((a, b) => a[0] < b[0] ? -1 : 1);
    for (let j = 0; j < paired.length; j++) { dates[j] = paired[j][0]; locations[j] = paired[j][1]; }
    saveRepoCache(repo, { dates, locations, starCount, cursor });

    onProgress({ fetched: dates.length, total: starCount });

    if (!pageInfo.hasNextPage) break;
  }

  // Sort dates and locations together
  {
    const p = dates.map((d, i) => [d, locations[i]]);
    p.sort((a, b) => a[0] < b[0] ? -1 : 1);
    for (let j = 0; j < p.length; j++) { dates[j] = p[j][0]; locations[j] = p[j][1]; }
  }
  const displayCount = starCount || dates.length;

  // Map locations to regions
  const regionPerStar = locations.map(loc => {
    if (!loc) return null;
    const region = locationMap[loc];
    if (!region || region === 'Unknown') return null;
    return region;
  });

  // Aggregate daily region counts (excluding unknown)
  const dailyRegionMap = {}; // day -> region -> count
  for (let i = 0; i < dates.length; i++) {
    const region = regionPerStar[i];
    if (!region) continue;
    const day = dates[i].slice(0, 10);
    if (!dailyRegionMap[day]) dailyRegionMap[day] = {};
    dailyRegionMap[day][region] = (dailyRegionMap[day][region] || 0) + 1;
  }

  // Collect all regions sorted by total count
  const defaultTopN = flags.top || 34;
  const totalByRegion = {};
  for (const day of Object.keys(dailyRegionMap)) {
    for (const [region, count] of Object.entries(dailyRegionMap[day])) {
      totalByRegion[region] = (totalByRegion[region] || 0) + count;
    }
  }
  const allRegionNames = Object.entries(totalByRegion)
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);

  // Build region daily data for ALL regions
  const regionDailyDates = Object.keys(dailyRegionMap).sort();
  const regionDailyData = {};
  for (const region of allRegionNames) {
    regionDailyData[region] = regionDailyDates.map(day =>
      (dailyRegionMap[day] && dailyRegionMap[day][region]) || 0
    );
  }

  // Aggregate hourly region counts for ALL regions
  const hourlyRegionMap = {}; // hour -> region -> count
  for (let i = 0; i < dates.length; i++) {
    const region = regionPerStar[i];
    if (!region) continue;
    const hour = dates[i].slice(0, 13);
    if (!hourlyRegionMap[hour]) hourlyRegionMap[hour] = {};
    hourlyRegionMap[hour][region] = (hourlyRegionMap[hour][region] || 0) + 1;
  }
  const regionHourlyDates = Object.keys(hourlyRegionMap).sort().map(h => h + ':00:00Z');
  const regionHourlyData = {};
  for (const region of allRegionNames) {
    regionHourlyData[region] = Object.keys(hourlyRegionMap).sort().map(h =>
      (hourlyRegionMap[h] && hourlyRegionMap[h][region]) || 0
    );
  }

  const knownCount = Object.values(totalByRegion).reduce((a, b) => a + b, 0);

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

  return { dates, cumulative, dailyDates, dailyValues, hourlyDates, hourlyValues, displayCount, regionDailyDates, regionDailyData, regionHourlyDates, regionHourlyData, allRegionNames, defaultTopN, knownCount };
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
        const fetchedNum = p.total ? Math.min(p.fetched, p.total) : p.fetched;
        const fetched = fetchedNum.toLocaleString();
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

// Build the command for re-running
const cmdParts = ['node bin/cli-region.js', ...repoList];
if (flags.style && flags.style !== 'blue') cmdParts.push('--style', flags.style);
if (flags.output) cmdParts.push('--output', flags.output);
const rerunCommand = cmdParts.join(' ');

const s = multiMode ? null : styles[style];
const d0 = repoData[0]; // first repo (used for single-mode)

const chartTitle = multiMode
  ? 'Star history comparison'
  : `<a href="https://github.com/${d0.repo}" target="_blank">${d0.repo}</a>`;

const chartSubtitle = multiMode
  ? repoData.map(d => `<a href="https://github.com/${d.repo}" target="_blank" style="color:#8b949e">${d.repo}</a>`).join(' vs ')
  : `<span id="star-info">${d0.displayCount.toLocaleString()} stars</span> · <span id="rate"></span>`;

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
  regionDailyDates: d.regionDailyDates,
  regionDailyData: d.regionDailyData,
  regionHourlyDates: d.regionHourlyDates,
  regionHourlyData: d.regionHourlyData,
  allRegionNames: d.allRegionNames,
  defaultTopN: d.defaultTopN,
  displayCount: d.displayCount,
  knownCount: d.knownCount,
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
  .range-select {
    background: #161b22; color: #c9d1d9; border: 1px solid #30363d;
    padding: 6px 12px; border-radius: 6px; cursor: pointer;
    font-size: 13px; font-family: inherit; outline: none;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238b949e' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center; padding-right: 28px;
  }
  .range-select:hover { border-color: #58a6ff; }
  .date-input {
    background: #161b22; color: #c9d1d9; border: 1px solid #30363d;
    padding: 5px 8px; border-radius: 6px; font-size: 13px; font-family: inherit;
    outline: none; color-scheme: dark; margin-left: 8px;
  }
  .date-input:hover { border-color: #58a6ff; }
  .range-btn {
    background: #161b22; color: #c9d1d9; border: 1px solid #30363d;
    padding: 6px 16px; margin: 0 4px; border-radius: 6px; cursor: pointer;
    font-size: 13px; font-family: inherit;
  }
  .range-btn:hover { border-color: #58a6ff; }
  .range-btn.active { background: #21262d; border-color: #58a6ff; color: #e6edf3; }
  .footer { text-align: center; color: #484f58; font-size: 12px; margin-top: 16px; }
  .footer a { color: #58a6ff; text-decoration: none; }
  .footer code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
</style>
</head>
<body>
<div class="container">
  <h1>${chartTitle}</h1>
  <div class="subtitle">${chartSubtitle}</div>
  <div class="range-buttons">
    <select id="range-select" class="range-select">
      <option value="all" selected>All Time</option>
      <option value="past">Past...</option>
      <option value="custom">Custom Range</option>
    </select>
    <select id="past-select" class="range-select" style="display:none;margin-left:8px">
      <option value="year">Year</option>
      <option value="6months">6 Months</option>
      <option value="3months">3 Months</option>
      <option value="month">Month</option>
      <option value="week">Week</option>
      <option value="day">24h</option>
    </select>
    <span id="custom-range" style="display:none">
      <input type="date" id="start-date" class="date-input">
      <span style="color:#8b949e;margin-left:8px">to</span>
      <input type="date" id="end-date" class="date-input">
    </span>${granularityToggle}
  </div>
  <div id="chart"></div>
  <div id="region-section" style="display:none; margin-top: 32px;">
    <h2 style="text-align:center; font-size:18px; color:#e6edf3; margin-bottom:4px;">Stars by region</h2>
    <div id="region-subtitle" style="text-align:center; color:#8b949e; font-size:13px; margin-bottom:12px;"></div>
    <div style="text-align:center; margin-bottom:12px;">
      <span style="color:#8b949e; font-size:13px;">Top</span>
      <input type="number" id="top-n-input" class="date-input" style="width:60px;margin-left:4px;text-align:center" min="1">
      <span style="color:#8b949e; font-size:13px; margin-left:4px;">regions</span>
    </div>
    <div id="region-chart"></div>
    <h2 style="text-align:center; font-size:18px; color:#e6edf3; margin: 32px 0 12px 0;">Overall region breakdown</h2>
    <div id="region-totals-chart"></div>
  </div>
  <div class="footer">Generated by <a href="https://github.com/ykdojo/gh-star-history" target="_blank">ykdojo/gh-star-history</a> | <code>${rerunCommand}</code> <a href="#" onclick="event.preventDefault();navigator.clipboard.writeText('${rerunCommand}').then(()=>{this.textContent='copied!';setTimeout(()=>this.textContent='copy',1500)})" style="color:#58a6ff;text-decoration:none;font-size:11px">copy</a></div>
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

// Compute date range across all repos
const allDates = repoData.flatMap(d => d.dates).sort();
const firstDateStr = allDates[0];
const lastDateStr = allDates[allDates.length - 1];
const firstDate = new Date(firstDateStr).getTime();
const lastDate = new Date(lastDateStr).getTime();
const totalSpanMs = lastDate - firstDate;

// Hide past-select options that exceed the data range, default to longest visible
const pastSelect = document.getElementById('past-select');
const periodThresholds = [
  { value: 'year', ms: 365*24*60*60*1000 },
  { value: '6months', ms: 182*24*60*60*1000 },
  { value: '3months', ms: 91*24*60*60*1000 },
  { value: 'month', ms: 30*24*60*60*1000 },
  { value: 'week', ms: 7*24*60*60*1000 },
  { value: 'day', ms: 24*60*60*1000 },
];
let defaultPast = 'day';
periodThresholds.forEach(p => {
  const opt = pastSelect.querySelector('option[value="' + p.value + '"]');
  if (totalSpanMs < p.ms) {
    if (opt) opt.style.display = 'none';
  } else {
    if (!defaultPast || periodThresholds.findIndex(x => x.value === p.value) < periodThresholds.findIndex(x => x.value === defaultPast)) {
      defaultPast = p.value;
    }
  }
});
pastSelect.value = defaultPast;

// Set min/max for custom date inputs
const startInput = document.getElementById('start-date');
const endInput = document.getElementById('end-date');
const customSpan = document.getElementById('custom-range');
if (startInput && endInput) {
  const minDate = firstDateStr.slice(0, 10);
  const maxDate = lastDateStr.slice(0, 10);
  startInput.min = minDate; startInput.max = maxDate;
  endInput.min = minDate; endInput.max = maxDate;
  startInput.value = minDate; endInput.value = maxDate;
}

const ranges = {
  all: null,
  year: [utcToLocal(new Date(lastDate - 365*24*60*60*1000).toISOString()), lastDateStr],
  '6months': [utcToLocal(new Date(lastDate - 182*24*60*60*1000).toISOString()), lastDateStr],
  '3months': [utcToLocal(new Date(lastDate - 91*24*60*60*1000).toISOString()), lastDateStr],
  month: [utcToLocal(new Date(lastDate - 30*24*60*60*1000).toISOString()), lastDateStr],
  week: [utcToLocal(new Date(lastDate - 7*24*60*60*1000).toISOString()), lastDateStr],
  day: [utcToLocal(new Date(lastDate - 24*60*60*1000).toISOString()), lastDateStr],
};

// Initial render
Plotly.newPlot(chartEl, traces, baseLayout, plotConfig);

// Granularity (single-repo only)
let currentBar = 'daily';
let currentRange = 'all';

if (!multiMode) {
  const d = repoData[0];
  const barIndex = traces.length - 1;

  // Pre-compute timestamps for star dates
  // Exclude the last synthetic "now" entry used to extend the chart line
  const starTimestamps = d.dates.slice(0, -1).map(dt => new Date(dt).getTime());

  function countStarsInRange(startMs, endMs) {
    let count = 0;
    for (let i = 0; i < starTimestamps.length; i++) {
      if (starTimestamps[i] >= startMs && starTimestamps[i] <= endMs) count++;
    }
    return count;
  }

  function countStarsBefore(ms) {
    let count = 0;
    for (let i = 0; i < starTimestamps.length; i++) {
      if (starTimestamps[i] < ms) count++;
    }
    return count;
  }

  function updateRate() {
    const rateEl = document.getElementById('rate');
    const starInfoEl = document.getElementById('star-info');
    if (!rateEl) return;
    const dataStart = starTimestamps[0];
    const isAllTime = !ranges[currentRange];
    const rangeStart = isAllTime ? dataStart : new Date(ranges[currentRange][0]).getTime();
    const rangeEnd = isAllTime ? starTimestamps[starTimestamps.length - 1] : new Date(ranges[currentRange][1]).getTime();
    const starsInRange = countStarsInRange(rangeStart, rangeEnd);
    const hours = (rangeEnd - rangeStart) / (1000 * 60 * 60);

    // Update star info
    if (starInfoEl) {
      if (isAllTime) {
        const totalMs = rangeEnd - dataStart;
        const totalDays = Math.floor(totalMs / (24 * 60 * 60 * 1000));
        const totalMonths = Math.floor(totalMs / (30.44 * 24 * 60 * 60 * 1000));
        const years = Math.floor(totalMonths / 12);
        const months = totalMonths % 12;
        const remainderDays = totalDays - Math.floor(totalMonths * 30.44);
        let duration = '';
        if (years >= 1) {
          duration = years + (years === 1 ? ' year' : ' years');
          if (months > 0) duration += ', ' + months + (months === 1 ? ' month' : ' months');
        } else {
          duration = months + (months === 1 ? ' month' : ' months');
          if (remainderDays > 0) duration += ', ' + remainderDays + (remainderDays === 1 ? ' day' : ' days');
        }
        starInfoEl.textContent = d.cumulative[d.cumulative.length - 1].toLocaleString() + ' stars (over ' + duration + ')';
      } else {
        const startCount = countStarsBefore(rangeStart);
        const endCount = startCount + starsInRange;
        starInfoEl.innerHTML = startCount.toLocaleString() + ' \u2192 ' + endCount.toLocaleString() + ' <span style="color:#3fb950">(+' + starsInRange.toLocaleString() + ' stars)</span>';
      }
    }

    const days = hours / 24;
    const perDay = days > 0 ? (starsInRange / days).toFixed(1) : '0';
    let rateText = perDay + ' stars/day';

    // Compare with previous equivalent period
    const durationMs = rangeEnd - rangeStart;
    const prevEnd = rangeStart;
    const prevStart = rangeStart - durationMs;
    if (prevStart >= dataStart && durationMs > 0) {
      const prevStars = countStarsInRange(prevStart, prevEnd);
      const prevRate = prevStars / (durationMs / (1000 * 60 * 60 * 24));
      const currRate = starsInRange / (durationMs / (1000 * 60 * 60 * 24));
      if (prevRate > 0) {
        const pctChange = ((currRate - prevRate) / prevRate * 100).toFixed(1);
        const sign = pctChange >= 0 ? '+' : '';
        const color = pctChange >= 0 ? '#3fb950' : '#f85149';
        rateText += ' <span style="color:' + color + '">' + sign + pctChange + '%</span>';
      }
    }

    rateEl.innerHTML = rateText;
  }

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
    if (updateRegionGranularity) updateRegionGranularity(granularity);
    updateRate();
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

  function applyRange() {
    const autoGranularity = (currentRange === 'day' || currentRange === 'week') ? 'hourly' : 'daily';
    setGranularity(autoGranularity);
    updateRate();
    requestAnimationFrame(() => {
      const y2Title = currentBar === 'hourly' ? 'Stars / Hour' : 'Stars / Day';
      if (ranges[currentRange]) {
        Plotly.relayout(chartEl, { 'xaxis.autorange': false, 'xaxis.range': ranges[currentRange], 'yaxis2.title.text': y2Title });
        if (updateRegionRange) updateRegionRange(currentRange);
      } else {
        Plotly.relayout(chartEl, { 'xaxis.autorange': true, 'yaxis2.title.text': y2Title });
        if (updateRegionRange) updateRegionRange(currentRange);
      }
      if (updateTotalsChart) updateTotalsChart(currentRange);
    });
  }

  // Range select handler
  document.getElementById('range-select').addEventListener('change', function() {
    pastSelect.style.display = this.value === 'past' ? 'inline-block' : 'none';
    customSpan.style.display = this.value === 'custom' ? 'inline' : 'none';
    if (this.value === 'past') {
      currentRange = pastSelect.value;
    } else if (this.value === 'custom') {
      ranges.custom = [startInput.value, endInput.value + 'T23:59:59'];
      currentRange = 'custom';
    } else {
      currentRange = 'all';
    }
    applyRange();
  });

  // Past period select handler
  pastSelect.addEventListener('change', function() {
    currentRange = this.value;
    applyRange();
  });

  // Custom date input handlers
  [startInput, endInput].forEach(input => {
    input.addEventListener('change', () => {
      if (startInput.value && endInput.value) {
        ranges.custom = [startInput.value, endInput.value + 'T23:59:59'];
        currentRange = 'custom';
        applyRange();
      }
    });
  });

  // Initial rate
  updateRate();
} else {
  // Range select handler (multi-mode, no granularity)
  document.getElementById('range-select').addEventListener('change', function() {
    pastSelect.style.display = this.value === 'past' ? 'inline-block' : 'none';
    customSpan.style.display = this.value === 'custom' ? 'inline' : 'none';
    let r;
    if (this.value === 'past') {
      r = pastSelect.value;
    } else if (this.value === 'custom') {
      ranges.custom = [startInput.value, endInput.value + 'T23:59:59'];
      r = 'custom';
    } else {
      r = 'all';
    }
    requestAnimationFrame(() => {
      if (ranges[r]) {
        Plotly.relayout(chartEl, { 'xaxis.autorange': false, 'xaxis.range': ranges[r] });
      } else {
        Plotly.relayout(chartEl, { 'xaxis.autorange': true });
      }
    });
  });

  // Past period select handler (multi-mode)
  pastSelect.addEventListener('change', function() {
    const r = this.value;
    requestAnimationFrame(() => {
      if (ranges[r]) {
        Plotly.relayout(chartEl, { 'xaxis.autorange': false, 'xaxis.range': ranges[r] });
      } else {
        Plotly.relayout(chartEl, { 'xaxis.autorange': true });
      }
    });
  });

  // Custom date input handlers (multi-mode)
  [startInput, endInput].forEach(input => {
    input.addEventListener('change', () => {
      if (startInput.value && endInput.value) {
        ranges.custom = [startInput.value, endInput.value + 'T23:59:59'];
        requestAnimationFrame(() => {
          Plotly.relayout(chartEl, { 'xaxis.autorange': false, 'xaxis.range': ranges.custom });
        });
      }
    });
  });
}
let updateTotalsChart = null;
let updateRegionGranularity = null;
let updateRegionRange = null;
// --- Region breakdown chart (single-repo only) ---
const regionChartEl = document.getElementById('region-chart');
const regionColors = [
  '#5B8FF9', '#E8684A', '#5AD8A6', '#F6BD16', '#6DC8EC',
  '#9270CA', '#F08BB4', '#7DD1B3', '#E8A65D', '#78D3F8',
  '#D4E157', '#FF8A65', '#4DD0E1', '#BA68C8', '#A1887F',
  '#90A4AE', '#F48FB1', '#80CBC4', '#FFD54F', '#CE93D8',
  '#AED581', '#4FC3F7', '#FF7043', '#7986CB', '#FFF176',
  '#E57373', '#81C784', '#64B5F6', '#FFB74D', '#9575CD',
  '#C5E1A5', '#EF9A9A', '#80DEEA', '#B39DDB', '#FFCC80',
  '#A5D6A7', '#90CAF9', '#FFAB91', '#CE93D8', '#FFF59D',
  '#F48FB1', '#B0BEC5',
  '#5D7092'
];

if (!multiMode && regionChartEl) {
  const d = repoData[0];
  if (d.regionDailyDates && d.allRegionNames && d.allRegionNames.length > 0) {
    document.getElementById('region-section').style.display = 'block';
    const regionSubtitleEl = document.getElementById('region-subtitle');

    // Set up top N input
    const topNInput = document.getElementById('top-n-input');
    let currentTopN = d.defaultTopN;
    topNInput.value = currentTopN;
    topNInput.max = d.allRegionNames.length;

    // Re-aggregate ALL region dates in local timezone (daily)
    const regionLocalDaily = {};
    d.regionDailyDates.forEach((utcDay, idx) => {
      const localDay = utcToLocal(utcDay + 'T12:00:00Z').slice(0, 10);
      d.allRegionNames.forEach(region => {
        if (!regionLocalDaily[region]) regionLocalDaily[region] = {};
        regionLocalDaily[region][localDay] = (regionLocalDaily[region][localDay] || 0) + (d.regionDailyData[region][idx] || 0);
      });
    });
    // Re-aggregate ALL region dates in local timezone (hourly)
    const regionLocalHourly = {};
    if (d.regionHourlyDates) {
      d.regionHourlyDates.forEach((utcHour, idx) => {
        const localHour = utcToLocal(utcHour).slice(0, 13);
        d.allRegionNames.forEach(region => {
          if (!regionLocalHourly[region]) regionLocalHourly[region] = {};
          regionLocalHourly[region][localHour] = (regionLocalHourly[region][localHour] || 0) + (d.regionHourlyData[region][idx] || 0);
        });
      });
    }
    const localDays = [...new Set(d.regionDailyDates.map(utcDay => utcToLocal(utcDay + 'T12:00:00Z').slice(0, 10)))].sort();
    const localHours = d.regionHourlyDates ? [...new Set(d.regionHourlyDates.map(utcHour => utcToLocal(utcHour).slice(0, 13)))].sort() : [];

    function updateRegionSubtitle(rangeKey) {
      const isAll = !ranges[rangeKey];
      const r = ranges[rangeKey];
      const startMs = r ? new Date(r[0]).getTime() : 0;
      const endMs = r ? new Date(r[1]).getTime() : Infinity;
      let knownInRange = 0;
      localDays.forEach(day => {
        const t = new Date(day).getTime();
        if (t < startMs || t > endMs) return;
        d.allRegionNames.forEach(region => {
          knownInRange += (regionLocalDaily[region] && regionLocalDaily[region][day]) || 0;
        });
      });
      let totalInRange;
      if (isAll) {
        totalInRange = d.displayCount;
      } else {
        totalInRange = 0;
        for (let i = 0; i < d.dates.length - 1; i++) {
          const t = new Date(d.dates[i]).getTime();
          if (t >= startMs && t <= endMs) totalInRange++;
        }
      }
      regionSubtitleEl.textContent = knownInRange.toLocaleString() + ' of ' + totalInRange.toLocaleString() + ' stargazers have a public location set';
    }
    updateRegionSubtitle('all');

    let currentRegionGranularity = 'daily';

    // Compute top N regions for a given date range, return { topRegions, displayRegions (with Other) }
    function computeTopRegions(topN, rangeKey) {
      const r = ranges[rangeKey];
      const startMs = r ? new Date(r[0]).getTime() : 0;
      const endMs = r ? new Date(r[1]).getTime() : Infinity;
      const filteredDays = localDays.filter(day => {
        const t = new Date(day).getTime();
        return t >= startMs && t <= endMs;
      });
      // Sum each region's stars in the range
      const totals = d.allRegionNames.map(region => {
        const total = filteredDays.reduce((s, day) => s + ((regionLocalDaily[region] && regionLocalDaily[region][day]) || 0), 0);
        return { region, total };
      }).filter(r => r.total > 0).sort((a, b) => b.total - a.total);

      const topRegions = totals.slice(0, topN).map(r => r.region);
      const otherRegions = totals.slice(topN).map(r => r.region);
      return { topRegions, otherRegions, filteredDays };
    }

    // Build color map - assign colors based on all-time rank so colors stay stable
    const colorByRegion = { 'Other': '#5D7092' };
    d.allRegionNames.forEach((region, i) => { colorByRegion[region] = regionColors[i % regionColors.length]; });

    // Build trace data for a set of display regions (topRegions + Other)
    function buildTraceData(topRegions) {
      const displayRegions = [...topRegions, 'Other'];
      const td = {};
      ['daily', 'hourly'].forEach(gran => {
        const timeBuckets = gran === 'hourly' ? localHours : localDays;
        const regionLocal = gran === 'hourly' ? regionLocalHourly : regionLocalDaily;
        // Compute "Other" values
        const otherVals = {};
        timeBuckets.forEach(bucket => {
          let other = 0;
          d.allRegionNames.forEach(region => {
            if (!topRegions.includes(region)) {
              other += (regionLocal[region] && regionLocal[region][bucket]) || 0;
            }
          });
          otherVals[bucket] = other;
        });
        // Top 7 per bucket for stacked chart visibility
        const top7PerBucket = {};
        timeBuckets.forEach(bucket => {
          const entries = displayRegions
            .map(c => ({ c, v: c === 'Other' ? otherVals[bucket] : ((regionLocal[c] && regionLocal[c][bucket]) || 0) }))
            .filter(e => e.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 7);
          top7PerBucket[bucket] = new Set(entries.map(e => e.c));
        });
        const xVals = gran === 'hourly' ? timeBuckets.map(h => h + ':00:00') : timeBuckets;
        td[gran] = {};
        displayRegions.forEach(region => {
          td[gran][region] = {
            x: xVals,
            y: timeBuckets.map(bucket => {
              const v = region === 'Other' ? otherVals[bucket] : ((regionLocal[region] && regionLocal[region][bucket]) || 0);
              if (v === 0 || !top7PerBucket[bucket].has(region)) return null;
              return v;
            })
          };
        });
      });
      return td;
    }

    // Initial computation
    let { topRegions, otherRegions } = computeTopRegions(currentTopN, 'all');
    let displayRegions = [...topRegions, 'Other'];
    let traceData = buildTraceData(topRegions);

    // Build initial traces (daily)
    function buildRegionTraces(displayRegs, td, gran) {
      const reversed = [...displayRegs].reverse();
      return reversed.map(region => ({
        x: td[gran][region].x,
        y: td[gran][region].y,
        type: 'bar',
        name: region,
        marker: { color: colorByRegion[region] },
        hovertemplate: region + ': %{y}<extra></extra>'
      }));
    }

    const regionLayout = {
      template: 'plotly_dark',
      paper_bgcolor: '#0d1117',
      plot_bgcolor: '#0d1117',
      barmode: 'stack',
      xaxis: { gridcolor: '#21262d', color: '#8b949e' },
      yaxis: { title: { text: 'Stars / Day', font: { color: '#8b949e' } }, gridcolor: '#21262d', color: '#8b949e' },
      hovermode: 'x unified',
      showlegend: true,
      legend: { font: { color: '#c9d1d9' }, bgcolor: 'transparent', orientation: 'h', y: -0.15, traceorder: 'reversed' },
      margin: { t: 20, r: 30, b: 50, l: 60 },
      height: 350,
    };

    Plotly.newPlot(regionChartEl, buildRegionTraces(displayRegions, traceData, 'daily'), regionLayout, plotConfig);

    // Full rebuild of both region charts
    // Compute max stacked y value within a date range for the region chart
    function getRegionYMax(gran, displayRegs, td) {
      const r = ranges[currentRange];
      const startMs = r ? new Date(r[0]).getTime() : 0;
      const endMs = r ? new Date(r[1]).getTime() : Infinity;
      const xVals = td[gran][displayRegs[0]].x;
      let maxStack = 0;
      for (let i = 0; i < xVals.length; i++) {
        const t = new Date(xVals[i]).getTime();
        if (t < startMs || t > endMs) continue;
        let stack = 0;
        for (const region of displayRegs) {
          const v = td[gran][region].y[i];
          if (v) stack += v;
        }
        if (stack > maxStack) maxStack = stack;
      }
      return maxStack;
    }

    function rebuildRegionCharts() {
      const result = computeTopRegions(currentTopN, currentRange);
      topRegions = result.topRegions;
      otherRegions = result.otherRegions;
      displayRegions = [...topRegions, 'Other'];
      traceData = buildTraceData(topRegions);
      updateRegionSubtitle(currentRange);

      const gran = currentRegionGranularity;
      const yTitle = gran === 'hourly' ? 'Stars / Hour' : 'Stars / Day';
      const r = ranges[currentRange];
      const yMax = getRegionYMax(gran, displayRegions, traceData);

      // Rebuild stacked bar chart
      const layout = Object.assign({}, regionLayout, {
        yaxis: Object.assign({}, regionLayout.yaxis, {
          title: { text: yTitle, font: { color: '#8b949e' } },
          autorange: false, range: [0, yMax > 0 ? yMax * 1.1 : 1],
        }),
        xaxis: r ? Object.assign({}, regionLayout.xaxis, { autorange: false, range: r }) : Object.assign({}, regionLayout.xaxis, { autorange: true }),
      });
      Plotly.react(regionChartEl, buildRegionTraces(displayRegions, traceData, gran), layout, plotConfig);

      // Rebuild totals chart
      rebuildTotalsChart(result);

      // Ensure stacked chart doesn't collapse after totals chart resizes
      requestAnimationFrame(() => Plotly.Plots.resize(regionChartEl));
    }

    function rebuildTotalsChart(result) {
      const totalsEl = document.getElementById('region-totals-chart');
      if (!totalsEl) return;
      const { topRegions: topRegs, otherRegions: otherRegs, filteredDays } = result || computeTopRegions(currentTopN, currentRange);

      // Compute totals for display
      const regionTotals = [];
      topRegs.forEach(region => {
        const total = filteredDays.reduce((s, day) => s + ((regionLocalDaily[region] && regionLocalDaily[region][day]) || 0), 0);
        if (total > 0) regionTotals.push({ region, total });
      });
      // Other total
      let otherTotal = 0;
      const otherBreakdownAll = [];
      otherRegs.forEach(region => {
        const total = filteredDays.reduce((s, day) => s + ((regionLocalDaily[region] && regionLocalDaily[region][day]) || 0), 0);
        if (total > 0) {
          otherTotal += total;
          otherBreakdownAll.push({ region, total });
        }
      });
      if (otherTotal > 0) regionTotals.push({ region: 'Other', total: otherTotal });

      // Sort: Other first (bottom), then ascending
      regionTotals.sort((a, b) => {
        if (a.region === 'Other') return -1;
        if (b.region === 'Other') return 1;
        return a.total - b.total;
      });

      const rangeKnown = regionTotals.reduce((s, r) => s + r.total, 0);

      // Build "Other" hover breakdown
      otherBreakdownAll.sort((a, b) => b.total - a.total);
      let otherHover = '';
      const shown = otherBreakdownAll.slice(0, 20);
      const rest = otherBreakdownAll.slice(20);
      otherHover = shown.map(r => r.region + ': ' + r.total).join('<br>');
      if (rest.length > 0) {
        const restTotal = rest.reduce((s, r) => s + r.total, 0);
        otherHover += '<br>...and ' + rest.length + ' more (' + restTotal + ' stars)';
      }

      const hoverTexts = regionTotals.map(r => {
        if (r.region === 'Other' && otherHover) return otherHover;
        return r.region + ': ' + r.total + ' stars (' + (rangeKnown > 0 ? (r.total / rangeKnown * 100).toFixed(1) : '0') + '%)';
      });

      Plotly.react(totalsEl, [{
        y: regionTotals.map(r => r.region),
        x: regionTotals.map(r => r.total),
        type: 'bar',
        orientation: 'h',
        marker: { color: regionTotals.map(r => colorByRegion[r.region]) },
        text: regionTotals.map(r => rangeKnown > 0 ? (r.total / rangeKnown * 100).toFixed(1) + '%' : '0%'),
        textposition: 'outside',
        textfont: { color: '#8b949e', size: 11 },
        hovertext: hoverTexts,
        hovertemplate: '%{hovertext}<extra></extra>'
      }], {
        template: 'plotly_dark',
        paper_bgcolor: '#0d1117',
        plot_bgcolor: '#0d1117',
        xaxis: { title: { text: 'Total stars', font: { color: '#8b949e' } }, gridcolor: '#21262d', color: '#8b949e' },
        yaxis: { color: '#8b949e', automargin: true },
        margin: { t: 20, r: 30, b: 50, l: 120 },
        height: Math.max(400, regionTotals.length * 22),
        showlegend: false,
      }, plotConfig);
    }

    // Wire up callbacks used by range/granularity handlers
    updateRegionRange = function(rangeKey) {
      rebuildRegionCharts();
    };

    updateRegionGranularity = function(granularity) {
      currentRegionGranularity = granularity;
      rebuildRegionCharts();
    };

    updateTotalsChart = function(rangeKey) {
      // Already handled by rebuildRegionCharts via updateRegionRange
    };

    // Top N input handler
    topNInput.addEventListener('change', function() {
      const val = parseInt(this.value, 10);
      if (val >= 1 && val <= d.allRegionNames.length) {
        currentTopN = val;
        rebuildRegionCharts();
      }
    });

    // Initial render of totals chart
    rebuildTotalsChart();
  }
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
