/**
 * Project Scanner — Cortex-only tool.
 * Scans the entire project dependency graph and generates a comprehensive
 * onboarding document using AI (BYOK).
 */

import * as fs from "fs";
import * as path from "path";
import { DependencyGraph } from "../graph";
import { getAIProvider } from "./provider";
import { buildSmartContext } from "./context-extractor";

// ── Interfaces ──

interface HubFile {
  path: string;
  relativePath: string;
  dependentCount: number;
}

interface ConfigFile {
  path: string;
  name: string;
  content: string;
}

interface ProjectContext {
  projectRoot: string;
  languages: string[];
  totalFiles: number;
  directoryStructure: string;
  hubFiles: HubFile[];
  entryPoints: string[];
  circularDependencies: string[][];
  configFiles: ConfigFile[];
  keyFileSignatures: string;
}

// ── Config file names to look for ──

const CONFIG_FILE_NAMES = [
  "package.json", "tsconfig.json", "tsconfig.base.json",
  "Cargo.toml", "go.mod", "go.sum",
  "pubspec.yaml", "build.gradle", "pom.xml",
  "Gemfile", "requirements.txt", "pyproject.toml", "setup.py",
  "Makefile", "CMakeLists.txt",
  "docker-compose.yml", "Dockerfile",
  ".env.example",
];

const MAX_CONFIG_LINES = 200;

// ── Core ──

export async function scanProject(graph: DependencyGraph): Promise<string> {
  const provider = getAIProvider();
  if (!provider) {
    return "scan_project requires an AI API key.\n\nSet one of: GEMINI_KEY, OPENAI_KEY, or ANTHROPIC_KEY.";
  }

  const ctx = collectProjectContext(graph);
  const systemPrompt = buildScanSystemPrompt();
  const userPrompt = buildScanUserPrompt(ctx);

  try {
    return await provider.analyze(systemPrompt, userPrompt);
  } catch (err: any) {
    return `AI analysis error: ${err.message || err}`;
  }
}

// ── Context Collection ──

function collectProjectContext(graph: DependencyGraph): ProjectContext {
  const projectRoot = graph.projectRoot;

  // 1. Hub files — sorted by reverse dependency count
  const hubFiles = getHubFiles(graph, 10);

  // 2. Entry points — files with 0 reverse dependencies
  const entryPoints = getEntryPoints(graph);

  // 3. Circular dependencies (SCC clusters with size > 1)
  const circularDependencies = getCircularDeps(graph);

  // 4. Directory structure (depth-limited tree)
  const directoryStructure = buildDirectoryTree(graph);

  // 5. Config files
  const configFiles = readConfigFiles(projectRoot);

  // 6. Key file signatures (top 5 hub files)
  const keyFileSignatures = buildKeySignatures(hubFiles.slice(0, 5), graph);

  return {
    projectRoot,
    languages: graph.languages,
    totalFiles: graph.files.size,
    directoryStructure,
    hubFiles,
    entryPoints,
    circularDependencies,
    configFiles,
    keyFileSignatures,
  };
}

function getHubFiles(graph: DependencyGraph, topN: number): HubFile[] {
  const counts: { path: string; count: number }[] = [];

  for (const file of graph.files) {
    const revDeps = graph.reverse.get(file) || [];
    counts.push({ path: file, count: revDeps.length });
  }

  counts.sort((a, b) => b.count - a.count);

  return counts.slice(0, topN).map((c) => ({
    path: c.path,
    relativePath: path.relative(graph.sourceDir, c.path).replace(/\\/g, "/"),
    dependentCount: c.count,
  }));
}

function getEntryPoints(graph: DependencyGraph): string[] {
  const entries: string[] = [];
  for (const file of graph.files) {
    const revDeps = graph.reverse.get(file) || [];
    if (revDeps.length === 0) {
      entries.push(path.relative(graph.sourceDir, file).replace(/\\/g, "/"));
    }
  }
  return entries.slice(0, 20); // cap at 20
}

function getCircularDeps(graph: DependencyGraph): string[][] {
  if (!graph.scc) return [];
  return graph.scc.components
    .filter((c) => c.length > 1)
    .map((cluster) =>
      cluster.map((f) => path.relative(graph.sourceDir, f).replace(/\\/g, "/"))
    );
}

