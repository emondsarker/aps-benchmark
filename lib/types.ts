// =============================================================================
// Repo-Level Types
// =============================================================================

export interface RepoManifest {
  repos: RepoEntry[];
  lastUpdated: string;
}

export interface RepoEntry {
  /** Filesystem-safe key: "{owner}_{name}" */
  id: string;
  owner: string;
  name: string;
  url: string;
  stars: number;
  forks: number;
  openIssues: number;
  description: string;
  language: string;
  topics: string[];
  license: string;
  defaultBranch: string;
  repoSizeKb: number;
  framework: Framework;
  addedAt: string;
  status: 'pending' | 'cloned' | 'clone-failed';
  clonedAt: string | null;
  lastAnalyzedVersion: string | null;
  lastEvaluatedVersion: string | null;
  tags: string[];
}

export type Framework = 'react' | 'express' | 'nestjs' | 'nextjs' | 'mixed';

// =============================================================================
// Analysis-Level Types
// =============================================================================

export interface RepoMeta {
  id: string;
  url: string;
  framework: Framework;
  stars: number;
  analysisHistory: AnalysisHistoryEntry[];
}

export interface AnalysisHistoryEntry {
  apsVersion: string;
  date: string;
  fileCount: number;
  filesByExtension: Record<string, number>;
  totalIssues: number;
  issuesPerFile: number;
  sniffersRun: string[];
  snifferConfig: Record<string, Record<string, unknown>>;
  frameworksDetected: string[];
  durationMs: number;
  errors: number;
  perSnifferCounts: Record<string, number>;
  perSnifferDurations: Record<string, number>;
}

/** Raw aps JSON output — mirrors json-renderer.ts JsonReport */
export interface RawAnalysisResult {
  meta: {
    fileCount: number;
    totalIssues: number;
    date: string;
    sniffersRun: string[];
  };
  files: Record<string, RawDetection[]>;
  summary: Record<string, { count: number; severity: string }>;
  errors: Array<{ snifferName: string; filePath: string; error: string }>;
}

/** Enriched raw result with extra tracking fields */
export interface EnrichedAnalysisResult extends RawAnalysisResult {
  _benchmark: {
    apsVersion: string;
    repoId: string;
    analyzedAt: string;
    durationMs: number;
    filesByExtension: Record<string, number>;
    snifferConfig: Record<string, Record<string, unknown>>;
    frameworksDetected: string[];
    perSnifferDurations: Record<string, number>;
  };
}

// =============================================================================
// Detection-Level Types
// =============================================================================

export interface RawDetection {
  snifferName: string;
  filePath: string;
  line: number;
  column: number;
  message: string;
  severity: 'info' | 'warning' | 'error';
  suggestion: string;
  details?: Record<string, unknown>;
}

export interface EnrichedDetection extends RawDetection {
  hash: string;
  sourceContext: string;
  relativeFilePath: string;
}

// =============================================================================
// Evaluation-Level Types
// =============================================================================

export type Classification = 'TP' | 'FP' | 'Unclear';

export type FpCategory =
  | 'idiomatic-pattern'
  | 'framework-api'
  | 'justified-complexity'
  | 'type-safe'
  | 'composition-not-drilling'
  | 'threshold-too-low'
  | 'other';

export type Confidence = 'high' | 'medium' | 'low';

export interface EvaluatedDetection {
  hash: string;
  snifferName: string;
  filePath: string;
  line: number;
  message: string;
  severity: string;
  classification: Classification;
  reasoning: string;
  fpCategory: FpCategory | null;
  confidence: Confidence;
  sourceContext: string;
}

export interface EvaluationResult {
  repoId: string;
  apsVersion: string;
  evaluatedAt: string;
  modelUsed: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  detections: EvaluatedDetection[];
  aggregate: {
    total: number;
    tp: number;
    fp: number;
    unclear: number;
    fpRate: number;
  };
}

// =============================================================================
// Aggregate / Dashboard Types
// =============================================================================

export interface DashboardSummary {
  generatedAt: string;
  apsVersion: string;
  repoCount: number;
  totalDetections: number;
  overall: {
    tp: number;
    fp: number;
    unclear: number;
    fpRate: number;
  };
  perSniffer: Record<string, SnifferMetrics>;
  perRepo: RepoMetrics[];
  perFramework: Record<string, {
    repoCount: number;
    totalDetections: number;
    tp: number;
    fp: number;
    unclear: number;
    fpRate: number;
  }>;
  versionComparison: VersionDelta[] | null;
  costSummary: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    estimatedCostUsd: number;
  };
}

export interface SnifferMetrics {
  total: number;
  tp: number;
  fp: number;
  unclear: number;
  fpRate: number;
  avgDetectionsPerRepo: number;
  commonFpPatterns: Array<{ pattern: string; category: FpCategory; count: number }>;
}

export interface RepoMetrics {
  id: string;
  framework: Framework;
  stars: number;
  fileCount: number;
  issueCount: number;
  fpRate: number;
  topSniffers: Array<{ name: string; count: number }>;
}

export interface VersionDelta {
  sniffer: string;
  previousVersion: string;
  currentVersion: string;
  previousFpRate: number;
  currentFpRate: number;
  delta: number;
}

// =============================================================================
// Claude API Response
// =============================================================================

export interface ClaudeClassification {
  index: number;
  classification: Classification;
  fpCategory: FpCategory | null;
  confidence: Confidence;
  reasoning: string;
}
