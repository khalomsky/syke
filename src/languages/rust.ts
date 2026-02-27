import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles } from "./plugin";

const USE_CRATE_RE = /^use\s+crate::(\S+)/;
const MOD_RE = /^mod\s+(\w+)\s*;/;

export const rustPlugin: LanguagePlugin = {
  id: "rust",
  name: "Rust",
  extensions: [".rs"],
  codeBlockLang: "rust",

  detectProject(root: string): boolean {
    return fs.existsSync(path.join(root, "Cargo.toml"));
  },

  getSourceDirs(root: string): string[] {
    const srcDir = path.join(root, "src");
    return fs.existsSync(srcDir) ? [srcDir] : [];
  },

  getPackageName(root: string): string {
    try {
      const cargo = fs.readFileSync(path.join(root, "Cargo.toml"), "utf-8");
      const match = cargo.match(/name\s*=\s*"([^"]+)"/);
      return match ? match[1] : path.basename(root);
    } catch {
      return path.basename(root);
    }
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".rs"]);
  },

  parseImports(filePath: string, _projectRoot: string, sourceDir: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    const imports: string[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();

      // use crate::module::submodule
      const useMatch = trimmed.match(USE_CRATE_RE);
      if (useMatch) {
        const cratePath = useMatch[1].replace(/::/g, path.sep).replace(/;$/, "").replace(/\{.*$/, "");
        const resolved = resolveRustPath(sourceDir, cratePath);
        if (resolved) imports.push(resolved);
        continue;
      }

      // mod module_name;
      const modMatch = trimmed.match(MOD_RE);
      if (modMatch) {
        const modName = modMatch[1];
        const fileDir = path.dirname(filePath);
        const resolved = resolveRustMod(fileDir, modName);
        if (resolved) imports.push(resolved);
      }
    }

    return imports;
  },
};

function resolveRustPath(srcDir: string, modPath: string): string | null {
  const candidates = [
    path.normalize(path.join(srcDir, modPath + ".rs")),
    path.normalize(path.join(srcDir, modPath, "mod.rs")),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveRustMod(dir: string, modName: string): string | null {
  const candidates = [
    path.normalize(path.join(dir, modName + ".rs")),
    path.normalize(path.join(dir, modName, "mod.rs")),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
