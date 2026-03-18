# gh-star-history

Visualize any GitHub repo's star history as an interactive chart. Powered by the [GitHub CLI](https://cli.github.com/) - no API tokens to configure.

For example, if you want to see the star growth of [claude-code-tips](https://github.com/ykdojo/claude-code-tips):

```
npx gh-star-history ykdojo/claude-code-tips
```

Generates a self-contained HTML file with an interactive Plotly chart - hover for details, zoom into spikes, pan across time.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 16
- [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

## Usage

```bash
npx gh-star-history <owner/repo or URL> [options]
```

Accepts both formats:
```bash
npx gh-star-history ykdojo/claude-code-tips
npx gh-star-history https://github.com/ykdojo/claude-code-tips
```

### Options

| Flag | Description |
|------|-------------|
| `--style <name>` | Chart style: `blue` (default), `green`, `purple` |
| `--output <path>` | Output file path (default: `star-history.html`) |
| `--no-open` | Don't auto-open the browser |
| `--no-cache` | Skip cache and fetch fresh data |
| `-h, --help` | Show help |

### Examples

```bash
# Default blue style
npx gh-star-history ykdojo/claude-code-tips

# Green accent
npx gh-star-history ykdojo/claude-code-tips --style green

# Save to specific file
npx gh-star-history torvalds/linux --output linux-stars.html
```

## Styles

Three styles matching GitHub's dark theme palette:

- **blue** (default) - `#58a6ff`
- **green** - `#3fb950`
- **purple** - `#bc8cff`

## How it works

1. Fetches stargazer timestamps via `gh api`, page by page
2. Caches results to `~/.gh-star-history-cache.json` - subsequent runs only fetch new stars
3. Generates a self-contained HTML file with [Plotly.js](https://plotly.com/javascript/) loaded from CDN
4. Opens it in your default browser

The cache saves after every page, so even if a large fetch gets interrupted, progress is kept. The chart shows both cumulative stars (line) and stars per day (bars) on a dual-axis layout.

## Development

```bash
git clone https://github.com/ykdojo/gh-star-history.git
cd gh-star-history
node bin/cli.js ykdojo/claude-code-tips
```

## License

MIT
