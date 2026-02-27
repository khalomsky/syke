import { FileChange } from "../watcher/file-cache";
import { DependencyGraph } from "../graph";
import { analyzeImpact } from "../tools/analyze-impact";
import * as crypto from "crypto";
import * as path from "path";
import { getAIProvider } from "./provider";
import { buildSmartContext, diffSignatures } from "./context-extractor";

// ── Hash cache: skip duplicate AI calls for unchanged content ──
interface CachedAnalysis {
  hash: string;
  result: RealtimeAnalysis;
  insertedAt: number;
}
const analysisCache = new Map<string, CachedAnalysis>();
const MAX_CACHE_SIZE = 100;

function computeContentHash(content: string | null, diff: string): string {
  return crypto.createHash("md5").update((content || "") + "\n---\n" + diff).digest("hex");
}

function evictOldestCacheEntry(): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of analysisCache) {
    if (entry.insertedAt < oldestTime) {
      oldestTime = entry.insertedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) analysisCache.delete(oldestKey);
}

// ── Rate limiter: max 10 AI calls per minute (sliding window) ──
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const callTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  // Remove timestamps outside the window
  while (callTimestamps.length > 0 && callTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    callTimestamps.shift();
  }
  return callTimestamps.length >= RATE_LIMIT_MAX;
}

function recordCall(): void {
  callTimestamps.push(Date.now());
}

export interface RealtimeAnalysis {
  file: string;           // relative path
  changeType: FileChange["type"];
  timestamp: number;
  riskLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "SAFE";
  summary: string;        // one-line summary
  brokenImports: string[];
  sideEffects: string[];
  warnings: string[];
  suggestion: string;     // recommended action
  affectedNodes: string[]; // relative paths of impacted files
  analysisMs: number;     // how long AI took
}

function getSystemPrompt(): string {
  return `You are a senior full-stack architect and code impact monitoring AI with 20 years of experience.
Role: Detect potential errors and cascading impacts before build when files are modified/added/deleted.

Analysis principles:
1. Broken imports/exports: Check if deleted/renamed classes/functions/variables are referenced in other files
2. Type mismatches: Verify parameter types and return type changes match call sites
3. State management cascade: Impact of Provider/Notifier changes on UI and business logic
4. Routing impact: Effect of route/parameter changes on navigation
5. Missing initialization: Whether newly added Providers are properly registered

Response format (must be JSON):
{
  "riskLevel": "CRITICAL|HIGH|MEDIUM|LOW|SAFE",
  "summary": "One-line summary",
  "brokenImports": ["List of potentially broken imports"],
  "sideEffects": ["List of expected side effects"],
  "warnings": ["List of warnings"],
  "suggestion": "Recommended action"
}

CRITICAL: Build failure certain
HIGH: Runtime error possible
MEDIUM: Behavior change possible
LOW: Minor impact
SAFE: Safe change

Respond with JSON only. No explanatory text, just pure JSON.`;
}

/**
 * Analyze a file change in real-time using the configured AI provider.
 * Receives the diff + connected files context from memory cache.
 */
