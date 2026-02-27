import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { detectLanguages, LanguagePlugin } from "../languages/plugin";
import { DependencyGraph } from "../graph";
import {
  updateGraphForFile,
  addFileToGraph,
  removeFileFromGraph,
  IncrementalUpdateResult,
} from "../graph/incremental";
import { getMemoCache } from "../graph/memo-cache";

export interface FileChange {
  filePath: string;       // absolute path
  relativePath: string;   // relative to sourceDir
  type: "modified" | "added" | "deleted";
  oldContent: string | null;
  newContent: string | null;
  diff: LineDiff[];
  timestamp: number;
}

export interface LineDiff {
  line: number;
  type: "added" | "removed" | "changed";
  old?: string;
  new?: string;
}

/**
 * FileCache: Holds ALL source files in memory.
 * Emits "change" events when files are modified on disk.
 */
export class FileCache extends EventEmitter {
  private cache = new Map<string, string>();       // abs path → content
  private sourceDirs: string[] = [];
  private extensions: Set<string>;
  private plugins: LanguagePlugin[];
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly DEBOUNCE_MS = 1500;
  private graph: DependencyGraph | null = null;

  constructor(private projectRoot: string) {
    super();
    this.plugins = detectLanguages(projectRoot);

    // Collect all extensions from detected plugins
    const allExts = new Set<string>();
    for (const plugin of this.plugins) {
      for (const ext of plugin.extensions) {
        allExts.add(ext);
      }
    }
    this.extensions = allExts.size > 0 ? allExts : new Set([".ts"]);

    // Collect all source dirs
    for (const plugin of this.plugins) {
      for (const dir of plugin.getSourceDirs(projectRoot)) {
        if (!this.sourceDirs.includes(dir)) {
          this.sourceDirs.push(dir);
        }
      }
    }
  }

  /** Primary source directory (backward compat) */
  get sourceDir(): string {
    return this.sourceDirs[0] || path.join(this.projectRoot, "src");
  }

  /**
   * Set the dependency graph reference for incremental updates.
   * When a graph is set, file changes will trigger incremental
   * edge updates and memo cache invalidation instead of requiring
   * a full graph rebuild.
   */
  setGraph(graph: DependencyGraph): void {
    this.graph = graph;
  }

  /** Load ALL source files into memory on startup */
  initialize(): { fileCount: number; totalLines: number } {
    let totalLines = 0;

    for (const plugin of this.plugins) {
      for (const dir of plugin.getSourceDirs(this.projectRoot)) {
        const files = plugin.discoverFiles(dir);
        for (const file of files) {
          try {
            const content = fs.readFileSync(file, "utf-8");
            this.cache.set(path.normalize(file), content);
            totalLines += content.split("\n").length;
          } catch (_) {
            // skip unreadable files
          }
        }
      }
    }

    console.error(`[syke:cache] Loaded ${this.cache.size} files (${totalLines.toLocaleString()} lines) into memory`);
    return { fileCount: this.cache.size, totalLines };
  }

  /** Start watching source directories for changes */
  startWatching(): void {
    if (this.watcher) return;

    // Watch each source directory
    for (const dir of this.sourceDirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          if (!this.isWatchedFile(filename)) return;

          const absPath = path.normalize(path.join(dir, filename));
          const relPath = filename.replace(/\\/g, "/");

          const existing = this.debounceTimers.get(absPath);
          if (existing) clearTimeout(existing);

          this.debounceTimers.set(absPath, setTimeout(() => {
            this.debounceTimers.delete(absPath);
            this.handleFileEvent(absPath, relPath);
          }, this.DEBOUNCE_MS));
        });

        // Store first watcher for backward compat
        if (!this.watcher) this.watcher = watcher;

