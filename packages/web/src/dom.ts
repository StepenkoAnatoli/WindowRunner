/**
 * The two DOM primitives both entry points (main.ts and the dashboard) build
 * their UI from. They used to be copy-pasted into each file; they live here so
 * a change to how a button or an element is built is made once.
 *
 * Deliberately tiny and dependency-free: this is not a component framework,
 * just `document.createElement` with attribute/child handling and the
 * `data-testid`/disabled conventions the E2E suite relies on.
 */

export type Child = Node | string | null | undefined;

/**
 * Create an element. `attrs` are set verbatim (so `data-*` and `role` work);
 * `disabled` is the one special case — any value other than the string "true"
 * is skipped, because `setAttribute("disabled", "false")` still disables.
 * Null/undefined children are dropped, which keeps conditional subtrees
 * (`cond ? el(...) : null`) readable.
 */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "disabled" && v !== "true") continue;
    node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * A button with the project's `btn <kind>` classes and a stable test id.
 * With no `onClick` it is a submit button (used inside forms, where the form's
 * own submit handler does the work); with one it is `type="button"`.
 */
export function button(testId: string, label: string, onClick: (() => void) | undefined, kind: "primary" | "secondary" | "danger" | "link", disabled = false): HTMLElement {
  const b = el("button", { type: onClick ? "button" : "submit", class: `btn ${kind}`, "data-testid": testId, ...(disabled ? { disabled: "true" } : {}) }, label);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
