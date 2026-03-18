#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    npx gh-star-history <owner/repo or URL> [options]

  Options:
    --style <name>   Chart style: blue (default), green, purple
    --output <path>  Output file path (default: star-history.html)
    --no-open        Don't auto-open the browser
    --no-cache       Skip cache and fetch fresh data
    -h, --help       Show this help

  Examples:
    npx gh-star-history ykdojo/claude-code-tips
    npx gh-star-history https://github.com/ykdojo/claude-code-tips
    npx gh-star-history ykdojo/claude-code-tips --style green

  Requires: GitHub CLI (gh) must be installed and authenticated.
`);
  process.exit(flags.help ? 0 : 1);
}

// Parse repo - accept both "owner/repo" and full GitHub URLs
let repo = positional[0];
const ghUrl = repo.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
if (ghUrl) {
  repo = ghUrl[1];
}

const style = flags.style || 'blue';
const outputPath = flags.output || 'star-history.html';

const validStyles = ['blue', 'green', 'purple'];
if (!validStyles.includes(style)) {
  console.error(`Error: Unknown style "${style}". Choose from: ${validStyles.join(', ')}`);
  process.exit(1);
}

// Validate repo format
if (!/^[^/]+\/[^/]+$/.test(repo)) {
  console.error(`Error: Invalid repo format "${repo}". Use owner/repo or a GitHub URL.`);
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

// --- Cache ---

const cacheFile = path.join(os.homedir(), '.gh-star-history-cache.json');

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
}

// --- Fetch star data (page by page with caching) ---

const cache = flags.noCache ? {} : loadCache();

// Support both old format (array) and new format ({ dates, starCount })
const cachedEntry = cache[repo] || {};
const cachedDates = Array.isArray(cachedEntry) ? cachedEntry : (cachedEntry.dates || []);
const cachedStarCount = Array.isArray(cachedEntry) ? null : (cachedEntry.starCount || null);
const dateSet = new Set(cachedDates);

// Resume from the page containing the last cached star.
// Uses real API dates length for page math (not starCount).
const startPage = cachedDates.length > 0 ? Math.floor((cachedDates.length - 1) / 100) + 1 : 1;

// Fetch the official star count so we can detect gaps
let starCount;
try {
  const repoJson = execSync(
    `gh api "repos/${repo}" --jq '.stargazers_count'`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  starCount = parseInt(repoJson.trim(), 10);
  if (isNaN(starCount)) starCount = null;
} catch {
  starCount = null;
}

if (cachedDates.length > 0 && startPage > 1) {
  const displayCached = cachedStarCount || starCount || cachedDates.length;
  console.log(`Found ${displayCached.toLocaleString()} cached stars. Fetching new stars from page ${startPage}...`);
} else {
  console.log(`Fetching star history for ${repo}...`);
}

let page = startPage;
const perPage = 100;

while (true) {
  let rawJson;
  try {
    rawJson = execSync(
      `gh api "repos/${repo}/stargazers?per_page=${perPage}&page=${page}" -H "Accept: application/vnd.github.v3.star+json"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    if (stderr.includes('404')) {
      console.error(`Error: Repository "${repo}" not found.`);
    } else if (stderr.includes('401') || stderr.includes('403')) {
      console.error('Error: Authentication failed. Run "gh auth login" first.');
    } else {
      console.error(`Error fetching page ${page}: ${stderr || err.message}`);
    }
    if (dateSet.size > 0) {
      console.log(`Saving ${dateSet.size.toLocaleString()} stars fetched so far to cache.`);
      cache[repo] = { dates: [...dateSet].sort(), starCount: starCount || dateSet.size };
      saveCache(cache);
    }
    process.exit(1);
  }

  let entries;
  try {
    entries = JSON.parse(rawJson);
  } catch {
    console.error(`Error: Failed to parse API response on page ${page}.`);
    break;
  }

  if (!Array.isArray(entries) || entries.length === 0) break;

  const pageDates = entries.map(e => e.starred_at).filter(Boolean);

  for (const d of pageDates) {
    dateSet.add(d);
  }

  // Save cache after every page
  cache[repo] = { dates: [...dateSet].sort(), starCount: starCount || dateSet.size };
  saveCache(cache);

  const isLastPage = entries.length < perPage;

  // Progress: assume 100 per full page, use starCount for the last page
  const progress = isLastPage ? (starCount || dateSet.size) : page * perPage;
  process.stdout.write(`\r  Page ${page} - ${progress.toLocaleString()} stars`);

  if (isLastPage) break;

  page++;
}

process.stdout.write('\n');

const dates = [...dateSet].sort();

if (dates.length === 0) {
  console.error(`Error: No stars found for "${repo}".`);
  process.exit(1);
}

const displayCount = starCount || dates.length;

const cumulative = dates.map((_, i) => i + 1);

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
  const hour = d.slice(0, 13); // "2025-12-05T14"
  hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
}
const hourlyDates = Object.keys(hourlyCounts).sort().map(h => h + ':00:00Z');
const hourlyValues = Object.keys(hourlyCounts).sort().map(h => hourlyCounts[h]);

console.log(`Total: ${displayCount.toLocaleString()} stars. Generating chart...`);

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

const s = styles[style];