        console.error(`[syke:cache] Watching ${dir} for changes`);
      } catch (err: any) {
        console.error(`[syke:cache] Watch failed for ${dir}: ${err.message}`);
      }
    }
  }

  private isWatchedFile(filename: string): boolean {
    if (filename.endsWith(".d.ts")) return false;
    for (const ext of this.extensions) {
      if (filename.endsWith(ext)) return true;
    }
    return false;
  }

  private handleFileEvent(absPath: string, relPath: string): void {
    const oldContent = this.cache.get(absPath) || null;
    let newContent: string | null = null;
    let type: FileChange["type"];

    try {
      if (fs.existsSync(absPath)) {
        newContent = fs.readFileSync(absPath, "utf-8");

        if (oldContent === null) {
          type = "added";
        } else if (oldContent === newContent) {
          return; // no actual change
        } else {
          type = "modified";
        }

        this.cache.set(absPath, newContent);
      } else {
        type = "deleted";
        this.cache.delete(absPath);
      }
    } catch (_) {
      return;
    }

    const diff = this.computeDiff(oldContent, newContent);

    const change: FileChange = {
      filePath: absPath,
      relativePath: relPath,
      type,
      oldContent,
      newContent,
      diff,
      timestamp: Date.now(),
    };

    console.error(`[syke:cache] ${type.toUpperCase()}: ${relPath} (${diff.length} changes)`);
    this.emit("change", change);

    // Incremental graph update (if graph is available)
    if (this.graph) {
      try {
        let result: IncrementalUpdateResult;

        if (type === "modified") {
          result = updateGraphForFile(this.graph, absPath, this.projectRoot);
        } else if (type === "added") {
          result = addFileToGraph(this.graph, absPath, this.projectRoot);
        } else {
          // deleted
          result = removeFileFromGraph(this.graph, absPath);
        }

        // Invalidate memo cache for affected files
        if (result.edgesChanged && result.affectedFiles.length > 0) {
          const invalidated = getMemoCache().invalidate(result.affectedFiles);
          console.error(
            `[syke:incremental] ${type}: ${relPath} — ` +
            `+${result.addedEdges.length}/-${result.removedEdges.length} edges, ` +
            `${result.affectedFiles.length} affected, ${invalidated} cache entries invalidated`
          );
        }

        // Emit graph-updated event for downstream consumers (e.g., SSE broadcast)
        this.emit("graph-updated", result);
      } catch (err: any) {
        console.error(`[syke:incremental] Error updating graph for ${relPath}: ${err.message}`);
      }
    }
  }

  /** Simple line-by-line diff */
  private computeDiff(oldContent: string | null, newContent: string | null): LineDiff[] {
    const diffs: LineDiff[] = [];
    const oldLines = oldContent ? oldContent.split("\n") : [];
    const newLines = newContent ? newContent.split("\n") : [];
    const maxLen = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < oldLines.length ? oldLines[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;

      if (oldLine === undefined && newLine !== undefined) {
        diffs.push({ line: i + 1, type: "added", new: newLine });
      } else if (oldLine !== undefined && newLine === undefined) {
        diffs.push({ line: i + 1, type: "removed", old: oldLine });
      } else if (oldLine !== newLine) {
        diffs.push({ line: i + 1, type: "changed", old: oldLine, new: newLine });
      }
    }

    return diffs;
  }

  /** Get content of a specific file from cache */
  getFile(absPath: string): string | null {
    return this.cache.get(path.normalize(absPath)) ?? null;
  }

  /** Get content by relative path (relative to first sourceDir) */
  getFileByRelPath(relPath: string): string | null {
    const absPath = path.normalize(path.join(this.sourceDir, relPath));
    return this.cache.get(absPath) ?? null;
  }

  /** Get all cached files as {relativePath → content} */
  getAllFiles(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [absPath, content] of this.cache) {
      const rel = path.relative(this.sourceDir, absPath).replace(/\\/g, "/");
      result.set(rel, content);
    }
    return result;
  }

  /** Get file count */
  get size(): number {
    return this.cache.size;
  }

  /** Get total lines across all files */
  get totalLines(): number {
    let total = 0;
    for (const content of this.cache.values()) {
      total += content.split("\n").length;
    }
    return total;
  }

  /** Cleanup */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    console.error("[syke:cache] Watcher stopped");
  }
}
