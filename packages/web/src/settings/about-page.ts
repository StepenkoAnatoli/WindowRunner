/**
 * Settings → About (B2): versions and mode, links, and diagnostics that are
 * safe to show — never a token, never a provider key.
 *
 * The app version is injected at bundle time (`__APP_VERSION__` define in
 * scripts/bundle.mjs); outside the bundle (unit tests, plain tsx) it falls
 * back to a stable "development" string.
 */
import type { HealthSummary } from "../api.js";
import { el } from "../dom.js";

export interface AboutPageProps {
  health?: HealthSummary;
  server?: { securityMode: string; persistenceMode: string };
  /** True inside the desktop shell. */
  desktopAvailable: boolean;
}

/** Bundle-time version; see scripts/bundle.mjs (`__APP_VERSION__` define). */
declare const __APP_VERSION__: string | undefined;

export function appVersion(): string {
  // `typeof` on an undeclared identifier is safe: outside the esbuild bundle
  // (unit tests, plain tsx) this evaluates to "undefined" and falls back.
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "development";
}

function runtimeDescription(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent) return navigator.userAgent;
  return "unknown runtime";
}

export function renderAboutPage(props: AboutPageProps): HTMLElement {
  const persistenceMode = props.health?.persistence?.mode ?? props.server?.persistenceMode ?? "unknown";
  const securityMode = props.health?.security?.mode ?? props.server?.securityMode ?? "unknown";
  return el(
    "div",
    { class: "settings-section", "data-testid": "about-page" },
    el("h3", {}, "About"),
    el(
      "dl",
      { class: "context-list" },
      el("dt", {}, "App version"),
      el("dd", { "data-testid": "about-version" }, appVersion()),
      el("dt", {}, "Mode"),
      el("dd", { "data-testid": "about-mode" }, props.desktopAvailable ? "Desktop (Electron shell, in-memory token)" : "Browser tab (tab-scoped token)"),
      el("dt", {}, "Server persistence"),
      el("dd", { "data-testid": "about-persistence" }, persistenceMode),
      el("dt", {}, "Server security"),
      el("dd", {}, securityMode),
      el("dt", {}, "Runtime"),
      el("dd", { "data-testid": "about-runtime" }, el("code", {}, runtimeDescription()))
    ),
    el("h3", {}, "Links"),
    el(
      "ul",
      { class: "about-links" },
      el("li", {}, el("a", { href: "https://github.com/StepenkoAnatoli/WindowRunner", "data-testid": "about-link-repository", target: "_blank", rel: "noreferrer noopener" }, "Repository")),
      el("li", {}, el("a", { href: "https://github.com/StepenkoAnatoli/WindowRunner#readme", "data-testid": "about-link-docs", target: "_blank", rel: "noreferrer noopener" }, "Documentation (README)")),
      el("li", {}, el("a", { href: "https://github.com/StepenkoAnatoli/WindowRunner/blob/main/docs/INSTALL.md", "data-testid": "about-link-install", target: "_blank", rel: "noreferrer noopener" }, "Installation guide"))
    ),
    el("h3", {}, "Diagnostics"),
    el(
      "p",
      { class: "hint", "data-testid": "about-diagnostics" },
      "Local-first: the server, tools, and persistence run on your machine; model requests go only to the providers you configure. No telemetry, no account. The bearer token and provider keys are never included in this page or in any diagnostic it renders."
    )
  );
}
