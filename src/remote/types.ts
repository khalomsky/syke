/**
 * Types for SYKE Remote Pro Analysis.
 *
 * GraphBundle is the serialization format sent from the local MCP server
 * to Firebase Cloud Functions for server-side Pro analysis.
 */

// ── Graph Bundle (local → server) ──

export interface GraphBundle {
  /** Relative file paths (relative to project root) */
  files: string[];
  /** Forward dependencies: file → files it imports */
  forward: Record<string, string[]>;
  /** Reverse dependencies: file → files that import it */
  reverse: Record<string, string[]>;
  /** Detected language plugin IDs */
  languages: string[];
}

// ── Remote Request / Response Types ──

export interface RemoteAnalyzeImpactRequest {
  licenseKey: string;
  deviceId: string;
  graphBundle: GraphBundle;
  targetFile: string;
  options?: {
    includeRiskScore?: boolean;
  };
}

export interface RemoteAnalyzeImpactResponse {
  riskLevel: string;
  totalImpacted: number;
  directDependents: string[];
  transitiveDependents: string[];
  cascadeLevels?: Record<string, number>;
  circularCluster?: string[];
  sccCount?: number;
  cyclicSCCs?: number;
  riskScore?: {
    composite: number;
    fanIn: number;
    fanOut: number;
    transitiveFanIn: number;
    instability: number;
    complexity: number;
    normalizedComplexity: number;
    cascadeDepth: number;
    riskLevel: string;
    pageRank?: number;
    pageRankPercentile?: number;
  };
}

export interface RemoteGetHubFilesRequest {
  licenseKey: string;
  deviceId: string;
  graphBundle: GraphBundle;
  topN?: number;
}

export interface RemoteGetHubFilesResponse {
  hubs: Array<{
    relativePath: string;
    dependentCount: number;
    riskLevel: string;
    pageRank?: number;
    pageRankPercentile?: number;
    riskScore?: number;
    riskScoreLevel?: string;
  }>;
  totalFiles: number;
}

export interface RemoteError {
  error: string;
  code?: string;
}