function buildDirectoryTree(graph: DependencyGraph): string {
  // Build a set of relative directory paths from file list
  const dirs = new Map<string, number>(); // dir -> file count

  for (const file of graph.files) {
    const rel = path.relative(graph.sourceDir, file).replace(/\\/g, "/");
    const parts = rel.split("/");
    // Count files per top-level and second-level directory
    for (let depth = 1; depth <= Math.min(parts.length - 1, 3); depth++) {
      const dirPath = parts.slice(0, depth).join("/");
      dirs.set(dirPath, (dirs.get(dirPath) || 0) + 1);
    }
  }

  // Sort and format as tree
  const sorted = [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines: string[] = [];

  for (const [dirPath, count] of sorted) {
    const depth = dirPath.split("/").length - 1;
    const indent = "  ".repeat(depth);
    const name = dirPath.split("/").pop()!;
    lines.push(`${indent}${name}/ (${count} files)`);
  }

  return lines.join("\n") || "(flat structure)";
}

function readConfigFiles(projectRoot: string): ConfigFile[] {
  const configs: ConfigFile[] = [];

  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.join(projectRoot, name);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const truncated = lines.length > MAX_CONFIG_LINES
          ? lines.slice(0, MAX_CONFIG_LINES).join("\n") + `\n... (${lines.length - MAX_CONFIG_LINES} more lines)`
          : content;
        configs.push({ path: filePath, name, content: truncated });
      }
    } catch {
      // skip unreadable files
    }
  }

  return configs;
}

function buildKeySignatures(hubFiles: HubFile[], graph: DependencyGraph): string {
  const parts: string[] = [];

  for (const hub of hubFiles) {
    try {
      const content = fs.readFileSync(hub.path, "utf-8");
      const lang = graph.languages[0] || "typescript";
      const summary = buildSmartContext(content, lang, 80);
      parts.push(`### ${hub.relativePath} (${hub.dependentCount} dependents)\n${summary}`);
    } catch {
      parts.push(`### ${hub.relativePath} (${hub.dependentCount} dependents)\n(unable to read)`);
    }
  }

  return parts.join("\n\n");
}

// ── AI Prompts ──

function buildScanSystemPrompt(): string {
  return `You are a senior software architect generating a comprehensive codebase onboarding document.
Based on the structural analysis data provided (dependency graph metrics, hub file rankings, circular dependencies, file signatures, and config files), generate a document following this exact structure:

## 1. Project Overview
Brief description of what this project does, its tech stack, and key technologies.

## 2. Architecture Overview
High-level architecture pattern (monolith, microservices, layered, etc.) and how components connect.

## 3. Repository Structure
Explain the directory layout and what each major directory contains.

## 4. Module / Component Map
Map out the key modules, their responsibilities, and how they relate to each other.

## 5. Key Concepts & Domain Model
Core domain concepts and abstractions that a new developer must understand.

## 6. Development Workflow
How to build, test, and run the project based on config files found.

## 7. Architectural Decisions
Notable patterns, frameworks, or design choices evident from the code structure.

## 8. Cross-Cutting Concerns
Shared utilities, common patterns, error handling, logging approaches found.

## 9. Danger Zones & Common Tasks
High-risk files (hub files with many dependents), circular dependencies to be aware of, and safe patterns for common modifications.

## 10. Quick Reference
Entry points, key file paths, and the most important files a new team member should read first.

Use the dependency graph data, hub file rankings, circular dependencies, entry points, and file signatures to make your analysis accurate and specific to THIS project.
Be concise but comprehensive. Output in Markdown. Do not include generic advice — only project-specific insights.`;
}

function buildScanUserPrompt(ctx: ProjectContext): string {
  const sections: string[] = [];

  sections.push(`# Project Scan Data`);
  sections.push(`- **Root:** ${ctx.projectRoot}`);
  sections.push(`- **Languages:** ${ctx.languages.join(", ")}`);
  sections.push(`- **Total files in graph:** ${ctx.totalFiles}`);

  sections.push(`\n## Directory Structure\n\`\`\`\n${ctx.directoryStructure}\n\`\`\``);

  sections.push(`\n## Hub Files (Top ${ctx.hubFiles.length} by dependent count)`);
  for (const h of ctx.hubFiles) {
    sections.push(`- **${h.relativePath}** — ${h.dependentCount} dependents`);
  }

  sections.push(`\n## Entry Points (${ctx.entryPoints.length} files with 0 reverse deps)`);
  for (const e of ctx.entryPoints) {
    sections.push(`- ${e}`);
  }

  if (ctx.circularDependencies.length > 0) {
    sections.push(`\n## Circular Dependencies (${ctx.circularDependencies.length} clusters)`);
    for (let i = 0; i < ctx.circularDependencies.length; i++) {
      sections.push(`### Cluster ${i + 1} (${ctx.circularDependencies[i].length} files)`);
      for (const f of ctx.circularDependencies[i]) {
        sections.push(`- ${f}`);
      }
    }
  } else {
    sections.push(`\n## Circular Dependencies\nNone detected.`);
  }

  if (ctx.configFiles.length > 0) {
    sections.push(`\n## Config Files`);
    for (const cfg of ctx.configFiles) {
      sections.push(`### ${cfg.name}\n\`\`\`\n${cfg.content}\n\`\`\``);
    }
  }

  if (ctx.keyFileSignatures) {
    sections.push(`\n## Key File Signatures (Top Hub Files)\n${ctx.keyFileSignatures}`);
  }

  return sections.join("\n");
}
