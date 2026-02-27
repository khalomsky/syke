import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as crypto from "crypto";
import { getConfig, setConfig, CONFIG_DIR_PATH } from "../config";

export interface LicenseStatus {
  plan: "free" | "pro" | "pro_trial" | "cortex";
  email?: string;
  expiresAt?: string;
  source: "online" | "cache" | "default";
  error?: string;
  /** @internal integrity token — do not modify */
  _t?: string;
}

// Runtime integrity verification
const _INTEGRITY_SEED = "syke:" + os.hostname() + ":" + process.pid;

function _signStatus(plan: string, source: string): string {
  return crypto.createHash("sha256").update(_INTEGRITY_SEED + ":" + plan + ":" + source).digest("hex").substring(0, 12);
}

export function _verifyStatus(status: LicenseStatus): boolean {
  if (!status._t) return status.plan === "free";
  return status._t === _signStatus(status.plan, status.source);
}

interface CacheData {
  valid: boolean;
  plan?: string;
  email?: string;
  expiresAt?: string;
  cachedAt: number;
}

const CACHE_DIR = CONFIG_DIR_PATH;
const CACHE_FILE = path.join(CACHE_DIR, ".license-cache.json");

// Cache durations
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_GRACE_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 days offline grace

// Heartbeat interval
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Cloud Function URLs
const BASE_URL = "https://us-central1-syke-cloud.cloudfunctions.net";
const VALIDATE_URL = `${BASE_URL}/validateLicenseKey`;
const HEARTBEAT_URL = `${BASE_URL}/licenseHeartbeat`;
const DEACTIVATE_URL = `${BASE_URL}/licenseDeactivate`;

// Module state for heartbeat
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let currentLicenseKey: string | null = null;
let currentDeviceId: string | null = null;

/**
 * Generate a stable device fingerprint from machine info
 */
