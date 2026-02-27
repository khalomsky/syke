import * as path from "path";
import * as fs from "fs";
import express, { Response } from "express";
import { DependencyGraph } from "../graph";
import { getPluginForFile } from "../languages/plugin";
import { analyzeImpact, getHubFiles, classifyRisk } from "../tools/analyze-impact";
import { analyzeWithAI } from "../ai/analyzer";
import { FileCache, FileChange } from "../watcher/file-cache";
import { IncrementalUpdateResult } from "../graph/incremental";
import { analyzeChangeRealtime, RealtimeAnalysis } from "../ai/realtime-analyzer";
import { getConfig } from "../config";

// ── Real-time AI analysis toggle ──
let realtimeAIEnabled = true;

function resolveFilePath(fileArg: string, projectRoot: string, sourceDir?: string): string {
  const srcDir = sourceDir || path.join(projectRoot, "lib");
  const srcDirName = path.basename(srcDir); // "lib" or "src"
  if (path.isAbsolute(fileArg)) return path.normalize(fileArg);
  if (fileArg.startsWith(srcDirName + "/") || fileArg.startsWith(srcDirName + "\\")) {
    return path.normalize(path.join(projectRoot, fileArg));
  }
  return path.normalize(path.join(srcDir, fileArg));
}

// ── Layer / Action / Env classification from file path ──
type Layer = "FE" | "BE" | "DB" | "API" | "CONFIG" | "UTIL";
type Action = "C" | "R" | "U" | "D" | "X";
type Env = "PROD" | "DEV";

function classifyFile(relPath: string): { layer: Layer; action: Action; env: Env } {
  const lower = relPath.toLowerCase();
  const fileName = lower.split("/").pop() || "";

  // ── Layer — try plugin-specific classification first ──
  let layer: Layer = "UTIL";
  const plugin = getPluginForFile(relPath);
  const pluginLayer = plugin?.classifyLayer?.(relPath);
  if (pluginLayer) {
    layer = pluginLayer as Layer;
  } else {

  // FE: presentation layer, UI components
  if (
    lower.includes("/presentation/") ||
    lower.includes("/widgets/") ||
    lower.includes("/screens/") ||
    lower.includes("/pages/") ||
    lower.includes("web/public/") ||
    lower.includes("components/") ||
    fileName.endsWith("_screen.dart") ||
    fileName.endsWith("_page.dart") ||
    fileName.endsWith("_widget.dart") ||
    fileName.endsWith("_dialog.dart") ||
    fileName.endsWith("_view.dart") ||
    fileName.endsWith("_card.dart") ||
    fileName.endsWith("_tile.dart") ||
    fileName.endsWith("_form.dart") ||
    fileName.endsWith("_bottom_sheet.dart") ||
    fileName.endsWith(".html") ||
    fileName.endsWith(".css") ||
    fileName.endsWith(".jsx") ||
    fileName.endsWith(".tsx")
  ) {
    layer = "FE";
  }
  // API: network/remote layer
  else if (
    lower.includes("/api/") ||
    fileName.includes("cloud_function") ||
    fileName.endsWith("_api.dart") ||
    fileName.endsWith("_client.dart") ||
    fileName.endsWith("_remote.dart") ||
    fileName.includes("_datasource") ||
    fileName.includes("_data_source") ||
    lower.includes("web/server") ||
    fileName.endsWith("server.ts") ||
    fileName.endsWith("server.js")
  ) {
    layer = "API";
  }
  // DB: data models, entities
  else if (
    lower.includes("/models/") ||
    lower.includes("/entities/") ||
    fileName.endsWith("_model.dart") ||
    fileName.endsWith("_entity.dart") ||
    fileName.endsWith("_dto.dart") ||
    fileName.endsWith("_schema.dart") ||
    fileName.endsWith(".model.ts") ||
    fileName.endsWith(".entity.ts") ||
    fileName.endsWith(".schema.ts")
  ) {
    layer = "DB";
  }
  // BE: business logic, repositories, services, state management
  else if (
    lower.includes("/data/") ||
    lower.includes("/domain/") ||
    lower.includes("/application/") ||
    lower.includes("/providers/") ||
    lower.includes("/notifiers/") ||
    lower.includes("tools/") ||
    lower.includes("ai/") ||
    lower.includes("watcher/") ||
    fileName.endsWith("_repository.dart") ||
    fileName.endsWith("_service.dart") ||
    fileName.endsWith("_provider.dart") ||
    fileName.endsWith("_notifier.dart") ||
    fileName.endsWith("_controller.dart") ||
    fileName.endsWith("_usecase.dart") ||
    fileName.endsWith("_state.dart") ||
    fileName.endsWith("_bloc.dart") ||
    fileName.endsWith("_cubit.dart") ||
    fileName.endsWith(".service.ts") ||
    fileName.endsWith(".controller.ts")
  ) {
    layer = "BE";
  }
  // CONFIG: app config, themes, routing, constants
  else if (
    lower.includes("/config/") ||
    lower.includes("/theme/") ||
    lower.includes("/router/") ||
    lower.includes("/routing/") ||
    lower.startsWith("app/") ||
    fileName.endsWith("_config.dart") ||
    fileName.endsWith("_theme.dart") ||
    fileName.endsWith("_constants.dart") ||
    fileName.endsWith("_routes.dart") ||
    fileName === "main.dart" ||
    fileName === "index.ts" ||
    fileName === "index.js" ||
    fileName.endsWith(".config.ts") ||
    fileName.endsWith(".config.js")
  ) {
    layer = "CONFIG";
  }
  // UTIL: utilities, helpers, extensions, shared
  else if (
    lower.includes("/utils/") ||
    lower.includes("/helpers/") ||
    lower.includes("/extensions/") ||
    lower.includes("shared/") ||
    lower.includes("languages/") ||
    fileName.endsWith("_util.dart") ||
    fileName.endsWith("_helper.dart") ||
    fileName.endsWith("_extension.dart") ||
    fileName.endsWith("_mixin.dart") ||
    fileName.endsWith(".util.ts") ||
    fileName.endsWith(".helper.ts")
  ) {
    layer = "UTIL";
  }
  } // end plugin fallback

  // ── Action (infer from filename patterns) ──
  let action: Action = "X";
  if (fileName.includes("create") || fileName.includes("add") || fileName.includes("register") || fileName.includes("new")) {
    action = "C";
  } else if (fileName.includes("list") || fileName.includes("get") || fileName.includes("fetch") || fileName.includes("show") || fileName.includes("detail") || fileName.includes("_screen") || fileName.includes("_page")) {
    action = "R";
  } else if (fileName.includes("update") || fileName.includes("edit") || fileName.includes("modify") || fileName.includes("change")) {
    action = "U";
  } else if (fileName.includes("delete") || fileName.includes("remove")) {
    action = "D";
  }

  // ── Environment ──
  const env: Env = (fileName.includes("_test") || fileName.includes("_mock") || fileName.includes("_fake") || lower.includes("/test/")) ? "DEV" : "PROD";

  return { layer, action, env };
}

