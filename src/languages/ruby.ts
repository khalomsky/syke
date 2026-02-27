import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles } from "./plugin";

const REQUIRE_RELATIVE_RE = /^require_relative\s+['"](.+?)['"]/;

export const rubyPlugin: LanguagePlugin = {
  id: "ruby",
  name: "Ruby",
  extensions: [".rb"],
  codeBlockLang: "ruby",

  detectProject(root: string): boolean {
    return fs.existsSync(path.join(root, "Gemfile"));
  },

  getSourceDirs(root: string): string[] {
    const libDir = path.join(root, "lib");
    if (fs.existsSync(libDir)) return [libDir];
    return [root];
  },

  getPackageName(root: string): string {
    // Try reading from gemspec
    try {
      const gemspecs = fs.readdirSync(root).filter(f => f.endsWith(".gemspec"));
      if (gemspecs.length > 0) {
        const content = fs.readFileSync(path.join(root, gemspecs[0]), "utf-8");
        const match = content.match(/\.name\s*=\s*['"]([^'"]+)['"]/);
        if (match) return match[1];
      }
    } catch {}
    return path.basename(root);
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".rb"]);
  },

  parseImports(filePath: string, _projectRoot: string, _sourceDir: string, content?: string): string[] {
    if (!content) {
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        return [];
      }
    }

    const fileDir = path.dirname(filePath);
    const imports: string[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;

      const match = trimmed.match(REQUIRE_RELATIVE_RE);
      if (!match) continue;

      const reqPath = match[1];
      const resolved = path.normalize(path.resolve(fileDir, reqPath + ".rb"));
      if (fs.existsSync(resolved)) {
        imports.push(resolved);
      }
    }

    return imports;
  },
};
