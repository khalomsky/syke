/**
 * Incremental Graph Updates for SYKE.
 *
 * Instead of rebuilding the entire dependency graph when a single file changes,
 * this module re-parses only the changed file's imports and updates the
 * forward/reverse maps in place. SCC and PageRank are recomputed fully
 * (both are O(V+E) and fast enough) only when edges actually change.
 *
 * This brings update latency from O(N * parse) down to O(1 * parse + V+E)
 * for large codebases (10K+ files).
 */

import * as path from "path";
import { DependencyGraph } from "../graph";
import { getPluginForFile } from "../languages/plugin";
import { computeSCC } from "./scc";

// ── Public Interfaces ──

export interface IncrementalUpdateResult {
  updatedFile: string;              // absolute path of changed file
  addedEdges: [string, string][];   // [from, to] edges added
  removedEdges: [string, string][]; // [from, to] edges removed
  edgesChanged: boolean;            // true if any edges actually changed
  affectedFiles: string[];          // files whose impact results may have changed
}

// ── Core Functions ──

/**
 * Update the graph for a single changed file.
 * Re-parses only that file's imports and updates forward/reverse maps.
 * Returns info about what changed for cache invalidation.
 */
export function updateGraphForFile(
  graph: DependencyGraph,
  filePath: string,
  projectRoot: string
): IncrementalUpdateResult {
  const normalized = path.normalize(filePath);

  // If file is not in the graph, treat as a new file addition
  if (!graph.files.has(normalized)) {
    return addFileToGraph(graph, filePath, projectRoot);
  }

  // 1. Get old forward edges for this file
  const oldDeps = graph.forward.get(normalized) || [];
  const oldDepsSet = new Set(oldDeps);

  // 2. Determine which language plugin handles this file
  const plugin = getPluginForFile(normalized);
  if (!plugin) {
    // No plugin can handle this file extension - nothing to update
    return {
      updatedFile: normalized,
      addedEdges: [],
      removedEdges: [],
      edgesChanged: false,
      affectedFiles: [],
    };
  }

  // 3. Find the appropriate source directory for this file
  const sourceDir = findSourceDirForFile(normalized, graph);

  // 4. Re-parse imports for this file
  const rawImports = plugin.parseImports(normalized, projectRoot, sourceDir);

  // 5. Filter to only include files that exist in the graph (internal deps)
  const newDeps = rawImports.filter(imp => graph.files.has(imp));
  const newDepsSet = new Set(newDeps);

  // 6. Compute diff
  const addedEdges: [string, string][] = [];
  const removedEdges: [string, string][] = [];

  for (const dep of newDeps) {
    if (!oldDepsSet.has(dep)) {
      addedEdges.push([normalized, dep]);
    }
  }

  for (const dep of oldDeps) {
    if (!newDepsSet.has(dep)) {
      removedEdges.push([normalized, dep]);
    }
  }

  const edgesChanged = addedEdges.length > 0 || removedEdges.length > 0;

  // 7. Update forward map
  graph.forward.set(normalized, newDeps);

  // 8. Update reverse map for removed edges
  for (const [, dep] of removedEdges) {
    const revList = graph.reverse.get(dep);
    if (revList) {
      const idx = revList.indexOf(normalized);
      if (idx !== -1) {
        revList.splice(idx, 1);
      }
    }
  }

  // 9. Update reverse map for added edges
  for (const [, dep] of addedEdges) {
    const revList = graph.reverse.get(dep);
    if (revList) {
      if (!revList.includes(normalized)) {
        revList.push(normalized);
      }
    } else {
      graph.reverse.set(dep, [normalized]);
    }
  }

  // 10. Compute affected files (reverse transitive closure of the changed file)
  const affectedFiles = computeAffectedFiles(normalized, graph);

  // 11. If edges changed, recompute SCC and PageRank
  if (edgesChanged) {
    recomputeGraphMetrics(graph);
  }

  return {
    updatedFile: normalized,
    addedEdges,
    removedEdges,
    edgesChanged,
    affectedFiles,
  };
}

/**
 * Add a new file to the graph.
 * Initializes forward/reverse entries, parses imports, and adds edges.
 */
