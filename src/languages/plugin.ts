import * as fs from "fs";
import * as path from "path";

// ── Language Plugin Interface ──

export interface LanguagePlugin {
  id: string;
  name: string;
  extensions: string[];
  codeBlockLang: string;

  detectProject(root: string): boolean;
  getSourceDirs(root: string): string[];
  getPackageName(root: string): string;
  discoverFiles(dir: string): string[];
  parseImports(filePath: string, projectRoot: string, sourceDir: string): string[];
  classifyLayer?(relPath: string): string | null;
}

// ── Registry ──

const plugins: LanguagePlugin[] = [];

export function registerPlugin(plugin: LanguagePlugin): void {
  plugins.push(plugin);
}

export function getPlugins(): LanguagePlugin[] {
  return plugins;
}

export function getPluginById(id: string): LanguagePlugin | undefined {
  return plugins.find(p => p.id === id);
}

export function getPluginForFile(filePath: string): LanguagePlugin | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return plugins.find(p => p.extensions.includes(ext));
}

// ── Auto-detect ──

export function detectLanguages(root: string): LanguagePlugin[] {
  return plugins.filter(p => p.detectProject(root));
}

export function detectProjectRoot(startDir?: string): string {
  let dir = startDir || process.cwd();

  const manifestFiles = [
    "pubspec.yaml", "package.json", "tsconfig.json",
    "pyproject.toml", "requirements.txt", "setup.py",
    "go.mod", "Cargo.toml",
    "pom.xml", "build.gradle",
    "CMakeLists.txt", "Makefile",
    "Gemfile",
  ];

  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    for (const f of manifestFiles) {
      if (fs.existsSync(path.join(dir, f))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return startDir || process.cwd();
}

export function detectPackageName(root: string, detectedPlugins: LanguagePlugin[]): string {
  for (const plugin of detectedPlugins) {
    const name = plugin.getPackageName(root);
    if (name) return name;
  }
  return path.basename(root);
}

// ── Common Utilities ──

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".dart_tool", ".pub-cache",
  "__pycache__", ".mypy_cache", ".pytest_cache", "venv", ".venv",
  "target", "vendor", ".gradle", "bin", "obj",
  ".next", "out", ".nuxt", ".output",
]);

export function discoverAllFiles(rootDir: string, extensions: string[], extraSkipDirs?: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) return results;

  const skipSet = extraSkipDirs
    ? new Set([...SKIP_DIRS, ...extraSkipDirs])
    : SKIP_DIRS;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: any) {
      console.error(`[syke] discoverAllFiles walk error for ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipSet.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(path.normalize(path.join(dir, entry.name)));
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Check if any of the given manifest files exist at root or in first-level subdirectories.
 * Useful for detecting projects with non-standard structures (e.g. backend/requirements.txt).
 */
export function hasManifestFile(root: string, manifests: string[]): boolean {
  // Check root
  if (manifests.some(f => fs.existsSync(path.join(root, f)))) return true;

  // Check first-level subdirectories
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (manifests.some(f => fs.existsSync(path.join(root, entry.name, f)))) return true;
    }
  } catch {}

  return false;
}

/**
 * Find first-level subdirectories (and optionally root) that contain files with given extensions.
 * Skips hidden dirs and common non-source dirs (.venv, node_modules, etc.).
 */
export function findSourceDirsWithFiles(root: string, extensions: string[]): string[] {
  const dirs: string[] = [];

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });

    // Check root for direct source files
    if (entries.some(e => e.isFile() && extensions.some(ext => e.name.endsWith(ext)))) {
      dirs.push(root);
    }

    // Check first-level subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;

      const subdir = path.join(root, entry.name);
      if (discoverAllFiles(subdir, extensions).length > 0) {
        dirs.push(subdir);
      }
    }
  } catch (err: any) {
    console.error(`[syke] findSourceDirsWithFiles error for ${root}: ${err.message}`);
  }

  return dirs;
}

// ── Register All Plugins ──

import { dartPlugin } from "./dart";
import { typescriptPlugin } from "./typescript";
import { pythonPlugin } from "./python";
import { goPlugin } from "./go";
import { rustPlugin } from "./rust";
import { javaPlugin } from "./java";
import { cppPlugin } from "./cpp";
import { rubyPlugin } from "./ruby";

registerPlugin(dartPlugin);
registerPlugin(typescriptPlugin);
registerPlugin(pythonPlugin);
registerPlugin(goPlugin);
registerPlugin(rustPlugin);
registerPlugin(javaPlugin);
registerPlugin(cppPlugin);
registerPlugin(rubyPlugin);