// ── Warning Store: accumulates unresolved warnings for AI to check ──
export interface SykeWarning {
  file: string;
  riskLevel: string;
  summary: string;
  brokenImports: string[];
  sideEffects: string[];
  warnings: string[];
  suggestion: string;
  affectedCount: number;
  timestamp: number;
  acknowledged: boolean;
}

const warningStore: SykeWarning[] = [];
const MAX_WARNINGS = 50;

export function addWarning(analysis: RealtimeAnalysis): void {
  // Only store non-SAFE warnings
  if (analysis.riskLevel === "SAFE") return;

  warningStore.unshift({
    file: analysis.file,
    riskLevel: analysis.riskLevel,
    summary: analysis.summary,
    brokenImports: analysis.brokenImports,
    sideEffects: analysis.sideEffects,
    warnings: analysis.warnings,
    suggestion: analysis.suggestion,
    affectedCount: analysis.affectedNodes.length,
    timestamp: analysis.timestamp,
    acknowledged: false,
  });

  // Cap the store
  while (warningStore.length > MAX_WARNINGS) warningStore.pop();
}

export function getUnacknowledgedWarnings(): SykeWarning[] {
  return warningStore.filter(w => !w.acknowledged);
}

export function acknowledgeWarnings(): number {
  let count = 0;
  for (const w of warningStore) {
    if (!w.acknowledged) { w.acknowledged = true; count++; }
  }
  return count;
}

export function getAllWarnings(): SykeWarning[] {
  return [...warningStore];
}

export interface SwitchProjectResult {
  projectRoot: string;
  packageName: string;
  languages: string[];
  fileCount: number;
  edgeCount: number;
}

export interface WebServerHandle {
  app: ReturnType<typeof express>;
  /** Re-wire SSE events when FileCache is replaced (e.g. after switchProject) */
  setFileCache(cache: FileCache): void;
}

