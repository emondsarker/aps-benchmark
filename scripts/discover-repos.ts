#!/usr/bin/env tsx
/**
 * Discover open-source repos on GitHub for benchmark evaluation.
 *
 * Usage:
 *   npx tsx scripts/discover-repos.ts --framework react --min-stars 500 --limit 20
 *   npx tsx scripts/discover-repos.ts --framework nestjs --min-stars 200 --limit 10
 *   npx tsx scripts/discover-repos.ts --framework express --min-stars 500 --limit 15
 */
import { execSync } from 'node:child_process';
import { addRepos } from '../lib/repo-registry.ts';
import { info, success, warn, heading, dim, step, error } from '../lib/logger.ts';
import type { RepoEntry, Framework } from '../lib/types.ts';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { framework: Framework; minStars: number; limit: number } {
  const args = process.argv.slice(2);
  let framework: Framework = 'react';
  let minStars = 500;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--framework' && args[i + 1]) {
      framework = args[++i] as Framework;
    } else if (args[i] === '--min-stars' && args[i + 1]) {
      minStars = parseInt(args[++i], 10);
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: npx tsx scripts/discover-repos.ts [options]

Options:
  --framework <name>   react | nextjs | express | nestjs (default: react)
  --min-stars <n>      Minimum star count (default: 500)
  --limit <n>          Max repos to fetch (default: 20)
  -h, --help           Show this help
`);
      process.exit(0);
    }
  }

  return { framework, minStars, limit };
}

// ---------------------------------------------------------------------------
// GitHub search queries per framework
// ---------------------------------------------------------------------------

const SEARCH_QUERIES: Record<Framework, string[]> = {
  react: [
    'topic:react language:TypeScript',
    'topic:react language:JavaScript',
  ],
  nextjs: [
    'topic:nextjs language:TypeScript',
  ],
  express: [
    'topic:express language:TypeScript',
    'topic:express language:JavaScript',
  ],
  nestjs: [
    'topic:nestjs language:TypeScript',
  ],
  mixed: [],
};

// ---------------------------------------------------------------------------
// GitHub API via gh CLI
// `gh search repos` exposes these --json fields:
//   name, owner, url, stargazersCount, forksCount, openIssuesCount,
//   description, language, license, defaultBranch, size, isArchived, isFork,
//   updatedAt, fullName, visibility
// ---------------------------------------------------------------------------

interface GhSearchResult {
  name: string;
  owner: { login: string };
  url: string;
  stargazersCount: number;
  forksCount: number;
  openIssuesCount: number;
  description: string;
  language: string;
  license: { key: string; name: string } | null;
  defaultBranch: string;
  size: number;
  isArchived: boolean;
  isFork: boolean;
  updatedAt: string;
}

function searchGitHub(query: string, minStars: number, limit: number): GhSearchResult[] {
  const fullQuery = `${query} stars:>=${minStars} archived:false fork:false`;

  const ghFields = [
    'name', 'owner', 'url', 'stargazersCount', 'forksCount',
    'openIssuesCount', 'description', 'language', 'license',
    'defaultBranch', 'size', 'isArchived', 'isFork', 'updatedAt',
  ].join(',');

  const cmd = `gh search repos ${JSON.stringify(fullQuery)} --json ${ghFields} --sort stars --order desc --limit ${limit}`;

  try {
    const stdout = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout) as GhSearchResult[];
  } catch (e) {
    error(`GitHub search failed: ${(e as Error).message?.split('\n')[0]}`);
    return [];
  }
}

function toRepoEntry(gh: GhSearchResult, framework: Framework): RepoEntry {
  const owner = gh.owner.login;
  const name = gh.name;

  return {
    id: `${owner}_${name}`,
    owner,
    name,
    url: gh.url,
    stars: gh.stargazersCount,
    forks: gh.forksCount,
    openIssues: gh.openIssuesCount,
    description: gh.description || '',
    language: gh.language || 'Unknown',
    topics: [], // gh search repos doesn't return topics
    license: gh.license?.key || 'Unknown',
    defaultBranch: gh.defaultBranch || 'main',
    repoSizeKb: gh.size || 0,
    framework,
    addedAt: new Date().toISOString(),
    status: 'pending',
    clonedAt: null,
    lastAnalyzedVersion: null,
    lastEvaluatedVersion: null,
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { framework, minStars, limit } = parseArgs();

  heading(`Discovering ${framework} repos (stars >= ${minStars}, limit ${limit})`);

  const queries = SEARCH_QUERIES[framework];
  if (!queries || queries.length === 0) {
    error(`No search queries defined for framework: ${framework}`);
    process.exit(1);
  }

  const allEntries: RepoEntry[] = [];
  const seenIds = new Set<string>();

  for (const query of queries) {
    step(`Searching: ${query} stars:>=${minStars}`);
    const repos = searchGitHub(query, minStars, limit);
    info(`  Found ${repos.length} results`);

    for (const gh of repos) {
      const entry = toRepoEntry(gh, framework);
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        allEntries.push(entry);
      }
    }
  }

  if (allEntries.length === 0) {
    warn('No repos found. Try lowering --min-stars or changing --framework.');
    return;
  }

  info(`Found ${allEntries.length} unique repos total`);

  const { added, skipped } = addRepos(allEntries);
  success(`Added ${added} new repos to manifest (${skipped} already existed)`);

  if (added > 0) {
    heading('Newly added repos:');
    for (const entry of allEntries) {
      dim(`${entry.id} — ★${entry.stars} — ${entry.description.slice(0, 80)}`);
    }
  }
}

main();