// --- Generate HTML ---

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Star History - ${repo}</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { text-align: center; font-size: 22px; margin: 20px 0 4px 0; color: #e6edf3; }
  h1 a { color: #e6edf3; text-decoration: none; }
  h1 a:hover { text-decoration: underline; }
  .subtitle { text-align: center; color: #8b949e; font-size: 14px; margin-bottom: 20px; }
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
  <h1><a href="https://github.com/${repo}" target="_blank">${repo}</a></h1>
  <div class="subtitle">${displayCount.toLocaleString()} stars</div>
  <div class="range-buttons">
    <button class="range-btn active" data-range="all">All Time</button>
    <button class="range-btn" data-range="month">Past Month</button>
    <button class="range-btn" data-range="week">Past Week</button>
    <button class="range-btn" data-range="day">Past 24h</button>
    <span style="margin-left: 12px; border-left: 1px solid #30363d; padding-left: 16px;">
      <button class="range-btn active" data-granularity="daily">Daily</button>
      <button class="range-btn" data-granularity="hourly">Hourly</button>
    </span>
  </div>
  <div id="chart"></div>
  <div class="footer">Generated by <a href="https://github.com/ykdojo/gh-star-history" target="_blank">ykdojo/gh-star-history</a></div>
</div>

<script>
const dates = ${JSON.stringify(dates)};
const cumulative = ${JSON.stringify(cumulative)};
const dailyDates = ${JSON.stringify(dailyDates)};
const dailyValues = ${JSON.stringify(dailyValues)};
const hourlyDates = ${JSON.stringify(hourlyDates)};
const hourlyValues = ${JSON.stringify(hourlyValues)};

const chartEl = document.getElementById('chart');
const baseTraces = [
  {
    x: dates,
    y: cumulative,
    fill: 'tozeroy',
    fillcolor: '${s.fillColor}',
    line: { color: '${s.lineColor}', width: 2.5 },
    name: 'Total Stars',
    hovertemplate: '%{x|%b %d, %Y %H:%M}<br>%{y:,} stars<extra></extra>'
  }
];
const dailyBar = {
  x: dailyDates,
  y: dailyValues,
  type: 'bar',
  marker: { color: '${s.barColor}' },
  name: 'Stars / Day',
  yaxis: 'y2',
  hovertemplate: '%{x|%b %d, %Y}<br>%{y} stars that day<extra></extra>'
};
const hourlyBar = {
  x: hourlyDates,
  y: hourlyValues,
  type: 'bar',
  marker: { color: '${s.barColor}' },
  name: 'Stars / Hour',
  yaxis: 'y2',
  hovertemplate: '%{x|%b %d %H:00}<br>%{y} stars that hour<extra></extra>'
};

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
  yaxis2: {
    title: { text: '', font: { color: '#8b949e' } },
    overlaying: 'y',
    side: 'right',
    gridcolor: '#21262d',
    color: '#8b949e'
  },
  hovermode: 'x unified',
  showlegend: false,
  margin: { t: 40, r: 60, b: 50, l: 60 },
  height: 500,
};
const plotConfig = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d']
};

const lastDate = new Date(dates[dates.length - 1]).getTime();
const ranges = {
  all: null,
  month: [new Date(lastDate - 30*24*60*60*1000).toISOString(), dates[dates.length-1]],
  week: [new Date(lastDate - 7*24*60*60*1000).toISOString(), dates[dates.length-1]],
  day: [new Date(lastDate - 24*60*60*1000).toISOString(), dates[dates.length-1]],
};

// Initial render
Plotly.newPlot(chartEl, [...baseTraces, dailyBar], baseLayout, plotConfig);

// State
let currentBar = 'daily';

function setGranularity(granularity) {
  if (granularity === currentBar) return;
  if (granularity === 'hourly') {
    Plotly.restyle(chartEl, { x: [hourlyDates], y: [hourlyValues], name: 'Stars / Hour', hovertemplate: '%{x|%b %d %H:00}<br>%{y} stars that hour<extra></extra>' }, [1]);
  } else {
    Plotly.restyle(chartEl, { x: [dailyDates], y: [dailyValues], name: 'Stars / Day', hovertemplate: '%{x|%b %d, %Y}<br>%{y} stars that day<extra></extra>' }, [1]);
  }
  currentBar = granularity;
  // Update granularity button state
  document.querySelectorAll('[data-granularity]').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector('[data-granularity="' + granularity + '"]');
  if (activeBtn) activeBtn.classList.add('active');
}

// Range button handlers
document.querySelectorAll('[data-range]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const r = btn.dataset.range;

    // Auto-select granularity based on range
    const autoGranularity = (r === 'day' || r === 'week') ? 'hourly' : 'daily';
    setGranularity(autoGranularity);

    requestAnimationFrame(() => {
      const y2Title = currentBar === 'hourly' ? 'Stars / Hour' : 'Stars / Day';
      if (ranges[r]) {
        Plotly.relayout(chartEl, {
          'xaxis.autorange': false,
          'xaxis.range': ranges[r],
          'yaxis2.title.text': y2Title
        });
      } else {
        Plotly.relayout(chartEl, {
          'xaxis.autorange': true,
          'yaxis2.title.text': y2Title
        });
      }
    });
  });
});

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
