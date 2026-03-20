---
name: country-breakdown
description: Fetch stargazer locations, classify countries, and generate a country breakdown chart
argument-hint: <owner/repo>
---

Generate a country breakdown chart for: $ARGUMENTS

## Steps

### 1. Fetch stargazer locations

Use the GitHub GraphQL API via `gh` CLI to fetch all stargazers with their locations and star dates. Save to a CSV at `/tmp/stargazers.csv` with columns: `username, location, starred_at`.

```
query {
  repository(owner: "<owner>", name: "<repo>") {
    stargazers(first: 100, after: "<cursor>") {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { starredAt node { login location } }
    }
  }
}
```

Paginate through all results. Show progress as you go.

### 2. Extract unique locations

From the stargazers CSV, extract unique location strings with their counts. Save to `/tmp/locations.csv` with columns: `location, count`.

### 3. Classify locations into countries

Split the locations into batches of ~200 and spawn parallel subagents to classify each batch. Each subagent should:

- Read its batch file (e.g., `/tmp/locations_batch_0.csv`)
- Determine the country for each location
- Write output to `/tmp/locations_classified_0.csv` with columns: `location, count, country`

Classification rules:
- Use standard country names (e.g., "South Korea", "United States", "China")
- US cities/states -> "United States"
- Chinese characters (深圳, 北京, etc.) -> "China"
- Korean characters (서울, etc.) -> "South Korea"
- Ambiguous/joke locations ("Earth", "localhost", "Matrix") -> "Unknown"
- Keep the exact original location string

### 4. Merge and analyze

After all subagents complete:
1. Build a location-to-country mapping from all classified files
2. Read the stargazers CSV and add country column
3. Show overall country breakdown (top 20 with percentages)
4. Show weekly waves (top 5 countries per week) to identify viral spread patterns

### 5. Update location map

Merge the new classified locations into `bin/location_map.json` in the project, adding any new mappings that don't already exist (skip "Unknown" entries).

### 6. Generate the chart

Run `node bin/cli-country.js <owner/repo>` to generate the HTML chart with the country breakdown visualization. This uses the updated location map and fetches fresh data with locations.
