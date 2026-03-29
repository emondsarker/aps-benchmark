#!/usr/bin/env tsx
/**
 * Run aps analysis against cloned repos.
 *
 * Usage:
 *   npx tsx scripts/run-analysis.ts              # analyze all cloned repos
 *   npx tsx scripts/run-analysis.ts --repo <id>  # analyze a specific repo
 *   npx tsx scripts/run-analysis.ts --force      # re-analyze even if version matches
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loadManifest, updateRepo, getCacheDir } from '../lib/repo-registry.ts';
import { loadMeta, saveMeta, saveRawResult, hasRawResult } from '../lib/result-store.ts';
import { info, success, warn, error, heading, step, dim } from '../lib/logger.ts';
import type { RepoEntry, RepoMeta, EnrichedAnalysisResult, AnalysisHistoryEntry } from '../lib/types.ts';

// ---------------------------------------------------------------------------
// Resolve the aps package (installed as a dependency via package.json)
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);
const apsPkgPath = require_.resolve('anti-pattern-sniffer/package.json');
const apsRoot = resolve(apsPkgPath, '..');
const APS_PKG = JSON.parse(readFileSync(apsPkgPath, 'utf-8'));
const APS_VERSION: string = APS_PKG.version;

async function importAps() {
  const orchestratorPath = join(apsRoot, 'dist', 'src', 'core', 'orchestrator.js');
  const configLoaderPath = join(apsRoot, 'dist', 'src', 'cli', 'config-loader.js');
  const frameworkDetectorPath = join(apsRoot, 'dist', 'src', 'utils', 'framework-detector.js');

  const orchestrator = await import(orchestratorPath);
  const configLoader = await import(configLoaderPath);
  const frameworkDetector = await import(frameworkDetectorPath);

  return {
    orchestrate: orchestrator.orchestrate as (
      config: any,
      targetDir: string,
    ) => Promise<{ output: string; issueCount: number; fileCount: number; grouped: Map<string, any[]> }>,
    DEFAULT_CONFIG: configLoader.DEFAULT_CONFIG,
    detectFrameworks: frameworkDetector.detectFrameworks as (dir: string) => string[],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { repoId: string | null; force: boolean; timeout: number } {
  const args = process.argv.slice(2);
  let repoId: string | null = null;
  let force = false;
  let timeout = 120_000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) repoId = args[++i];
    else if (args[i] === '--force') force = true;
    else if (args[i] === '--timeout' && args[i + 1]) timeout = parseInt(args[++i], 10);
  }

  return { repoId, force, timeout };
}

// ---------------------------------------------------------------------------
// File extension counting
// ---------------------------------------------------------------------------

function countFilesByExtension(dir: string): Record<string, number> {
  const counts: Record<string, number> = {};

  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') continue;
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else {
          const ext = extname(entry).toLowerCase();
          if (ext) counts[ext] = (counts[ext] || 0) + 1;
        }
      } catch {
        // skip inaccessible files
      }
    }
  }

  walk(dir);
  return counts;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function analyzeRepo(
  repo: RepoEntry,
  aps: Awaited<ReturnType<typeof importAps>>,
  timeout: number,
): Promise<EnrichedAnalysisResult | null> {
  const cacheDir = getCacheDir(repo.id);

  step(`Analyzing ${repo.id} (★${repo.stars})...`);

  // Detect frameworks
  const frameworksDetected = aps.detectFrameworks(cacheDir);
  dim(`  Frameworks: ${frameworksDetected.length > 0 ? frameworksDetected.join(', ') : 'none detected'}`);

  // Build config with auto-detected frameworks
  const config = {
    ...aps.DEFAULT_CONFIG,
    frameworks: frameworksDetected.length > 0 ? frameworksDetected : ['react'],
    outputFormat: 'json' as const,
    parallel: false,
    timeoutMs: timeout,
    include: ['**/*.{jsx,tsx,js,ts}'],
    exclude: [
      'node_modules', 'dist', 'build', '.next', 'coverage',
      '**/*.test.*', '**/*.spec.*', '**/*.stories.*',
      '**/__tests__/**', '**/__mocks__/**',
    ],
  };

  const startTime = Date.now();

  try {
    const result = await aps.orchestrate(config, cacheDir);
    const durationMs = Date.now() - startTime;

    const filesByExtension = countFilesByExtension(cacheDir);

    // Extract per-sniffer counts and durations
    const perSnifferCounts: Record<string, number> = {};
    const perSnifferDurations: Record<string, number> = {};

    for (const [, snifferResults] of result.grouped) {
      for (const sr of snifferResults) {
        perSnifferCounts[sr.snifferName] = (perSnifferCounts[sr.snifferName] || 0) + sr.detections.length;
        perSnifferDurations[sr.snifferName] = (perSnifferDurations[sr.snifferName] || 0) + sr.durationMs;
      }
    }

    // Build raw JSON report structure
    const files: Record<string, any[]> = {};
    const summary: Record<string, { count: number; severity: string }> = {};
    const errors: Array<{ snifferName: string; filePath: string; error: string }> = [];
    let totalIssues = 0;
    const sniffersRun = new Set<string>();

    for (const [, snifferResults] of result.grouped) {
      for (const sr of snifferResults) {
        sniffersRun.add(sr.snifferName);
        if (sr.error) {
          errors.push({ snifferName: sr.snifferName, filePath: sr.filePath, error: sr.error });
        }
        for (const detection of sr.detections) {
          if (!files[detection.filePath]) files[detection.filePath] = [];
          files[detection.filePath].push(detection);
          totalIssues++;

          if (!summary[detection.snifferName]) {
            summary[detection.snifferName] = { count: 0, severity: detection.severity };
          }
          summary[detection.snifferName].count++;
        }
      }
    }

    const enriched: EnrichedAnalysisResult = {
      meta: {
        fileCount: result.fileCount,
        totalIssues,
        date: new Date().toISOString().split('T')[0],
        sniffersRun: [...sniffersRun],
      },
      files,
      summary,
      errors,
      _benchmark: {
        apsVersion: APS_VERSION,
        repoId: repo.id,
        analyzedAt: new Date().toISOString(),
        durationMs,
        filesByExtension,
        snifferConfig: config.sniffers,
        frameworksDetected,
        perSnifferDurations,
      },
    };

    success(`  ${totalIssues} issues in ${result.fileCount} files (${durationMs}ms)`);

    if (Object.keys(summary).length > 0) {
      for (const [name, s] of Object.entries(summary)) {
        dim(`    ${name}: ${s.count}`);
      }
    }

    return enriched;
  } catch (e) {
    const durationMs = Date.now() - startTime;
    error(`  Analysis failed after ${durationMs}ms: ${(e as Error).message?.slice(0, 200)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { repoId, force, timeout } = parseArgs();

  heading(`aps Benchmark Analysis (v${APS_VERSION})`);

  step('Loading aps modules...');
  const aps = await importAps();
  success('aps loaded');

  const manifest = loadManifest();
  let repos: RepoEntry[];

  if (repoId) {
    const repo = manifest.repos.find(r => r.id === repoId);
    if (!repo) { error(`Repo not found: ${repoId}`); process.exit(1); }
    if (repo.status !== 'cloned') { error(`Repo not cloned: ${repoId}`); process.exit(1); }
    repos = [repo];
  } else {
    repos = manifest.repos.filter(r => r.status === 'cloned');
  }

  if (repos.length === 0) {
    warn('No cloned repos to analyze. Run clone-repos.ts first.');
    return;
  }

  if (!force) {
    repos = repos.filter(r => {
      if (r.lastAnalyzedVersion === APS_VERSION && hasRawResult(r.id, APS_VERSION)) {
        dim(`Skipping ${r.id} (already analyzed at v${APS_VERSION})`);
        return false;
      }
      return true;
    });

    if (repos.length === 0) {
      info(`All repos already analyzed at v${APS_VERSION}. Use --force to re-analyze.`);
      return;
    }
  }

  heading(`Analyzing ${repos.length} repos`);

  let analyzed = 0;
  let failed = 0;
  let totalIssues = 0;

  for (const repo of repos) {
    const result = await analyzeRepo(repo, aps, timeout);

    if (result) {
      saveRawResult(repo.id, APS_VERSION, result);

      const meta: RepoMeta = loadMeta(repo.id) || {
        id: repo.id,
        url: repo.url,
        framework: repo.framework,
        stars: repo.stars,
        analysisHistory: [],
      };

      const historyEntry: AnalysisHistoryEntry = {
        apsVersion: APS_VERSION,
        date: result._benchmark.analyzedAt,
        fileCount: result.meta.fileCount,
        filesByExtension: result._benchmark.filesByExtension,
        totalIssues: result.meta.totalIssues,
        issuesPerFile: result.meta.fileCount > 0 ? +(result.meta.totalIssues / result.meta.fileCount).toFixed(2) : 0,
        sniffersRun: result.meta.sniffersRun,
        snifferConfig: result._benchmark.snifferConfig,
        frameworksDetected: result._benchmark.frameworksDetected,
        durationMs: result._benchmark.durationMs,
        errors: result.errors.length,
        perSnifferCounts: Object.fromEntries(
          Object.entries(result.summary).map(([k, v]) => [k, v.count]),
        ),
        perSnifferDurations: result._benchmark.perSnifferDurations,
      };

      meta.analysisHistory.push(historyEntry);
      saveMeta(repo.id, meta);
      updateRepo(repo.id, { lastAnalyzedVersion: APS_VERSION });

      analyzed++;
      totalIssues += result.meta.totalIssues;
    } else {
      failed++;
    }
  }

  heading('Analysis Summary');
  success(`Analyzed: ${analyzed} repos, ${totalIssues} total issues`);
  if (failed > 0) error(`Failed: ${failed}`);
}

main().catch(e => {
  error(e.message);
  process.exit(1);
});
