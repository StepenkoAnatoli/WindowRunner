import type { ToolDefinition, ToolExecutionContext } from "./types.js";
import type { ToolResult } from "@windows-runner/shared";
import { runWithDeadline, DeadlineError } from "../../deadline.js";
import { PathError } from "../../project-root.js";

export async function executeTool(
  tool: ToolDefinition,
  input: unknown,
  ctx: ToolExecutionContext,
  timeoutMs: number,
  clock?: any,
  shutdownGraceMs = 5000
): Promise<ToolResult> {
  try {
    const result = await runWithDeadline(
      async (signal) => {
        const childCtx: ToolExecutionContext = {
          ...ctx,
          signal,
          projectRoot: ctx.projectRoot,
          cwd: ctx.projectRoot.getRoot(),
          safePath: (requested: string) => ctx.projectRoot.resolve(requested),
        };
        const raw = await tool.execute(input, childCtx);
        if (typeof raw === "string") {
          return { ok: true, output: raw } as ToolResult;
        }
        if ((raw as any).ok === true) {
          return raw as ToolResult;
        }
        if ((raw as any).ok === false) {
          const r = raw as any;
          return {
            ok: false,
            code: r.code ?? "TOOL_FAILED",
            message: r.message ?? "tool failed",
            retryable: r.retryable ?? true,
          } as ToolResult;
        }
        return { ok: true, output: String(raw) } as ToolResult;
      },
      {
        parentSignal: ctx.signal,
        timeoutMs,
        kind: "tool",
        clock,
        shutdownGraceMs,
      }
    );
    return result;
  } catch (err: any) {
    if (err instanceof PathError) {
      return {
        ok: false,
        code: err.code,
        message: err.message,
        retryable: err.retryable,
      };
    }
    if (err instanceof DeadlineError) {
      if (err.kind === "cancelled") {
        throw err;
      }
      if (err.kind === "deadline_expired") {
        return {
          ok: false,
          code: "TOOL_TIMED_OUT",
          message: `${tool.name} timed out after ${timeoutMs}ms`,
          retryable: true,
        };
      }
      if (err.kind === "shutdown_timeout") {
        return {
          ok: false,
          code: "TOOL_FAILED",
          message: `${tool.name} shutdown timeout: ${err.message} — abort requested, operation not confirmed stopped`,
          retryable: false,
        };
      }
    }
    // Map raw fs errors that might have escaped PathError (defense in depth)
    if (err.code === "ENOENT") {
      return {
        ok: false,
        code: "PATH_NOT_FOUND",
        message: `file not found: ${err.message}`,
        retryable: true,
      };
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      return {
        ok: false,
        code: "PERMISSION_DENIED",
        message: `permission denied: ${err.message}`,
        retryable: false,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "TOOL_FAILED",
      message,
      retryable: true,
    };
  }
}
