/**
 * Semantic context extractor — structural code analysis for AI prompts.
 * Extracts function/class/type signatures, compares changes, builds smart context.
 */

export interface CodeSignature {
  type: "function" | "class" | "interface" | "type" | "variable";
  name: string;
  signature: string; // full declaration line (no body)
  exported: boolean;
  line: number;
}

export interface SignatureChange {
  type: "added" | "removed" | "modified";
  name: string;
  oldSignature?: string;
  newSignature?: string;
}

// ── Language-specific regex patterns ────────────────────────────────

interface LangPatterns {
  patterns: { type: CodeSignature["type"]; regex: RegExp; exportCheck?: RegExp }[];
}

const LANG_PATTERNS: Record<string, LangPatterns> = {
  typescript: {
    patterns: [
      { type: "function", regex: /^(export\s+)?(async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\([^)]*\)/gm },
      { type: "class", regex: /^(export\s+)?(abstract\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/gm },
      { type: "interface", regex: /^(export\s+)?interface\s+(\w+)(\s+extends\s+[\w,\s]+)?/gm },
      { type: "type", regex: /^(export\s+)?type\s+(\w+)\s*(<[^>]*>)?\s*=/gm },
      { type: "variable", regex: /^(export\s+)?(const|let)\s+(\w+)\s*[=:]/gm },
    ],
  },
  dart: {
    patterns: [
      { type: "class", regex: /^(abstract\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+with\s+[\w,\s]+)?(\s+implements\s+[\w,\s]+)?/gm },
      { type: "function", regex: /^\s*(static\s+)?(Future<[^>]+>|void|String|int|double|bool|List<[^>]+>|Map<[^>]+>|Set<[^>]+>|\w+\??)\s+(\w+)\s*\([^)]*\)/gm },
      { type: "variable", regex: /^\s*(static\s+)?(final|const|late\s+final)\s+(\w+\??)\s+(\w+)/gm },
    ],
  },
  python: {
    patterns: [
      { type: "function", regex: /^(async\s+)?def\s+(\w+)\s*\([^)]*\)(\s*->\s*\w+)?/gm },
      { type: "class", regex: /^class\s+(\w+)(\([^)]*\))?/gm },
      { type: "variable", regex: /^(\w+)\s*:\s*\w+\s*=/gm },
    ],
  },
  go: {
    patterns: [
      { type: "function", regex: /^func\s+(\([^)]+\)\s+)?(\w+)\s*\([^)]*\)(\s*\([^)]*\)|\s*\w+)?/gm },
      { type: "interface", regex: /^type\s+(\w+)\s+interface/gm },
      { type: "type", regex: /^type\s+(\w+)\s+struct/gm },
    ],
  },
  rust: {
    patterns: [
      { type: "function", regex: /^(pub\s+)?(async\s+)?fn\s+(\w+)\s*(<[^>]*>)?\s*\([^)]*\)(\s*->\s*[\w<>&]+)?/gm },
      { type: "class", regex: /^(pub\s+)?struct\s+(\w+)/gm },
      { type: "interface", regex: /^(pub\s+)?trait\s+(\w+)/gm },
      { type: "type", regex: /^(pub\s+)?enum\s+(\w+)/gm },
    ],
  },
  java: {
    patterns: [
      { type: "class", regex: /^(public\s+)?(abstract\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/gm },
      { type: "interface", regex: /^(public\s+)?interface\s+(\w+)(\s+extends\s+[\w,\s]+)?/gm },
      { type: "function", regex: /^\s*(public|protected|private)?\s*(static\s+)?([\w<>\[\]]+)\s+(\w+)\s*\([^)]*\)/gm },
    ],
  },
  cpp: {
    patterns: [
      { type: "class", regex: /^(class|struct)\s+(\w+)/gm },
      { type: "function", regex: /^(virtual\s+)?(static\s+)?([\w:*&<>]+)\s+(\w+)\s*\([^)]*\)/gm },
    ],
  },
  ruby: {
    patterns: [
      { type: "class", regex: /^class\s+(\w+)(\s*<\s*\w+)?/gm },
      { type: "function", regex: /^\s*def\s+(self\.)?(\w+[?!]?)\s*(\([^)]*\))?/gm },
    ],
  },
};

// Map file extensions / language names to pattern keys
function getLangKey(lang: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", typescript: "typescript", javascript: "typescript", js: "typescript",
    dart: "dart", flutter: "dart",
    py: "python", python: "python",
    go: "go",
    rs: "rust", rust: "rust",
    java: "java", kotlin: "java",
    cpp: "cpp", "c++": "cpp", c: "cpp", h: "cpp", hpp: "cpp",
    rb: "ruby", ruby: "ruby",
  };
  return map[lang.toLowerCase()] || "typescript"; // fallback to TS patterns
}

