import * as path from "path";
import { DependencyGraph } from "../graph";
import {
  getUnacknowledgedWarnings,
  acknowledgeWarnings,
  SykeWarning,
} from "../web/server";
import {
  mineGitHistory,
  getCoupledFiles,
} from "../git/change-coupling";

// ── Types ──

export type GateVerdict = "PASS" | "WARN" | "FAIL";

export interface GateIssue {
  file: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  description: string;
}

export interface GateResult {
  verdict: GateVerdict;
  statusLine: string;
  issues: GateIssue[];
  recommendation: string;
  stats: { filesInGraph: number; unresolvedWarnings: number; sccCount?: number; cyclicSCCs?: number };
  autoAcknowledged: number;
}

// ── Cycle Detection (SCC-based, replaces old DFS) ──

interface CycleInfo {
  cycle: string[];
  file: string;
}

/**
 * Detect circular dependencies using SCC data.
 * Much faster and more complete than DFS-based cycle detection.
 * Returns all cyclic SCCs that contain any of the specified files.
 */
function detectCyclesWithSCC(
  files: string[],
  graph: DependencyGraph
): CycleInfo[] {
  const scc = graph.scc;
  if (!scc) {
    // Fallback to old DFS if SCC data not available
    return detectCyclesForFilesDFS(files, graph, 10);
  }

  const cycles: CycleInfo[] = [];
  const reportedSCCs = new Set<number>();

  for (const file of files) {
    if (!graph.files.has(file)) continue;

    const sccIndex = scc.nodeToComponent.get(file);
    if (sccIndex === undefined) continue;

    const node = scc.condensed.nodes[sccIndex];
    if (!node.isCyclic) continue;

    // Only report each cyclic SCC once
    if (reportedSCCs.has(sccIndex)) continue;
    reportedSCCs.add(sccIndex);

    // Build a cycle representation: all files in the SCC form a cycle
    // For display, show the circular path by appending the first file at the end
    const cyclePath = [...node.files, node.files[0]];

    cycles.push({
      cycle: cyclePath,
      file,
    });
  }

  return cycles;
}

/**
 * Also scan the entire graph for cyclic SCCs (not just specified files).
 * Returns summary info about all cycles in the project.
 */
function detectAllCycles(graph: DependencyGraph): CycleInfo[] {
  const scc = graph.scc;
  if (!scc) return [];

  const cycles: CycleInfo[] = [];

  for (const node of scc.condensed.nodes) {
    if (!node.isCyclic) continue;

    const cyclePath = [...node.files, node.files[0]];
    cycles.push({
      cycle: cyclePath,
      file: node.files[0],
    });
  }

  return cycles;
}

/**
 * Legacy DFS forward traversal from specified files to detect circular dependencies.
 * Used as fallback when SCC data is not available.
 */
function detectCyclesForFilesDFS(
  files: string[],
  graph: DependencyGraph,
  maxCycles: number = 10
): CycleInfo[] {
  const cycles: CycleInfo[] = [];
  const globalVisited = new Set<string>();

  for (const startFile of files) {
    if (!graph.files.has(startFile)) continue;

    const stack = new Set<string>();
    const pathStack: string[] = [];

    function dfs(file: string): void {
      if (cycles.length >= maxCycles) return;
      if (globalVisited.has(file)) return;

      stack.add(file);
      pathStack.push(file);

      const deps = graph.forward.get(file) || [];
      for (const dep of deps) {
        if (cycles.length >= maxCycles) break;
        if (stack.has(dep)) {
          // Back-edge found: cycle
          const idx = pathStack.indexOf(dep);
          if (idx >= 0) {
            cycles.push({
              cycle: [...pathStack.slice(idx), dep],
              file: startFile,
            });
          }
        } else if (!globalVisited.has(dep)) {
          dfs(dep);
        }
      }

      stack.delete(file);
      pathStack.pop();
    }

    dfs(startFile);
    for (const f of stack) globalVisited.add(f);
  }

  return cycles.slice(0, maxCycles);
}

// ── Gate Check ──

/**
 * Run the build gate check.
 * If `specifiedFiles` is provided, only warnings for those files are considered.
 * Cycle detection uses SCC data when available (faster and more complete).
 */
