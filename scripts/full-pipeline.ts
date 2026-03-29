#!/usr/bin/env tsx
/**
 * Run the full benchmark pipeline: discover → clone → analyze → evaluate → aggregate.
 *
 * Usage:
 *   npx tsx scripts/full-pipeline.ts --framework react --min-stars 1000 --limit 5
 *   npx tsx scripts/full-pipeline.ts --skip-discover --skip-evaluate
 *   npx tsx scripts/full-pipeline.ts --repo <id>
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { heading, info, success, error, step } from '../lib/logger.ts';

const SCRIPTS_DIR = import.meta.dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let skipDiscover = false;
  let skipEvaluate = false;
  let repoId: string | null = null;
  let framework = 'react';
  let minStars = 1000;
  let limit = 5;
  let compareWith: string | null = null;
  let incremental = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-discover') skipDiscover = true;
    else if (args[i] === '--skip-evaluate') skipEvaluate = true;
    else if (args[i] === '--repo' && args[i + 1]) repoId = args[++i];
    else if (args[i] === '--framework' && args[i + 1]) framework = args[++i];
    else if (args[i] === '--min-stars' && args[i + 1]) minStars = parseInt(args[++i], 10);
    else if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--compare-with' && args[i + 1]) compareWith = args[++i];
    else if (args[i] === '--incremental') incremental = true;
    else if (args[i] === '--force') force = true;
  }

  return { skipDiscover, skipEvaluate, repoId, framework, minStars, limit, compareWith, incremental, force };
}

function run(label: string, script: string, extraArgs: string[] = []): void {
  const cmd = `npx tsx ${join(SCRIPTS_DIR, script)} ${extraArgs.join(' ')}`;
  step(`${label}: ${cmd}`);

  try {
    execSync(cmd, {
      encoding: 'utf-8',
      stdio: 'inherit',
      cwd: join(SCRIPTS_DIR, '..'),
      timeout: 600_000,
    });
  } catch (e) {
    error(`${label} failed: ${(e as Error).message?.slice(0, 200)}`);
    throw e;
  }
}

function main(): void {
  const opts = parseArgs();

  heading('Full Benchmark Pipeline');

  const startTime = Date.now();

  // Step 1: Discover
  if (!opts.skipDiscover && !opts.repoId) {
    run('Discover', 'discover-repos.ts', [
      '--framework', opts.framework,
      '--min-stars', String(opts.minStars),
      '--limit', String(opts.limit),
    ]);
  } else {
    info('Skipping discovery');
  }

  // Step 2: Clone
  const cloneArgs: string[] = [];
  if (opts.repoId) cloneArgs.push('--repo', opts.repoId);
  else cloneArgs.push('--all');
  run('Clone', 'clone-repos.ts', cloneArgs);

  // Step 3: Analyze
  const analyzeArgs: string[] = [];
  if (opts.repoId) analyzeArgs.push('--repo', opts.repoId);
  if (opts.force) analyzeArgs.push('--force');
  run('Analyze', 'run-analysis.ts', analyzeArgs);

  // Step 4: Evaluate
  if (!opts.skipEvaluate) {
    const evalArgs: string[] = [];
    if (opts.repoId) evalArgs.push('--repo', opts.repoId);
    if (opts.incremental) evalArgs.push('--incremental');
    run('Evaluate', 'evaluate.ts', evalArgs);
  } else {
    info('Skipping evaluation');
  }

  // Step 5: Aggregate
  const aggArgs: string[] = [];
  if (opts.compareWith) aggArgs.push('--compare-with', opts.compareWith);
  run('Aggregate', 'aggregate.ts', aggArgs);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  success(`\nPipeline complete in ${elapsed}s`);
}

main();
