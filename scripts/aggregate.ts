#!/usr/bin/env tsx
/**
 * Aggregate evaluation results into a dashboard summary.
 *
 * Usage:
 *   npx tsx scripts/aggregate.ts                          # generate summary
 *   npx tsx scripts/aggregate.ts --compare-with 0.5.0     # include version comparison
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loadManifest } from '../lib/repo-registry.ts';
import { loadEvalResult, loadRawResult, saveDashboard } from '../lib/result-store.ts';
import { info, success, warn, heading, step, dim } from '../lib/logger.ts';
import type {
  DashboardSummary, SnifferMetrics, RepoMetrics, VersionDelta,
  EvaluationResult, FpCategory, Framework,
} from '../lib/types.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);
const apsPkgPath = require_.resolve('anti-pattern-sniffer/package.json');
const APS_VERSION: string = JSON.parse(readFileSync(apsPkgPath, 'utf-8')).version;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { compareWith: string | null } {
  const args = process.argv.slice(2);
  let compareWith: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--compare-with' && args[i + 1]) compareWith = args[++i];
  }

  return { compareWith };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function main(): void {
  const { compareWith } = parseArgs();

  heading(`aps Benchmark Aggregation (v${APS_VERSION})`);

  const manifest = loadManifest();

  const evals: Array<{ repoId: string; eval: EvaluationResult; framework: Framework; stars: number }> = [];

  for (const repo of manifest.repos) {
    const evalResult = loadEvalResult(repo.id, APS_VERSION);
    if (evalResult) {
      evals.push({ repoId: repo.id, eval: evalResult, framework: repo.framework, stars: repo.stars });
    }
  }

  if (evals.length === 0) {
    warn('No evaluation results found. Run evaluate.ts first.');
    return;
  }

  step(`Aggregating results from ${evals.length} repos`);

  let totalTP = 0;
  let totalFP = 0;
  let totalUnclear = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const snifferAcc: Record<string, {
    total: number; tp: number; fp: number; unclear: number;
    repoSet: Set<string>;
    fpCategories: Array<{ category: FpCategory; reasoning: string }>;
  }> = {};

  const frameworkAcc: Record<string, {
    repoSet: Set<string>; total: number; tp: number; fp: number; unclear: number;
  }> = {};

  const repoMetrics: RepoMetrics[] = [];

  for (const { repoId, eval: ev, framework, stars } of evals) {
    totalTP += ev.aggregate.tp;
    totalFP += ev.aggregate.fp;
    totalUnclear += ev.aggregate.unclear;
    totalPromptTokens += ev.totalPromptTokens;
    totalCompletionTokens += ev.totalCompletionTokens;

    if (!frameworkAcc[framework]) {
      frameworkAcc[framework] = { repoSet: new Set(), total: 0, tp: 0, fp: 0, unclear: 0 };
    }
    frameworkAcc[framework].repoSet.add(repoId);
    frameworkAcc[framework].total += ev.aggregate.total;
    frameworkAcc[framework].tp += ev.aggregate.tp;
    frameworkAcc[framework].fp += ev.aggregate.fp;
    frameworkAcc[framework].unclear += ev.aggregate.unclear;

    const snifferCounts: Record<string, number> = {};
    for (const d of ev.detections) {
      if (!snifferAcc[d.snifferName]) {
        snifferAcc[d.snifferName] = { total: 0, tp: 0, fp: 0, unclear: 0, repoSet: new Set(), fpCategories: [] };
      }
      const acc = snifferAcc[d.snifferName];
      acc.total++;
      acc.repoSet.add(repoId);
      if (d.classification === 'TP') acc.tp++;
      else if (d.classification === 'FP') {
        acc.fp++;
        if (d.fpCategory) acc.fpCategories.push({ category: d.fpCategory, reasoning: d.reasoning });
      } else acc.unclear++;

      snifferCounts[d.snifferName] = (snifferCounts[d.snifferName] || 0) + 1;
    }

    const raw = loadRawResult(repoId, APS_VERSION);
    const fileCount = raw?.meta.fileCount || 0;
    const topSniffers = Object.entries(snifferCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    repoMetrics.push({
      id: repoId,
      framework,
      stars,
      fileCount,
      issueCount: ev.aggregate.total,
      fpRate: ev.aggregate.fpRate,
      topSniffers,
    });
  }

  const perSniffer: Record<string, SnifferMetrics> = {};
  for (const [name, acc] of Object.entries(snifferAcc)) {
    const categoryCount: Record<string, number> = {};
    for (const fp of acc.fpCategories) {
      categoryCount[fp.category] = (categoryCount[fp.category] || 0) + 1;
    }
    const commonFpPatterns = Object.entries(categoryCount)
      .sort((a, b) => b[1] - a[1])
      .map(([pattern, count]) => ({ pattern, category: pattern as FpCategory, count }));

    perSniffer[name] = {
      total: acc.total,
      tp: acc.tp,
      fp: acc.fp,
      unclear: acc.unclear,
      fpRate: acc.total > 0 ? +((acc.fp / acc.total) * 100).toFixed(1) : 0,
      avgDetectionsPerRepo: acc.repoSet.size > 0 ? +(acc.total / acc.repoSet.size).toFixed(1) : 0,
      commonFpPatterns,
    };
  }

  const perFramework: Record<string, any> = {};
  for (const [fw, acc] of Object.entries(frameworkAcc)) {
    perFramework[fw] = {
      repoCount: acc.repoSet.size,
      totalDetections: acc.total,
      tp: acc.tp,
      fp: acc.fp,
      unclear: acc.unclear,
      fpRate: acc.total > 0 ? +((acc.fp / acc.total) * 100).toFixed(1) : 0,
    };
  }

  let versionComparison: VersionDelta[] | null = null;
  if (compareWith) {
    versionComparison = buildVersionComparison(compareWith, evals, perSniffer);
  }

  const estimatedCost = (totalPromptTokens / 1_000_000) * 3 + (totalCompletionTokens / 1_000_000) * 15;

  const totalDetections = totalTP + totalFP + totalUnclear;
  const summary: DashboardSummary = {
    generatedAt: new Date().toISOString(),
    apsVersion: APS_VERSION,
    repoCount: evals.length,
    totalDetections,
    overall: {
      tp: totalTP,
      fp: totalFP,
      unclear: totalUnclear,
      fpRate: totalDetections > 0 ? +((totalFP / totalDetections) * 100).toFixed(1) : 0,
    },
    perSniffer,
    perRepo: repoMetrics.sort((a, b) => b.issueCount - a.issueCount),
    perFramework,
    versionComparison,
    costSummary: {
      totalPromptTokens,
      totalCompletionTokens,
      estimatedCostUsd: +estimatedCost.toFixed(4),
    },
  };

  saveDashboard(summary, APS_VERSION);

  // Print summary
  heading('Dashboard Summary');
  info(`Repos: ${summary.repoCount} | Detections: ${summary.totalDetections}`);
  info(`Overall: TP=${totalTP} FP=${totalFP} Unclear=${totalUnclear} (${summary.overall.fpRate}% FP rate)`);

  heading('Per-Sniffer FP Rates');
  const sortedSniffers = Object.entries(perSniffer).sort((a, b) => b[1].fpRate - a[1].fpRate);
  for (const [name, m] of sortedSniffers) {
    const bar = '█'.repeat(Math.round(m.fpRate / 5)) + '░'.repeat(Math.round((100 - m.fpRate) / 5));
    info(`  ${name.padEnd(35)} ${bar} ${m.fpRate}% FP  (${m.total} total)`);
    if (m.commonFpPatterns.length > 0) {
      for (const p of m.commonFpPatterns.slice(0, 3)) {
        dim(`    → ${p.pattern}: ${p.count}`);
      }
    }
  }

  if (versionComparison && versionComparison.length > 0) {
    heading(`Version Comparison: v${compareWith} → v${APS_VERSION}`);
    for (const vc of versionComparison) {
      const arrow = vc.delta < 0 ? '↓' : vc.delta > 0 ? '↑' : '→';
      const color = vc.delta < 0 ? '\x1b[32m' : vc.delta > 0 ? '\x1b[31m' : '\x1b[2m';
      info(`  ${vc.sniffer.padEnd(35)} ${color}${arrow} ${Math.abs(vc.delta).toFixed(1)}%\x1b[0m  (${vc.previousFpRate}% → ${vc.currentFpRate}%)`);
    }
  }

  heading('Per-Framework');
  for (const [fw, m] of Object.entries(perFramework)) {
    info(`  ${fw}: ${m.repoCount} repos, ${m.totalDetections} detections, ${m.fpRate}% FP`);
  }

  dim(`\nCost: ~$${estimatedCost.toFixed(4)} (${totalPromptTokens.toLocaleString()} prompt + ${totalCompletionTokens.toLocaleString()} completion tokens)`);
  success(`Dashboard saved to data/dashboard/summary.json`);
}

function buildVersionComparison(
  previousVersion: string,
  currentEvals: Array<{ repoId: string; eval: EvaluationResult }>,
  currentPerSniffer: Record<string, SnifferMetrics>,
): VersionDelta[] {
  const prevSnifferAcc: Record<string, { total: number; fp: number }> = {};

  for (const { repoId } of currentEvals) {
    const prevEval = loadEvalResult(repoId, previousVersion);
    if (!prevEval) continue;

    for (const d of prevEval.detections) {
      if (!prevSnifferAcc[d.snifferName]) {
        prevSnifferAcc[d.snifferName] = { total: 0, fp: 0 };
      }
      prevSnifferAcc[d.snifferName].total++;
      if (d.classification === 'FP') prevSnifferAcc[d.snifferName].fp++;
    }
  }

  const deltas: VersionDelta[] = [];
  const allSniffers = new Set([...Object.keys(currentPerSniffer), ...Object.keys(prevSnifferAcc)]);

  for (const sniffer of allSniffers) {
    const prev = prevSnifferAcc[sniffer];
    const curr = currentPerSniffer[sniffer];

    const prevRate = prev && prev.total > 0 ? +((prev.fp / prev.total) * 100).toFixed(1) : 0;
    const currRate = curr ? curr.fpRate : 0;

    deltas.push({
      sniffer,
      previousVersion,
      currentVersion: APS_VERSION,
      previousFpRate: prevRate,
      currentFpRate: currRate,
      delta: +(currRate - prevRate).toFixed(1),
    });
  }

  return deltas.sort((a, b) => a.delta - b.delta);
}

main();
