import * as path from "path";
import { DependencyGraph } from "../graph";
import {
  mineGitHistory,
  getCoupledFiles,
  CouplingResult,
} from "../git/change-coupling";
import { getMemoCache, MemoCache } from "../graph/memo-cache";

export type RiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface CoupledFileInfo {
  relativePath: string;
  confidence: number;
  coChangeCount: number;
  inDependencyGraph: boolean;
}

export interface ImpactResult {
  filePath: string;
  relativePath: string;
  riskLevel: RiskLevel;
  directDependents: string[];
  transitiveDependents: string[];
  totalImpacted: number;
  /** Cascade depth of each impacted file in the condensed DAG */
  cascadeLevels?: Map<string, number>;
  /** Files in the same cyclic SCC as the changed file (if any) */
  circularCluster?: string[];
  /** Total number of SCCs in the project */
  sccCount?: number;
  /** Number of SCCs with more than one file (circular dependencies) */
  cyclicSCCs?: number;
  /** Files that historically co-change but may not be in the dependency graph */
  coupledFiles?: CoupledFileInfo[];
  /** True if the BFS result came from the memo cache (fast path) */
  fromCache?: boolean;
}

/**
 * BFS reverse traversal to find all files impacted by modifying `filePath`.
 * When SCC data is available, uses the condensed DAG for more accurate
 * cascade-level analysis and circular dependency detection.
 *
 * Optionally computes a composite risk score when `includeRiskScore` is true.
 * Optionally computes historical change coupling when `includeCoupling` is true.
 */
/**
 * Local BFS impact analysis — used by BYOK ai_analyze and web dashboard.
 * Risk scoring is now server-side (Pro). This function provides basic
 * BFS traversal and SCC-enhanced cascade analysis.
 */
export async function analyzeImpact(
  filePath: string,
  graph: DependencyGraph,
  options?: { includeCoupling?: boolean }
): Promise<ImpactResult> {
  const normalized = path.normalize(filePath);
  const toRelative = (f: string) => path.relative(graph.sourceDir, f).replace(/\\/g, "/");

  // Check memo cache for a cached BFS result (fast path)
  const memoCache = getMemoCache();
  const cached = memoCache.get(normalized);
  if (cached) {
    const directDependents = (graph.reverse.get(normalized) || []).map(toRelative);
    const directSet = new Set(directDependents);
    const transitiveDependents = cached.impactSet
      .map(f => toRelative(f))
      .filter(rel => !directSet.has(rel));

    let result: ImpactResult = {
      filePath: normalized,
      relativePath: toRelative(normalized),
      riskLevel: cached.riskLevel as RiskLevel,
      directDependents,
      transitiveDependents,
      totalImpacted: cached.directCount + cached.transitiveCount,
      cascadeLevels: cached.cascadeLevels,
      fromCache: true,
    };

    if (options?.includeCoupling) {
      try {
        const coupledFiles = await computeCoupledFiles(normalized, graph, toRelative);
        if (coupledFiles.length > 0) {
          result.coupledFiles = coupledFiles;
        }
      } catch (err) {
        console.error(`[syke:coupling] Failed to compute change coupling for ${filePath}: ${err}`);
      }
    }

    return result;
  }

  // Cache miss: run full BFS analysis
  let result: ImpactResult;
  if (graph.scc) {
    result = analyzeImpactWithSCC(normalized, graph, toRelative);
  } else {
    result = analyzeImpactBFS(normalized, graph, toRelative);
  }

  // Store BFS result in memo cache
  const allImpactedAbsPaths = [
    ...result.directDependents,
    ...result.transitiveDependents,
  ].map(rel => path.normalize(path.join(graph.sourceDir, rel)));

  memoCache.set(normalized, {
    impactSet: allImpactedAbsPaths,
    directCount: result.directDependents.length,
    transitiveCount: result.transitiveDependents.length,
    riskLevel: result.riskLevel,
    cascadeLevels: result.cascadeLevels,
    computedAt: Date.now(),
  });

  // Compute historical change coupling if requested
  if (options?.includeCoupling) {
    try {
      const coupledFiles = await computeCoupledFiles(normalized, graph, toRelative);
      if (coupledFiles.length > 0) {
        result.coupledFiles = coupledFiles;
      }
    } catch (err) {
      console.error(`[syke:coupling] Failed to compute change coupling for ${filePath}: ${err}`);
    }
  }

  return result;
}

