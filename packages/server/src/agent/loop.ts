import type { SessionId, TurnId, TurnLimits, TurnUsage } from "@windows-runner/shared";
import { ProviderError, type LLMProvider, type LLMRequest } from "../providers/types.js";
import type { ToolDefinition } from "./tools/types.js";
import { ApprovalRegistry, type ApprovalResolution } from "./approval-registry.js";
import { TurnManager } from "./turn-manager.js";
import { runModelCall } from "../providers/model-call.js";
import { executeTool } from "./tools/executor.js";
import { DeadlineError } from "../deadline.js";
import { ProjectRoot, PathError } from "../project-root.js";
import type { MetricsRegistry } from "./metrics.js";
import type { ProjectTrustRegistry } from "./project-trust.js";

export interface RunTurnInput {
  sessionId: SessionId;
  turnId: TurnId;
  cwd: string;
  request: LLMRequest;
  limits: TurnLimits;
  signal: AbortSignal;
  allowedRoots?: string[];
  projectRoot?: ProjectRoot;
}

export interface TurnRunnerDependencies {
  provider: LLMProvider;
  tools: ReadonlyMap<string, ToolDefinition>;
  approvals: ApprovalRegistry;
  manager: TurnManager;
  now?: () => number;
  clock?: any;
  allowedRoots?: string[];
  metrics?: MetricsRegistry;
  /**
   * Trust decisions for project-supplied tool configuration. When absent,
   * every tool that declares `trust` is refused with PROJECT_NOT_TRUSTED —
   * the safe default for a runtime that has not been given a registry.
   */
  trust?: ProjectTrustRegistry;
}

export interface TurnResult {
  status: "completed" | "cancelled" | "failed";
  usage?: TurnUsage;
  message?: string;
}

function mapDeadlineError(err: any): { code: string; message: string; retryable: boolean; kind: string } | null {
  if (err instanceof DeadlineError) {
    return {
      code: err.kind,
      message: err.message,
      retryable: err.kind === "deadline_expired",
      kind: err.kind,
    };
  }
  return null;
}

export class TurnRunner {
  private provider: LLMProvider;
  private tools: ReadonlyMap<string, ToolDefinition>;
  private approvals: ApprovalRegistry;
  private manager: TurnManager;
  private now: () => number;
  private clock?: any;
  private allowedRoots: string[];
  private metrics?: MetricsRegistry;
  private trust?: ProjectTrustRegistry;

  constructor(deps: TurnRunnerDependencies) {
    this.provider = deps.provider;
    this.tools = deps.tools;
    this.approvals = deps.approvals;
    this.manager = deps.manager;
    this.now = deps.now ?? (() => Date.now());
    this.clock = deps.clock;
    this.allowedRoots = deps.allowedRoots ?? [];
    this.metrics = deps.metrics;
    this.trust = deps.trust;
  }