// ── Signature Extraction ────────────────────────────────────────────

/**
 * Extract function/class/type signatures from source code.
 */
export function extractSignatures(content: string, lang: string): CodeSignature[] {
  const langKey = getLangKey(lang);
  const langPatterns = LANG_PATTERNS[langKey];
  if (!langPatterns) return [];

  const lines = content.split("\n");
  const signatures: CodeSignature[] = [];
  const seen = new Set<string>();

  for (const { type, regex } of langPatterns.patterns) {
    // Reset regex state
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const matchLine = content.substring(0, match.index).split("\n").length;
      const fullLine = lines[matchLine - 1]?.trim() || match[0].trim();
      const exported = /^export\s/.test(fullLine) || /^pub\s/.test(fullLine);

      // Extract name (last capturing group that looks like a name)
      let name = "";
      for (let i = match.length - 1; i >= 1; i--) {
        if (match[i] && /^\w+$/.test(match[i])) {
          name = match[i];
          break;
        }
      }
      if (!name) name = fullLine.split(/[\s(<{=]/)[1] || "unknown";

      const key = `${type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      signatures.push({
        type,
        name,
        signature: fullLine,
        exported,
        line: matchLine,
      });
    }
  }

  return signatures.sort((a, b) => a.line - b.line);
}

// ── Signature Diff ──────────────────────────────────────────────────

/**
 * Compare signatures between old and new file content.
 * Returns structural changes (added/removed/modified declarations).
 */
export function diffSignatures(
  oldContent: string,
  newContent: string,
  lang: string
): SignatureChange[] {
  const oldSigs = extractSignatures(oldContent, lang);
  const newSigs = extractSignatures(newContent, lang);

  const oldMap = new Map(oldSigs.map((s) => [`${s.type}:${s.name}`, s]));
  const newMap = new Map(newSigs.map((s) => [`${s.type}:${s.name}`, s]));

  const changes: SignatureChange[] = [];

  // Removed
  for (const [key, sig] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({ type: "removed", name: sig.name, oldSignature: sig.signature });
    }
  }

  // Added
  for (const [key, sig] of newMap) {
    if (!oldMap.has(key)) {
      changes.push({ type: "added", name: sig.name, newSignature: sig.signature });
    }
  }

  // Modified
  for (const [key, newSig] of newMap) {
    const oldSig = oldMap.get(key);
    if (oldSig && oldSig.signature !== newSig.signature) {
      changes.push({
        type: "modified",
        name: newSig.name,
        oldSignature: oldSig.signature,
        newSignature: newSig.signature,
      });
    }
  }

  return changes;
}

// ── Smart Context Builder ───────────────────────────────────────────

/**
 * Build a smart context summary of a file for AI prompts.
 * Short files (<100 lines) are passed through as-is.
 * Longer files get: imports + exported signatures + body summary.
 */
export function buildSmartContext(
  content: string,
  lang: string,
  maxLines = 100
): string {
  const lines = content.split("\n");

  // Short files: return as-is
  if (lines.length <= maxLines) return content;

  const parts: string[] = [];
  const importLines: string[] = [];
  let lastImportLine = 0;

  // Collect imports
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("import ") ||
      line.startsWith("from ") ||
      line.startsWith("require(") ||
      line.startsWith("const ") && line.includes("require(") ||
      line.startsWith("use ") ||
      line.startsWith("#include") ||
      line.startsWith("package ")
    ) {
      importLines.push(lines[i]);
      lastImportLine = i;
    }
    // Stop scanning after a non-import, non-blank line beyond the header
    if (i > 20 && line && !line.startsWith("import") && !line.startsWith("from") && !line.startsWith("//") && !line.startsWith("#") && !line.startsWith("*") && !line.startsWith("/*")) {
      break;
    }
  }

  if (importLines.length > 0) {
    parts.push("// ── Imports ──");
    parts.push(...importLines);
    parts.push("");
  }

  // Collect exported signatures
  const sigs = extractSignatures(content, lang).filter((s) => s.exported);
  if (sigs.length > 0) {
    parts.push("// ── Exported Declarations ──");
    for (const sig of sigs) {
      parts.push(`${sig.signature}  // L${sig.line}`);
    }
    parts.push("");
  }

  // All signatures (non-exported)
  const privateSigs = extractSignatures(content, lang).filter((s) => !s.exported);
  if (privateSigs.length > 0) {
    parts.push("// ── Internal Declarations ──");
    for (const sig of privateSigs) {
      parts.push(`${sig.signature}  // L${sig.line}`);
    }
    parts.push("");
  }

  const bodyLines = lines.length - lastImportLine - 1;
  parts.push(`// ... (${bodyLines} lines of implementation omitted)`);
  parts.push(`// Total: ${lines.length} lines`);

  return parts.join("\n");
}