export function createWebServer(
  getGraphFn: () => DependencyGraph,
  initialFileCache?: FileCache,
  switchProjectFn?: (newRoot: string) => SwitchProjectResult,
  getProjectRoot?: () => string,
  getPackageName?: () => string,
  getLicenseStatus?: () => { plan: string; expiresAt?: string; error?: string; source?: string },
  hasAIKeyFn?: () => boolean,
  setLicenseKeyFn?: (key: string | null) => Promise<{ success: boolean; plan?: string; expiresAt?: string; error?: string }>,
  setAIKeyFn?: (provider: string, key: string | null) => { success: boolean; activeProvider: string; configured: { gemini: boolean; openai: boolean; anthropic: boolean } },
  getAIInfoFn?: () => { activeProvider: string; configured: { gemini: boolean; openai: boolean; anthropic: boolean }; forced: string | null },
  setAIProviderFn?: (provider: string) => { success: boolean; activeProvider: string; forced: string | null }
): WebServerHandle {
  const app = express();
  app.use(express.json());

  /** Check if current license is Pro (includes pro_trial) */
  function isProPlan(): boolean {
    const license = getLicenseStatus?.();
    return license?.plan === "pro" || license?.plan === "pro_trial";
  }

  // Serve static files from public/
  const publicDir = path.join(__dirname, "public");
  app.use(express.static(publicDir));

  // ── SSE: Server-Sent Events for real-time updates ──
  const sseClients = new Set<Response>();
  let currentFileCache: FileCache | null = initialFileCache || null;

  function broadcastSSE(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (_) {
        sseClients.delete(client);
      }
    }
  }

  /**
   * Build a specific error message for Pro-only features based on license state.
   */
  function getProFeatureError(featureName: string): { error: string; requiresPro: boolean; upgrade: string } {
    const license = getLicenseStatus?.();
    const upgrade = "https://syke.cloud/dashboard/";

    if (license?.error) {
      return { error: `${featureName}: ${license.error}`, requiresPro: true, upgrade };
    }
    if (license?.source === "online" && license?.expiresAt) {
      // Had a license but it's no longer valid (expired trial or subscription)
      return { error: `Trial expired. Upgrade at ${upgrade}`, requiresPro: true, upgrade };
    }
    return { error: `${featureName} requires SYKE Pro. Set SYKE_LICENSE_KEY or sign up at https://syke.cloud`, requiresPro: true, upgrade };
  }

  app.get("/api/events", (_req, res: any) => {
    // Pro-only: real-time monitoring via SSE
    if (!isProPlan()) {
      res.status(403).json(getProFeatureError("Real-time monitoring"));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ clients: sseClients.size + 1, cacheSize: currentFileCache?.size || 0 })}\n\n`);

    sseClients.add(res);
    console.error(`[syke:sse] Client connected (${sseClients.size} total)`);

    _req.on("close", () => {
      sseClients.delete(res);
      console.error(`[syke:sse] Client disconnected (${sseClients.size} total)`);
    });
  });

  // Wire FileCache change events → SSE broadcast + AI analysis
  function wireFileCacheEvents(cache: FileCache): void {
    // Give the FileCache a reference to the current graph for incremental updates
    const graph = getGraphFn();
    cache.setGraph(graph);

    // Listen for incremental graph updates (emitted after file changes update edges)
    cache.on("graph-updated", (result: IncrementalUpdateResult) => {
      if (result.edgesChanged) {
        console.error(
          `[syke:sse] Graph incrementally updated: ${result.updatedFile} ` +
          `(+${result.addedEdges.length}/-${result.removedEdges.length} edges, ` +
          `${result.affectedFiles.length} affected files)`
        );
        broadcastSSE("graph-incremental-update", {
          file: path.relative(getGraphFn().sourceDir, result.updatedFile).replace(/\\/g, "/"),
          addedEdges: result.addedEdges.length,
          removedEdges: result.removedEdges.length,
          affectedFiles: result.affectedFiles.length,
        });
      }
    });

    cache.on("change", async (change: FileChange) => {
      const graph = getGraphFn();
      const absPath = path.normalize(path.join(graph.sourceDir, change.relativePath));

      // Compute affected nodes for visual pulse
      const revDeps = graph.reverse.get(absPath) || [];
      const fwdDeps = graph.forward.get(absPath) || [];
      const connectedNodes = [...new Set([...revDeps, ...fwdDeps])].map(
        f => path.relative(graph.sourceDir, f).replace(/\\/g, "/")
      );

      // Send diff lines (capped at 100 for bandwidth)
      const diffLines = change.diff.slice(0, 100).map(d => ({
        line: d.line,
        type: d.type,
        old: d.old,
        new: d.new,
      }));

      // Send new file content (for code crawl display)
      const newLines = change.newContent
        ? change.newContent.split("\n").slice(0, 300)
        : [];

      // Immediately broadcast the file change event (node pulse starts)
      broadcastSSE("file-change", {
        file: change.relativePath,
        type: change.type,
        diffCount: change.diff.length,
        diff: diffLines,
        newContent: newLines,
        connectedNodes,
        timestamp: change.timestamp,
      });

      // Run Gemini real-time analysis (Pro only, when toggle is on)
      if (isProPlan() && realtimeAIEnabled) {
        broadcastSSE("analysis-start", { file: change.relativePath });

        try {
          const analysis = await analyzeChangeRealtime(
            change,
            graph,
            (relPath) => currentFileCache?.getFileByRelPath(relPath) ?? null
          );

          broadcastSSE("analysis-result", analysis);

          // Store warnings for MCP check_warnings tool
          addWarning(analysis);

          // If graph structure changed (new/deleted files), rebuild
          if (change.type === "added" || change.type === "deleted") {
            broadcastSSE("graph-rebuild", { reason: change.type, file: change.relativePath });
          }
        } catch (err: any) {
          broadcastSSE("analysis-error", {
            file: change.relativePath,
            error: err.message,
          });
        }
      } else if (isProPlan() && !realtimeAIEnabled) {
        // Pro but AI toggle is off — log and skip AI, still handle structural changes
        console.error(`[syke:ai] Real-time AI disabled — skipping analysis for ${change.relativePath}`);
        if (change.type === "added" || change.type === "deleted") {
          broadcastSSE("graph-rebuild", { reason: change.type, file: change.relativePath });
        }
      } else {
        // Free: still rebuild graph on structural changes, but skip AI
        if (change.type === "added" || change.type === "deleted") {
          broadcastSSE("graph-rebuild", { reason: change.type, file: change.relativePath });
        }
      }
    });
  }

  if (currentFileCache) wireFileCacheEvents(currentFileCache);

  /** Replace the FileCache (called after switchProject) */
  function setFileCache(cache: FileCache): void {
    currentFileCache = cache;
    wireFileCacheEvents(cache);
    console.error(`[syke:sse] FileCache re-wired (${cache.size} files)`);
  }

  // GET /api/cache-status — Memory cache stats
  app.get("/api/cache-status", (_req, res) => {
    if (!currentFileCache) {
      return res.json({ enabled: false });
    }
    res.json({
      enabled: true,
      fileCount: currentFileCache.size,
      totalLines: currentFileCache.totalLines,
      sseClients: sseClients.size,
    });
  });

  // POST /api/toggle-realtime-ai — Enable or disable real-time AI analysis
  app.post("/api/toggle-realtime-ai", (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled === "boolean") {
      realtimeAIEnabled = enabled;
    } else {
      realtimeAIEnabled = !realtimeAIEnabled;
    }
    console.error(`[syke:ai] Real-time AI analysis ${realtimeAIEnabled ? "ENABLED" : "DISABLED"}`);
    res.json({ realtimeAIEnabled });
  });

  // GET /api/graph — Cytoscape.js compatible JSON
  app.get("/api/graph", (_req, res) => {
    const graph = getGraphFn();
    const isPro = isProPlan();
    const FREE_GRAPH_LIMIT = 200;
    const nodes: any[] = [];
    const edges: any[] = [];

    // ── Compute depth for each file (BFS from roots) ──
    const depthMap = new Map<string, number>();
    const roots = [...graph.files].filter(f => {
      const rev = graph.reverse.get(f);
      return !rev || rev.length === 0;
    });
    const queue: [string, number][] = roots.map(r => [r, 0] as [string, number]);
    while (queue.length > 0) {
      const [file, d] = queue.shift()!;
      if (depthMap.has(file)) continue;
      depthMap.set(file, d);
      const fwdDeps = graph.forward.get(file) || [];
      for (const dep of fwdDeps) {
        if (!depthMap.has(dep)) queue.push([dep, d + 1]);
      }
    }

    // Free tier: limit to first 200 files sorted alphabetically
    const allFiles = [...graph.files].sort();
    const visibleFiles = isPro ? allFiles : allFiles.slice(0, FREE_GRAPH_LIMIT);
    const visibleSet = new Set(visibleFiles);

    for (const file of visibleFiles) {
      const rel = path.relative(graph.sourceDir, file).replace(/\\/g, "/");
      const revDeps = graph.reverse.get(file) || [];
      const dependentCount = revDeps.length;
      const riskLevel = classifyRisk(dependentCount);
      const parts = rel.split("/");
      const group = parts.length > 1 ? parts[0] + "/" + parts[1] : parts[0];
      const { layer, action, env } = classifyFile(rel);

      // Count lines
      let lineCount = 0;
      try {
        const content = fs.readFileSync(file, "utf-8");
        lineCount = content.split("\n").length;
      } catch (_) {}

      // Imports count (direct forward dependencies)
      const importsCount = (graph.forward.get(file) || []).length;

      // Depth in dependency tree
      const depth = depthMap.get(file) ?? 0;

      nodes.push({
        data: {
          id: rel,
          label: parts[parts.length - 1],
          fullPath: rel,
          riskLevel,
          dependentCount,
          lineCount,
          importsCount,
          depth,
          group,
          layer,
          action,
          env,
        },
      });
    }

    for (const [file, deps] of graph.forward) {
      // Only include edges where both source and target are in the visible set
      if (!visibleSet.has(file)) continue;
      const from = path.relative(graph.sourceDir, file).replace(/\\/g, "/");
      for (const d of deps) {
        if (!visibleSet.has(d)) continue;
        const to = path.relative(graph.sourceDir, d).replace(/\\/g, "/");
        edges.push({ data: { source: from, target: to } });
      }
    }

    res.json({ nodes, edges, totalFiles: graph.files.size, limited: !isPro && graph.files.size > FREE_GRAPH_LIMIT });
  });

  // GET /api/impact/:file — Impact analysis for a specific file
  app.get("/api/impact/*splat", async (req: any, res: any) => {
    const splat = (req.params as any).splat;
    const fileParam = Array.isArray(splat) ? splat.join("/") : splat;
    if (!fileParam) {
      return res.status(400).json({ error: "File path required" });
    }

    const graph = getGraphFn();
    const resolved = resolveFilePath(fileParam, graph.projectRoot, graph.sourceDir);

    if (!graph.files.has(resolved)) {
      return res.status(404).json({ error: `File not found in graph: ${fileParam}` });
    }

    const result = await analyzeImpact(resolved, graph);
    res.json(result);
  });

  // POST /api/ai-analyze — AI semantic analysis (Pro or BYOK)
  app.post("/api/ai-analyze", async (req, res) => {
    const isPro = isProPlan();
    const hasKey = hasAIKeyFn?.() || false;

    if (!isPro && !hasKey) {
      return res.status(403).json({
        ...getProFeatureError("AI analysis"),
        hint: "Or set GEMINI_KEY / OPENAI_KEY / ANTHROPIC_KEY to use ai_analyze with your own API key.",
      });
    }

    const { file } = req.body;
    if (!file) {
      return res.status(400).json({ error: "file is required in body" });
    }

    const graph = getGraphFn();
    const resolved = resolveFilePath(file, graph.projectRoot, graph.sourceDir);

    if (!graph.files.has(resolved)) {
      return res.status(404).json({ error: `File not found in graph: ${file}` });
    }

    // Free tier: check file limit
    if (!isPro) {
      const allFiles = [...graph.files].sort();
      const idx = allFiles.indexOf(resolved);
      if (idx < 0 || idx >= 200) {
        return res.status(403).json({ error: "This file exceeds the Free tier limit (200 files). Upgrade to Pro for unlimited analysis.", upgrade: "https://syke.cloud/dashboard/" });
      }
    }

    const impactResult = await analyzeImpact(resolved, graph);

    try {
      const aiResult = await analyzeWithAI(resolved, impactResult, graph);
      const partial = !isPro && graph.files.size > 200;
      res.json({ file: impactResult.relativePath, analysis: aiResult, partial });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "AI analysis failed" });
    }
  });

  // GET /api/hub-files — Top hub files ranking (Pro only)
  app.get("/api/hub-files", (req, res) => {
    if (!isProPlan()) {
      return res.status(403).json(getProFeatureError("Hub files ranking"));
    }

    const requested = parseInt(req.query.top as string) || 10;
    const graph = getGraphFn();
    const hubs = getHubFiles(graph, requested);
    res.json({ hubs, totalFiles: graph.files.size, limited: false, plan: "pro" });
  });

  // POST /api/connected-code — Batch load code from file + connected nodes
  app.post("/api/connected-code", (req, res) => {
    const { file, maxFiles = 6, maxLinesPerFile = 80 } = req.body;
    if (!file) return res.status(400).json({ error: "file required" });

    const graph = getGraphFn();
    const resolved = resolveFilePath(file, graph.projectRoot, graph.sourceDir);
    const toRel = (f: string) => path.relative(graph.sourceDir, f).replace(/\\/g, "/");

    if (!graph.files.has(resolved)) {
      return res.status(404).json({ error: `File not found: ${file}` });
    }

    // Gather: selected file + direct dependents + direct imports
    const filesToLoad: string[] = [resolved];
    const revDeps = graph.reverse.get(resolved) || [];
    const fwdDeps = graph.forward.get(resolved) || [];
    for (const d of [...revDeps, ...fwdDeps]) {
      if (!filesToLoad.includes(d)) filesToLoad.push(d);
      if (filesToLoad.length >= maxFiles) break;
    }

    const results: Array<{ path: string; layer: string; lines: string[]; lineCount: number }> = [];
    for (const f of filesToLoad) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        const allLines = content.split("\n");
        const rel = toRel(f);
        const { layer } = classifyFile(rel);
        results.push({
          path: rel,
          layer,
          lines: allLines.slice(0, maxLinesPerFile),
          lineCount: allLines.length,
        });
      } catch (_) {}
    }

    res.json({ files: results });
  });

  // GET /api/file-content/:file — Source code preview
  app.get("/api/file-content/*splat", (req: any, res: any) => {
    const splat = (req.params as any).splat;
    const fileParam = Array.isArray(splat) ? splat.join("/") : splat;
    if (!fileParam) return res.status(400).json({ error: "File path required" });

    const graph = getGraphFn();
    const resolved = resolveFilePath(fileParam, graph.projectRoot, graph.sourceDir);

    if (!graph.files.has(resolved)) {
      return res.status(404).json({ error: `File not found: ${fileParam}` });
    }

    try {
      const content = fs.readFileSync(resolved, "utf-8");
      const lines = content.split("\n");
      res.json({
        path: fileParam,
        lineCount: lines.length,
        content: lines.length > 500 ? lines.slice(0, 500).join("\n") + "\n// ... truncated ..." : content,
        truncated: lines.length > 500,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cycles — Detect circular dependencies (Pro only)
  app.get("/api/cycles", (_req, res) => {
    if (!isProPlan()) {
      return res.status(403).json(getProFeatureError("Cycle detection"));
    }

    const graph = getGraphFn();
    const toRel = (f: string) => path.relative(graph.sourceDir, f).replace(/\\/g, "/");

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();
    const parent = new Map<string, string>();

    function dfs(file: string, pathSoFar: string[]): void {
      if (cycles.length >= 50) return; // cap
      visited.add(file);
      stack.add(file);

      const deps = graph.forward.get(file) || [];
      for (const dep of deps) {
        if (stack.has(dep)) {
          // Found cycle — extract it
          const cycleStart = pathSoFar.indexOf(dep);
          if (cycleStart >= 0) {
            const cycle = pathSoFar.slice(cycleStart).map(toRel);
            cycle.push(toRel(dep)); // close the loop
            cycles.push(cycle);
          }
        } else if (!visited.has(dep)) {
          dfs(dep, [...pathSoFar, dep]);
        }
      }

      stack.delete(file);
    }

    for (const file of graph.files) {
      if (!visited.has(file)) {
        dfs(file, [file]);
      }
    }

    res.json({ cycles, count: cycles.length });
  });

  // GET /api/shortest-path?from=X&to=Y — BFS shortest path (follows forward edges)
  app.get("/api/shortest-path", (req, res) => {
    const fromParam = req.query.from as string;
    const toParam = req.query.to as string;
    if (!fromParam || !toParam) return res.status(400).json({ error: "from and to required" });

    const graph = getGraphFn();
    const toRel = (f: string) => path.relative(graph.sourceDir, f).replace(/\\/g, "/");
    const fromAbs = resolveFilePath(fromParam, graph.projectRoot, graph.sourceDir);
    const toAbs = resolveFilePath(toParam, graph.projectRoot, graph.sourceDir);

    if (!graph.files.has(fromAbs) || !graph.files.has(toAbs)) {
      return res.status(404).json({ error: "File not found in graph" });
    }

    // BFS on combined forward + reverse (undirected shortest path)
    const prev = new Map<string, string>();
    const visited = new Set<string>();
    const queue: string[] = [fromAbs];
    visited.add(fromAbs);
    let found = false;

    while (queue.length > 0 && !found) {
      const cur = queue.shift()!;
      const neighbors = new Set<string>();
      (graph.forward.get(cur) || []).forEach(n => neighbors.add(n));
      (graph.reverse.get(cur) || []).forEach(n => neighbors.add(n));

      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          prev.set(nb, cur);
          if (nb === toAbs) { found = true; break; }
          queue.push(nb);
        }
      }
    }

    if (!found) return res.json({ path: [], distance: -1 });

    // Reconstruct path
    const pathResult: string[] = [];
    let cur = toAbs;
    while (cur) {
      pathResult.unshift(toRel(cur));
      cur = prev.get(cur)!;
    }

    res.json({ path: pathResult, distance: pathResult.length - 1 });
  });

  // GET /api/simulate-delete/:file — Simulate file removal (Pro only)
  app.get("/api/simulate-delete/*splat", (req: any, res: any) => {
    if (!isProPlan()) {
      return res.status(403).json(getProFeatureError("Delete simulation"));
    }

    const splat = (req.params as any).splat;
    const fileParam = Array.isArray(splat) ? splat.join("/") : splat;
    if (!fileParam) return res.status(400).json({ error: "File path required" });

    const graph = getGraphFn();
    const resolved = resolveFilePath(fileParam, graph.projectRoot, graph.sourceDir);
    const toRel = (f: string) => path.relative(graph.sourceDir, f).replace(/\\/g, "/");

    if (!graph.files.has(resolved)) {
      return res.status(404).json({ error: `File not found: ${fileParam}` });
    }

    // Files that directly import the deleted file → will have broken imports
    const brokenImports = (graph.reverse.get(resolved) || []).map(toRel);

    // Full cascade: all transitively affected files
    const cascadeSet = new Set<string>();
    const queue = [...(graph.reverse.get(resolved) || [])];
    for (const q of queue) cascadeSet.add(q);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const dep of (graph.reverse.get(cur) || [])) {
        if (!cascadeSet.has(dep) && dep !== resolved) {
          cascadeSet.add(dep);
          queue.push(dep);
        }
      }
    }

    // Orphaned files: files that only had forward deps to the deleted file
    const orphaned: string[] = [];
    for (const dep of (graph.forward.get(resolved) || [])) {
      const revDeps = graph.reverse.get(dep) || [];
      // If the deleted file is the only one importing this dep
      if (revDeps.length === 1 && revDeps[0] === resolved) {
        orphaned.push(toRel(dep));
      }
    }

    res.json({
      deletedFile: fileParam,
      brokenImports,
      brokenCount: brokenImports.length,
      cascadeFiles: [...cascadeSet].map(toRel),
      cascadeCount: cascadeSet.size,
      orphanedFiles: orphaned,
      orphanedCount: orphaned.length,
      severity: cascadeSet.size >= 20 ? "CRITICAL" : cascadeSet.size >= 10 ? "HIGH" : cascadeSet.size >= 5 ? "MEDIUM" : "LOW",
    });
  });

  // GET /api/warnings — List unresolved warnings (for MCP/dashboard)
  app.get("/api/warnings", (_req, res) => {
    const unacked = getUnacknowledgedWarnings();
    const all = getAllWarnings();
    res.json({
      unresolved: unacked,
      unresolvedCount: unacked.length,
      totalCount: all.length,
    });
  });

  // POST /api/warnings/acknowledge — Mark all warnings as acknowledged
  app.post("/api/warnings/acknowledge", (_req, res) => {
    const count = acknowledgeWarnings();
    res.json({ acknowledged: count });
  });

  // GET /api/project-info — Current project metadata
  app.get("/api/project-info", (_req, res) => {
    const graph = getGraphFn();
    let edgeCount = 0;
    for (const deps of graph.forward.values()) edgeCount += deps.length;
    const license = getLicenseStatus?.();
    // Read SYKE version from package.json
    let sykeVersion = "unknown";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
      sykeVersion = pkg.version || "unknown";
    } catch {}
    // Read current license key (masked for display)
    const rawKey = getConfig("licenseKey", "SYKE_LICENSE_KEY") || "";
    const maskedKey = rawKey.length > 10
      ? rawKey.substring(0, 9) + "····" + rawKey.substring(rawKey.length - 4)
      : "";
    const aiInfo = getAIInfoFn ? getAIInfoFn() : { activeProvider: "disabled", configured: { gemini: false, openai: false, anthropic: false }, forced: null };
    res.json({
      projectRoot: getProjectRoot ? getProjectRoot() : graph.projectRoot,
      packageName: getPackageName ? getPackageName() : "",
      languages: graph.languages,
      fileCount: graph.files.size,
      edgeCount,
      plan: license?.plan || "free",
      planSource: license?.source || "default",
      expiresAt: license?.expiresAt || null,
      licenseKey: maskedKey,
      freeFileLimit: 200,
      sykeVersion,
      aiProvider: aiInfo.activeProvider,
      aiKeys: aiInfo.configured,
      aiProviderForced: aiInfo.forced,
    });
  });

  // POST /api/set-license-key — Set or remove license key via dashboard
  app.post("/api/set-license-key", async (req, res) => {
    if (!setLicenseKeyFn) {
      res.status(501).json({ success: false, error: "Not supported" });
      return;
    }
    const { key } = req.body as { key?: string };
    try {
      const result = await setLicenseKeyFn(key || null);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || "Unknown error" });
    }
  });

  // POST /api/set-ai-key — Set or remove an AI provider API key
  app.post("/api/set-ai-key", (req, res) => {
    if (!setAIKeyFn) {
      res.status(501).json({ success: false, error: "Not supported" });
      return;
    }
    const { provider, key } = req.body as { provider?: string; key?: string };
    if (!provider || !["gemini", "openai", "anthropic"].includes(provider)) {
      res.status(400).json({ success: false, error: "provider must be gemini, openai, or anthropic" });
      return;
    }
    try {
      const result = setAIKeyFn(provider, key || null);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || "Unknown error" });
    }
  });

  // POST /api/set-ai-provider — Set or clear forced AI provider
  app.post("/api/set-ai-provider", (req, res) => {
    if (!setAIProviderFn) {
      res.status(501).json({ success: false, error: "Not supported" });
      return;
    }
    const { provider } = req.body as { provider?: string };
    if (!provider || !["gemini", "openai", "anthropic", "auto"].includes(provider)) {
      res.status(400).json({ success: false, error: "provider must be gemini, openai, anthropic, or auto" });
      return;
    }
    try {
      const result = setAIProviderFn(provider);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || "Unknown error" });
    }
  });

  // GET /api/browse-dirs — List subdirectories for folder browser
  app.get("/api/browse-dirs", (req, res) => {
    const dirPath = (req.query.path as string) || (process.platform === "win32" ? "C:\\" : "/");
    const normalized = path.normalize(dirPath);

    if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
      return res.status(400).json({ error: `Not a directory: ${normalized}` });
    }

    try {
      const entries = fs.readdirSync(normalized, { withFileTypes: true });
      const dirs = entries
        .filter(e => {
          if (!e.isDirectory()) return false;
          const name = e.name;
          // Hide system/hidden dirs
          if (name.startsWith(".") || name === "node_modules" || name === "$RECYCLE.BIN" || name === "System Volume Information") return false;
          return true;
        })
        .map(e => e.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Check if this looks like a project root (has package.json, pubspec.yaml, etc.)
      const markers = ["package.json", "pubspec.yaml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "CMakeLists.txt", "Makefile", "pyproject.toml", "setup.py"];
      const isProject = markers.some(m => fs.existsSync(path.join(normalized, m)));
      const detectedMarker = markers.find(m => fs.existsSync(path.join(normalized, m))) || null;

      res.json({
        current: normalized,
        parent: path.dirname(normalized) !== normalized ? path.dirname(normalized) : null,
        dirs,
        isProject,
        detectedMarker,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/switch-project — Switch to a different project folder (Pro only)
  app.post("/api/switch-project", (req, res) => {
    const { projectRoot } = req.body;
    if (!projectRoot || typeof projectRoot !== "string") {
      return res.status(400).json({ error: "projectRoot is required" });
    }

    const normalized = path.normalize(projectRoot);

    // Free tier: only 1 project allowed — block switch to a different project
    if (!isProPlan()) {
      const currentRoot = getProjectRoot ? path.normalize(getProjectRoot()) : null;
      if (currentRoot && normalized !== currentRoot) {
        return res.status(403).json({
          error: "Multiple projects require SYKE Pro. Free tier supports 1 project.",
          upgrade: "https://syke.cloud/dashboard/",
        });
      }
    }

    if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
      return res.status(400).json({ error: `Directory not found: ${normalized}` });
    }

    if (!switchProjectFn) {
      return res.status(500).json({ error: "Switch project not supported" });
    }

    try {
      const result = switchProjectFn(normalized);
      broadcastSSE("project-switched", result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to switch project" });
    }
  });

  return { app, setFileCache };
}
