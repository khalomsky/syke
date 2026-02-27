#!/usr/bin/env node

// Silence dotenv stdout output (v17+ writes to stdout, corrupting MCP stdio protocol)
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as any;
import * as dotenv from "dotenv";
dotenv.config();
process.stdout.write = origStdoutWrite;

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec } from "child_process";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import { getGraph, rebuildGraph } from "./graph";
import { detectProjectRoot, detectPackageName, detectLanguages } from "./languages/plugin";
import { getImpactMemoCache } from "./tools/analyze-impact";
import { gateCheck, formatGateResult } from "./tools/gate-build";
import { invalidateCouplingCache } from "./git/change-coupling";
import { analyzeWithAI } from "./ai/analyzer";
import { getAIProvider, getProviderName, resetAIProvider } from "./ai/provider";
import { createWebServer, getUnacknowledgedWarnings, acknowledgeWarnings } from "./web/server";
import { FileCache } from "./watcher/file-cache";
import { checkLicense, LicenseStatus, stopAndDeactivate, clearLicenseCache, _verifyStatus } from "./license/validator";
import { getConfig, setConfig } from "./config";
import { remoteAnalyzeImpact, remoteGetHubFiles } from "./remote/proxy";

// Configuration — auto-detect if env vars not set
let currentProjectRoot = process.env.SYKE_currentProjectRoot || detectProjectRoot();
let currentPackageName = process.env.SYKE_currentPackageName || detectPackageName(currentProjectRoot, detectLanguages(currentProjectRoot));
const WEB_PORT = parseInt(getConfig("port", "SYKE_WEB_PORT") || "3333", 10);

function resolveFilePath(fileArg: string, projectRoot: string, sourceDir?: string): string {
  const srcDir = sourceDir || path.join(projectRoot, "src");
  const srcDirName = path.basename(srcDir); // "lib" or "src"

  if (path.isAbsolute(fileArg)) {
    return path.normalize(fileArg);
  }

  if (fileArg.startsWith(srcDirName + "/") || fileArg.startsWith(srcDirName + "\\")) {
    return path.normalize(path.join(projectRoot, fileArg));
  }

  return path.normalize(path.join(srcDir, fileArg));
}

// License state — set at startup
let licenseStatus: LicenseStatus = { plan: "free", source: "default" };

// Free tier limits
const FREE_MAX_FILES = 200;

function isPro(): boolean {
  if (!_verifyStatus(licenseStatus)) {
    licenseStatus = { plan: "free", source: "default" };
    return false;
  }
  return ["pro", "pro_trial", "cortex"].includes(licenseStatus.plan);
}

function isCortex(): boolean {
  if (!_verifyStatus(licenseStatus)) {
    licenseStatus = { plan: "free", source: "default" };
    return false;
  }
  return licenseStatus.plan === "cortex";
}

function getCortexToolError(toolName: string): string {
  if (licenseStatus.error) return `${toolName}: ${licenseStatus.error}`;
  if (isPro()) return `${toolName} requires SYKE Cortex. Upgrade at https://syke.cloud/dashboard/`;
  return `${toolName} requires SYKE Cortex. Sign up at https://syke.cloud`;
}

function getMaxFiles(): number | undefined {
  return isPro() ? undefined : FREE_MAX_FILES;
}

/**
 * Check if a resolved file path is within the free tier limit.
 * Free set = first 200 files sorted alphabetically by relative path.
 */
function isFileInFreeSet(resolvedPath: string, graph: ReturnType<typeof getGraph>): boolean {
  if (isPro()) return true;
  const allFiles = [...graph.files].sort();
  const idx = allFiles.indexOf(resolvedPath);
  return idx >= 0 && idx < FREE_MAX_FILES;
}

const PRO_UPGRADE_MSG = "This file exceeds the Free tier limit (200 files). Upgrade to Pro for unlimited analysis: https://syke.cloud/dashboard/";

function getProToolError(toolName: string): string {
  if (licenseStatus.error) {
    return `${toolName}: ${licenseStatus.error}`;
  }
  if (licenseStatus.expiresAt) {
    return `${toolName}: Trial expired. Upgrade at https://syke.cloud/dashboard/`;
  }
  return `${toolName} requires SYKE Pro. Set SYKE_LICENSE_KEY in your MCP config or sign up at https://syke.cloud`;
}