export async function gateCheck(
  graph: DependencyGraph,
  specifiedFiles?: string[]
): Promise<GateResult> {
  const allWarnings = getUnacknowledgedWarnings();

  const sccCount = graph.scc?.condensed.nodes.length;
  const cyclicSCCs = graph.scc?.condensed.nodes.filter(n => n.isCyclic).length;

  const stats = {
    filesInGraph: graph.files.size,
    unresolvedWarnings: allWarnings.length,
    sccCount,
    cyclicSCCs,
  };

  // Filter warnings to specified files if provided
  const warnings: SykeWarning[] = specifiedFiles
    ? allWarnings.filter((w) =>
        specifiedFiles.some(
          (f) =>
            w.file === f ||
            f.endsWith(w.file) ||
            w.file.endsWith(f.replace(/\\/g, "/"))
        )
      )
    : allWarnings;

  const issues: GateIssue[] = [];

  // 1. Check warnings by severity
  for (const w of warnings) {
    const severity = mapRiskToSeverity(w.riskLevel);
    if (severity) {
      issues.push({
        file: w.file,
        severity,
        description:
          w.summary +
          (w.brokenImports.length > 0
            ? ` (broken imports: ${w.brokenImports.join(", ")})`
            : ""),
      });
    }
  }

  // 2. Detect cycles using SCC (or fallback to DFS)
  const filesToCheck = specifiedFiles || [];
  const cycles = detectCyclesWithSCC(filesToCheck, graph);

  for (const c of cycles) {
    const cyclePath = c.cycle
      .map((f) => path.relative(graph.sourceDir, f).replace(/\\/g, "/"))
      .join(" -> ");
    issues.push({
      file: path.relative(graph.sourceDir, c.file).replace(/\\/g, "/"),
      severity: "CRITICAL",
      description: `Circular dependency detected (${c.cycle.length - 1} files): ${cyclePath}`,
    });
  }

  // 3. Check if hub files were modified (simplified — no Pro scoring)
  if (specifiedFiles) {
    // Simple hub detection: files with most reverse dependents
    const hubEntries: Array<{ file: string; count: number }> = [];
    for (const f of graph.files) {
      const revDeps = graph.reverse.get(f) || [];
      hubEntries.push({ file: f, count: revDeps.length });
    }
    hubEntries.sort((a, b) => b.count - a.count);
    const top5 = hubEntries.slice(0, 5);
    const hubPathSet = new Set(top5.map(h =>
      path.relative(graph.sourceDir, h.file).replace(/\\/g, "/")
    ));

    for (const f of specifiedFiles) {
      if (!graph.files.has(f)) continue;
      const rel = path.relative(graph.sourceDir, f).replace(/\\/g, "/");

      // Check if this file is a hub file
      if (hubPathSet.has(rel)) {
        const hub = top5.find(h =>
          path.relative(graph.sourceDir, h.file).replace(/\\/g, "/") === rel
        );
        if (hub) {
          const riskLevel = hub.count >= 10 ? "HIGH" : hub.count >= 5 ? "MEDIUM" : "LOW";
          issues.push({
            file: rel,
            severity: riskLevel === "HIGH" ? "HIGH" : "MEDIUM",
            description: `Hub file modified (${hub.count} dependents, ${riskLevel} risk)`,
          });
        }
      }
    }

    // 4. Check historical change coupling for modified files
    try {
      const couplingResult = await mineGitHistory(graph.projectRoot);
      if (couplingResult.totalCommitsAnalyzed > 0) {
        const modifiedSet = new Set(
          specifiedFiles.map((f) =>
            path.relative(graph.projectRoot, f).replace(/\\/g, "/")
          )
        );

        for (const f of specifiedFiles) {
          if (!graph.files.has(f)) continue;

          const gitRelPath = path
            .relative(graph.projectRoot, f)
            .replace(/\\/g, "/");
          const couplings = getCoupledFiles(gitRelPath, couplingResult);

          for (const coupling of couplings) {
            const otherFile =
              coupling.file1 === gitRelPath ? coupling.file2 : coupling.file1;

            if (modifiedSet.has(otherFile)) continue;

            const otherAbsolute = path.normalize(
              path.join(graph.projectRoot, otherFile)
            );
            const forwardDeps = graph.forward.get(f) || [];
            const reverseDeps = graph.reverse.get(f) || [];
            const isInGraph =
              forwardDeps.includes(otherAbsolute) ||
              reverseDeps.includes(otherAbsolute);
            if (isInGraph) continue;

            if (coupling.confidence < 0.3) continue;

            const severity: "MEDIUM" | "LOW" =
              coupling.confidence >= 0.5 ? "MEDIUM" : "LOW";
            const pct = Math.round(coupling.confidence * 100);
            const rel = path.relative(graph.sourceDir, f).replace(/\\/g, "/");

            issues.push({
              file: rel,
              severity,
              description: `Historical coupling: ${otherFile} changes with this file in ${pct}% of commits (${coupling.coChangeCount} times) -- consider reviewing`,
            });
          }
        }
      }
    } catch {
      // Non-critical: coupling analysis failure should not block build gate
    }
  }

  // ── Determine verdict ──
  const hasCritical = issues.some((i) => i.severity === "CRITICAL");
  const highIssues = issues.filter((i) => i.severity === "HIGH");
  const hasHighWithBroken =
    highIssues.length > 0 &&
    warnings.some((w) => w.riskLevel === "HIGH" && w.brokenImports.length > 0);
  const hasCycles = cycles.length > 0;

  let verdict: GateVerdict;
  let statusLine: string;
  let recommendation: string;
  let autoAcknowledged = 0;

  if (hasCritical || hasHighWithBroken || hasCycles) {
    verdict = "FAIL";
    const reasons: string[] = [];
    if (hasCritical) reasons.push("CRITICAL warnings");
    if (hasHighWithBroken) reasons.push("HIGH warnings with broken imports");
    if (hasCycles) reasons.push(`${cycles.length} circular dependency(ies)`);
    statusLine = `BUILD BLOCKED — ${reasons.join(", ")}`;
    recommendation =
      "Fix the issues above before building. Use `check_warnings` for details, then `analyze_impact` on affected files.";
  } else if (
    highIssues.length > 0 ||
    issues.some((i) => i.severity === "MEDIUM")
  ) {
    verdict = "WARN";
    statusLine = `PROCEED WITH CAUTION — ${issues.length} issue(s) detected`;
    recommendation =
      "Review the issues. If you've verified they're safe, proceed with the build. Use `check_warnings acknowledge=true` to clear warnings.";
  } else {
    verdict = "PASS";
    statusLine = "All clear — safe to build";
    recommendation = "No issues detected. You may proceed with build/deploy.";
    // Auto-acknowledge warnings on PASS
    autoAcknowledged = acknowledgeWarnings();
  }

  return {
    verdict,
    statusLine,
    issues,
    recommendation,
    stats,
    autoAcknowledged,
  };
}

