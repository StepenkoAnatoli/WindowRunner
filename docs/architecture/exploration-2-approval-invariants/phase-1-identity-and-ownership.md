# Phase 1 — Approval identity and ownership

**Focus:** Contracts 1 and 2 from your list:
1. Approval identity is minted once and is unique per session/turn/provider call.
2. `sessionId` and `turnId` are carried on every approval request.

**Status:** Draft for review — stops and waits for your go before Phase 2.

---

## 1. Current design (after #3+#6 implementation)

**Files:** `packages/server/src/agent/approval-registry.ts`, `packages/shared/src/index.ts` (ApprovalRequest), `packages/server/src/agent/loop.ts`

**What exists after #3+#6:**

```ts
// shared
interface ApprovalRequest {
  requestId: ApprovalId; // currently = provider's toolCall.id
  turnId: TurnId;
  sessionId: SessionId; // added in #3+#6 loop
  toolName: string;
  input: unknown;
  reason: string;
  expiresAt: number; // computed in loop as now + approvalTimeoutMs
}

// registry
class ApprovalRegistry {
  private entries = Map<ApprovalId, Entry>; // global across all sessions/turns
  register(request, timeoutMs) // timeoutMs = limits.approvalTimeoutMs, same as expiresAt - now
  wait(requestId) // no signal, fix for C2
  resolve(requestId, decision) => boolean // false if stale
  cancelTurn(turnId)
  snapshot(turnId) => ApprovalRequest[]
}
```

**Loop usage:**

```ts
const approvalRequest = {
  requestId: toolCall.id, // provider's call id, e.g., "c1", "call_0"
  turnId, sessionId, toolName, input, reason, expiresAt: now + limits.approvalTimeoutMs
};
approvals.register(approvalRequest, limits.approvalTimeoutMs);
append({ type: "turn_waiting_for_approval", request: approvalRequest });
decision = await approvals.wait(requestId);
append({ type: "approval_resolved", requestId, decision });
```

**Problems:**

- **Identity collision:** `requestId = toolCall.id` is provider-controlled. OpenAI-compatible servers often emit `call_0`, `call_1` per turn. FakeProvider always emits `c1`. Two concurrent turns whose providers reuse same id → `register` throws "already exists" → turn fails. Global Map keyed by provider id, not namespaced by turn/session.
- **Minting not owned:** Who mints approval id? Loop uses provider's id, registry just stores. No single owner.
- **Two expiry sources:** `request.expiresAt` (for UI) and `timeoutMs` (for timer) are passed separately but derived from same limit. If they drift (e.g., clock skew, different now), UI shows different expiry than actual timeout. Single source should be registry computing expiresAt from timeoutMs + now.
- **Session ownership validation:** `ApprovalRequest` now carries `sessionId`, but `approve` endpoint does not validate sessionId — it just calls `resolve(requestId)`. Routes should validate session ownership, but registry has no sessionId index? It does have request.sessionId, so it could validate, but currently doesn't.

---

## 2. Proposed identity model

### 2.1 Minted approval id, provider call id as separate field

**Decision:** Approval id is minted by ApprovalRegistry, not by provider. Provider's call id is stored as `providerCallId` field for correlation, but not used as key.

```ts
interface ApprovalRequest {
  requestId: ApprovalId; // minted, e.g., "apr_2f9e1b..."
  providerCallId: string; // original toolCall.id, e.g., "c1" or "call_0"
  turnId: TurnId;
  sessionId: SessionId;
  toolName: string;
  input: unknown;
  reason: string;
  expiresAt: number; // computed by registry, single source
  createdAt: number;
}
```

**Minting:**

