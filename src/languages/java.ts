import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles } from "./plugin";

const IMPORT_RE = /^import\s+([\w.]+)\s*;/;

export const javaPlugin: LanguagePlugin = {
  id: "java",
  name: "Java",
  extensions: [".java"],
  codeBlockLang: "java",

  detectProject(root: string): boolean {
    return fs.existsSync(path.join(root, "pom.xml")) ||
           fs.existsSync(path.join(root, "build.gradle")) ||
           fs.existsSync(path.join(root, "build.gradle.kts"));
  },

  getSourceDirs(root: string): string[] {
    const mainJava = path.join(root, "src", "main", "java");
    if (fs.existsSync(mainJava)) return [mainJava];
    const src = path.join(root, "src");
    if (fs.existsSync(src)) return [src];
    return [];
  },

  getPackageName(root: string): string {
    // Try reading from pom.xml
    try {
      const pom = fs.readFileSync(path.join(root, "pom.xml"), "utf-8");
      const groupMatch = pom.match(/<groupId>([^<]+)<\/groupId>/);
      const artifactMatch = pom.match(/<artifactId>([^<]+)<\/artifactId>/);
      if (groupMatch && artifactMatch) {
        return `${groupMatch[1]}.${artifactMatch[1]}`;
      }
    } catch {}
    return path.basename(root);
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".java"]);
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

      if (trimmed.length > 0 &&
          !trimmed.startsWith("import ") &&
          !trimmed.startsWith("package ") &&
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("/*") &&
          !trimmed.startsWith("*")) {
        break;
      }

      const match = trimmed.match(IMPORT_RE);
      if (!match) continue;

      const importPath = match[1];
      // Skip standard library and common frameworks
      if (importPath.startsWith("java.") || importPath.startsWith("javax.") ||
          importPath.startsWith("org.springframework.") || importPath.startsWith("lombok.")) {
        continue;
      }

      // Convert dots to path separators
      const relFile = importPath.replace(/\./g, path.sep) + ".java";
      const resolved = path.normalize(path.join(sourceDir, relFile));
      if (fs.existsSync(resolved)) {
        imports.push(resolved);
      }
    }

    return imports;
  },
};
