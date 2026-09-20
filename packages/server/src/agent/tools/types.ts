import type { ProjectRoot } from "../../project-root.js";

export interface ToolExecutionContext {
  projectRoot: ProjectRoot;
  signal: AbortSignal;
  cwd: string; // canonicalRoot for backward compat, prefer projectRoot.getRoot()
  safePath: (requested: string) => string; // wrapper around projectRoot.resolve, sync
}

/**
 * Declared by tools that execute configuration supplied by the project itself
 * (MCP server commands, project-defined skills, hooks). Before such a tool runs
 * the loop requires an explicit, persisted trust grant for the session's real
 * root bound to exactly this configuration (see agent/project-trust.ts). A
 * per-call approval never substitutes for it.
 */
export interface ToolTrustRequirement {
  /** `sha256:<hex>` of the configuration that will be executed (computeConfigHash). */
  configHash: string;
  /** Where the configuration came from, shown to the user when consent is requested. */
  source: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  requiresApproval: (input: unknown) => boolean;
  reason?: (input: unknown) => string;
  /** Present when the tool runs project-supplied configuration; may depend on the input. */
  trust?: (input: unknown) => ToolTrustRequirement | undefined;
  execute: (input: unknown, ctx: ToolExecutionContext) => Promise<{ ok: true; output: string } | { ok: false; code?: string; message: string; retryable?: boolean } | string>;
}

export type ToolResult = import("@windows-runner/shared").ToolResult;
