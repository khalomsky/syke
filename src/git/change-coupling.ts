import { execSync } from "child_process";

// ── Interfaces ──

export interface ChangeCoupling {
  file1: string;
  file2: string;
  coChangeCount: number;
  file1Changes: number;
  file2Changes: number;
  confidence: number;
  support: number;
}

export interface CouplingResult {
  couplings: ChangeCoupling[];
  fileCouplings: Map<string, ChangeCoupling[]>;
  totalCommitsAnalyzed: number;
  analyzedAt: number;
}

export interface CouplingOptions {
  maxCommits?: number;
  minSupport?: number;
  minConfidence?: number;
  maxFilesPerCommit?: number;
}

// ── Defaults ──

const DEFAULT_MAX_COMMITS = 500;
const DEFAULT_MIN_SUPPORT = 3;
const DEFAULT_MIN_CONFIDENCE = 0.3;
const DEFAULT_MAX_FILES_PER_COMMIT = 20;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Cache ──

let cachedResult: CouplingResult | null = null;
let cachedProjectRoot: string | null = null;

/**
 * Invalidate the coupling cache. Call this when the graph is refreshed
 * or when git history may have changed.
 */
export function invalidateCouplingCache(): void {
  cachedResult = null;
  cachedProjectRoot = null;
}

// ── Git History Mining ──

/**
 * Check whether the given directory is inside a git repository.
 */
function isGitRepo(projectRoot: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse git log output into a list of commits, each containing
 * the list of files changed in that commit.
 */
function parseGitLog(raw: string): string[][] {
  const commits: string[][] = [];
  const segments = raw.split("COMMIT:");

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // First line is the commit hash, remaining lines are file paths
    const lines = trimmed.split("\n");
    const files: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const fileLine = lines[i].trim();
      if (fileLine) {
        files.push(fileLine);
      }
    }

    if (files.length > 0) {
      commits.push(files);
    }
  }

  return commits;
}

/**
 * Normalize a git-output path (forward slashes) to be consistent
 * with how the dependency graph stores paths.
 */
function normalizePath(filePath: string): string {
  // Git always outputs forward slashes; normalize for consistency
  return filePath.replace(/\\/g, "/");
}

/**
 * Check if a file path looks like a source file (not binary, not config noise).
 * We keep this broad — the dependency graph comparison will handle the real filtering.
 */
function isSourceFile(filePath: string): boolean {
  // Skip obviously non-source files
  const skipPatterns = [
    /\.lock$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /\.min\.(js|css)$/,
    /\.map$/,
    /\.d\.ts$/,
    /\.png$/,
    /\.jpg$/,
    /\.jpeg$/,
    /\.gif$/,
    /\.svg$/,
    /\.ico$/,
    /\.woff2?$/,
    /\.ttf$/,
    /\.eot$/,
    /\.pdf$/,
    /\.zip$/,
    /\.tar$/,
    /\.gz$/,
  ];

  const normalized = filePath.toLowerCase();
  return !skipPatterns.some((p) => p.test(normalized));
}

/**
 * Create a canonical pair key for two files (order-independent).
 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

/**
 * Mine git history to find files that frequently co-change.
 *
 * Runs `git log --name-only` and analyzes pairwise file combinations
 * within each commit to identify hidden logical dependencies.
 */