/**
 * Compute historical change coupling for a file, filtering to only show
 * couplings that are NOT already in the dependency graph ("hidden" dependencies).
 * Returns at most 5 coupled files, sorted by confidence.
 */
async function computeCoupledFiles(
  normalizedPath: string,
  graph: DependencyGraph,
  toRelative: (f: string) => string
): Promise<CoupledFileInfo[]> {
  const couplingResult = await mineGitHistory(graph.projectRoot);

  if (couplingResult.totalCommitsAnalyzed === 0) {
    return [];
  }

  // Convert file path to git-relative format (forward slashes, relative to project root)
  const gitRelPath = path.relative(graph.projectRoot, normalizedPath).replace(/\\/g, "/");
  const couplings = getCoupledFiles(gitRelPath, couplingResult);

  if (couplings.length === 0) {
    return [];
  }

  // Build a set of all files in the dependency graph (both direct and transitive)
  const graphDeps = new Set<string>();

  // Forward dependencies of this file
  const forwardDeps = graph.forward.get(normalizedPath) || [];
  for (const d of forwardDeps) {
    graphDeps.add(path.relative(graph.projectRoot, d).replace(/\\/g, "/"));
  }

  // Reverse dependents of this file
  const reverseDeps = graph.reverse.get(normalizedPath) || [];
  for (const d of reverseDeps) {
    graphDeps.add(path.relative(graph.projectRoot, d).replace(/\\/g, "/"));
  }

  const results: CoupledFileInfo[] = [];

  for (const coupling of couplings) {
    // Determine which file is the "other" file in the pair
    const otherFile = coupling.file1 === gitRelPath ? coupling.file2 : coupling.file1;
    const inGraph = graphDeps.has(otherFile);

    // Convert to source-dir-relative path for display
    const otherAbsolute = path.normalize(path.join(graph.projectRoot, otherFile));
    const displayPath = toRelative(otherAbsolute);

    results.push({
      relativePath: displayPath,
      confidence: coupling.confidence,
      coChangeCount: coupling.coChangeCount,
      inDependencyGraph: inGraph,
    });
  }

  // Filter to only hidden dependencies (not in graph) and limit to top 5
  const hidden = results.filter((r) => !r.inDependencyGraph);
  return hidden.slice(0, 5);
}

/**
 * Original BFS-based impact analysis (no SCC data).
 */