// ── Formatting ──

export function formatGateResult(result: GateResult): string {
  const icon =
    result.verdict === "PASS"
      ? "✅"
      : result.verdict === "WARN"
        ? "⚠️"
        : "🚫";

  const lines: string[] = [
    `## SYKE Build Gate — ${icon} ${result.verdict}`,
    "",
    "### Status",
    result.statusLine,
  ];

  if (result.issues.length > 0) {
    lines.push("", "### Issues");
    for (const issue of result.issues) {
      const issueIcon =
        issue.severity === "CRITICAL"
          ? "🚫"
          : issue.severity === "HIGH"
            ? "🔴"
            : issue.severity === "MEDIUM"
              ? "🟡"
              : "🔵";
      lines.push(
        `- ${issueIcon} **[${issue.severity}]** ${issue.file}: ${issue.description}`
      );
    }
  }

  lines.push("", "### Recommendation", result.recommendation);

  lines.push(
    "",
    "### Stats",
    `- Files in graph: ${result.stats.filesInGraph}`,
    `- Unresolved warnings: ${result.stats.unresolvedWarnings}`
  );

  if (result.stats.sccCount !== undefined) {
    lines.push(`- Strongly Connected Components: ${result.stats.sccCount}`);
  }
  if (result.stats.cyclicSCCs !== undefined && result.stats.cyclicSCCs > 0) {
    lines.push(`- Circular dependency clusters: ${result.stats.cyclicSCCs}`);
  }

  if (result.autoAcknowledged > 0) {
    lines.push(`- Auto-acknowledged: ${result.autoAcknowledged} warning(s)`);
  }

  return lines.join("\n");
}

// ── Helpers ──

function mapRiskToSeverity(
  riskLevel: string
): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | null {
  switch (riskLevel) {
    case "CRITICAL":
      return "CRITICAL";
    case "HIGH":
      return "HIGH";
    case "MEDIUM":
      return "MEDIUM";
    case "LOW":
      return "LOW";
    default:
      return null; // SAFE → no issue
  }
}