async function main() {
  // Check license before starting (graceful fallback for hosted environments like Smithery)
  try {
    licenseStatus = await checkLicense();
  } catch {
    licenseStatus = { plan: "free", source: "default" };
  }

  if (!currentProjectRoot) {
    // No project detected — still start MCP server for tool discovery (Smithery scan)
    console.error(
      "[syke] WARNING: No project root detected. Tools will return errors until a project is opened."
    );
    console.error("[syke] Set SYKE_currentProjectRoot or run from a project directory.");
  }

  // Show device binding errors
  if (licenseStatus.error) {
    console.error(`[syke] LICENSE ERROR: ${licenseStatus.error}`);
  }

  // Graceful shutdown — deactivate session so another device can use the license
  const shutdown = async () => {
    console.error("[syke] Shutting down — deactivating session...");
    await stopAndDeactivate();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const server = new Server(
    { name: "syke", version: "1.8.1" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "gate_build",
        description:
          "MANDATORY: Call this BEFORE any build, deploy, or test command. "
          + "Returns PASS, WARN, or FAIL verdict with detailed reasons. "
          + "If FAIL, do NOT proceed with build — fix issues first. "
          + "Always call this as the final check before any compilation or deployment.",
        inputSchema: {
          type: "object" as const,
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional list of modified files (absolute or relative to source directory)",
            },
          },
        },
      },
      {
        name: "analyze_impact",
        description:
          "[PRO] Analyze which files are impacted when a given file is modified. Returns direct and transitive dependents with risk level.",
        inputSchema: {
          type: "object" as const,
          properties: {
            file: {
              type: "string",
              description:
                'Source file path (absolute or relative to source directory). Example: "features/auth/data/auth_repository.dart"',
            },
          },
          required: ["file"],
        },
      },
      {
        name: "check_safe",
        description:
          "Quick safety check for modifying a file. Returns a one-line verdict: HIGH/MEDIUM/LOW/NONE risk with impacted file count.",
        inputSchema: {
          type: "object" as const,
          properties: {
            file: { type: "string", description: "Source file path to check" },
          },
          required: ["file"],
        },
      },
      {
        name: "get_dependencies",
        description:
          "List the internal files that a given file imports (forward dependencies).",
        inputSchema: {
          type: "object" as const,
          properties: {
            file: { type: "string", description: "Source file path" },
          },
          required: ["file"],
        },
      },
      {
        name: "get_hub_files",
        description:
          "[PRO] Rank files by how many other files depend on them (PageRank). High-hub files are risky to modify.",
        inputSchema: {
          type: "object" as const,
          properties: {
            top_n: {
              type: "number",
              description: "Number of top files to return (default 10)",
            },
          },
        },
      },
      {
        name: "refresh_graph",
        description:
          "[PRO] Re-scan all source files and rebuild the dependency graph. Use after adding/removing files.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "ai_analyze",
        description:
          "[CORTEX] Use AI (Gemini/OpenAI/Claude) to perform semantic analysis on a file. Reads the file's source code and its dependents to explain what might break when modified and how to safely make changes.",
        inputSchema: {
          type: "object" as const,
          properties: {
            file: {
              type: "string",
              description: "Source file path to analyze with AI",
            },
          },
          required: ["file"],
        },
      },
      {
        name: "check_warnings",
        description:
          "[PRO] Check for unresolved warnings from SYKE's real-time monitoring. Returns warnings about file changes that may have broken dependents. Use this AFTER modifying files to see if SYKE caught any issues you may have missed. Pass acknowledge=true to clear warnings after reading them.",
        inputSchema: {
          type: "object" as const,
          properties: {
            acknowledge: {
              type: "boolean",
              description: "If true, mark all warnings as acknowledged after returning them (default: false)",
            },
          },
        },
      },
      {
        name: "scan_project",
        description:
          "[CORTEX] Scan the entire project and generate a comprehensive onboarding document. "
          + "Analyzes architecture, key files, dependencies, and patterns to help new team members "
          + "understand the codebase quickly. Requires AI API key (BYOK).",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ],
  }));

  // Dashboard URL footer — shown only on the first successful tool call
  let firstToolCall = true;
  const DASHBOARD_FOOTER = `\n\n---\n📊 SYKE Dashboard: http://localhost:${WEB_PORT}`;

  function appendDashboardFooter(text: string): string {
    if (firstToolCall && currentProjectRoot) {
      firstToolCall = false;
      return text + DASHBOARD_FOOTER;
    }
    return text;
  }

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "gate_build": {
        const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());
        const files = (args as { files?: string[] }).files?.map((f) =>
          resolveFilePath(f, currentProjectRoot, graph.sourceDir)
        );
        const result = await gateCheck(graph, files);
        return {
          content: [
            { type: "text" as const, text: appendDashboardFooter(formatGateResult(result)) },
          ],
          isError: result.verdict === "FAIL",
        };
      }

      case "analyze_impact": {
        if (!isPro()) {
          return { content: [{ type: "text" as const, text: getProToolError("analyze_impact") }] };
        }

        const file = (args as { file: string }).file;
        const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());
        const resolved = resolveFilePath(file, currentProjectRoot, graph.sourceDir);

        if (!graph.files.has(resolved)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File not found in dependency graph: ${file}\nResolved to: ${resolved}\nTip: Use a path relative to the source directory`,
              },
            ],
          };
        }

        try {
          const result = await remoteAnalyzeImpact(graph, resolved, { includeRiskScore: true });
          const rel = path.relative(graph.sourceDir, resolved).replace(/\\/g, "/");
          const lines = [
            `## Impact Analysis: ${rel}`,
            `**Risk Level:** ${result.riskLevel}`,
            `**Total impacted files:** ${result.totalImpacted}`,
            "",
          ];

          // Show composite risk score
          if (result.riskScore) {
            const rs = result.riskScore;
            lines.push("### Composite Risk Score");
            lines.push(`Risk Score: ${rs.composite.toFixed(2)} (${rs.riskLevel})`);
            lines.push(`  Fan-in: ${rs.transitiveFanIn} (direct: ${rs.fanIn}, fan-out: ${rs.fanOut})`);
            lines.push(`  Stability: ${rs.instability.toFixed(2)}`);
            lines.push(`  Cascade depth: ${rs.cascadeDepth} level(s)`);
            if (rs.pageRank !== undefined && rs.pageRankPercentile !== undefined) {
              lines.push(`  PageRank: ${rs.pageRank.toFixed(6)} (${rs.pageRankPercentile}th percentile)`);
            }
            lines.push("");
          }

          // Show circular dependency warning
          if (result.circularCluster && result.circularCluster.length > 0) {
            lines.push("### Circular Dependency Cluster");
            lines.push(`This file is part of a circular dependency with ${result.circularCluster.length} other file(s):`);
            for (const f of result.circularCluster) {
              lines.push(`- ${f}`);
            }
            lines.push("**All files in this cluster are immediately affected by any change.**");
            lines.push("");
          }

          if (result.directDependents.length > 0) {
            lines.push(`### Direct Dependents (${result.directDependents.length})`);
            for (const d of result.directDependents) {
              const level = result.cascadeLevels?.[d];
              const levelStr = level !== undefined ? `cascade level ${level}` : "";
              lines.push(`- ${d}${levelStr ? ` (${levelStr})` : ""}`);
            }
          }

          if (result.transitiveDependents.length > 0) {
            lines.push("");
            lines.push(`### Transitive Dependents (${result.transitiveDependents.length})`);
            for (const d of result.transitiveDependents) {
              const level = result.cascadeLevels?.[d];
              const levelStr = level !== undefined ? `cascade level ${level}` : "";
              lines.push(`- ${d}${levelStr ? ` (${levelStr})` : ""}`);
            }
          }

          // SCC summary stats
          if (result.sccCount !== undefined) {
            lines.push("");
            lines.push("### Graph Structure");
            lines.push(`- SCCs in project: ${result.sccCount}`);
            if (result.cyclicSCCs !== undefined && result.cyclicSCCs > 0) {
              lines.push(`- Circular dependency clusters: ${result.cyclicSCCs}`);
            }
          }

          return { content: [{ type: "text" as const, text: appendDashboardFooter(lines.join("\n")) }] };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `analyze_impact failed: ${err.message || err}` }],
            isError: true,
          };
        }
      }

      case "check_safe": {
        const file = (args as { file: string }).file;
        const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());
        const resolved = resolveFilePath(file, currentProjectRoot, graph.sourceDir);

        if (!graph.files.has(resolved)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `UNKNOWN — file not found in graph: ${file}`,
              },
            ],
          };
        }

        if (!isFileInFreeSet(resolved, graph)) {
          return { content: [{ type: "text" as const, text: PRO_UPGRADE_MSG }] };
        }

        // Simplified local check: count direct dependents only (no Pro algorithms)
        const revDeps = graph.reverse.get(resolved) || [];
        const directCount = revDeps.length;

        // Simple BFS for transitive count
        const visited = new Set<string>();
        const queue = [...revDeps];
        for (const d of revDeps) visited.add(d);
        while (queue.length > 0) {
          const current = queue.shift()!;
          const deps = graph.reverse.get(current) || [];
          for (const dep of deps) {
            if (!visited.has(dep) && dep !== resolved) {
              visited.add(dep);
              queue.push(dep);
            }
          }
        }
        const totalImpacted = visited.size;

        const riskLevel = totalImpacted >= 10 ? "HIGH" : totalImpacted >= 5 ? "MEDIUM" : totalImpacted >= 1 ? "LOW" : "NONE";
        const rel = path.relative(graph.sourceDir, resolved).replace(/\\/g, "/");

        let output = `${riskLevel} — ${rel} impacts ${totalImpacted} file(s) (${directCount} direct)`;

        if (isPro()) {
          output += `\n\nFor detailed analysis with risk scoring, circular dependency detection, and cascade levels, use \`analyze_impact\`.`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: appendDashboardFooter(output),
            },
          ],
        };
      }

      case "get_dependencies": {
        const file = (args as { file: string }).file;
        const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());
        const resolved = resolveFilePath(file, currentProjectRoot, graph.sourceDir);

        if (!graph.files.has(resolved)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File not found in graph: ${file}`,
              },
            ],
          };
        }

        if (!isFileInFreeSet(resolved, graph)) {
          return { content: [{ type: "text" as const, text: PRO_UPGRADE_MSG }] };
        }

        const deps = graph.forward.get(resolved) || [];
        const rel = path.relative(graph.sourceDir, resolved).replace(/\\/g, "/");

        if (deps.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${rel} has no internal dependencies.`,
              },
            ],
          };
        }

        const lines = [`## Dependencies of ${rel}`, ""];
        for (const d of deps) {
          lines.push(`- ${path.relative(graph.sourceDir, d).replace(/\\/g, "/")}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      case "get_hub_files": {
        // Pro-only feature
        if (!isPro()) {
          return {
            content: [{ type: "text" as const, text: getProToolError("get_hub_files") }],
          };
        }

        const requestedN = (args as { top_n?: number }).top_n || 10;
        const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());

        try {
          const result = await remoteGetHubFiles(graph, requestedN);
          const lines = [
            `## Hub Files (Top ${result.hubs.length}, ranked by PageRank)`,
            "",
          ];

          result.hubs.forEach((h, i) => {
            lines.push(`**#${i + 1}  ${h.relativePath}**`);
            if (h.pageRank !== undefined && h.pageRankPercentile !== undefined) {
              lines.push(`    PageRank: ${h.pageRank.toFixed(6)} (${h.pageRankPercentile}th percentile)`);
            }
            lines.push(`    Dependents: ${h.dependentCount} (direct)`);
            if (h.riskScore !== undefined && h.riskScoreLevel) {
              lines.push(`    Risk Score: ${h.riskScore.toFixed(2)} (${h.riskScoreLevel})`);
            } else {
              lines.push(`    Risk: ${h.riskLevel}`);
            }
            lines.push("");
          });

          lines.push(`Total files in graph: ${result.totalFiles}`);

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `get_hub_files failed: ${err.message || err}` }],
            isError: true,
          };
        }
      }

      case "refresh_graph": {
        if (!isPro()) {
          return { content: [{ type: "text" as const, text: getProToolError("refresh_graph") }] };
        }
        const graph = rebuildGraph(currentProjectRoot, currentPackageName, getMaxFiles());
        invalidateCouplingCache();
        const cacheStats = getImpactMemoCache().stats();
        return {
          content: [
            {
              type: "text" as const,
              text: `Graph refreshed (${graph.languages.join("+")}): ${graph.files.size} files scanned. Change coupling cache invalidated. Memo cache cleared (was ${cacheStats.size} entries, ${cacheStats.hits} hits / ${cacheStats.misses} misses).`,
            },
          ],
        };
      }

      case "ai_analyze": {
        // Cortex-only tool
        if (!isCortex()) {
          return {
            content: [{ type: "text" as const, text: getCortexToolError("ai_analyze") }],
          };
        }

        const hasAIKey = !!getAIProvider();
        if (!hasAIKey) {
          return {
            content: [{ type: "text" as const, text: `ai_analyze requires an AI API key.\n\nSet one of: GEMINI_KEY, OPENAI_KEY, or ANTHROPIC_KEY in your environment.\nSee: https://syke.cloud/docs/ai-analyze` }],
          };
        }

        const file = (args as { file: string }).file;
        const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());
        const resolved = resolveFilePath(file, currentProjectRoot, graph.sourceDir);

        if (!graph.files.has(resolved)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File not found in graph: ${file}`,
              },
            ],
          };
        }

        const { analyzeImpact: localAnalyzeImpact } = await import("./tools/analyze-impact");
        const impactResult = await localAnalyzeImpact(resolved, graph);
        const aiResult = await analyzeWithAI(resolved, impactResult, graph);

        return {
          content: [{ type: "text" as const, text: appendDashboardFooter(aiResult) }],
        };
      }

      case "check_warnings": {
        // Pro-only feature (real-time monitoring)
        if (!isPro()) {
          return {
            content: [{ type: "text" as const, text: getProToolError("check_warnings") }],
          };
        }

        const shouldAck = (args as { acknowledge?: boolean }).acknowledge || false;
        const warnings = getUnacknowledgedWarnings();

        if (warnings.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No unresolved warnings. All clear.",
              },
            ],
          };
        }

        const lines = [
          `SYKE detected ${warnings.length} unresolved warning(s):`,
          "",
        ];

        for (const w of warnings) {
          const time = new Date(w.timestamp).toLocaleTimeString();
          lines.push(`### [${w.riskLevel}] ${w.file} (${time})`);
          lines.push(`**Summary:** ${w.summary}`);
          if (w.brokenImports.length > 0) {
            lines.push(`**Broken imports:** ${w.brokenImports.join(", ")}`);
          }
          if (w.sideEffects.length > 0) {
            lines.push(`**Side effects:** ${w.sideEffects.join("; ")}`);
          }
          if (w.warnings.length > 0) {
            lines.push(`**Warnings:** ${w.warnings.join("; ")}`);
          }
          if (w.suggestion) {
            lines.push(`**Suggestion:** ${w.suggestion}`);
          }
          lines.push(`**Affected files:** ${w.affectedCount}`);
          lines.push("");
        }

        if (shouldAck) {
          const count = acknowledgeWarnings();
          lines.push(`---`);
          lines.push(`${count} warning(s) acknowledged.`);
        }

        return {
          content: [{ type: "text" as const, text: appendDashboardFooter(lines.join("\n")) }],
        };
      }

      case "scan_project": {
        // Cortex-only tool
        if (!isCortex()) {
          return {
            content: [{ type: "text" as const, text: getCortexToolError("scan_project") }],
          };
        }

        const hasAIKey = !!getAIProvider();
        if (!hasAIKey) {
          return {
            content: [{ type: "text" as const, text: `scan_project requires an AI API key.\n\nSet one of: GEMINI_KEY, OPENAI_KEY, or ANTHROPIC_KEY in your environment.\nSee: https://syke.cloud/docs/ai-analyze` }],
          };
        }

        const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());
        const { scanProject } = await import("./ai/project-scanner");
        const result = await scanProject(graph);

        return {
          content: [{ type: "text" as const, text: appendDashboardFooter(result) }],
        };
      }

      default:
        return {
          content: [
            { type: "text" as const, text: `Unknown tool: ${name}` },
          ],
          isError: true,
        };
    }
  });

  // Pre-warm the graph (skip if no project root — e.g. Smithery scan)
  console.error(`[syke] Starting SYKE MCP Server v1.8.1`);
  console.error(`[syke] License: ${licenseStatus.plan.toUpperCase()} (${licenseStatus.source})`);
  if (licenseStatus.expiresAt) {
    console.error(`[syke] Expires: ${licenseStatus.expiresAt}`);
  }

  // Log AI provider status
  const aiProvider = getAIProvider();
  if (aiProvider) {
    console.error(`[syke] AI Provider: ${getProviderName()}`);
  } else {
    console.error(`[syke] AI: disabled (set GEMINI_KEY, OPENAI_KEY, or ANTHROPIC_KEY)`);
  }

  if (isPro()) {
    console.error(`[syke] Pro activated for: ${licenseStatus.email || "unknown"}`);
  } else {
    console.error(`[syke] Free tier: ${FREE_MAX_FILES} file limit, 3 tools (gate_build, check_safe, get_dependencies)`);
    console.error(`[syke] Upgrade at https://syke.cloud/dashboard/`);
  }

  let fileCache: FileCache | null = null;

  if (currentProjectRoot) {
    const detectedLangs = detectLanguages(currentProjectRoot).map(p => p.name).join(", ") || "none";
    console.error(`[syke] Project root: ${currentProjectRoot}`);
    console.error(`[syke] Detected languages: ${detectedLangs}`);
    console.error(`[syke] Package name: ${currentPackageName}`);

    const graph = getGraph(currentProjectRoot, currentPackageName, getMaxFiles());

    // Initialize file cache (load ALL source files into memory)
    fileCache = new FileCache(currentProjectRoot);
    fileCache.initialize();
    fileCache.setGraph(graph);  // Enable incremental graph updates on file changes
    fileCache.startWatching();
  }

  // Web server handle (set after server starts)
  let webServerHandle: { setFileCache: (cache: FileCache) => void } | null = null;

  // Switch project callback — reinitializes graph + file cache
  function switchProject(newRoot: string): { projectRoot: string; packageName: string; languages: string[]; fileCount: number; edgeCount: number } {
    currentProjectRoot = newRoot;
    const plugins = detectLanguages(newRoot);
    currentPackageName = detectPackageName(newRoot, plugins);

    // Stop old file cache and create new one
    if (fileCache) fileCache.stop();
    fileCache = new FileCache(newRoot);
    fileCache.initialize();

    // Rebuild graph
    const graph = rebuildGraph(newRoot, currentPackageName, getMaxFiles());

    // Enable incremental updates on the new cache
    fileCache.setGraph(graph);
    fileCache.startWatching();

    // Re-wire SSE events to the new FileCache
    if (webServerHandle) {
      webServerHandle.setFileCache(fileCache);
    }

    console.error(`[syke] Switched to project: ${newRoot}`);
    console.error(`[syke] Languages: ${plugins.map(p => p.name).join(", ")}`);
    console.error(`[syke] Package: ${currentPackageName}`);
    console.error(`[syke] Files: ${graph.files.size}`);

    let edgeCount = 0;
    for (const deps of graph.forward.values()) edgeCount += deps.length;

    return {
      projectRoot: newRoot,
      packageName: currentPackageName,
      languages: graph.languages,
      fileCount: graph.files.size,
      edgeCount,
    };
  }

  // Start Express web server with file cache for SSE (only if project detected)
  if (currentProjectRoot) {
    const { app: webApp, setFileCache: setWebFileCache } = createWebServer(
      () => getGraph(currentProjectRoot, currentPackageName, getMaxFiles()),
      fileCache!,
      switchProject,
      () => currentProjectRoot,
      () => currentPackageName,
      () => licenseStatus,
      () => !!getAIProvider(),
      async (key: string | null) => {
        // Stop existing heartbeat/session
        await stopAndDeactivate();

        if (key && (key.startsWith("SYKE-") || key.startsWith("FOUNDING-"))) {
          setConfig("licenseKey", key);
          clearLicenseCache(); // clear stale cache from previous key
          try {
            licenseStatus = await checkLicense();
          } catch {
            licenseStatus = { plan: "free", source: "default" };
          }
          if (isPro()) {
            return { success: true, plan: licenseStatus.plan, expiresAt: licenseStatus.expiresAt };
          } else {
            return { success: false, error: licenseStatus.error || "Invalid or expired key" };
          }
        } else {
          // Remove key
          setConfig("licenseKey", null);
          clearLicenseCache();
          licenseStatus = { plan: "free", source: "default" };
          return { success: true, plan: "free" };
        }
      },
      // setAIKeyFn
      (provider: string, key: string | null) => {
        const map: Record<string, string> = { gemini: "geminiKey", openai: "openaiKey", anthropic: "anthropicKey" };
        const configKey = map[provider];
        if (configKey) {
          setConfig(configKey as any, key);
          resetAIProvider();
        }
        const gemini = !!getConfig("geminiKey", "GEMINI_KEY");
        const openai = !!getConfig("openaiKey", "OPENAI_KEY");
        const anthropic = !!getConfig("anthropicKey", "ANTHROPIC_KEY");
        return {
          success: true,
          activeProvider: getProviderName(),
          configured: { gemini, openai, anthropic },
        };
      },
      // getAIInfoFn
      () => {
        const forced = getConfig("aiProvider", "SYKE_AI_PROVIDER") || null;
        return {
          activeProvider: getProviderName(),
          configured: {
            gemini: !!getConfig("geminiKey", "GEMINI_KEY"),
            openai: !!getConfig("openaiKey", "OPENAI_KEY"),
            anthropic: !!getConfig("anthropicKey", "ANTHROPIC_KEY"),
          },
          forced,
        };
      },
      // setAIProviderFn
      (provider: string) => {
        setConfig("aiProvider", provider === "auto" ? null : provider);
        resetAIProvider();
        const forced = getConfig("aiProvider", "SYKE_AI_PROVIDER") || null;
        return {
          success: true,
          activeProvider: getProviderName(),
          forced,
        };
      }
    );
    webServerHandle = { setFileCache: setWebFileCache };

    webApp.listen(WEB_PORT, () => {
      const dashUrl = `http://localhost:${WEB_PORT}`;
      console.error(`[syke] Web dashboard: ${dashUrl}`);

      // Auto-open browser (disable with SYKE_NO_BROWSER=1)
      // Delay 1s to let server fully stabilize before dashboard connects
      if (process.env.SYKE_NO_BROWSER !== "1") {
        setTimeout(() => {
          const cmd = process.platform === "win32" ? `start ${dashUrl}`
            : process.platform === "darwin" ? `open ${dashUrl}`
            : `xdg-open ${dashUrl}`;
          exec(cmd, () => {});
        }, 1000);
      }
    });
  }

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[syke] MCP server connected via stdio");
}