function analyzeImpactBFS(
  normalized: string,
  graph: DependencyGraph,
  toRelative: (f: string) => string
): ImpactResult {
  // Direct dependents (depth 1)
  const directDependents = graph.reverse.get(normalized) || [];

  // BFS for transitive dependents (all depths)
  const visited = new Set<string>();
  const queue: string[] = [...directDependents];

  for (const d of directDependents) {
    visited.add(d);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependents = graph.reverse.get(current) || [];
    for (const dep of dependents) {
      if (!visited.has(dep) && dep !== normalized) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  const totalImpacted = visited.size;

  // Transitive-only = all visited minus direct
  const directSet = new Set(directDependents);
  const transitiveDependents = [...visited].filter((f) => !directSet.has(f));

  const riskLevel = classifyRisk(totalImpacted);

  return {
    filePath: normalized,
    relativePath: toRelative(normalized),
    riskLevel,
    directDependents: directDependents.map(toRelative),
    transitiveDependents: transitiveDependents.map(toRelative),
    totalImpacted,
  };
}

/**
 * SCC-enhanced impact analysis using the condensed DAG.
 *
 * 1. If the changed file is in a cyclic SCC (size > 1), ALL files in that SCC
 *    are immediately marked as affected at cascade level 0.
 * 2. BFS on the condensed DAG (using reverse edges = dependents) to find
 *    all impacted SCCs with correct cascade levels.
 * 3. Each file inherits the cascade level of its SCC.
 */
function analyzeImpactWithSCC(
  normalized: string,
  graph: DependencyGraph,
  toRelative: (f: string) => string
): ImpactResult {
  const scc = graph.scc!;
  const { nodeToComponent, condensed } = scc;

  const sccIndex = nodeToComponent.get(normalized);

  // File not found in SCC mapping — fall back to BFS
  if (sccIndex === undefined) {
    return analyzeImpactBFS(normalized, graph, toRelative);
  }

  const startNode = condensed.nodes[sccIndex];

  // Collect circular cluster info
  const circularCluster = startNode.isCyclic
    ? startNode.files.filter(f => f !== normalized).map(toRelative)
    : undefined;

  // BFS on condensed DAG reverse edges to find all impacted SCCs
  // Level 0 = the SCC containing the changed file
  // Level 1 = SCCs that directly depend on the changed SCC
  // Level N = SCCs at distance N in the condensed DAG
  const visitedSCCs = new Map<number, number>(); // SCC index -> cascade level
  visitedSCCs.set(sccIndex, 0);

  const queue: Array<{ sccIdx: number; level: number }> = [
    { sccIdx: sccIndex, level: 0 },
  ];

  while (queue.length > 0) {
    const { sccIdx, level } = queue.shift()!;

    // Get SCCs that depend on this SCC (reverse edges in condensed DAG)
    const dependentSCCs = condensed.reverse.get(sccIdx) || [];
    for (const depSCC of dependentSCCs) {
      if (!visitedSCCs.has(depSCC)) {
        visitedSCCs.set(depSCC, level + 1);
        queue.push({ sccIdx: depSCC, level: level + 1 });
      }
    }
  }

  // Expand SCC indices back to individual files
  const cascadeLevels = new Map<string, number>();
  const allImpactedFiles = new Set<string>();

  for (const [sccIdx, level] of visitedSCCs) {
    const node = condensed.nodes[sccIdx];
    for (const file of node.files) {
      if (file === normalized) continue; // Exclude the changed file itself
      allImpactedFiles.add(file);
      cascadeLevels.set(file, level);
    }
  }

  // Separate into direct (level 1 from raw graph) and transitive
  const rawDirectDependents = graph.reverse.get(normalized) || [];
  const directSet = new Set(rawDirectDependents);

  // Files in the same cyclic SCC are also considered "direct" dependents
  if (startNode.isCyclic) {
    for (const f of startNode.files) {
      if (f !== normalized) {
        directSet.add(f);
      }
    }
  }

  const directDependents = [...allImpactedFiles].filter(f => directSet.has(f));
  const transitiveDependents = [...allImpactedFiles].filter(f => !directSet.has(f));

  const totalImpacted = allImpactedFiles.size;
  const riskLevel = classifyRisk(totalImpacted);

  // Convert cascade levels keys to relative paths
  const relativeCascadeLevels = new Map<string, number>();
  for (const [file, level] of cascadeLevels) {
    relativeCascadeLevels.set(toRelative(file), level);
  }

  return {
    filePath: normalized,
    relativePath: toRelative(normalized),
    riskLevel,
    directDependents: directDependents.map(toRelative),
    transitiveDependents: transitiveDependents.map(toRelative),
    totalImpacted,
    cascadeLevels: relativeCascadeLevels,
    circularCluster,
    sccCount: condensed.nodes.length,
    cyclicSCCs: condensed.nodes.filter(n => n.isCyclic).length,
  };
}

/**
 * Get the memo cache instance for diagnostics (cache stats, etc.).
 */
export function getImpactMemoCache(): MemoCache {
  return getMemoCache();
}

export function classifyRisk(count: number): RiskLevel {
  if (count >= 10) return "HIGH";
  if (count >= 5) return "MEDIUM";
  if (count >= 1) return "LOW";
  return "NONE";
}

/**
 * Rank files by number of reverse dependents (hub score).
 */
export function getHubFiles(
  graph: DependencyGraph,
  topN: number = 10
): Array<{ relativePath: string; dependentCount: number; riskLevel: RiskLevel }> {
  const entries: Array<{ file: string; count: number }> = [];

  for (const file of graph.files) {
    const revDeps = graph.reverse.get(file) || [];
    entries.push({ file, count: revDeps.length });
  }

  entries.sort((a, b) => b.count - a.count);

  return entries.slice(0, topN).map((e) => ({
    relativePath: path.relative(graph.sourceDir, e.file).replace(/\\/g, "/"),
    dependentCount: e.count,
    riskLevel: classifyRisk(e.count),
  }));
}
