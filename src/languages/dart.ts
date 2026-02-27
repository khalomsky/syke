import * as fs from "fs";
import * as path from "path";
import { LanguagePlugin, discoverAllFiles } from "./plugin";

const IMPORT_RE = /^import\s+['"](.+?)['"]/;

export const dartPlugin: LanguagePlugin = {
  id: "dart",
  name: "Dart",
  extensions: [".dart"],
  codeBlockLang: "dart",

  detectProject(root: string): boolean {
    return fs.existsSync(path.join(root, "pubspec.yaml"));
  },

  getSourceDirs(root: string): string[] {
    const libDir = path.join(root, "lib");
    return fs.existsSync(libDir) ? [libDir] : [];
  },

  getPackageName(root: string): string {
    try {
      const pubspec = fs.readFileSync(path.join(root, "pubspec.yaml"), "utf-8");
      const match = pubspec.match(/^name:\s*(\S+)/m);
      return match ? match[1] : path.basename(root);
    } catch {
      return path.basename(root);
    }
  },

  discoverFiles(dir: string): string[] {
    return discoverAllFiles(dir, [".dart"]);
  },

  parseImports(filePath: string, projectRoot: string, sourceDir: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    const libDir = sourceDir;
    const imports: string[] = [];

    // Read package name for resolving package: imports
    let packageName = path.basename(projectRoot);
    try {
      const pubspec = fs.readFileSync(path.join(projectRoot, "pubspec.yaml"), "utf-8");
      const match = pubspec.match(/^name:\s*(\S+)/m);
      if (match) packageName = match[1];
    } catch {}

    for (const line of content.split("\n")) {
      const trimmed = line.trim();

      if (
        trimmed.length > 0 &&
        !trimmed.startsWith("import ") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("library ") &&
        !trimmed.startsWith("part ") &&
        !trimmed.startsWith("export ")
      ) {
        break;
      }

      const match = trimmed.match(IMPORT_RE);
      if (!match) continue;

      const importPath = match[1];

      if (importPath.startsWith("dart:")) continue;

      if (importPath.startsWith("package:")) {
        const pkgPrefix = `package:${packageName}/`;
        if (!importPath.startsWith(pkgPrefix)) continue;
        const relative = importPath.slice(pkgPrefix.length);
        imports.push(path.normalize(path.join(libDir, relative)));
        continue;
      }

      const fileDir = path.dirname(filePath);
      imports.push(path.normalize(path.resolve(fileDir, importPath)));
    }

    return imports;
  },

  classifyLayer(relPath: string): string | null {
    const lower = relPath.toLowerCase();
    const fileName = lower.split("/").pop() || "";

    if (lower.includes("/presentation/") || lower.includes("/widgets/") ||
        lower.includes("/screens/") || lower.includes("/pages/") ||
        fileName.endsWith("_screen.dart") || fileName.endsWith("_page.dart") ||
        fileName.endsWith("_widget.dart") || fileName.endsWith("_dialog.dart") ||
        fileName.endsWith("_view.dart") || fileName.endsWith("_card.dart") ||
        fileName.endsWith("_tile.dart") || fileName.endsWith("_form.dart") ||
        fileName.endsWith("_bottom_sheet.dart")) {
      return "FE";
    }
    if (lower.includes("/data/") || lower.includes("/domain/") ||
        lower.includes("/application/") || lower.includes("/providers/") ||
        lower.includes("/notifiers/") ||
        fileName.endsWith("_repository.dart") || fileName.endsWith("_service.dart") ||
        fileName.endsWith("_provider.dart") || fileName.endsWith("_notifier.dart") ||
        fileName.endsWith("_controller.dart") || fileName.endsWith("_usecase.dart") ||
        fileName.endsWith("_state.dart") || fileName.endsWith("_bloc.dart") ||
        fileName.endsWith("_cubit.dart")) {
      return "BE";
    }
    if (lower.includes("/models/") || lower.includes("/entities/") ||
        fileName.endsWith("_model.dart") || fileName.endsWith("_entity.dart") ||
        fileName.endsWith("_dto.dart")) {
      return "DB";
    }
    if (lower.includes("/api/") || fileName.includes("cloud_function") ||
        fileName.endsWith("_api.dart") || fileName.endsWith("_client.dart") ||
        fileName.endsWith("_remote.dart") || fileName.includes("_datasource") ||
        fileName.includes("_data_source")) {
      return "API";
    }
    if (lower.includes("/config/") || lower.includes("/theme/") ||
        lower.includes("/router/") || lower.includes("/routing/") ||
        fileName.endsWith("_config.dart") || fileName.endsWith("_theme.dart") ||
        fileName.endsWith("_constants.dart") || fileName.endsWith("_routes.dart") ||
        fileName === "main.dart") {
      return "CONFIG";
    }
    if (lower.includes("/utils/") || lower.includes("/helpers/") ||
        lower.includes("/extensions/") || lower.includes("shared/") ||
        fileName.endsWith("_util.dart") || fileName.endsWith("_helper.dart") ||
        fileName.endsWith("_extension.dart") || fileName.endsWith("_mixin.dart")) {
      return "UTIL";
    }
    return null;
  },
};
