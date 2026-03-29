import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getResultsDir } from './repo-registry.ts';
import type { RepoMeta, EnrichedAnalysisResult, EvaluationResult } from './types.ts';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export function loadMeta(repoId: string): RepoMeta | null {
  const path = join(getResultsDir(repoId), 'meta.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveMeta(repoId: string, meta: RepoMeta): void {
  const dir = getResultsDir(repoId);
  ensureDir(dir);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Raw analysis results
// ---------------------------------------------------------------------------

export function rawResultPath(repoId: string, version: string): string {
  return join(getResultsDir(repoId), `raw-v${version}.json`);
}

export function hasRawResult(repoId: string, version: string): boolean {
  return existsSync(rawResultPath(repoId, version));
}

export function loadRawResult(repoId: string, version: string): EnrichedAnalysisResult | null {
  const path = rawResultPath(repoId, version);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveRawResult(repoId: string, version: string, result: EnrichedAnalysisResult): void {
  const dir = getResultsDir(repoId);
  ensureDir(dir);
  writeFileSync(rawResultPath(repoId, version), JSON.stringify(result, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Evaluation results
// ---------------------------------------------------------------------------

export function evalResultPath(repoId: string, version: string): string {
  return join(getResultsDir(repoId), `eval-v${version}.json`);
}

export function hasEvalResult(repoId: string, version: string): boolean {
  return existsSync(evalResultPath(repoId, version));
}

export function loadEvalResult(repoId: string, version: string): EvaluationResult | null {
  const path = evalResultPath(repoId, version);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveEvalResult(repoId: string, version: string, result: EvaluationResult): void {
  const dir = getResultsDir(repoId);
  ensureDir(dir);
  writeFileSync(evalResultPath(repoId, version), JSON.stringify(result, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const DASHBOARD_DIR = join(import.meta.dirname, '..', 'data', 'dashboard');

export function saveDashboard(summary: unknown, version: string): void {
  ensureDir(DASHBOARD_DIR);
  ensureDir(join(DASHBOARD_DIR, 'history'));

  writeFileSync(join(DASHBOARD_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  const dateStr = new Date().toISOString().split('T')[0];
  writeFileSync(
    join(DASHBOARD_DIR, 'history', `${dateStr}_v${version}.json`),
    JSON.stringify(summary, null, 2) + '\n',
  );
}
