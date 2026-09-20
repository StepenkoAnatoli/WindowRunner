import type { ProjectRoot } from "../../project-root.js";

export interface ToolExecutionContext {
  projectRoot: ProjectRoot;
  signal: AbortSignal;
  cwd: string; // canonicalRoot for backward compat, prefer projectRoot.getRoot()
  safePath: (requested: string) => string; // wrapper around projectRoot.resolve, sync
}

export interface ToolDefinition {
  name: string;
  description: string;
  requiresApproval: (input: unknown) => boolean;
  reason?: (input: unknown) => string;
  execute: (input: unknown, ctx: ToolExecutionContext) => Promise<{ ok: true; output: string } | { ok: false; code?: string; message: string; retryable?: boolean } | string>;
}

export type ToolResult = import("@windows-runner/shared").ToolResult;
