#!/usr/bin/env tsx
/**
 * Evaluate aps detections using Claude API.
 *
 * Usage:
 *   npx tsx scripts/evaluate.ts                    # evaluate all repos with raw results
 *   npx tsx scripts/evaluate.ts --repo <id>        # evaluate a specific repo
 *   npx tsx scripts/evaluate.ts --incremental      # only evaluate new/changed detections
 *   npx tsx scripts/evaluate.ts --batch-size 10    # detections per API call
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loadManifest, updateRepo, getCacheDir } from '../lib/repo-registry.ts';
import { loadRawResult, loadEvalResult, saveEvalResult, hasRawResult, hasEvalResult } from '../lib/result-store.ts';
import { enrichDetection } from '../lib/source-context.ts';
import { classifyBatch, SNIFFER_DESCRIPTIONS, getModelName } from '../lib/claude-client.ts';
import { info, success, warn, error, heading, step, dim } from '../lib/logger.ts';
import type {
  RepoEntry, RawDetection, EnrichedDetection,
  EvaluatedDetection, EvaluationResult, Classification, FpCategory, Confidence,
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

function parseArgs() {
  const args = process.argv.slice(2);
  let repoId: string | null = null;
  let incremental = false;
  let batchSize = 10;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) repoId = args[++i];
    else if (args[i] === '--incremental') incremental = true;
    else if (args[i] === '--batch-size' && args[i + 1]) batchSize = parseInt(args[++i], 10);
  }

  return { repoId, incremental, batchSize };
}

// ---------------------------------------------------------------------------
// Evaluation logic
// ---------------------------------------------------------------------------

async function evaluateRepo(
  repo: RepoEntry,
  incremental: boolean,
  batchSize: number,
): Promise<EvaluationResult | null> {
  const rawResult = loadRawResult(repo.id, APS_VERSION);
  if (!rawResult) {
    warn(`  No raw results for ${repo.id} at v${APS_VERSION}`);
    return null;
  }

  const cacheDir = getCacheDir(repo.id);

  const allDetections: RawDetection[] = [];
  for (const detections of Object.values(rawResult.files)) {
    allDetections.push(...detections);
  }

  if (allDetections.length === 0) {
    info(`  No detections for ${repo.id} — creating empty eval`);
    return {
      repoId: repo.id,
      apsVersion: APS_VERSION,
      evaluatedAt: new Date().toISOString(),
      modelUsed: getModelName(),
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      detections: [],
      aggregate: { total: 0, tp: 0, fp: 0, unclear: 0, fpRate: 0 },
    };
  }

  step(`Evaluating ${repo.id}: ${allDetections.length} detections`);

  const enriched: EnrichedDetection[] = allDetections.map(d => enrichDetection(d, cacheDir));

  // Incremental: carry forward unchanged classifications
  const previousEval = incremental ? findPreviousEval(repo.id) : null;
  const previousByHash = new Map<string, EvaluatedDetection>();
  if (previousEval) {
    for (const d of previousEval.detections) {
      previousByHash.set(d.hash, d);
    }
  }

  const newDetections: EnrichedDetection[] = [];
  const carriedForward: EvaluatedDetection[] = [];

  for (const d of enriched) {
    const prev = previousByHash.get(d.hash);
    if (prev) {
      carriedForward.push(prev);
    } else {
      newDetections.push(d);
    }
  }

  if (incremental && carriedForward.length > 0) {
    dim(`  Carried forward ${carriedForward.length} unchanged classifications`);
  }

  if (newDetections.length === 0) {
    info(`  All detections unchanged — no API calls needed`);
    return buildResult(repo.id, [...carriedForward], 0, 0);
  }

  dim(`  Evaluating ${newDetections.length} new detections via Claude...`);

  // Group by sniffer for batching
  const bySnifferMap = new Map<string, EnrichedDetection[]>();
  for (const d of newDetections) {
    const existing = bySnifferMap.get(d.snifferName) || [];
    existing.push(d);
    bySnifferMap.set(d.snifferName, existing);
  }

  const evaluated: EvaluatedDetection[] = [...carriedForward];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const [snifferName, detections] of bySnifferMap) {
    const description = SNIFFER_DESCRIPTIONS[snifferName] || `Sniffer: ${snifferName}`;

    for (let i = 0; i < detections.length; i += batchSize) {
      const batch = detections.slice(i, i + batchSize);
      dim(`    ${snifferName}: batch ${Math.floor(i / batchSize) + 1} (${batch.length} detections)`);

      try {
        const result = await classifyBatch(batch, snifferName, description);
        totalPromptTokens += result.promptTokens;
        totalCompletionTokens += result.completionTokens;

        for (const cls of result.classifications) {
          const detection = batch[cls.index - 1];
          if (!detection) {
            warn(`    Invalid index ${cls.index} in batch response`);
            continue;
          }

          evaluated.push({
            hash: detection.hash,
            snifferName: detection.snifferName,
            filePath: detection.relativeFilePath,
            line: detection.line,
            message: detection.message,
            severity: detection.severity,
            classification: cls.classification as Classification,
            reasoning: cls.reasoning,
            fpCategory: (cls.fpCategory as FpCategory) || null,
            confidence: (cls.confidence as Confidence) || 'medium',
            sourceContext: detection.sourceContext,
          });
        }
      } catch (e) {
        error(`    Batch failed: ${(e as Error).message?.slice(0, 200)}`);
        for (const d of batch) {
          evaluated.push({
            hash: d.hash,
            snifferName: d.snifferName,
            filePath: d.relativeFilePath,
            line: d.line,
            message: d.message,
            severity: d.severity,
            classification: 'Unclear',
            reasoning: 'Evaluation failed — API error',
            fpCategory: null,
            confidence: 'low',
            sourceContext: d.sourceContext,
          });
        }
      }
    }
  }

  return buildResult(repo.id, evaluated, totalPromptTokens, totalCompletionTokens);
}

function findPreviousEval(repoId: string): EvaluationResult | null {
  const versions = ['0.6.0', '0.5.0', '0.4.1', '0.4.0', '0.3.0'];
  for (const v of versions) {
    if (v === APS_VERSION) continue;
    const eval_ = loadEvalResult(repoId, v);
    if (eval_) return eval_;
  }
  return null;
}

function buildResult(
  repoId: string,
  detections: EvaluatedDetection[],
  promptTokens: number,
  completionTokens: number,
): EvaluationResult {
  const tp = detections.filter(d => d.classification === 'TP').length;
  const fp = detections.filter(d => d.classification === 'FP').length;
  const unclear = detections.filter(d => d.classification === 'Unclear').length;
  const total = detections.length;

  return {
    repoId,
    apsVersion: APS_VERSION,
    evaluatedAt: new Date().toISOString(),
    modelUsed: getModelName(),
    totalPromptTokens: promptTokens,
    totalCompletionTokens: completionTokens,
    detections,
    aggregate: {
      total,
      tp,
      fp,
      unclear,
      fpRate: total > 0 ? +((fp / total) * 100).toFixed(1) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { repoId, incremental, batchSize } = parseArgs();

  heading(`aps Benchmark Evaluation (v${APS_VERSION})`);

  if (!process.env.ANTHROPIC_API_KEY) {
    error('ANTHROPIC_API_KEY not set. Export it before running.');
    process.exit(1);
  }

  const manifest = loadManifest();
  let repos: RepoEntry[];

  if (repoId) {
    const repo = manifest.repos.find(r => r.id === repoId);
    if (!repo) { error(`Repo not found: ${repoId}`); process.exit(1); }
    repos = [repo];
  } else {
    repos = manifest.repos.filter(r =>
      hasRawResult(r.id, APS_VERSION) &&
      (!hasEvalResult(r.id, APS_VERSION) || incremental),
    );
  }

  if (repos.length === 0) {
    info('No repos need evaluation. Run run-analysis.ts first, or use --repo to target one.');
    return;
  }

  heading(`Evaluating ${repos.length} repos`);

  let evaluated = 0;
  let totalDetections = 0;
  let totalTP = 0;
  let totalFP = 0;
  let totalTokens = 0;

  for (const repo of repos) {
    const result = await evaluateRepo(repo, incremental, batchSize);

    if (result) {
      saveEvalResult(repo.id, APS_VERSION, result);
      updateRepo(repo.id, { lastEvaluatedVersion: APS_VERSION });

      evaluated++;
      totalDetections += result.aggregate.total;
      totalTP += result.aggregate.tp;
      totalFP += result.aggregate.fp;
      totalTokens += result.totalPromptTokens + result.totalCompletionTokens;

      success(`  ${repo.id}: ${result.aggregate.total} detections — TP:${result.aggregate.tp} FP:${result.aggregate.fp} Unclear:${result.aggregate.unclear} (${result.aggregate.fpRate}% FP)`);
    }
  }

  heading('Evaluation Summary');
  success(`Evaluated: ${evaluated} repos, ${totalDetections} detections`);
  info(`  TP: ${totalTP} | FP: ${totalFP} | FP Rate: ${totalDetections > 0 ? ((totalFP / totalDetections) * 100).toFixed(1) : 0}%`);
  dim(`  Total tokens: ${totalTokens.toLocaleString()} (~$${((totalTokens / 1_000_000) * 3).toFixed(3)})`);
}

main().catch(e => {
  error(e.message);
  process.exit(1);
});