```ts
class ApprovalRegistry {
  private counter = 0;
  private newId(): ApprovalId {
    // deterministic for tests, or random for prod
    return `apr_${Date.now()}_${++this.counter}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // New API: request() mints id and computes expiry
  request(input: {
    sessionId: SessionId;
    turnId: TurnId;
    providerCallId: string;
    toolName: string;
    input: unknown;
    reason: string;
    timeoutMs: number;
  }): ApprovalRequest {
    const now = this.now();
    const requestId = this.newId();
    const request: ApprovalRequest = {
      requestId,
      providerCallId: input.providerCallId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolName: input.toolName,
      input: input.input,
      reason: input.reason,
      expiresAt: now + input.timeoutMs,
      createdAt: now,
    };
    this.registerInternal(request, input.timeoutMs);
    return request;
  }

  private registerInternal(request: ApprovalRequest, timeoutMs: number) { /* ... */ }
}
```

**Benefits:**
- Unique per session/turn/provider call, even if provider reuses call_0
- No collision across concurrent turns
- Provider call id still available for debugging and for tool result correlation
- Single expiry source: registry computes expiresAt from now + timeoutMs

### 2.2 Session and turn carried everywhere

- `ApprovalRequest` already carries `sessionId` and `turnId` after #3+#6 — keep
- `approval_resolved` event should also carry `sessionId` and `turnId` for replay? Currently it has `requestId`, `decision`, `resolvedAt`. For replay reconstruction without registry, we need to know which turn it belongs to. But since event has base envelope with sessionId/turnId/seq, it's already there via base. Good.
- `approve` endpoint should validate session ownership: `POST /api/sessions/:sessionId/approve` body `{ requestId, decision }` → registry checks `request.sessionId === sessionId` and `request.turnId` exists, else 404 or 403. Currently it doesn't validate sessionId — fix.

### 2.3 Namespacing

Instead of global Map<requestId>, we could have Map<turnId, Map<requestId>> for faster cancelTurn and snapshot. But global Map with filter on turnId is okay for small numbers. For correctness, minted id is globally unique, so global Map is fine. For performance, we can keep secondary index.

Proposed internal structure:

```ts
class ApprovalRegistry {
  private entries = new Map<ApprovalId, Entry>; // global unique
  private byTurn = new Map<TurnId, Set<ApprovalId>>; // index for cancelTurn and snapshot
}
```

---

## 3. Design-it-twice

### Option A — Registry mints id, single expiry source (recommended)

- Registry has `request()` that mints id, computes expiresAt, registers, returns request
- Loop calls `const req = approvals.request({ sessionId, turnId, providerCallId, toolName, input, reason, timeoutMs })`, then `append({ type: "turn_waiting_for_approval", request: req })`
- Provider call id kept as `providerCallId` field, not key
- Expiry computed once inside registry

Pros: Single owner of identity and expiry, no collision, single source, testable
Cons: Loop no longer controls requestId, but that's good — registry owns invariants

### Option B — Loop mints id, registry just stores (current, but with namespaced key)

- Loop generates `requestId = `${turnId}:${toolCall.id}`` to namespace
- Registry still takes timeoutMs and expiresAt separately

Pros: Simple, no change to registry API
Cons: Identity still not owned by registry, expiry still two sources, loop must remember to namespace, easy to forget

**Recommendation:** Option A — registry owns identity and expiry. This concentrates the two hardest invariants (uniqueness and single expiry) in one module.

---

## 4. Benefits and risks

**Benefits:**
- Locality: "what is the identity of an approval and when does it expire?" has one answer
- Leverage: concurrent turns with same provider call id now work, no collision
- Tests: can test minting uniqueness, expiry computation, session ownership validation

**Risks:**
- Change to ApprovalRequest shape adds `providerCallId` and `createdAt` — need to update shared type and all consumers, but cheap now before many consumers
- Minted id is random, not deterministic — for tests, need deterministic fake clock and counter, or allow injecting id generator

---

## 5. Next steps

**Phase 2:** Settlement paths — exactly one wins: decision, expiry, cancelTurn; single expiry source; idempotency for repeated/stale decisions and cancellation races.

Please confirm go for Phase 2, or request changes to Phase 1.

