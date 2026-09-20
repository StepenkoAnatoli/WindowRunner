/**
 * describeError (src/describe-error.ts) — the single implementation both entry
 * points use to turn a failure into a sentence. The defaults must reproduce
 * the main UI's original wording exactly (the E2E suite asserts on one of
 * those strings), and the opt-ins must add the dashboard's detail without
 * changing the defaults.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiRequestError } from "../src/api.js";
import { describeError } from "../src/describe-error.js";

const err = (status: number, code: string, message: string, details?: unknown) => new ApiRequestError(status, code, message, details);

describe("describeError", () => {
  it("keeps the main UI's 401 wording by default", () => {
    assert.equal(describeError(err(401, "AUTH_REQUIRED", "token required")), "token required (401)");
    assert.equal(describeError(err(401, "AUTH_INVALID", "token rejected")), "token rejected (401 AUTH_INVALID)");
  });

  it("lets a caller supply its own 401 wording", () => {
    const dash = { auth: "the server rejected the token" };
    assert.equal(describeError(err(401, "AUTH_REQUIRED", "token required"), dash), "the server rejected the token");
  });

  it("explains a folder outside the allowed roots", () => {
    const out = describeError(err(403, "PATH_ESCAPES_ROOT", "/etc is not inside an allowed root"));
    assert.equal(out, "folder is outside the allowed roots (403 PATH_ESCAPES_ROOT): /etc is not inside an allowed root");
  });

  it("omits the per-field error list unless asked for it", () => {
    const e = err(400, "PROFILE_INVALID", "profile is invalid", { errors: ["baseUrl required for openai-compatible"] });
    assert.equal(describeError(e), "profile is invalid (400 PROFILE_INVALID)");
    assert.equal(
      describeError(e, { fieldErrors: true }),
      "profile is invalid: baseUrl required for openai-compatible"
    );
  });

  it("finds a per-field list nested under details, and ignores a non-array one", () => {
    assert.equal(
      describeError(err(400, "PROFILE_INVALID", "profile is invalid", { details: { errors: ["a", "b"] } }), { fieldErrors: true }),
      "profile is invalid: a; b"
    );
    assert.equal(
      describeError(err(400, "PROFILE_INVALID", "profile is invalid", { errors: "not a list" }), { fieldErrors: true }),
      "profile is invalid (400 PROFILE_INVALID)"
    );
  });

  it("names a transport failure as unreachable rather than a server error", () => {
    assert.equal(describeError(new TypeError("Failed to fetch")), "cannot reach the server: Failed to fetch");
  });

  it("falls back to the message, then to String()", () => {
    assert.equal(describeError(new Error("boom")), "boom");
    assert.equal(describeError("boom"), "boom");
  });
});
