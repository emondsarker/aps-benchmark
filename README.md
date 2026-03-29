# aps-benchmark

Automated benchmark and evaluation pipeline for [anti-pattern-sniffer](https://github.com/emondsarker/react-anti-pattern-sniffer) (aps). Discovers open-source repos, runs aps against them, uses Claude to classify each detection as TP/FP/Unclear, and tracks everything for data-driven sniffer tuning.

## Why

Manual FP analysis doesn't scale. Over v0.1.0–v0.6.0 we reduced FPs from ~80% to ~47% by analyzing a single production codebase. This pipeline automates that process across dozens of real-world repos so we can:

- Measure per-sniffer FP rates across diverse codebases
- Identify **why** detections are false positives (categorized)
- Track accuracy improvements across aps versions
- Find FP patterns that inform new sniffer heuristics

## Pipeline Overview

```
discover → clone → analyze → evaluate → aggregate
```

| Step | Script | What it does |
|------|--------|--------------|
| **Discover** | `scripts/discover-repos.ts` | Search GitHub for React/Express/NestJS repos via `gh` CLI |
| **Clone** | `scripts/clone-repos.ts` | Shallow-clone repos to `data/cache/` |
| **Analyze** | `scripts/run-analysis.ts` | Import aps `orchestrate()` directly, save enriched JSON results |
| **Evaluate** | `scripts/evaluate.ts` | Batch-classify detections via Claude API |
| **Aggregate** | `scripts/aggregate.ts` | Compute per-sniffer FP rates, dashboards, version comparisons |
| **Full Pipeline** | `scripts/full-pipeline.ts` | Run all steps end-to-end |

## Setup

### Prerequisites

- Node.js >= 20
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- [anti-pattern-sniffer](https://github.com/emondsarker/react-anti-pattern-sniffer) cloned as a sibling directory (linked via `file:../react-anti-pattern-sniffer`)
- `ANTHROPIC_API_KEY` environment variable (for the evaluate step only)

### Install

```bash
# Clone this repo
git clone git@github.com:emondsarker/aps-benchmark.git
cd aps-benchmark

# Make sure aps is built
cd ../react-anti-pattern-sniffer && npm run build && cd ../aps-benchmark

# Install dependencies
npm install
```

## Usage

### Individual Steps

```bash
# 1. Discover repos (searches GitHub, adds to data/repos.json)
npm run discover -- --framework react --min-stars 500 --limit 20
npm run discover -- --framework nestjs --min-stars 200 --limit 10
npm run discover -- --framework express --min-stars 500 --limit 15

# 2. Clone all pending repos
npm run clone

# 3. Run aps analysis on all cloned repos
npm run analyze

# 4. Evaluate detections with Claude (requires ANTHROPIC_API_KEY)
npm run evaluate

# 5. Generate aggregate dashboard
npm run aggregate
npm run aggregate -- --compare-with 0.5.0  # with version comparison
```

### Full Pipeline (all-in-one)

```bash
# Discover, clone, analyze, evaluate, and aggregate
npm run pipeline -- --framework react --min-stars 1000 --limit 10

# Skip expensive steps
npm run pipeline -- --skip-discover --skip-evaluate

# Target a single repo
npm run pipeline -- --repo tremorlabs_tremor-npm --force
```

### CLI Flags

#### discover-repos

| Flag | Default | Description |
|------|---------|-------------|
| `--framework` | `react` | `react`, `nextjs`, `express`, or `nestjs` |
| `--min-stars` | `500` | Minimum GitHub star count |
| `--limit` | `20` | Max repos to fetch per search query |

#### clone-repos

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <id>` | — | Clone a specific repo |
| `--all` | — | Clone all non-cloned repos (including failed) |

#### run-analysis

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <id>` | — | Analyze a specific repo |
| `--force` | `false` | Re-analyze even if already done at current version |
| `--timeout <ms>` | `120000` | Per-repo timeout |

#### evaluate

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <id>` | — | Evaluate a specific repo |
| `--incremental` | `false` | Only classify new/changed detections (carry forward unchanged) |
| `--batch-size` | `10` | Detections per Claude API call |

#### aggregate

| Flag | Default | Description |
|------|---------|-------------|
| `--compare-with <version>` | — | Include FP rate deltas vs a previous aps version |

#### full-pipeline

| Flag | Default | Description |
|------|---------|-------------|
| `--framework` | `react` | Framework for discovery |
| `--min-stars` | `1000` | Min stars for discovery |
| `--limit` | `5` | Repo limit for discovery |
| `--skip-discover` | `false` | Skip the discovery step |
| `--skip-evaluate` | `false` | Skip the Claude evaluation step |
| `--repo <id>` | — | Target a single repo (skips discovery) |
| `--force` | `false` | Force re-analysis |
| `--incremental` | `false` | Incremental evaluation |
| `--compare-with <version>` | — | Version comparison in aggregation |

## Data Tracked

Every data point that can inform sniffer improvements is captured and persisted.

### Per Repo (`data/results/{id}/meta.json`)

- Stars, forks, open issues, language, license, repo size
- Frameworks auto-detected (react, express, nestjs)
- File count by extension (`.tsx`, `.jsx`, `.ts`, `.js`)
- Analysis duration, sniffer config used, errors

### Per Detection (`data/results/{id}/raw-v*.json`)

- Sniffer name, file path, line, column
- Message, severity, suggestion
- Sniffer-specific details (propCount, propNames, componentName, threshold, etc.)
- 20 lines of source context around the detection
- Content hash (SHA-256) for incremental evaluation

### Per Evaluation (`data/results/{id}/eval-v*.json`)

- **Classification**: TP (True Positive), FP (False Positive), Unclear
- **FP Category**: why it's a false positive
  - `idiomatic-pattern` — standard framework idiom
  - `framework-api` — using a framework API as designed
  - `justified-complexity` — complexity warranted by requirements
  - `type-safe` — TypeScript types make the pattern safe
  - `composition-not-drilling` — props distributed, not drilled
  - `threshold-too-low` — sniffer threshold too aggressive
  - `other`
- **Confidence**: high, medium, low
- **Reasoning**: one-line explanation from Claude
- Prompt/completion token counts (cost tracking)

### Dashboard (`data/dashboard/summary.json`)

- Overall TP/FP/Unclear counts and FP rate
- Per-sniffer FP rates with common FP pattern clusters
- Per-framework breakdown
- Per-repo breakdown with top sniffers
- Version comparison deltas
- Cost summary (tokens + estimated USD)

## Directory Structure

```
aps-benchmark/
  package.json
  tsconfig.json

  scripts/
    discover-repos.ts         # GitHub search
    clone-repos.ts            # Shallow clone
    run-analysis.ts           # Run aps
    evaluate.ts               # Claude classification
    aggregate.ts              # Metrics & dashboard
    full-pipeline.ts          # End-to-end orchestrator

  lib/
    types.ts                  # All TypeScript interfaces
    repo-registry.ts          # CRUD for repos.json
    result-store.ts           # Read/write versioned result files
    claude-client.ts          # Anthropic SDK wrapper
    source-context.ts         # Extract code context + hashing
    logger.ts                 # Console logger

  data/
    repos.json                # Repo manifest (tracked in git)
    cache/                    # Cloned repos (gitignored)
    results/                  # Per-repo results (tracked in git)
      {owner}_{repo}/
        meta.json             # Repo metadata + analysis history
        raw-v0.6.0.json       # Raw aps JSON output
        eval-v0.6.0.json      # Claude classifications
    dashboard/
      summary.json            # Latest aggregate metrics
      history/                # Timestamped snapshots
```

## How Evaluation Works

Detections are batched by sniffer (10 per API call) and sent to Claude Sonnet with a structured prompt. For each detection, Claude sees:

- The sniffer name and description
- The detection message and severity
- 20 lines of source code around the flagged line
- Sniffer-specific details (prop counts, thresholds, etc.)

Claude responds with a JSON array of classifications. Cost is approximately **$0.15 per 500 detections**.

### Incremental Evaluation

Each detection gets a content hash (`SHA-256(snifferName + filePath + line + message)`). When re-evaluating after sniffer changes:

1. Unchanged detections (same hash) carry forward their previous classification — no API call
2. Only new or changed detections are sent to Claude
3. This means changing one sniffer doesn't re-evaluate detections from the other 13

## Typical Workflow

### Initial benchmarking

```bash
# Discover and analyze repos across frameworks
npm run pipeline -- --framework react --min-stars 500 --limit 20
npm run pipeline -- --framework express --min-stars 300 --limit 15
npm run pipeline -- --framework nestjs --min-stars 200 --limit 10

# Review the dashboard
cat data/dashboard/summary.json | python3 -m json.tool
```

### After changing a sniffer

```bash
# Rebuild aps
cd ../react-anti-pattern-sniffer && npm run build && cd ../aps-benchmark

# Re-analyze all repos and incrementally evaluate
npm run analyze -- --force
npm run evaluate -- --incremental
npm run aggregate -- --compare-with 0.6.0
```

### Targeting a single repo

```bash
npm run pipeline -- --repo epicweb-dev_epic-stack --force
```

## Current Test Repos

| Repo | Stars | Framework | Issues (v0.6.0) |
|------|-------|-----------|-----------------|
| `tremorlabs/tremor-npm` | 16,469 | React | 0 |
| `ant-design/ant-design-pro` | 38,036 | React | 0 |
| `epicweb-dev/epic-stack` | 5,500 | React + Express | 12 |

## License

MIT
