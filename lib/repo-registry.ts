import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoManifest, RepoEntry } from './types.ts';

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const REPOS_PATH = join(DATA_DIR, 'repos.json');

export function loadManifest(): RepoManifest {
  if (!existsSync(REPOS_PATH)) {
    return { repos: [], lastUpdated: '' };
  }
  return JSON.parse(readFileSync(REPOS_PATH, 'utf-8'));
}

export function saveManifest(manifest: RepoManifest): void {
  manifest.lastUpdated = new Date().toISOString();
  writeFileSync(REPOS_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

export function addRepos(newRepos: RepoEntry[]): { added: number; skipped: number } {
  const manifest = loadManifest();
  const existingIds = new Set(manifest.repos.map(r => r.id));
  let added = 0;
  let skipped = 0;

  for (const repo of newRepos) {
    if (existingIds.has(repo.id)) {
      skipped++;
      continue;
    }
    manifest.repos.push(repo);
    existingIds.add(repo.id);
    added++;
  }

  saveManifest(manifest);
  return { added, skipped };
}

export function updateRepo(id: string, updates: Partial<RepoEntry>): void {
  const manifest = loadManifest();
  const repo = manifest.repos.find(r => r.id === id);
  if (!repo) throw new Error(`Repo not found: ${id}`);
  Object.assign(repo, updates);
  saveManifest(manifest);
}

export function getRepo(id: string): RepoEntry | undefined {
  return loadManifest().repos.find(r => r.id === id);
}

export function getReposByStatus(status: RepoEntry['status']): RepoEntry[] {
  return loadManifest().repos.filter(r => r.status === status);
}

export function getCacheDir(repoId: string): string {
  return join(DATA_DIR, 'cache', repoId);
}

export function getResultsDir(repoId: string): string {
  return join(DATA_DIR, 'results', repoId);
}
