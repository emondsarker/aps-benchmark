import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { RawDetection, EnrichedDetection } from './types.ts';

/**
 * Extract lines around a detection from the source file.
 * Returns 5 lines before and 15 lines after (20 lines total) with line numbers.
 */
export function extractSourceContext(
  filePath: string,
  line: number,
  contextBefore: number = 5,
  contextAfter: number = 15,
): string {
  if (!existsSync(filePath)) return '(source file not found)';

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, line - 1 - contextBefore);
    const end = Math.min(lines.length, line - 1 + contextAfter + 1);
    const slice = lines.slice(start, end);

    return slice
      .map((l, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === line ? '→' : ' ';
        return `${marker} ${String(lineNum).padStart(4)} | ${l}`;
      })
      .join('\n');
  } catch {
    return '(failed to read source file)';
  }
}

/**
 * Compute a stable hash for a detection (for incremental evaluation).
 */
export function computeDetectionHash(detection: RawDetection): string {
  const input = `${detection.snifferName}::${detection.filePath}::${detection.line}::${detection.message}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Enrich a raw detection with source context and hash.
 */
export function enrichDetection(
  detection: RawDetection,
  repoDir: string,
): EnrichedDetection {
  const relativeFilePath = detection.filePath.startsWith(repoDir)
    ? detection.filePath.slice(repoDir.length + 1)
    : detection.filePath;

  return {
    ...detection,
    hash: computeDetectionHash(detection),
    sourceContext: extractSourceContext(detection.filePath, detection.line),
    relativeFilePath,
  };
}