export function addFileToGraph(
  graph: DependencyGraph,
  filePath: string,
  projectRoot: string
): IncrementalUpdateResult {
  const normalized = path.normalize(filePath);

  // Already in graph? Treat as an update instead
  if (graph.files.has(normalized)) {
    return updateGraphForFile(graph, filePath, projectRoot);
  }

  // 1. Add to the files set
  graph.files.add(normalized);

  // 2. Initialize forward entry
  graph.forward.set(normalized, []);

  // 3. Initialize reverse entry if not exists
  if (!graph.reverse.has(normalized)) {
    graph.reverse.set(normalized, []);
  }

  // 4. Determine which plugin handles this file
  const plugin = getPluginForFile(normalized);
  if (!plugin) {
    return {
      updatedFile: normalized,
      addedEdges: [],
      removedEdges: [],
      edgesChanged: false,
      affectedFiles: [],
    };
  }

  // 5. Find source directory
  const sourceDir = findSourceDirForFile(normalized, graph);

  // 6. Parse imports
  const rawImports = plugin.parseImports(normalized, projectRoot, sourceDir);
  const newDeps = rawImports.filter(imp => graph.files.has(imp));

  const addedEdges: [string, string][] = [];

  // 7. Set forward edges
  graph.forward.set(normalized, newDeps);

  // 8. Update reverse maps for new edges
  for (const dep of newDeps) {
    addedEdges.push([normalized, dep]);
    const revList = graph.reverse.get(dep);
    if (revList) {
      if (!revList.includes(normalized)) {
        revList.push(normalized);
      }
    } else {
      graph.reverse.set(dep, [normalized]);
    }
  }

  // 9. Check if any existing file imports this new file
  //    (their forward edges might now resolve to this file)
  //    This is hard to detect without re-parsing all files,
  //    so we skip it — the next full refresh will catch it.
  //    The conservative approach is to just note that edges changed.

  const edgesChanged = addedEdges.length > 0;
  const affectedFiles = computeAffectedFiles(normalized, graph);

  if (edgesChanged) {
    recomputeGraphMetrics(graph);
  }

  return {
    updatedFile: normalized,
    addedEdges,
    removedEdges: [],
    edgesChanged,
    affectedFiles,
  };
}

/**
 * Remove a file from the graph.
 * Cleans up all forward edges, reverse edges, and the files set.
 */
export function removeFileFromGraph(
  graph: DependencyGraph,
  filePath: string
): IncrementalUpdateResult {
  const normalized = path.normalize(filePath);

  if (!graph.files.has(normalized)) {
    // File wasn't in graph, nothing to do
    return {
      updatedFile: normalized,
      addedEdges: [],
      removedEdges: [],
      edgesChanged: false,
      affectedFiles: [],
    };
  }

  // Compute affected files BEFORE removing (need the reverse graph intact)
  const affectedFiles = computeAffectedFiles(normalized, graph);

  const removedEdges: [string, string][] = [];

  // 1. Remove all forward edges (this file imports X)
  const forwardDeps = graph.forward.get(normalized) || [];
  for (const dep of forwardDeps) {
    removedEdges.push([normalized, dep]);
    // Remove this file from dep's reverse list
    const revList = graph.reverse.get(dep);
    if (revList) {
      const idx = revList.indexOf(normalized);
      if (idx !== -1) {
        revList.splice(idx, 1);
      }
    }
  }

  // 2. Remove all reverse edges (X imports this file)
  const reverseDeps = graph.reverse.get(normalized) || [];
  for (const src of reverseDeps) {
    removedEdges.push([src, normalized]);
    // Remove this file from src's forward list
    const fwdList = graph.forward.get(src);
    if (fwdList) {
      const idx = fwdList.indexOf(normalized);
      if (idx !== -1) {
        fwdList.splice(idx, 1);
      }
    }
  }

  // 3. Clean up maps
  graph.forward.delete(normalized);
  graph.reverse.delete(normalized);
  graph.files.delete(normalized);

  const edgesChanged = removedEdges.length > 0;

  if (edgesChanged) {
    recomputeGraphMetrics(graph);
  }

  return {
    updatedFile: normalized,
    addedEdges: [],
    removedEdges,
    edgesChanged,
    affectedFiles,
  };
}

// ── Internal Helpers ──

/**
 * Find the source directory that contains the given file.
 * Falls back to graph.sourceDir if no match found.
 */
function findSourceDirForFile(filePath: string, graph: DependencyGraph): string {
  for (const dir of graph.sourceDirs) {
    if (filePath.startsWith(dir)) {
      return dir;
    }
  }
  return graph.sourceDir;
}

/**
 * Compute the set of files whose cached BFS/impact results might be stale.
 * This is the reverse transitive closure: all files that transitively depend
 * on the changed file (including the changed file itself).
 */
function computeAffectedFiles(filePath: string, graph: DependencyGraph): string[] {
  const affected = new Set<string>();
  affected.add(filePath);

  const queue: string[] = [filePath];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependents = graph.reverse.get(current) || [];
    for (const dep of dependents) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...affected];
}

/**
 * Recompute SCC after edge changes.
 * O(V+E) and fast (<100ms for 10K files).
 * PageRank and risk scoring are now computed server-side (Pro).
 */
function recomputeGraphMetrics(graph: DependencyGraph): void {
  // Recompute SCC (used by gate_build for cycle detection)
  graph.scc = computeSCC(graph);

  const cyclicCount = graph.scc.condensed.nodes.filter(n => n.isCyclic).length;
  console.error(
    `[syke:incremental] Graph metrics recomputed: ${graph.files.size} files, ` +
    `${graph.scc.components.length} SCCs (${cyclicCount} cyclic)`
  );
}
