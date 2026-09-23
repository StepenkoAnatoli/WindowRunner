import type { SkillDiagnostic, SkillMeta } from "@windows-runner/shared";
import { el } from "./dom.js";

/**
 * The `/`-command palette for project skills (ADR 003, phase 6).
 *
 * Pure: it renders from the props it is given and calls back through
 * `onPick`. It never constructs an ApiClient, never calls fetch, and never
 * touches the app reducer — the same rule `workspace.ts` is held to.
 *
 * The palette manages its own DOM node rather than being re-rendered by
 * `renderConversationWorkspace`. That is deliberate: the workspace re-renders
 * on every state change, and filtering on each keystroke would rebuild the
 * textarea and drop focus mid-typing. So the palette is attached once, next to
 * the form, and mutates only itself.
 *
 * Selecting a skill does NOT inject skill content into the turn. It puts the
 * skill's name in the composer and submits, and the model calls `read_skill`
 * itself. That is what keeps manual and automatic activation on one mechanism
 * instead of two code paths.
 */

/** Skills whose name or description matches the typed query. Empty query = all. */
export function filterSkills(skills: SkillMeta[], query: string): SkillMeta[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...skills];
  return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}

/** The text a picked skill puts in the composer before submitting. */
export function skillInvocation(name: string): string {
  return `/${name}`;
}

export interface SkillsPaletteOptions {
  getSkills(): SkillMeta[];
  /** Called with the composer already holding `/<name>`; the caller submits. */
  onPick(name: string): void;
}

export interface SkillsPalette {
  /** Re-evaluate from the current composer text. Safe to call on every input. */
  sync(): void;
  /** Whether the palette is currently shown. Exposed for tests. */
  readonly open: boolean;
  close(): void;
}

/**
 * Attach the palette to a composer form. Listens on the form's message input
 * for `/` at the start of the text, and owns the list element it inserts after
 * the form.
 */
export function attachSkillsPalette(form: HTMLElement, options: SkillsPaletteOptions): SkillsPalette {
  const input = form.querySelector<HTMLTextAreaElement | HTMLInputElement>('[data-testid="message-input"]');
  const list = el("ul", {
    class: "skills-palette",
    role: "listbox",
    "aria-label": "Project skills",
    "data-testid": "skills-palette",
    hidden: "true",
  });
  // Sibling of the form, not a child: the workspace rebuilds the form on state
  // changes and the palette must survive that.
  form.parentElement?.append(list);

  let open = false;
  let active = 0;
  let matches: SkillMeta[] = [];

  const close = (): void => {
    open = false;
    active = 0;
    matches = [];
    list.replaceChildren();
    list.setAttribute("hidden", "true");
  };

  const render = (): void => {
    list.replaceChildren();
    if (!open || matches.length === 0) {
      list.setAttribute("hidden", "true");
      return;
    }
    list.removeAttribute("hidden");
    matches.forEach((skill, i) => {
      const item = el(
        "li",
        {
          class: i === active ? "active" : "",
          role: "option",
          "aria-selected": i === active ? "true" : "false",
          "data-testid": "skills-palette-option",
          "data-skill": skill.name,
        },
        el("strong", { class: "skill-name" }, `/${skill.name}`),
        el("span", { class: "muted" }, ` ${skill.description}`)
      );
      item.addEventListener("click", () => pick(skill.name));
      list.append(item);
    });
  };

  const pick = (name: string): void => {
    if (input) input.value = skillInvocation(name);
    close();
    options.onPick(name);
  };

  const sync = (): void => {
    const value = input?.value ?? "";
    // `/` only opens the palette at the very start, so a slash inside an
    // ordinary sentence ("and/or") does not hijack typing.
    if (!value.startsWith("/")) {
      if (open) close();
      return;
    }
    const query = value.slice(1);
    if (query.includes(" ") || query.includes("\n")) {
      // The user has moved on to prose; stop filtering.
      if (open) close();
      return;
    }
    matches = filterSkills(options.getSkills(), query);
    open = true;
    active = 0;
    render();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (!open) return;
    if (event.key === "Escape") {
      // Escape closes the palette without clearing the composer, and must not
      // be swallowed once the palette is gone.
      event.preventDefault();
      close();
      return;
    }
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = (active + 1) % matches.length;
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = (active - 1 + matches.length) % matches.length;
      render();
    } else if (event.key === "Enter") {
      // The palette takes Enter only while it is open; otherwise the form's
      // own submit behaviour is untouched.
      event.preventDefault();
      const chosen = matches[active];
      if (chosen) pick(chosen.name);
    }
  };

  if (input) {
    input.addEventListener("input", sync);
    input.addEventListener("keydown", onKeydown as EventListener);
  }

  return {
    sync,
    close,
    get open() {
      return open;
    },
  };
}

/**
 * Read-only list of skills the project ships, plus why any were excluded.
 *
 * Diagnostics are shown verbatim rather than summarised: a skill that silently
 * fails to load is undebuggable, and the server already produced a
 * human-readable reason.
 */
export function renderSkillsPanel(skills: SkillMeta[], diagnostics: SkillDiagnostic[]): HTMLElement {
  if (skills.length === 0 && diagnostics.length === 0) {
    return el(
      "p",
      { class: "hint", "data-testid": "skills-none" },
      "This project ships no skills. Add one at .windowrunner/skills/<name>/SKILL.md."
    );
  }
  return el(
    "section",
    { class: "skills-panel", "data-testid": "skills-panel" },
    el("h3", {}, `Project skills (${skills.length})`),
    skills.length === 0
      ? null
      : el(
          "ul",
          { class: "skills-list", "data-testid": "skills-list" },
          ...skills.map((s) =>
            el(
              "li",
              { "data-testid": "skills-list-item", "data-skill": s.name },
              el("code", {}, `/${s.name}`),
              el("span", { class: "muted" }, ` ${s.description}`),
              el("span", { class: "hint" }, ` ${s.path}`)
            )
          )
        ),
    diagnostics.length === 0
      ? null
      : el(
          "div",
          { class: "card warn", role: "status", "data-testid": "skills-diagnostics" },
          el("strong", {}, `${diagnostics.length} skill${diagnostics.length === 1 ? "" : "s"} not loaded`),
          el(
            "ul",
            {},
            ...diagnostics.map((d) =>
              el(
                "li",
                { "data-testid": "skills-diagnostic", "data-reason": d.reason },
                el("code", {}, d.file),
                ` — ${d.reason}: ${d.message}`
              )
            )
          )
        )
  );
}
