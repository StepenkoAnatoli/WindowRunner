import type { Express, Request, Response } from "express";
import { loadSkills } from "../../agent/skills.js";
import { createBuiltinTools } from "../../agent/tools/builtin.js";
import type { SkillDiagnostic, SkillMeta } from "@windows-runner/shared";
import type { AppRuntime } from "../runtime.js";
import { requireSessionId } from "../validate.js";

/**
 * Skills route (ADR 003, phase 3): the index the UI renders.
 *
 *   GET /api/sessions/:sessionId/skills -> { sessionId, skills, diagnostics }
 *
 * `skills` carries name, description and path — never bodies. Bodies are loaded
 * on demand by the `read_skill` tool, which is what keeps a project with forty
 * skills from costing forty files of context on every turn.
 *
 * `diagnostics` is returned alongside the index rather than swallowed, because
 * a skill that silently fails to load is undebuggable: the settings view shows
 * these verbatim so "why is my skill not appearing" has an answer.
 *
 * No `StreamEvent` is involved — `read_skill` is an ordinary tool call, so
 * `tool_started`/`tool_completed` already carry it and the web reducer needs no
 * change. That was a deliberate decision in the ADR, not an omission.
 */

/**
 * The names a skill may not take. Resolved from the real tool registry rather
 * than a hardcoded list, so the index and `read_skill` cannot disagree about
 * what is reserved — a hardcoded copy here would drift the day a tool is added.
 */
const RESERVED_NAMES: readonly string[] = [...createBuiltinTools().keys()];

export function registerSkillRoutes(app: Express, rt: AppRuntime): void {
  const { sessionManager } = rt;

  app.get("/api/sessions/:sessionId/skills", async (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    }

    try {
      // loadSkills never throws for a bad skill — every failure mode is a
      // diagnostic — but a root that cannot be read at all is worth a 500
      // rather than a plausible-looking empty index.
      const { skills, diagnostics } = await loadSkills(session.projectRoot, { reservedNames: RESERVED_NAMES });
      const index: SkillMeta[] = skills.map(({ name, description, path }) => ({ name, description, path }));
      const reported: SkillDiagnostic[] = diagnostics.map(({ reason, file, message }) => ({ reason, file, message }));
      return res.json({ sessionId, skills: index, diagnostics: reported });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "failed to load skills", code: "SKILLS_LOAD_FAILED", sessionId });
    }
  });
}