  async run(input: RunTurnInput): Promise<TurnResult> {
    const { sessionId, turnId, cwd, limits, signal } = input;
    let request = input.request;

    this.manager.ensureLog(sessionId, turnId, limits);

    // Unified durable append: if manager durableBeforeNotify, await persistence before notify
    const append = async (event: any) => {
      return await this.manager.appendAsync(sessionId, turnId, {
        at: this.now(),
        ...event,
      });
    };

    if (signal.aborted) {
      await append({ type: "turn_cancelled", reason: "aborted before start" });
      return { status: "cancelled", message: "aborted before start" };
    }

    // Construct ProjectRoot only from validated allowedRoots — single owner for fs safety
    let projectRoot: ProjectRoot;
    try {
      if (input.projectRoot) {
        projectRoot = input.projectRoot;
      } else {
        const allowedRoots = input.allowedRoots ?? this.allowedRoots;
        projectRoot = await ProjectRoot.create(cwd, allowedRoots);
      }
    } catch (err: any) {
      if (err instanceof PathError) {
        await append({
          type: "turn_failed",
          code: "MODEL_FAILED",
          message: `invalid project root: ${err.message}`,
          retryable: false,
        });
        return { status: "failed", message: err.message };
      }
      throw err;
    }

    await append({ type: "turn_started", limits, message: request.messages[0]?.content ?? "", root: projectRoot.getRoot(), realRoot: projectRoot.getRealRoot() } as any);
    const turnStartedAt = this.now();

    let usage: TurnUsage | undefined;

    try {
      for (let step = 0; step < limits.maxSteps; step++) {
        if (signal.aborted) {
          throw new DeadlineError("cancelled", "model", "Stop pressed");
        }
        await append({ type: "model_call", step: step + 1, maxSteps: limits.maxSteps });

        // Text is streamed to the log as it arrives; `streamed` tracks how much
        // of the model's text has already been appended so the post-call paths
        // below only emit what is still missing (nothing, in the normal case).
        let streamed = "";
        const emitRemaining = async (full: string) => {
          if (full.length > streamed.length && full.startsWith(streamed)) {
            await append({ type: "text_delta", delta: full.slice(streamed.length) });
          } else if (!full.startsWith(streamed) && full) {
            await append({ type: "text_delta", delta: full });
          }
          streamed = full;
        };
        let modelResult;
        try {
          modelResult = await runModelCall(this.provider, request, signal, limits.modelCallTimeoutMs, this.clock, 1000, async (delta) => {
            if (signal.aborted) return;
            await append({ type: "text_delta", delta });
            streamed += delta;
          });
        } catch (err: any) {
          const deadlineInfo = mapDeadlineError(err);
          // shutdown_timeout must be checked before cancelled/signal.aborted — it indicates abort-ignoring operation
          if (deadlineInfo?.kind === "shutdown_timeout") {
            if (this.metrics) {
              try {
                this.metrics.recordShutdownTimeout("model", {
                  turnId,
                  sessionId,
                  detail: err.message,
                });
              } catch {}
            }
            await append({
              type: "turn_failed",
              code: "MODEL_FAILED",
              message: `model shutdown timeout: ${err.message} — abort requested, operation not confirmed stopped`,
              retryable: false,
            });
            if (this.metrics) { try { this.metrics.observeDuration("turnCompletion", this.now() - turnStartedAt); } catch {} }
            return { status: "failed", message: err.message, usage };
          }

          if (deadlineInfo?.kind === "cancelled" || signal.aborted) {
            await append({ type: "turn_cancelled", reason: err.message ?? "cancelled" });
            if (this.metrics) { try { this.metrics.observeDuration("turnCompletion", this.now() - turnStartedAt); } catch {} }
            return { status: "cancelled", message: err.message };
          }

          await emitRemaining(err.partialText ?? "");

          if (deadlineInfo?.kind === "deadline_expired") {
            await append({
              type: "turn_failed",
              code: "MODEL_TIMEOUT",
              message: err.message ?? "model call timed out",
              retryable: true,
            });
            if (this.metrics) { try { this.metrics.observeDuration("turnCompletion", this.now() - turnStartedAt); } catch {} }
            return { status: "failed", message: err.message, usage: addUsage(usage, err.partialUsage) };
          }

          const providerError = err instanceof ProviderError ? err : err?.cause instanceof ProviderError ? err.cause : undefined;
          await append({
            type: "turn_failed",
            code: providerError?.code ?? "MODEL_FAILED",
            message: err.message ?? "model call failed",
            retryable: providerError?.retryable ?? false,
          });
          if (this.metrics) { try { this.metrics.observeDuration("turnCompletion", this.now() - turnStartedAt); } catch {} }
          return { status: "failed", message: err.message, usage: addUsage(usage, err.partialUsage) };
        }

        // Usage is summed across the steps of a turn so multi-step turns report
        // total spend, not the last call's.
        usage = addUsage(usage, modelResult.usage);

        if (modelResult.toolCalls.length === 0) {
          await emitRemaining(modelResult.text);
          await append({ type: "turn_completed", usage });
          if (this.metrics) {
            try {
              this.metrics.observeDuration("turnCompletion", this.now() - turnStartedAt);
            } catch {}
          }
          return { status: "completed", usage };
        }

        const nextMessages = [...request.messages];
        await emitRemaining(modelResult.text);
        // The assistant turn carries its tool calls so wire formats that require
        // the calls to be echoed back (OpenAI) can rebuild the transcript.
        nextMessages.push({ role: "assistant", content: modelResult.text, toolCalls: modelResult.toolCalls });

        for (const toolCall of modelResult.toolCalls) {
          if (signal.aborted) {
            throw new DeadlineError("cancelled", "tool", "Stop pressed");
          }

          await append({ type: "tool_call", callId: toolCall.id, toolName: toolCall.name, input: toolCall.input });

          const tool = this.tools.get(toolCall.name);

          // Malformed arguments (unparsable JSON from the model) are a
          // controlled tool failure the model can correct, never a crash.
          if (tool && toolCall.inputError !== undefined) {
            const result = {
              ok: false as const,
              code: "TOOL_FAILED" as const,
              message: `malformed tool input for ${toolCall.name}: ${toolCall.inputError}`,
              retryable: true,
              details: { rawInput: (toolCall.rawInput ?? "").slice(0, 2000) },
            };
            await append({ type: "tool_completed", callId: toolCall.id, toolName: toolCall.name, result });
            nextMessages.push({ role: "tool", content: `${result.code}: ${result.message}`, toolCallId: toolCall.id, toolName: toolCall.name });
            continue;
          }

          if (!tool) {
            const result = {
              ok: false as const,
              code: "UNKNOWN_TOOL" as const,
              message: `unknown tool: ${toolCall.name}`,
              retryable: true,
            };
            await append({ type: "tool_completed", callId: toolCall.id, toolName: toolCall.name, result });
            nextMessages.push({
              role: "tool",
              content: `${result.code}: ${result.message}`,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
            });
            continue;
          }

          // Project trust gate — evaluated before approval so a user is never
          // asked to approve a call the project is not trusted to make.
          const trustRequirement = tool.trust ? tool.trust(toolCall.input) : undefined;
          if (trustRequirement) {
            const realRoot = projectRoot.getRealRoot();
            const check = this.trust ? this.trust.check(realRoot, trustRequirement.configHash) : { trusted: false as const };
            if (!check.trusted) {
              const stale = "staleGrant" in check && check.staleGrant;
              const result = {
                ok: false as const,
                code: "PROJECT_NOT_TRUSTED" as const,
                message: stale
                  ? `project ${realRoot} was trusted for a different ${trustRequirement.source} configuration (${stale.configHash}); ` +
                    `it changed to ${trustRequirement.configHash} and must be trusted again`
                  : `project ${realRoot} is not trusted to run ${trustRequirement.source} (${trustRequirement.configHash}); ` +
                    `grant trust via POST /api/sessions/${sessionId}/trust`,
                retryable: false,
                details: {
                  realRoot,
                  configHash: trustRequirement.configHash,
                  source: trustRequirement.source,
                  ...(stale ? { staleConfigHash: stale.configHash } : {}),
                },
              };
              await append({ type: "tool_completed", callId: toolCall.id, toolName: toolCall.name, result });
              nextMessages.push({
                role: "tool",
                content: `${result.code}: ${result.message}`,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              });
              continue;
            }
          }

          if (tool.requiresApproval(toolCall.input)) {
            const approvalRequest = this.approvals.request({
              sessionId,
              turnId,
              providerCallId: toolCall.id,
              toolName: toolCall.name,
              input: toolCall.input,
              reason: (tool as any).reason ? (tool as any).reason(toolCall.input) : `approval required for ${toolCall.name}`,
              timeoutMs: limits.approvalTimeoutMs,
              parentSignal: signal,
            });

            await append({ type: "turn_waiting_for_approval", request: approvalRequest });

            let resolution: ApprovalResolution;
            try {
              const abortHandler = () => {
                this.approvals.cancelTurn(turnId);
              };
              if (signal.aborted) {
                abortHandler();
              } else {
                signal.addEventListener("abort", abortHandler, { once: true });
              }

              try {
                resolution = await this.approvals.wait(approvalRequest.requestId);
              } finally {
                signal.removeEventListener("abort", abortHandler);
              }
            } catch (err: any) {
              await append({
                type: "turn_failed",
                code: "MODEL_FAILED",
                message: `approval wait failed: ${err.message}`,
                retryable: false,
              });
              return { status: "failed", message: err.message, usage };
            }

            const approvalResolvedAt = this.now();
            await append({
              type: "approval_resolved",
              requestId: approvalRequest.requestId,
              decision: resolution.kind === "approved" ? "approve" : resolution.kind === "denied" ? "deny" : resolution.kind,
              resolvedAt: approvalResolvedAt,
              resolution,
            });
            if (this.metrics) {
              try {
                const waitMs = approvalResolvedAt - (approvalRequest.createdAt ?? approvalResolvedAt);
                this.metrics.observeDuration("approvalWait", waitMs);
              } catch {}
            }

            if (resolution.kind === "denied") {
              const result = {
                ok: false as const,
                code: "APPROVAL_DENIED" as const,
                message: `approval denied for ${toolCall.name}${resolution.reason ? `: ${resolution.reason}` : ""}`,
                retryable: true,
              };
              await append({ type: "tool_completed", callId: toolCall.id, toolName: toolCall.name, result });
              nextMessages.push({
                role: "tool",
                content: `${result.code}: ${result.message}`,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              });
              continue;
            }

            if (resolution.kind === "expired") {
              await append({
                type: "turn_failed",
                code: "APPROVAL_TIMEOUT",
                message: `approval timed out: ${approvalRequest.requestId}`,
                retryable: false,
              });
              return { status: "failed", message: "approval timeout", usage };
            }

            if (resolution.kind === "cancelled") {
              await append({ type: "turn_cancelled", reason: "cancelled while waiting for approval" });
              return { status: "cancelled", message: "cancelled while waiting" };
            }
          }

          await append({ type: "tool_started", callId: toolCall.id, toolName: toolCall.name });

          let toolResult;
          try {
            toolResult = await executeTool(
              tool,
              toolCall.input,
              {
                projectRoot,
                signal,
                cwd: projectRoot.getRoot(),
                safePath: (requested: string) => projectRoot.resolve(requested),
              },
              limits.toolTimeoutMs,
              this.clock,
              5000,
              this.metrics
            );
          } catch (err: any) {
            const deadlineInfo = mapDeadlineError(err);
            if (deadlineInfo?.kind === "cancelled" || signal.aborted) {
              await append({ type: "turn_cancelled", reason: "tool cancelled" });
              return { status: "cancelled", message: "tool cancelled" };
            }
            throw err;
          }

          await append({ type: "tool_completed", callId: toolCall.id, toolName: toolCall.name, result: toolResult });

          const content = toolResult.ok ? toolResult.output : `${toolResult.code}: ${toolResult.message}`;
          nextMessages.push({
            role: "tool",
            content,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
        }

        request = {
          ...request,
          messages: nextMessages,
        };
      }

      await append({
        type: "turn_failed",
        code: "TURN_LIMIT",
        message: `max steps ${limits.maxSteps} exceeded`,
        retryable: false,
      });
      if (this.metrics) {
        try { this.metrics.observeDuration("turnCompletion", this.now() - turnStartedAt); } catch {}
      }
      return { status: "failed", message: "max steps exceeded", usage };
    } catch (err: any) {
      const deadlineInfo = mapDeadlineError(err);
      if (deadlineInfo?.kind === "cancelled" || signal.aborted) {
        try {
          await append({ type: "turn_cancelled", reason: err.message ?? "cancelled" });
        } catch {}
        return { status: "cancelled", message: err.message };
      }
      try {
        await append({
          type: "turn_failed",
          code: "MODEL_FAILED",
          message: err.message ?? "unexpected failure",
          retryable: false,
        });
      } catch {}
      return { status: "failed", message: err.message, usage };
    } finally {
      this.approvals.cancelTurn(turnId);
    }
  }
}

function addUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!b) return a;
  if (!a) return b;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return { inputTokens: sum(a.inputTokens, b.inputTokens), outputTokens: sum(a.outputTokens, b.outputTokens), totalTokens: sum(a.totalTokens, b.totalTokens) };
}
