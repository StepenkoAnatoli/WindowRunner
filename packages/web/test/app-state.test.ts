import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activeTurn, describeTurn, initialAppState, initialProviderUiState, pendingApprovals, reduceApp, previewApproval, type AppState } from "../src/app-state.js";
import { validateWorkspaceCatalog } from "../src/workspace-catalog.js";

function ev(seq: number, type: string, extra: Record<string, unknown> = {}): any {
  return { seq, at: seq * 10, sessionId: "s", turnId: "t1", type, ...extra };
}

function withTurn(): AppState {
  let s = reduceApp(initialAppState, { type: "auth_ok", securityMode: "token", persistenceMode: "memory" });
  s = reduceApp(s, { type: "session_created", sessionId: "s", root: "/p" });
  s = reduceApp(s, { type: "turn_submitted", turnId: "t1", message: "hello" });
  return s;
}

describe("app reducer", () => {
  it("auth_invalid resets everything except the error", () => {
    const s = reduceApp(withTurn(), { type: "auth_invalid", message: "nope" });
    assert.equal(s.auth, "invalid");
    assert.equal(s.authError, "nope");
    assert.equal(s.session, undefined);
    assert.deepEqual(s.turns, []);
  });

  it("folds stream events through the shared reducer, tracks tools, and clears the active turn at terminal", () => {
    let s = withTurn();
    assert.equal(activeTurn(s)?.turnId, "t1");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "hello", root: "/p" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "text_delta", { delta: "Hel" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "text_delta", { delta: "DUP" }) }); // duplicate seq ignored
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(3, "text_delta", { delta: "lo" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(4, "tool_call", { callId: "c1", toolName: "run_terminal", input: { cmd: "ls" } }) });
    const req = { requestId: "apr_1", providerCallId: "c1", turnId: "t1", sessionId: "s", toolName: "run_terminal", input: { cmd: "ls" }, reason: "needs approval", expiresAt: 999, createdAt: 40 };
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(5, "turn_waiting_for_approval", { request: req }) });
    assert.equal(s.turns[0].state.textAccumulated, "Hello");
    assert.equal(s.turns[0].state.status, "waiting_for_approval");
    assert.equal(pendingApprovals(s.turns[0])[0].requestId, "apr_1");
    assert.equal(describeTurn(s.turns[0]), "waiting for approval (1)");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(6, "approval_resolved", { requestId: "apr_1", decision: "approve", resolvedAt: 60 }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(7, "tool_started", { callId: "c1", toolName: "run_terminal" }) });
    assert.equal(s.turns[0].tools[0].status, "running");
    assert.match(describeTurn(s.turns[0]), /running run_terminal/);
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(8, "tool_completed", { callId: "c1", toolName: "run_terminal", result: { ok: true, output: "ok" } }) });
    assert.equal(s.turns[0].tools[0].status, "done");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(9, "turn_completed", { usage: { totalTokens: 12 } }) });
    assert.equal(s.turns[0].state.isTerminal, true);
    assert.equal(activeTurn(s), undefined);
    assert.equal(describeTurn(s.turns[0]), "completed · 12 tokens");
    // Post-terminal events are ignored.
    const after = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(10, "text_delta", { delta: "late" }) });
    assert.equal(after, s);
  });

  it("raises a trust prompt from a PROJECT_NOT_TRUSTED tool result and clears it when trust loads", () => {
    let s = withTurn();
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "m", root: "/p" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "tool_call", { callId: "c1", toolName: "mcp", input: {} }) });
    s = reduceApp(s, {
      type: "turn_event",
      turnId: "t1",
      event: ev(3, "tool_completed", { callId: "c1", toolName: "mcp", result: { ok: false, code: "PROJECT_NOT_TRUSTED", message: "x", retryable: false, details: { realRoot: "/real/p", configHash: "sha256:" + "a".repeat(64), source: ".mcp.json", staleConfigHash: "sha256:" + "b".repeat(64) } } }),
    });
    assert.equal(s.trustPrompt?.toolName, "mcp");
    assert.equal(s.trustPrompt?.realRoot, "/real/p");
    assert.equal(s.trustPrompt?.staleConfigHash, "sha256:" + "b".repeat(64));
    s = reduceApp(s, { type: "trust_loaded", grant: { configHash: "sha256:" + "a".repeat(64), source: ".mcp.json" } });
    assert.equal(s.trustPrompt, undefined);
    assert.equal(s.session?.trust?.source, ".mcp.json");
  });

  it("describes failures, cancellation, reconnects and stream errors", () => {
    let s = withTurn();
    s = reduceApp(s, { type: "turn_connection", turnId: "t1", connection: "reconnecting", attempt: 2 });
    assert.equal(describeTurn(s.turns[0]), "reconnecting (attempt 2)…");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "m", root: "/p" }) });
    assert.match(describeTurn(s.turns[0]), /running — reconnecting \(attempt 2\)/);
    s = reduceApp(s, { type: "turn_connection", turnId: "t1", connection: "streaming" });
    assert.equal(describeTurn(s.turns[0]), "running…");
    const failed = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "turn_failed", { code: "MODEL_TIMEOUT", message: "slow", retryable: true }) });
    assert.equal(describeTurn(failed.turns[0]), "failed: MODEL_TIMEOUT — slow (retryable)");
    const cancelled = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "turn_cancelled", { reason: "stop" }) });
    assert.equal(describeTurn(cancelled.turns[0]), "cancelled");
    const broken = reduceApp(s, { type: "turn_stream_error", turnId: "t1", message: "gave up" });
    assert.equal(describeTurn(broken.turns[0]), "stream error: gave up");
    assert.equal(broken.turns[0].connection, "closed");
  });
});