export async function mineGitHistory(
  projectRoot: string,
  options?: CouplingOptions
): Promise<CouplingResult> {
  // Return cached result if still valid
  if (
    cachedResult &&
    cachedProjectRoot === projectRoot &&
    Date.now() - cachedResult.analyzedAt < CACHE_TTL_MS
  ) {
    return cachedResult;
  }

  const maxCommits = options?.maxCommits ?? DEFAULT_MAX_COMMITS;
  const minSupport = options?.minSupport ?? DEFAULT_MIN_SUPPORT;
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxFilesPerCommit = options?.maxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT;

  // Empty result for non-git projects
  const emptyResult: CouplingResult = {
    couplings: [],
    fileCouplings: new Map(),
    totalCommitsAnalyzed: 0,
    analyzedAt: Date.now(),
  };

  if (!isGitRepo(projectRoot)) {
    cachedResult = emptyResult;
    cachedProjectRoot = projectRoot;
    return emptyResult;
  }

  // Run git log
  let raw: string;
  try {
    raw = execSync(
      `git log --name-only --format="COMMIT:%H" --max-count=${maxCommits}`,
      {
        cwd: projectRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch {
    cachedResult = emptyResult;
    cachedProjectRoot = projectRoot;
    return emptyResult;
  }

  const commits = parseGitLog(raw);

  // Track per-file change counts and per-pair co-change counts
  const fileChangeCount = new Map<string, number>();
  const pairCoChangeCount = new Map<string, number>();
  let totalCommitsAnalyzed = 0;

  for (const commitFiles of commits) {
    // Filter to source files and normalize paths
    const filtered = commitFiles
      .map(normalizePath)
      .filter(isSourceFile);

    // Skip mega-commits (merge commits, large refactors)
    if (filtered.length > maxFilesPerCommit || filtered.length < 2) {
      if (filtered.length === 1) {
        // Still count single-file commits for per-file totals
        const file = filtered[0];
        fileChangeCount.set(file, (fileChangeCount.get(file) || 0) + 1);
      }
      totalCommitsAnalyzed++;
      continue;
    }

    totalCommitsAnalyzed++;

    // Count per-file changes
    for (const file of filtered) {
      fileChangeCount.set(file, (fileChangeCount.get(file) || 0) + 1);
    }

    // Count pairwise co-changes
    for (let i = 0; i < filtered.length; i++) {
      for (let j = i + 1; j < filtered.length; j++) {
        const key = pairKey(filtered[i], filtered[j]);
        pairCoChangeCount.set(key, (pairCoChangeCount.get(key) || 0) + 1);
      }
    }
  }

  // Build coupling results, filtering by thresholds
  const couplings: ChangeCoupling[] = [];

  for (const [key, coCount] of pairCoChangeCount) {
    if (coCount < minSupport) continue;

    const [file1, file2] = key.split("\0");
    const file1Changes = fileChangeCount.get(file1) || 0;
    const file2Changes = fileChangeCount.get(file2) || 0;
    const maxChanges = Math.max(file1Changes, file2Changes);
    const confidence = maxChanges > 0 ? coCount / maxChanges : 0;

    if (confidence < minConfidence) continue;

    couplings.push({
      file1,
      file2,
      coChangeCount: coCount,
      file1Changes,
      file2Changes,
      confidence,
      support: coCount,
    });
  }

  // Sort by confidence descending
  couplings.sort((a, b) => b.confidence - a.confidence);

  // Build the per-file lookup map
  const fileCouplings = new Map<string, ChangeCoupling[]>();

  for (const coupling of couplings) {
    // Add to file1's list
    if (!fileCouplings.has(coupling.file1)) {
      fileCouplings.set(coupling.file1, []);
    }
    fileCouplings.get(coupling.file1)!.push(coupling);

    // Add to file2's list
    if (!fileCouplings.has(coupling.file2)) {
      fileCouplings.set(coupling.file2, []);
    }
    fileCouplings.get(coupling.file2)!.push(coupling);
  }

  // Sort each file's couplings by confidence descending
  for (const [, list] of fileCouplings) {
    list.sort((a, b) => b.confidence - a.confidence);
  }

  const result: CouplingResult = {
    couplings,
    fileCouplings,
    totalCommitsAnalyzed,
    analyzedAt: Date.now(),
  };

  cachedResult = result;
  cachedProjectRoot = projectRoot;
  return result;
}

/**
 * Get all significant couplings for a given file path.
 * Returns an empty array if no couplings are found.
 *
 * The filePath should be a relative path matching git log output format
 * (forward slashes, relative to project root).
 */
export function getCoupledFiles(
  filePath: string,
  result: CouplingResult
): ChangeCoupling[] {
  const normalized = normalizePath(filePath);
  return result.fileCouplings.get(normalized) || [];
}
