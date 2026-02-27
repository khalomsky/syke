import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles } from "./plugin";

const INCLUDE_RE = /^#include\s+"(.+?)"/;

export const cppPlugin: LanguagePlugin = {
  id: "cpp",
  name: "C/C++",
  extensions: [".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hxx"],
  codeBlockLang: "cpp",

  detectProject(root: string): boolean {
    return fs.existsSync(path.join(root, "CMakeLists.txt")) ||
           fs.existsSync(path.join(root, "Makefile")) ||
           fs.existsSync(path.join(root, "meson.build"));
  },

  getSourceDirs(root: string): string[] {
    const dirs: string[] = [];
    const srcDir = path.join(root, "src");
    const includeDir = path.join(root, "include");
    if (fs.existsSync(srcDir)) dirs.push(srcDir);
    if (fs.existsSync(includeDir)) dirs.push(includeDir);
    if (dirs.length === 0) dirs.push(root);
    return dirs;
  },

  getPackageName(root: string): string {
    try {
      const cmake = fs.readFileSync(path.join(root, "CMakeLists.txt"), "utf-8");
      const match = cmake.match(/project\s*\(\s*(\w+)/i);
      return match ? match[1] : path.basename(root);
    } catch {
      return path.basename(root);
    }
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hxx"]);
  },

  parseImports(filePath: string, projectRoot: string, sourceDir: string): string[] {
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

      // Only process local includes (#include "..."), skip system <...>
      const match = trimmed.match(INCLUDE_RE);
      if (!match) continue;

      const includePath = match[1];

      // Try resolving: relative to file, then to sourceDir, then to projectRoot
      const candidates = [
        path.normalize(path.resolve(fileDir, includePath)),
        path.normalize(path.join(sourceDir, includePath)),
        path.normalize(path.join(projectRoot, "include", includePath)),
        path.normalize(path.join(projectRoot, includePath)),
      ];

      for (const c of candidates) {
        if (fs.existsSync(c)) {
          imports.push(c);
          break;
        }
      }
    }

    return imports;
  },
};
