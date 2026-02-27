/**
 * Remote proxy for SYKE Pro tools.
 *
 * Serializes the local dependency graph and sends it to Firebase Cloud Functions
 * for server-side Pro analysis. The user experience is transparent — same tools,
 * same output format, just executed on the server.
 */

import * as https from "https";
import * as path from "path";
import { DependencyGraph } from "../graph";
import { getConfig } from "../config";
import {
  GraphBundle,
  RemoteAnalyzeImpactResponse,
  RemoteGetHubFilesResponse,
} from "./types";

// ── Constants ──

const BASE_URL = "https://us-central1-syke-cloud.cloudfunctions.net";

const ENDPOINTS = {
  analyzeImpact: `${BASE_URL}/proAnalyzeImpact`,
  getHubFiles: `${BASE_URL}/proGetHubFiles`,
};

// ── Graph Serialization ──

/**
 * Serialize a DependencyGraph into a GraphBundle for transmission.
 * Converts absolute paths to relative paths (relative to sourceDir)
 * to minimize payload size and avoid leaking local paths.
 */
export function serializeGraph(graph: DependencyGraph): GraphBundle {
  const toRel = (f: string) => path.relative(graph.sourceDir, f).replace(/\\/g, "/");

  const files: string[] = [];
  for (const f of graph.files) {
    files.push(toRel(f));
  }

  const forward: Record<string, string[]> = {};
  for (const [file, deps] of graph.forward) {
    const rel = toRel(file);
    forward[rel] = deps.map(toRel);
  }

  const reverse: Record<string, string[]> = {};
  for (const [file, deps] of graph.reverse) {
    const rel = toRel(file);
    reverse[rel] = deps.map(toRel);
  }

  return {
    files,
    forward,
    reverse,
    languages: graph.languages,
  };
}

// ── HTTP Client ──

function postJSON(url: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => { responseData += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(responseData);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Invalid response: ${responseData.substring(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("Request timeout (60s)"));
    });

    req.write(data);
    req.end();
  });
}

// ── License + Device Info ──

function getLicenseKey(): string | undefined {
  return getConfig("licenseKey", "SYKE_LICENSE_KEY");
}

function getDeviceId(): string {
  const os = require("os");
  const crypto = require("crypto");
  const raw = `${os.hostname()}:${os.userInfo().username}:${process.platform}:${os.arch()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 16);
}

// ── Public API ──

/**
 * Remote analyze_impact: sends graph + target file to server.
 */
export async function remoteAnalyzeImpact(
  graph: DependencyGraph,
  resolvedFilePath: string,
  options?: { includeRiskScore?: boolean }
): Promise<RemoteAnalyzeImpactResponse> {
  const licenseKey = getLicenseKey();
  if (!licenseKey) {
    throw new Error("No license key configured");
  }

  const graphBundle = serializeGraph(graph);
  const targetFile = path.relative(graph.sourceDir, resolvedFilePath).replace(/\\/g, "/");

  const result = await postJSON(ENDPOINTS.analyzeImpact, {
    licenseKey,
    deviceId: getDeviceId(),
    graphBundle,
    targetFile,
    options: { includeRiskScore: options?.includeRiskScore !== false },
  });

  return result as RemoteAnalyzeImpactResponse;
}

/**
 * Remote get_hub_files: sends graph to server for PageRank analysis.
 */
export async function remoteGetHubFiles(
  graph: DependencyGraph,
  topN: number = 10
): Promise<RemoteGetHubFilesResponse> {
  const licenseKey = getLicenseKey();
  if (!licenseKey) {
    throw new Error("No license key configured");
  }

  const graphBundle = serializeGraph(graph);

  const result = await postJSON(ENDPOINTS.getHubFiles, {
    licenseKey,
    deviceId: getDeviceId(),
    graphBundle,
    topN,
  });

  return result as RemoteGetHubFilesResponse;
}

/**
 * Remote license validation only (for refresh_graph, check_warnings).
 * Returns true if the license is valid Pro.
 */
export async function remoteValidateLicense(): Promise<boolean> {
  const licenseKey = getLicenseKey();
  if (!licenseKey) return false;

  try {
    const result = await postJSON(`${BASE_URL}/validateLicenseKey`, {
      key: licenseKey,
      deviceId: getDeviceId(),
    });
    return result.valid === true;
  } catch {
    return false;
  }
}
