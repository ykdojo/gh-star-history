#!/usr/bin/env node

// Lists locations from a repo's stargazer cache that aren't in location_map.json
// Usage: node bin/list-unclassified.js <owner/repo>
// Output: CSV to stdout with columns: location, count

const fs = require('fs');
const path = require('path');
const os = require('os');

const repo = process.argv[2];
if (!repo) {
  console.error('Usage: node bin/list-unclassified.js <owner/repo>');
  process.exit(1);
}

const cacheFile = path.join(os.homedir(), '.gh-star-history', repo.replace('/', '__') + '__locations.json');
if (!fs.existsSync(cacheFile)) {
  console.error(`No cache found for ${repo}. Run "node bin/cli-country.js ${repo}" first.`);
  process.exit(1);
}

const locationMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'location_map.json'), 'utf8'));
const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const locations = cache.locations || [];

// Count unique locations not in the map
const counts = {};
for (const loc of locations) {
  if (!loc) continue;
  if (locationMap[loc]) continue;
  counts[loc] = (counts[loc] || 0) + 1;
}

const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

if (sorted.length === 0) {
  console.error('All locations are already classified.');
  process.exit(0);
}

console.error(`${sorted.length} unclassified unique locations found.`);
console.log('location,count');
for (const [loc, count] of sorted) {
  // CSV-escape the location
  const escaped = loc.includes(',') || loc.includes('"') || loc.includes('\n')
    ? '"' + loc.replace(/"/g, '""') + '"'
    : loc;
  console.log(`${escaped},${count}`);
}
