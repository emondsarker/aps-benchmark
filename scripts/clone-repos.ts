#!/usr/bin/env tsx
/**
 * Clone repos from the manifest into the local cache.
 *
 * Usage:
 *   npx tsx scripts/clone-repos.ts              # clone all pending
 *   npx tsx scripts/clone-repos.ts --repo <id>  # clone a specific repo
 *   npx tsx scripts/clone-repos.ts --all        # clone all non-cloned
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { loadManifest, updateRepo, getCacheDir } from '../lib/repo-registry.ts';
import { info, success, warn, error, heading, step } from '../lib/logger.ts';
import type { RepoEntry } from '../lib/types.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { repoId: string | null; all: boolean } {
  const args = process.argv.slice(2);
  let repoId: string | null = null;
  let all = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) repoId = args[++i];
    else if (args[i] === '--all') all = true;
  }

  return { repoId, all };
}

// ---------------------------------------------------------------------------
// Clone logic
// ---------------------------------------------------------------------------

function cloneRepo(repo: RepoEntry): boolean {
  const cacheDir = getCacheDir(repo.id);

  if (existsSync(cacheDir)) {
    info(`  Cache exists for ${repo.id}, skipping clone`);
    updateRepo(repo.id, { status: 'cloned', clonedAt: new Date().toISOString() });
    return true;
  }

  const parentDir = cacheDir.replace(/\/[^/]+$/, '');
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const cloneUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
  const cmd = `git clone --depth 1 --branch ${repo.defaultBranch} ${cloneUrl} ${cacheDir}`;

  try {
    step(`Cloning ${repo.owner}/${repo.name} (★${repo.stars})...`);
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
    updateRepo(repo.id, { status: 'cloned', clonedAt: new Date().toISOString() });
    success(`  Cloned ${repo.id}`);
    return true;
  } catch (e) {
    // Retry without --branch flag in case defaultBranch is wrong
    try {
      const fallbackCmd = `git clone --depth 1 ${cloneUrl} ${cacheDir}`;
      execSync(fallbackCmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      updateRepo(repo.id, { status: 'cloned', clonedAt: new Date().toISOString() });
      success(`  Cloned ${repo.id} (fallback branch)`);
      return true;
    } catch {
      error(`  Failed to clone ${repo.id}: ${(e as Error).message?.split('\n')[0]}`);
      updateRepo(repo.id, { status: 'clone-failed' });
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { repoId, all } = parseArgs();
  const manifest = loadManifest();

  let repos: RepoEntry[];

  if (repoId) {
    const repo = manifest.repos.find(r => r.id === repoId);
    if (!repo) {
      error(`Repo not found: ${repoId}`);
      process.exit(1);
    }
    repos = [repo];
  } else if (all) {
    repos = manifest.repos.filter(r => r.status !== 'cloned');
  } else {
    repos = manifest.repos.filter(r => r.status === 'pending');
  }

  if (repos.length === 0) {
    warn('No repos to clone. Run discover-repos.ts first.');
    return;
  }

  heading(`Cloning ${repos.length} repos`);

  let cloned = 0;
  let failed = 0;

  for (const repo of repos) {
    if (cloneRepo(repo)) {
      cloned++;
    } else {
      failed++;
    }
  }

  heading('Summary');
  success(`Cloned: ${cloned}`);
  if (failed > 0) error(`Failed: ${failed}`);
}

main();
