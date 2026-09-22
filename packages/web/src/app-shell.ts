import { el } from "./dom.js";

/**
 * Fixed page geometry for the B1 three-column workspace (B1).
 *
 * The shell owns responsive layout and panel visibility only. It never owns
 * authentication effects, session creation, streaming, approval decisions,
 * or provider API calls — those stay in the main.ts coordinator.
 */
export interface AppShellProps {
  header: HTMLElement;
  sidebar: HTMLElement;
  workspace: HTMLElement;
  inspector: HTMLElement;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  /** In-flow notice (never a sticky overlay, never a focus trap). */
  notice?: HTMLElement | null;
}

export function renderAppShell(props: AppShellProps): HTMLElement {
  // The regions arrive with their own `data-testid`s from their render
  // modules; the shell only positions them and marks collapsed panels so
  // CSS can hide them without unmounting (input focus + scroll survive).
  const shell = el(
    "div",
    {
      class: [
        "workspace-shell",
        props.sidebarOpen ? "sidebar-open" : "sidebar-collapsed",
        props.inspectorOpen ? "inspector-open" : "inspector-collapsed",
      ].join(" "),
      "data-testid": "workspace-shell",
    },
    props.sidebar,
    props.workspace,
    props.inspector
  );
  return el("div", { class: "app-root" }, props.header, props.notice ?? null, shell);
}
