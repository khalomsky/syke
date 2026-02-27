import * as fs from "fs";
import * as path from "path";
import { DependencyGraph } from "../graph";
import { ImpactResult } from "../tools/analyze-impact";
import { getAIProvider } from "./provider";
import { buildSmartContext } from "./context-extractor";

function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function buildSystemPrompt(languages: string[]): string {
  const langNames = languages.length > 0 ? languages.join("/") : "source";

  return `You are an expert in ${langNames} code impact analysis.
Analyze the source code of the given file and its dependents to identify
what could break when this file is modified.

Analysis format:
## Core Role
Describe the file's role in the project in one sentence

## Risk Points on Modification
Specific parts that could break (include function/class names)

## Dependent File Analysis
How dependent files use specific parts of this file

## Safe Modification Guide
Precautions and recommended approaches for modifying this file

Be concise but specific.`;
}

export async function analyzeWithAI(
  filePath: string,
  impactResult: ImpactResult,
  graph: DependencyGraph
): Promise<string> {
  const provider = getAIProvider();
  if (!provider) {
    return "AI analysis disabled — set GEMINI_KEY, OPENAI_KEY, or ANTHROPIC_KEY.";
  }

  const targetSource = readFileContent(filePath);
  if (!targetSource) {
    return `Cannot read file: ${filePath}`;
  }

  const codeBlockLang = graph.languages[0] || "text";

  // Build smart context for the target file
  const smartTarget = buildSmartContext(targetSource, codeBlockLang);

  // Build smart context for dependent files (top 5)
  const directDeps = (graph.reverse.get(path.normalize(filePath)) || []).slice(0, 5);
  const dependentSources: string[] = [];
  for (const dep of directDeps) {
    const source = readFileContent(dep);
    if (source) {
      const rel = path.relative(graph.sourceDir, dep).replace(/\\/g, "/");
      const smartDep = buildSmartContext(source, codeBlockLang);
      dependentSources.push(`### ${rel}\n\`\`\`${codeBlockLang}\n${smartDep}\n\`\`\``);
    }
  }

  const userPrompt = `## Target file: ${impactResult.relativePath}
- Risk level: ${impactResult.riskLevel}
- Direct dependents: ${impactResult.directDependents.length}
- Transitive dependents: ${impactResult.transitiveDependents.length}
- Total impacted files: ${impactResult.totalImpacted}

### Target file source code
\`\`\`${codeBlockLang}
${smartTarget}
\`\`\`

${dependentSources.length > 0 ? `### Files depending on this file (top ${dependentSources.length})\n${dependentSources.join("\n\n")}` : "No internal files depend on this file."}`;

  try {
    const systemPrompt = buildSystemPrompt(graph.languages);
    return await provider.analyze(systemPrompt, userPrompt);
  } catch (err: any) {
    return `AI analysis error: ${err.message || err}`;
  }
}
