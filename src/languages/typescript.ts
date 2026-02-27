import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles, hasManifestFile, findSourceDirsWithFiles } from "./plugin";

const TS_IMPORT_RE = /(?:import|export)\s+.*?from\s+['"](.+?)['"]/;
const TS_SIDE_EFFECT_RE = /^import\s+['"](.+?)['"]/;
const JS_REQUIRE_RE = /(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"](.+?)['"]\s*\)/;

// ── tsconfig.json path alias cache ──
interface PathAlias {
  prefix: string;   // e.g. "@/"
  targets: string[]; // absolute directory paths to try
}

const aliasCache = new Map<string, PathAlias[]>(); // projectRoot → aliases

function loadPathAliases(projectRoot: string): PathAlias[] {
  if (aliasCache.has(projectRoot)) return aliasCache.get(projectRoot)!;

  const aliases: PathAlias[] = [];
  try {
    const tsconfigPath = path.join(projectRoot, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) { aliasCache.set(projectRoot, aliases); return aliases; }

    // Strip single-line comments (// ...) and trailing commas for lenient parsing
    const raw = fs.readFileSync(tsconfigPath, "utf-8")
      .replace(/\/\/.*$/gm, "")
      .replace(/,\s*([\]}])/g, "$1");
    const tsconfig = JSON.parse(raw);

    const paths: Record<string, string[]> = tsconfig?.compilerOptions?.paths;
    const baseUrl: string = tsconfig?.compilerOptions?.baseUrl || ".";
    if (!paths) { aliasCache.set(projectRoot, aliases); return aliases; }

    const baseDir = path.resolve(projectRoot, baseUrl);

    for (const [pattern, targets] of Object.entries(paths)) {
      // Pattern like "@/*" → prefix "@/", target "./src/*" → baseDir + "src"
      const prefix = pattern.endsWith("/*") ? pattern.slice(0, -1) : pattern;
      const resolvedTargets: string[] = [];
      for (const target of targets) {
        const stripped = target.endsWith("/*") ? target.slice(0, -1) : target;
        resolvedTargets.push(path.resolve(baseDir, stripped));
      }
      aliases.push({ prefix, targets: resolvedTargets });
    }
  } catch (_) {
    // Ignore parse errors
  }

  aliasCache.set(projectRoot, aliases);
  return aliases;
}

function resolveTsImport(fromDir: string, importPath: string): string | null {
  const base = path.resolve(fromDir, importPath);
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.normalize(candidate);
    }
  }
  return null;
}

/** Clear cached aliases (call on project switch / graph refresh) */
export function clearAliasCache(): void {
  aliasCache.clear();
}

function resolveAliasImport(importPath: string, projectRoot: string): string | null {
  const aliases = loadPathAliases(projectRoot);
  for (const alias of aliases) {
    if (importPath.startsWith(alias.prefix)) {
      const rest = importPath.slice(alias.prefix.length);
      for (const targetDir of alias.targets) {
        const resolved = resolveTsImport(targetDir, "./" + rest);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

export const typescriptPlugin: LanguagePlugin = {
  id: "typescript",
  name: "TypeScript",
  extensions: [".ts", ".tsx", ".js", ".jsx"],
  codeBlockLang: "typescript",

  detectProject(root: string): boolean {
    return hasManifestFile(root, ["tsconfig.json", "package.json"]);
  },

  getSourceDirs(root: string): string[] {
    const dirs = findSourceDirsWithFiles(root, [".ts", ".tsx", ".js", ".jsx"]);
    return dirs.length > 0 ? dirs : [];
  },

  getPackageName(root: string): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
      return pkg.name || path.basename(root);
    } catch {
      return path.basename(root);
    }
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".ts", ".tsx", ".js", ".jsx"]).filter(f => !f.endsWith(".d.ts"));
  },

  parseImports(filePath: string, projectRoot: string, _sourceDir: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    const fileDir = path.dirname(filePath);
    const imports: string[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();

      let importPath: string | null = null;
      const match = trimmed.match(TS_IMPORT_RE) || trimmed.match(TS_SIDE_EFFECT_RE) || trimmed.match(JS_REQUIRE_RE);
      if (match) importPath = match[1];
      if (!importPath) continue;

      // Skip bare package imports (e.g. "react", "next/link", "firebase/app")
      if (importPath.startsWith(".")) {
        // Relative import
        const resolved = resolveTsImport(fileDir, importPath);
        if (resolved) imports.push(resolved);
      } else {
        // Try path alias resolution (e.g. @/components/Sidebar → projectRoot/components/Sidebar)
        const resolved = resolveAliasImport(importPath, projectRoot);
        if (resolved) imports.push(resolved);
      }
    }

    return imports;
  },

  classifyLayer(relPath: string): string | null {
    const lower = relPath.toLowerCase();
    const fileName = lower.split("/").pop() || "";

    if (fileName.endsWith(".jsx") || fileName.endsWith(".tsx") ||
        lower.includes("components/") || lower.includes("web/public/")) {
      return "FE";
    }
    if (fileName.endsWith("server.ts") || fileName.endsWith("server.js") ||
        lower.includes("web/server")) {
      return "API";
    }
    if (fileName.endsWith(".model.ts") || fileName.endsWith(".entity.ts") ||
        fileName.endsWith(".schema.ts")) {
      return "DB";
    }
    if (fileName.endsWith(".service.ts") || fileName.endsWith(".controller.ts") ||
        lower.includes("tools/") || lower.includes("ai/") || lower.includes("watcher/")) {
      return "BE";
    }
    if (fileName === "index.ts" || fileName === "index.js" ||
        fileName.endsWith(".config.ts") || fileName.endsWith(".config.js")) {
      return "CONFIG";
    }
    if (fileName.endsWith(".util.ts") || fileName.endsWith(".helper.ts")) {
      return "UTIL";
    }
    return null;
  },
};