describe("previewApproval", () => {
  it("renders edit_file as a removed/added diff with the uniqueness note", () => {
    const p = previewApproval("edit_file", { path: "src/a.ts", oldText: "a\nb", newText: "c" });
    assert.equal(p.kind, "diff");
    if (p.kind !== "diff") return;
    assert.equal(p.path, "src/a.ts");
    assert.deepEqual(p.lines, [{ type: "-", text: "a" }, { type: "-", text: "b" }, { type: "+", text: "c" }]);
    assert.match(p.note!, /exactly one/);
    assert.match((previewApproval("edit_file", { path: "x", oldText: "a", newText: "b", replaceAll: true }) as any).note, /every occurrence/);
  });

  it("renders write_file as all-added lines with the byte count, clipped for long files", () => {
    const p = previewApproval("write_file", { path: "big.txt", content: Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n") });
    if (p.kind !== "diff") throw new Error("expected diff");
    assert.equal(p.lines.length, 61);
    assert.match(p.lines[60].text, /40 more line/);
    assert.match(p.note!, /bytes/);
  });

  it("renders run_terminal as a command and everything else as JSON", () => {
    assert.deepEqual(previewApproval("run_terminal", { command: "npm test" }).kind, "command");
    const j = previewApproval("mystery", { a: 1 });
    assert.equal(j.kind, "json");
    assert.match((j as any).text, /"a": 1/);
    assert.equal(previewApproval("edit_file", "not an object").kind, "json");
  });
});

describe("workspace navigation (B1)", () => {
  const catalog = validateWorkspaceCatalog({
    version: 1,
    projects: [
      { id: "p1", root: "/one", label: "one", lastOpenedAt: 1 },
      { id: "p2", root: "/two", label: "two", lastOpenedAt: 2 },
    ],
    sessions: [
      { sessionId: "s1", projectId: "p1", lastOpenedAt: 3 },
      { sessionId: "s2", projectId: "p2", lastOpenedAt: 4 },
    ],
  });

  function withCatalog(): AppState {
    return reduceApp(initialAppState, { type: "workspace_catalog_loaded", catalog });
  }

  it("starts with an empty catalog, context tab, and open panels", () => {
    assert.deepEqual(initialAppState.workspace.catalog, { version: 1, projects: [], sessions: [] });
    assert.equal(initialAppState.workspace.inspectorTab, "context");
    assert.deepEqual(initialAppState.workspace.inspectorSelection, { kind: "none" });
    assert.equal(initialAppState.workspace.sidebarOpen, true);
    assert.equal(initialAppState.workspace.inspectorOpen, true);
  });

  it("preserves the selected project/session on catalog load only when references exist", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "project_selected", projectId: "p1", lastOpenedAt: 10 });
    s = reduceApp(s, { type: "session_selected", sessionId: "s1", lastOpenedAt: 11 });
    assert.equal(s.workspace.selectedProjectId, "p1");
    assert.equal(s.workspace.selectedSessionId, "s1");
    // Reload with the project gone: stale selection is dropped, never dangling.
    const pruned = validateWorkspaceCatalog({ version: 1, projects: [], sessions: [] });
    s = reduceApp(s, { type: "workspace_catalog_loaded", catalog: pruned });
    assert.equal(s.workspace.selectedProjectId, undefined);
    assert.equal(s.workspace.selectedSessionId, undefined);
  });

  it("loading a catalog never synthesizes transcript history", () => {
    const s = withCatalog();
    assert.deepEqual(s.turns, []);
    assert.equal(s.activeTurnId, undefined);
    assert.equal(s.session, undefined);
  });

  it("selecting a project clears the session display; reselecting keeps turns", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "project_selected", projectId: "p1", lastOpenedAt: 10 });
    s = reduceApp(s, { type: "session_created", sessionId: "s1", root: "/one" });
    s = reduceApp(s, { type: "turn_submitted", turnId: "t1", message: "hi" });
    assert.equal(s.turns.length, 1);
    s = reduceApp(s, { type: "project_selected", projectId: "p1", lastOpenedAt: 11 });
    assert.equal(s.turns.length, 1, "reselecting the same project must not wipe turns");
    s = reduceApp(s, { type: "project_selected", projectId: "p2", lastOpenedAt: 12 });
    assert.equal(s.session, undefined);
    assert.deepEqual(s.turns, []);
    assert.equal(s.workspace.selectedSessionId, undefined);
  });

  it("upserting the already-selected project only touches recency", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "project_selected", projectId: "p1", lastOpenedAt: 10 });
    s = reduceApp(s, { type: "session_created", sessionId: "s1", root: "/one" });
    s = reduceApp(s, { type: "turn_submitted", turnId: "t1", message: "hi" });
    s = reduceApp(s, { type: "project_upserted", project: { id: "p1", root: "/one", label: "one", lastOpenedAt: 99 } });
    assert.equal(s.turns.length, 1);
    assert.equal(s.workspace.catalog.projects[0].id, "p1");
    assert.equal(s.workspace.catalog.projects[0].lastOpenedAt, 99);
  });

  it("session selection never mutates turns and always belongs to the selected project", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "project_selected", projectId: "p1", lastOpenedAt: 10 });
    s = reduceApp(s, { type: "session_created", sessionId: "s1", root: "/one" });
    s = reduceApp(s, { type: "turn_submitted", turnId: "t1", message: "hi" });
    const before = s.turns;
    s = reduceApp(s, { type: "session_selected", sessionId: "s2", lastOpenedAt: 11 });
    assert.equal(s.turns, before, "session_selected must not touch turns; session_created clears them");
    assert.equal(s.workspace.selectedSessionId, "s2");
    assert.equal(s.workspace.selectedProjectId, "p2", "selecting across projects moves the project along");
    s = reduceApp(s, { type: "session_created", sessionId: "s2", root: "/two" });
    assert.deepEqual(s.turns, []);
  });

  it("session_created aligns the workspace selection; session_cleared drops it", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "session_created", sessionId: "s2", root: "/two" });
    assert.equal(s.workspace.selectedSessionId, "s2");
    assert.equal(s.workspace.selectedProjectId, "p2");
    s = reduceApp(s, { type: "session_cleared" });
    assert.equal(s.workspace.selectedSessionId, undefined);
    assert.equal(s.workspace.selectedProjectId, "p2");
  });

  it("a newly pending approval takes over the inspector on the approvals tab", () => {
    let s = withTurn();
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "hello", root: "/p" }) });
    assert.deepEqual(s.workspace.inspectorSelection, { kind: "turn", turnId: "t1" });
    const req = { requestId: "apr_1", providerCallId: "c1", turnId: "t1", sessionId: "s", toolName: "run_terminal", input: { cmd: "ls" }, reason: "needs approval", expiresAt: 999, createdAt: 40 };
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "turn_waiting_for_approval", { request: req }) });
    assert.equal(s.workspace.inspectorTab, "approvals");
    assert.deepEqual(s.workspace.inspectorSelection, { kind: "approval", turnId: "t1", requestId: "apr_1" });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(3, "approval_resolved", { requestId: "apr_1", decision: "approve", resolvedAt: 60 }) });
    assert.deepEqual(s.workspace.inspectorSelection, { kind: "turn", turnId: "t1" });
  });

  it("a manual selection of another turn is not stolen by streamed events", () => {
    let s = withTurn();
    s = reduceApp(s, { type: "turn_submitted", turnId: "t2", message: "second" });
    s = reduceApp(s, { type: "inspector_selection_changed", selection: { kind: "turn", turnId: "t2" } });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "hello", root: "/p" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "text_delta", { delta: "hi" }) });
    assert.deepEqual(s.workspace.inspectorSelection, { kind: "turn", turnId: "t2" });
  });

  it("a selected terminal turn stays selected when another turn terminates", () => {
    let s = withTurn();
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "hello", root: "/p" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "turn_completed", { usage: { totalTokens: 1 } }) });
    assert.deepEqual(s.workspace.inspectorSelection, { kind: "turn", turnId: "t1" });
    s = reduceApp(s, { type: "turn_submitted", turnId: "t2", message: "second" });
    s = reduceApp(s, { type: "turn_event", turnId: "t2", event: ev(1, "turn_started", { limits: {}, message: "second", root: "/p" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t2", event: ev(2, "turn_cancelled", { reason: "stop" }) });
    assert.deepEqual(s.workspace.inspectorSelection, { kind: "turn", turnId: "t1" });
    // Late events for the terminal turn change nothing at all.
    const after = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(3, "text_delta", { delta: "late" }) });
    assert.equal(after, s);
  });

  it("sign-out keeps the catalog but resets the selection; toggles flip panels", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "project_selected", projectId: "p1", lastOpenedAt: 10 });
    s = reduceApp(s, { type: "auth_cleared" });
    assert.equal(s.workspace.catalog.projects.length, 2);
    assert.equal(s.workspace.selectedProjectId, undefined);
    assert.equal(s.workspace.sidebarOpen, true);
    s = reduceApp(s, { type: "sidebar_toggled" });
    assert.equal(s.workspace.sidebarOpen, false);
    s = reduceApp(s, { type: "inspector_toggled" });
    assert.equal(s.workspace.inspectorOpen, false);
    s = reduceApp(s, { type: "inspector_tab_selected", tab: "changes" });
    assert.equal(s.workspace.inspectorTab, "changes");
  });

  // ---- B2 route host + provider/usage slices ----

  it("route_changed moves only the route: catalog, session, turns, providers, usage untouched", () => {
    let s = withTurn();
    s = reduceApp(s, {
      type: "providers_state",
      providers: { status: "ready", activeProfileId: "p1", profiles: [{ id: "p1", label: "L", kind: "mock", model: "m", createdAt: 1, updatedAt: 2, active: true }], form: undefined },
    });
    s = reduceApp(s, { type: "usage_state", usage: { status: "ready", records: [] } });
    s = reduceApp(s, { type: "route_changed", route: { kind: "providers" } });
    assert.equal(s.route.kind, "providers");
    assert.equal(s.turns.length, 1, "turns survive a route change");
    assert.ok(s.session, "session survives a route change");
    assert.equal(s.providers.status, "ready", "provider cache survives a route change");
    assert.ok(s.providers.form === undefined || typeof s.providers.form === "object");
    assert.equal(s.usage.status, "ready");
  });

  it("the provider form survives route changes (in-memory preservation), sign-out clears it", () => {
    let s = reduceApp(initialAppState, { type: "auth_ok", securityMode: "token", persistenceMode: "memory" });
    const formState = {
      mode: "create" as const,
      profileId: "x",
      label: "X",
      kind: "mock",
      baseUrl: "",
      model: "m",
      apiKey: "",
      apiKeyMode: "empty" as const,
      modelDiscovery: { status: "idle" } as const,
      validationErrors: {},
      submitting: false,
    };
    s = reduceApp(s, { type: "providers_state", providers: { ...initialProviderUiState, form: formState } });
    s = reduceApp(s, { type: "route_changed", route: { kind: "usage" } });
    assert.equal(s.providers.form?.label, "X", "navigating away preserves the open form");
    s = reduceApp(s, { type: "auth_cleared" });
    assert.equal(s.providers.form, undefined, "sign-out drops the transient form");
    assert.equal(s.providers.status, "idle", "sign-out drops cached provider data");
    assert.equal(s.usage.status, "idle", "sign-out drops usage data");
    assert.equal(s.health, undefined);
  });

  it("auth_invalid clears provider/usage state but keeps the workspace catalog", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "providers_state", providers: { status: "ready", activeProfileId: "p", profiles: [], form: undefined } });
    s = reduceApp(s, { type: "usage_state", usage: { status: "ready", records: [], bounded: true, retained: 3 } });
    s = reduceApp(s, { type: "route_changed", route: { kind: "providers" } });
    s = reduceApp(s, { type: "auth_invalid", message: "nope" });
    assert.equal(s.providers.status, "idle");
    assert.equal(s.usage.status, "idle");
    assert.equal(s.auth, "invalid");
    assert.equal(s.authError, "nope");
    assert.equal(s.route.kind, "providers", "the route itself is preserved");
    assert.equal(s.workspace.catalog.projects.length, 2, "B1 navigation metadata survives");
  });

  it("workspace_catalog_reset clears only the local catalog and its selections", () => {
    let s = withCatalog();
    s = reduceApp(s, { type: "project_selected", projectId: "p1", lastOpenedAt: 10 });
    s = reduceApp(s, { type: "workspace_catalog_reset" });
    assert.deepEqual(s.workspace.catalog, { version: 1, projects: [], sessions: [] });
    assert.equal(s.workspace.selectedProjectId, undefined);
    assert.equal(s.workspace.selectedSessionId, undefined);
    assert.equal(s.providers.status, "idle", "providers (server state) untouched by the catalog reset");
    assert.ok(s.session === undefined);
  });
});
