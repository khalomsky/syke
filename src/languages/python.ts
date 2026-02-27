import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles, hasManifestFile, findSourceDirsWithFiles } from "./plugin";

const FROM_IMPORT_RE = /^from\s+(\S+)\s+import/;
const IMPORT_RE = /^import\s+(\S+)/;

export const pythonPlugin: LanguagePlugin = {
  id: "python",
  name: "Python",
  extensions: [".py"],
  codeBlockLang: "python",

  detectProject(root: string): boolean {
    return hasManifestFile(root, ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"]);
  },

  getSourceDirs(root: string): string[] {
    const dirs = findSourceDirsWithFiles(root, [".py"]);
    return dirs.length > 0 ? dirs : [root];
  },

  getPackageName(root: string): string {
    try {
      const toml = fs.readFileSync(path.join(root, "pyproject.toml"), "utf-8");
      const match = toml.match(/name\s*=\s*"([^"]+)"/);
      return match ? match[1] : path.basename(root);
    } catch {
      return path.basename(root);
    }
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".py"]);
  },

  parseImports(filePath: string, projectRoot: string, sourceDir: string, content?: string): string[] {
    if (!content) {
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        return [];
      }
    }

    const imports: string[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;

      let modulePath: string | null = null;

      const fromMatch = trimmed.match(FROM_IMPORT_RE);
      if (fromMatch) {
        modulePath = fromMatch[1];
      } else {
        const impMatch = trimmed.match(IMPORT_RE);
        if (impMatch) {
          modulePath = impMatch[1];
        }
      }

      if (!modulePath) continue;

      // Handle relative imports (starts with .)
      if (modulePath.startsWith(".")) {
        const dots = modulePath.match(/^\.+/)?.[0].length || 1;
        let base = path.dirname(filePath);
        for (let i = 1; i < dots; i++) base = path.dirname(base);
        const rest = modulePath.slice(dots).replace(/\./g, path.sep);
        const resolved = resolveModule(base, rest);
        if (resolved) imports.push(resolved);
        continue;
      }

      // Try resolving as local module relative to source dir
      const modPath = modulePath.replace(/\./g, path.sep);
      const resolved = resolveModule(sourceDir, modPath);
      if (resolved) imports.push(resolved);
    }

    return imports;
  },
};

function resolveModule(baseDir: string, modPath: string): string | null {
  const candidates = [
    path.join(baseDir, modPath + ".py"),
    path.join(baseDir, modPath, "__init__.py"),
  ];

  for (const c of candidates) {
    const normalized = path.normalize(c);
    if (fs.existsSync(normalized)) return normalized;
  }
  return null;
}