main().catch((err) => {
  console.error("[syke] Fatal error:", err);
  process.exit(1);
});

/**
 * Smithery sandbox server — returns a lightweight MCP server for tool/capability scanning.
 * No project root, license, or file cache needed.
 * See: https://smithery.ai/docs/deploy#sandbox-server
 */
export function createSandboxServer() {
  const sandboxServer = new Server(
    { name: "syke", version: "1.8.1" },
    { capabilities: { tools: {} } }
  );

  sandboxServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "gate_build",
        description: "MANDATORY: Call this BEFORE any build, deploy, or test command. Returns PASS, WARN, or FAIL verdict.",
        inputSchema: { type: "object" as const, properties: { files: { type: "array", items: { type: "string" }, description: "Files that were modified" } }, required: ["files"] },
      },
      {
        name: "analyze_impact",
        description: "Shows direct and transitive dependents when a file is modified.",
        inputSchema: { type: "object" as const, properties: { file: { type: "string", description: "File to analyze" } }, required: ["file"] },
      },
      {
        name: "check_safe",
        description: "Quick safety verdict: HIGH/MEDIUM/LOW/NONE risk.",
        inputSchema: { type: "object" as const, properties: { file: { type: "string", description: "File to check" } }, required: ["file"] },
      },
      {
        name: "get_dependencies",
        description: "Lists internal imports (forward dependencies) of a file.",
        inputSchema: { type: "object" as const, properties: { file: { type: "string", description: "File to check" } }, required: ["file"] },
      },
      {
        name: "get_hub_files",
        description: "Pro: Ranks files by how many other files depend on them.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "refresh_graph",
        description: "Re-scans all source files and rebuilds the dependency graph.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "ai_analyze",
        description: "Cortex: AI semantic analysis (Gemini/OpenAI/Claude) of a file and its dependents.",
        inputSchema: { type: "object" as const, properties: { file: { type: "string", description: "File to analyze" } }, required: ["file"] },
      },
      {
        name: "check_warnings",
        description: "Pro: Real-time monitoring alerts for file changes.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "scan_project",
        description: "Cortex: Scan entire project and generate onboarding document.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  sandboxServer.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text" as const, text: "Sandbox mode — no project loaded." }],
  }));

  return sandboxServer;
}
