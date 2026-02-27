/**
 * Central config reader for SYKE MCP Server.
 *
 * Priority: environment variables > ~/.syke/config.json
 *
 * IDE users (Cursor, Windsurf, etc.) set env vars in their MCP config.
 * Terminal users (Claude Code CLI) edit ~/.syke/config.json directly.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".syke");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

interface SykeConfig {
  licenseKey?: string;
  geminiKey?: string;
  openaiKey?: string;
  anthropicKey?: string;
  aiProvider?: string;
  port?: number;
}

let cached: SykeConfig | null = null;

/**
 * Read ~/.syke/config.json (cached after first read)
 */
function readConfigFile(): SykeConfig {
  if (cached) return cached;

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      cached = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return cached!;
    }
  } catch {
    // ignore parse errors
  }

  cached = {};
  return cached;
}

/**
 * Get a config value. Env var takes priority over config file.
 */
export function getConfig(key: keyof SykeConfig, envVar?: string): string | undefined {
  // 1. Environment variable
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  // 2. Config file
  const file = readConfigFile();
  const val = file[key];
  return val !== undefined && val !== null ? String(val) : undefined;
}

/**
 * Get all resolved config (for logging/debug)
 */
export function getAllConfig(): Record<string, string | undefined> {
  return {
    licenseKey: getConfig("licenseKey", "SYKE_LICENSE_KEY"),
    geminiKey: getConfig("geminiKey", "GEMINI_KEY"),
    openaiKey: getConfig("openaiKey", "OPENAI_KEY"),
    anthropicKey: getConfig("anthropicKey", "ANTHROPIC_KEY"),
    aiProvider: getConfig("aiProvider", "SYKE_AI_PROVIDER"),
    port: getConfig("port", "SYKE_WEB_PORT"),
  };
}

/**
 * Set a config value in ~/.syke/config.json
 */
export function setConfig(key: keyof SykeConfig, value: string | null): void {
  const file = readConfigFile();

  if (value === null) {
    delete file[key];
  } else {
    (file as any)[key] = value;
  }

  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2));
    cached = file;
  } catch {
    // ignore write errors
  }
}

export const CONFIG_DIR_PATH = CONFIG_DIR;
export const CONFIG_FILE_PATH = CONFIG_FILE;
