import * as path from "path";
import * as fs from "fs/promises";
import { detectLanguages, LanguagePlugin } from "./languages/plugin";
import { clearAliasCache } from "./languages/typescript";
import { SCCResult, computeSCC } from "./graph/scc";
import { resetMemoCache } from "./graph/memo-cache";

export interface DependencyGraph {
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
  files: Set<string>;
  projectRoot: string;
  languages: string[];
  sourceDirs: string[];
  /** backward compat: first source directory */
  sourceDir: string;
  /** Strongly Connected Components — computed after graph build */
  scc?: SCCResult;
}

let cachedGraph: DependencyGraph | null = null;

export function buildGraph(
  projectRoot: string,
  packageName?: string,
  maxFiles?: number
): DependencyGraph {
  const detectedPlugins = detectLanguages(projectRoot);
  const languages = detectedPlugins.map(p => p.id);

  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const files = new Set<string>();
  const allSourceDirs: string[] = [];
  let totalDiscovered = 0;
  let fileLimitHit = false;

  for (const plugin of detectedPlugins) {
    const dirs = plugin.getSourceDirs(projectRoot);
    console.error(`[syke:debug] ${plugin.id} getSourceDirs(${projectRoot}) => ${dirs.length} dirs: ${dirs.join(", ")}`);
    for (const dir of dirs) {
      if (!allSourceDirs.includes(dir)) allSourceDirs.push(dir);

      const sourceFiles = plugin.discoverFiles(dir);
      console.error(`[syke:debug] ${plugin.id} discoverFiles(${dir}) => ${sourceFiles.length} files`);
      totalDiscovered += sourceFiles.length;

      for (const f of sourceFiles) {
        if (maxFiles && files.size >= maxFiles) {
          fileLimitHit = true;
          break;
        }
        files.add(f);
        if (!forward.has(f)) forward.set(f, []);
      }

      for (const f of sourceFiles) {
        if (!files.has(f)) continue;
        const imports = plugin.parseImports(f, projectRoot, dir);
        const validImports: string[] = [];

        for (const imp of imports) {
          if (!files.has(imp)) continue;
          validImports.push(imp);
          const rev = reverse.get(imp) || [];
          rev.push(f);
          reverse.set(imp, rev);
        }

        forward.set(f, validImports);
      }
    }
  }

  if (fileLimitHit) {
    console.error(`[syke] Free tier: loaded ${files.size}/${totalDiscovered} files (limit: ${maxFiles}). Upgrade to Pro for unlimited.`);
  }

  const sourceDir = allSourceDirs[0] || path.join(projectRoot, "src");

  const graph: DependencyGraph = {
    forward,
    reverse,
    files,
    projectRoot,
    languages,
    sourceDirs: allSourceDirs,
    sourceDir,
  };

  // Invalidate memo cache (full rebuild means all cached BFS results are stale)
  resetMemoCache();

  // Compute SCC and attach to graph (used by gate_build for cycle detection)
  const scc = computeSCC(graph);
  graph.scc = scc;

  const cyclicCount = scc.condensed.nodes.filter(n => n.isCyclic).length;
  cachedGraph = graph;

  console.error(
    `[syke] Graph built (${languages.join("+")}): ${files.size} files, ${countEdges(forward)} edges, ${scc.components.length} SCCs (${cyclicCount} cyclic)`
  );

  return graph;
}

/**
 * Async graph builder — reads all files in parallel batches for faster startup.
 * Returns the graph + contentMap (reusable by FileCache to avoid re-reading).
 */
export async function buildGraphAsync(
  projectRoot: string,
  packageName?: string,
  maxFiles?: number
): Promise<{ graph: DependencyGraph; contentMap: Map<string, string> }> {
  const detectedPlugins = detectLanguages(projectRoot);
  const languages = detectedPlugins.map(p => p.id);

  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const files = new Set<string>();
  const allSourceDirs: string[] = [];
  let totalDiscovered = 0;
  let fileLimitHit = false;

  // Phase 1: Discover files (sync — directory walking is I/O-light)
  const pluginDirFiles = new Map<LanguagePlugin, Map<string, string[]>>();

  for (const plugin of detectedPlugins) {
    const dirs = plugin.getSourceDirs(projectRoot);
    const dirMap = new Map<string, string[]>();

    for (const dir of dirs) {
      if (!allSourceDirs.includes(dir)) allSourceDirs.push(dir);
      const sourceFiles = plugin.discoverFiles(dir);
      totalDiscovered += sourceFiles.length;
      dirMap.set(dir, sourceFiles);

      for (const f of sourceFiles) {
        if (maxFiles && files.size >= maxFiles) {
          fileLimitHit = true;
          break;
        }
        files.add(f);
        if (!forward.has(f)) forward.set(f, []);
      }
    }

    pluginDirFiles.set(plugin, dirMap);
  }

  if (fileLimitHit) {
    console.error(`[syke] Free tier: loaded ${files.size}/${totalDiscovered} files (limit: ${maxFiles}). Upgrade to Pro for unlimited.`);
  }

  // Phase 2: Parallel file reading (biggest performance win)
  const contentMap = new Map<string, string>();
  const filesToRead = [...files];
  const BATCH_SIZE = 100;

  for (let i = 0; i < filesToRead.length; i += BATCH_SIZE) {
    const batch = filesToRead.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (f) => {
        try {
          const content = await fs.readFile(f, "utf-8");
          return [f, content] as [string, string];
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) contentMap.set(r[0], r[1]);
    }
  }

  // Phase 3: Parse imports using pre-read content (no I/O)
  for (const [plugin, dirMap] of pluginDirFiles) {
    for (const [dir, sourceFiles] of dirMap) {
      for (const f of sourceFiles) {
        if (!files.has(f)) continue;
        const content = contentMap.get(f);
        const imports = plugin.parseImports(f, projectRoot, dir, content);
        const validImports: string[] = [];

        for (const imp of imports) {
          if (!files.has(imp)) continue;
          validImports.push(imp);
          const rev = reverse.get(imp) || [];
          rev.push(f);
          reverse.set(imp, rev);
        }

        forward.set(f, validImports);
      }
    }
  }

  const sourceDir = allSourceDirs[0] || path.join(projectRoot, "src");

  const graph: DependencyGraph = {
    forward,
    reverse,
    files,
    projectRoot,
    languages,
    sourceDirs: allSourceDirs,
    sourceDir,
  };

  resetMemoCache();

  const scc = computeSCC(graph);
  graph.scc = scc;

  const cyclicCount = scc.condensed.nodes.filter(n => n.isCyclic).length;
  cachedGraph = graph;

  console.error(
    `[syke] Graph built (${languages.join("+")}): ${files.size} files, ${countEdges(forward)} edges, ${scc.components.length} SCCs (${cyclicCount} cyclic)`
  );

  return { graph, contentMap };
}

function countEdges(forward: Map<string, string[]>): number {
  let count = 0;
  for (const deps of forward.values()) {
    count += deps.length;
  }
  return count;
}

export function getGraph(
  projectRoot: string,
  packageName?: string,
  maxFiles?: number
): DependencyGraph {
  if (cachedGraph && cachedGraph.projectRoot === projectRoot) {
    return cachedGraph;
  }
  return buildGraph(projectRoot, packageName, maxFiles);
}

export function rebuildGraph(
  projectRoot: string,
  packageName?: string,
  maxFiles?: number
): DependencyGraph {
  cachedGraph = null;
  clearAliasCache();
  resetMemoCache();
  return buildGraph(projectRoot, packageName, maxFiles);
}