function getDeviceFingerprint(): string {
  const raw = `${os.hostname()}:${os.userInfo().username}:${os.platform()}:${os.arch()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 16);
}

/**
 * Human-readable device name for dashboard display
 */
function getDeviceName(): string {
  const platformNames: Record<string, string> = {
    win32: "Windows",
    darwin: "macOS",
    linux: "Linux",
  };
  const platformName = platformNames[os.platform()] || os.platform();
  return `${os.hostname()} (${platformName})`;
}

/**
 * Read license key from env var or config file
 */
function getLicenseKey(): string | null {
  const key = getConfig("licenseKey", "SYKE_LICENSE_KEY");
  if (key && (key.startsWith("SYKE-") || key.startsWith("FOUNDING-"))) return key;
  return null;
}

/**
 * Read cached license validation result
 */
function readCache(): CacheData | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (!data || typeof data.cachedAt !== "number") return null;
    return data as CacheData;
  } catch {
    return null;
  }
}

/**
 * Write license validation result to cache
 */
function writeCache(data: CacheData): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch {
    // silently fail — cache is optional
  }
}

/**
 * POST JSON to a URL, return parsed response
 */
function postJSON(url: string, body: Record<string, any>): Promise<any> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const parsedUrl = new URL(url);

    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname,
        method: "POST",
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ valid: false });
          }
        });
      }
    );

    req.on("error", () => resolve({ valid: false }));
    req.on("timeout", () => { req.destroy(); resolve({ valid: false }); });
    req.write(payload);
    req.end();
  });
}

/**
 * Validate license online with device binding
 */
async function validateOnline(key: string): Promise<{ valid: boolean; plan?: string; email?: string; expiresAt?: string; error?: string; foundingRedeemed?: boolean; licenseKey?: string }> {
  const deviceId = getDeviceFingerprint();
  const deviceName = getDeviceName();

  return postJSON(VALIDATE_URL, { key, deviceId, deviceName });
}

/**
 * Send heartbeat to keep session alive
 */
async function sendHeartbeat(): Promise<void> {
  if (!currentLicenseKey || !currentDeviceId) return;

  try {
    await postJSON(HEARTBEAT_URL, {
      key: currentLicenseKey,
      deviceId: currentDeviceId,
      deviceName: getDeviceName(),
    });
  } catch {
    // silently fail — next heartbeat will retry
  }
}

/**
 * Deactivate session — called on graceful shutdown
 */
async function sendDeactivate(): Promise<void> {
  if (!currentLicenseKey || !currentDeviceId) return;

  try {
    await postJSON(DEACTIVATE_URL, {
      key: currentLicenseKey,
      deviceId: currentDeviceId,
    });
  } catch {
    // best-effort — server will timeout the session anyway
  }
}

/**
 * Start heartbeat interval (called after successful Pro validation)
 */
export function startHeartbeat(key: string, deviceId: string): void {
  currentLicenseKey = key;
  currentDeviceId = deviceId;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop heartbeat and deactivate session (called on shutdown)
 */
export async function stopAndDeactivate(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  await sendDeactivate();
  currentLicenseKey = null;
  currentDeviceId = null;
}

/**
 * Get current device fingerprint (exported for use by index.ts)
 */
export function getDeviceId(): string {
  return getDeviceFingerprint();
}

/**
 * Clear license cache file (called when license key changes)
 */
export function clearLicenseCache(): void {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
  } catch {
    // silently fail
  }
}

/**
 * Map server plan string to client plan type.
 * Cortex plans → "cortex", trial → "pro_trial", everything else paid → "pro".
 */
function mapPlan(serverPlan: string): "free" | "pro" | "pro_trial" | "cortex" {
  if (serverPlan === "pro_trial") return "pro_trial";
  if (serverPlan === "cortex_monthly" || serverPlan === "cortex_annual" || serverPlan === "cortex") return "cortex";
  return "pro"; // pro_monthly, pro_annual, pro_founding, master, etc.
}

/**
 * Main license validation — called on MCP server startup
 */
export async function checkLicense(): Promise<LicenseStatus> {
  const key = getLicenseKey();

  // No key → Free mode
  if (!key) {
    return { plan: "free", source: "default", _t: _signStatus("free", "default") };
  }

  // Check cache first
  const cache = readCache();
  const now = Date.now();

  if (cache && cache.valid && (now - cache.cachedAt) < CACHE_MAX_AGE) {
    // Cache is fresh — still start heartbeat with cached session
    startHeartbeat(key, getDeviceFingerprint());
    const cachedPlan = mapPlan(cache.plan || "");
    return {
      plan: cachedPlan,
      email: cache.email,
      expiresAt: cache.expiresAt,
      source: "cache",
      _t: _signStatus(cachedPlan, "cache"),
    };
  }

  // Try online validation (with device binding)
  const result = await validateOnline(key);

  // Handle founding code auto-redemption: server returns real SYKE- key
  if (result.foundingRedeemed && result.licenseKey) {
    const realKey = result.licenseKey;
    console.error(`[syke] Founding code redeemed → ${realKey}`);
    setConfig("licenseKey", realKey);
    clearLicenseCache();

    writeCache({
      valid: true,
      plan: result.plan,
      email: result.email,
      expiresAt: result.expiresAt,
      cachedAt: now,
    });

    startHeartbeat(realKey, getDeviceFingerprint());

    const foundingPlan = mapPlan(result.plan || "");
    return {
      plan: foundingPlan,
      email: result.email,
      expiresAt: result.expiresAt,
      source: "online" as const,
      _t: _signStatus(foundingPlan, "online"),
    };
  }

  if (!result.valid) {
    const reason = result.error || "invalid key or expired";
    console.error(`[syke] License validation failed: ${reason}`);
  }

  if (result.valid) {
    // Update cache
    writeCache({
      valid: true,
      plan: result.plan,
      email: result.email,
      expiresAt: result.expiresAt,
      cachedAt: now,
    });

    // Start heartbeat
    startHeartbeat(key, getDeviceFingerprint());

    const onlinePlan = mapPlan(result.plan || "");
    return {
      plan: onlinePlan,
      email: result.email,
      expiresAt: result.expiresAt,
      source: "online",
      _t: _signStatus(onlinePlan, "online"),
    };
  }

  // Device/session error — pass through error message
  if (result.error) {
    return {
      plan: "free",
      source: "online",
      error: result.error,
      _t: _signStatus("free", "online"),
    };
  }

  // Online validation failed — check if we have a grace-period cache
  if (cache && cache.valid && (now - cache.cachedAt) < CACHE_GRACE_PERIOD) {
    startHeartbeat(key, getDeviceFingerprint());
    const gracePlan = mapPlan(cache.plan || "");
    return {
      plan: gracePlan,
      email: cache.email,
      expiresAt: cache.expiresAt,
      source: "cache",
      _t: _signStatus(gracePlan, "cache"),
    };
  }

  // No valid cache within grace period → Free mode
  writeCache({ valid: false, cachedAt: now });
  return { plan: "free", source: "default", _t: _signStatus("free", "default") };
}