export async function analyzeChangeRealtime(
  change: FileChange,
  graph: DependencyGraph,
  getFileContent: (relPath: string) => string | null
): Promise<RealtimeAnalysis> {
  const start = Date.now();
  const relPath = change.relativePath;
  const codeBlockLang = graph.languages[0] || "text";

  // Get impacted files from graph
  const absPath = path.normalize(path.join(graph.sourceDir, relPath));
  let affectedNodes: string[] = [];

  if (graph.files.has(absPath)) {
    const impact = await analyzeImpact(absPath, graph);
    affectedNodes = [...impact.directDependents, ...impact.transitiveDependents];
  }

  // Build context: changed file + top 5 connected files' smart context
  const connectedFiles: string[] = [];
  const revDeps = graph.reverse.get(absPath) || [];
  const fwdDeps = graph.forward.get(absPath) || [];
  const connected = [...new Set([...revDeps, ...fwdDeps])].slice(0, 5);

  for (const dep of connected) {
    const depRel = path.relative(graph.sourceDir, dep).replace(/\\/g, "/");
    const content = getFileContent(depRel);
    if (content) {
      const smartCtx = buildSmartContext(content, codeBlockLang);
      connectedFiles.push(`### ${depRel}\n\`\`\`${codeBlockLang}\n${smartCtx}\n\`\`\``);
    }
  }

  // Build diff summary with signature changes
  let diffSummary = "";
  if (change.type === "deleted") {
    diffSummary = `File deleted. Previous content:\n\`\`\`${codeBlockLang}\n${(change.oldContent || "").split("\n").slice(0, 40).join("\n")}\n\`\`\``;
  } else if (change.type === "added") {
    const smartNew = buildSmartContext(change.newContent || "", codeBlockLang);
    diffSummary = `New file added:\n\`\`\`${codeBlockLang}\n${smartNew}\n\`\`\``;
  } else {
    // Modified — include signature diff
    const diffLines = change.diff.slice(0, 30).map(d => {
      if (d.type === "added") return `+ L${d.line}: ${d.new}`;
      if (d.type === "removed") return `- L${d.line}: ${d.old}`;
      return `~ L${d.line}: ${d.old} → ${d.new}`;
    });
    diffSummary = `Changed lines (top 30 of ${change.diff.length}):\n\`\`\`\n${diffLines.join("\n")}\n\`\`\``;

    // Add structural signature changes
    if (change.oldContent && change.newContent) {
      const sigChanges = diffSignatures(change.oldContent, change.newContent, codeBlockLang);
      if (sigChanges.length > 0) {
        diffSummary += "\n\n### Structural changes (signature diff)";
        for (const sc of sigChanges) {
          if (sc.type === "added") {
            diffSummary += `\n+ Added: ${sc.newSignature}`;
          } else if (sc.type === "removed") {
            diffSummary += `\n- Removed: ${sc.oldSignature}`;
          } else {
            diffSummary += `\n~ Changed: ${sc.oldSignature}\n  →       ${sc.newSignature}`;
          }
        }
      }
    }

    if (change.newContent) {
      const smartNew = buildSmartContext(change.newContent, codeBlockLang);
      diffSummary += `\n\nFull file after modification:\n\`\`\`${codeBlockLang}\n${smartNew}\n\`\`\``;
    }
  }

  const userPrompt = `## File change detected: ${relPath}
Change type: ${change.type.toUpperCase()}
Project languages: ${graph.languages.join(", ") || "unknown"}
Affected files: ${affectedNodes.length}

${diffSummary}

${connectedFiles.length > 0 ? `## Connected files (${connectedFiles.length})\n${connectedFiles.join("\n\n")}` : "No connected files"}

Analyze the impact of this change on the project.`;

  // ── Hash cache check: skip AI if content+diff unchanged ──
  const diffStr = change.diff.map(d => `${d.type}:${d.line}:${d.old || ""}:${d.new || ""}`).join("|");
  const contentHash = computeContentHash(change.newContent, diffStr);
  const cached = analysisCache.get(relPath);
  if (cached && cached.hash === contentHash) {
    console.error(`[syke:ai] Cache hit for ${relPath} — skipping AI call`);
    return { ...cached.result, timestamp: change.timestamp, analysisMs: 0 };
  }

  // ── Rate limit check ──
  if (isRateLimited()) {
    const analysisMs = Date.now() - start;
    console.error(`[syke:ai] Rate limit reached (${RATE_LIMIT_MAX}/min) — skipping AI for ${relPath}`);
    return {
      file: relPath,
      changeType: change.type,
      timestamp: change.timestamp,
      riskLevel: affectedNodes.length >= 10 ? "HIGH" : affectedNodes.length >= 5 ? "MEDIUM" : "LOW",
      summary: `Rate limited — graph-based analysis: ${affectedNodes.length} files impacted`,
      brokenImports: [],
      sideEffects: [],
      warnings: ["AI analysis skipped: rate limit (10 calls/min)"],
      suggestion: "Wait a moment for AI analysis to resume",
      affectedNodes,
      analysisMs,
    };
  }

  try {
    const provider = getAIProvider();
    if (!provider) {
      throw new Error("No AI provider available (set GEMINI_KEY, OPENAI_KEY, or ANTHROPIC_KEY)");
    }

    recordCall();

    const parsed = await provider.analyzeJSON<{
      riskLevel?: string;
      summary?: string;
      brokenImports?: string[];
      sideEffects?: string[];
      warnings?: string[];
      suggestion?: string;
    }>(getSystemPrompt(), userPrompt);

    const analysisMs = Date.now() - start;

    const result: RealtimeAnalysis = {
      file: relPath,
      changeType: change.type,
      timestamp: change.timestamp,
      riskLevel: (parsed.riskLevel as RealtimeAnalysis["riskLevel"]) || "LOW",
      summary: parsed.summary || "Analysis complete",
      brokenImports: parsed.brokenImports || [],
      sideEffects: parsed.sideEffects || [],
      warnings: parsed.warnings || [],
      suggestion: parsed.suggestion || "",
      affectedNodes,
      analysisMs,
    };

    // Store in cache
    if (analysisCache.size >= MAX_CACHE_SIZE) evictOldestCacheEntry();
    analysisCache.set(relPath, { hash: contentHash, result, insertedAt: Date.now() });

    return result;
  } catch (err: any) {
    const analysisMs = Date.now() - start;
    console.error(`[syke:ai] Analysis error for ${relPath}: ${err.message}`);

    return {
      file: relPath,
      changeType: change.type,
      timestamp: change.timestamp,
      riskLevel: affectedNodes.length >= 10 ? "HIGH" : affectedNodes.length >= 5 ? "MEDIUM" : "LOW",
      summary: `AI analysis failed — graph-based analysis: ${affectedNodes.length} files impacted`,
      brokenImports: [],
      sideEffects: [],
      warnings: [`AI analysis error: ${err.message}`],
      suggestion: "Manual review required",
      affectedNodes,
      analysisMs,
    };
  }
}
