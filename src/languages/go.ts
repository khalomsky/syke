import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles } from "./plugin";

const IMPORT_LINE_RE = /^\s*"([^"]+)"/;

export const goPlugin: LanguagePlugin = {
  id: "go",
  name: "Go",
  extensions: [".go"],
  codeBlockLang: "go",

  detectProject(root: string): boolean {
    return fs.existsSync(path.join(root, "go.mod"));
  },

  getSourceDirs(root: string): string[] {
    return [root];
  },

  getPackageName(root: string): string {
    try {
      const goMod = fs.readFileSync(path.join(root, "go.mod"), "utf-8");
      const match = goMod.match(/^module\s+(\S+)/m);
      return match ? match[1] : path.basename(root);
    } catch {
      return path.basename(root);
    }
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".go"]).filter(f => !f.endsWith("_test.go"));
  },

  parseImports(filePath: string, projectRoot: string, _sourceDir: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    // Get module prefix from go.mod
    let modulePrefix = "";
    try {
      const goMod = fs.readFileSync(path.join(projectRoot, "go.mod"), "utf-8");
      const match = goMod.match(/^module\s+(\S+)/m);
      if (match) modulePrefix = match[1];
    } catch {}

    const imports: string[] = [];

    // Parse import block or single imports
    const importBlockMatch = content.match(/import\s*\(([\s\S]*?)\)/);
    const singleImports = content.matchAll(/^import\s+"([^"]+)"/gm);

    const importLines: string[] = [];
    if (importBlockMatch) {
      importLines.push(...importBlockMatch[1].split("\n"));
    }
    for (const m of singleImports) {
      importLines.push(`"${m[1]}"`);
    }

    for (const line of importLines) {
      const match = line.match(IMPORT_LINE_RE);
      if (!match) continue;

      const importPath = match[1];

      // Only include internal module imports
      if (modulePrefix && importPath.startsWith(modulePrefix + "/")) {
        const relImport = importPath.slice(modulePrefix.length + 1);
        const resolved = path.normalize(path.join(projectRoot, relImport));

        // Go packages are directories, find any .go file in it
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          const goFiles = discoverAllFiles(resolved, [".go"]).filter(f => !f.endsWith("_test.go"));
          imports.push(...goFiles);
        }
      }
    }

    return imports;
  },
};
