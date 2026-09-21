/**
 * The B2 client-side route model — a tiny sum type plus three pure helpers.
 *
 * Deliberately not a router: there is no dependency, no matcher table, and no
 * framework. The server serves the app bundle at `/` (and the compatibility
 * dashboard at `/dashboard`); every other route below is reached in-app via
 * `history.pushState` and survived back/forward through `popstate`. A hard
 * reload of a deep link (`/providers`, …) is NOT served by the server in B2 —
 * the route host treats unknown paths as the workspace when it does load.
 *
 * Route values never carry secrets: no tokens, no API keys, no provider data,
 * no project roots. The `#token=…` authentication fragment is handled by
 * `loadToken()` (which strips it from the address bar) and is never parsed as
 * a route.
 */

export type SettingsSection = "security" | "storage" | "about";

export type UiRoute =
  | { kind: "workspace" }
  | { kind: "providers" }
  | { kind: "usage" }
  | { kind: "settings"; section: SettingsSection };

const SETTINGS_SECTIONS: readonly SettingsSection[] = ["security", "storage", "about"];

/** Optional in-page application links (`#/providers`); the hash form exists so a bookmark always lands on `/`, which every static deployment serves. */
const HASH_ROUTES: Array<{ re: RegExp; route: UiRoute }> = [
  { re: /^#\/providers\/?$/, route: { kind: "providers" } },
  { re: /^#\/usage\/?$/, route: { kind: "usage" } },
  { re: /^#\/settings\/security\/?$/, route: { kind: "settings", section: "security" } },
  { re: /^#\/settings\/storage\/?$/, route: { kind: "settings", section: "storage" } },
  { re: /^#\/settings\/about\/?$/, route: { kind: "settings", section: "about" } },
];

function normalizePathname(pathname: string): string {
  const trimmed = (pathname ?? "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.toLowerCase();
}

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Map a location to a route. Unknown paths fall back to the workspace —
 * including `/dashboard`, which parses to the providers route for
 * compatibility (the URL itself is left alone; the page never forces a
 * redirect). `hash` is examined only for `#/…` application links: a
 * `#token=…` fragment (or any other fragment) is never treated as a route.
 */
export function parseUiRoute(pathname: string, hash?: string): UiRoute {
  const path = normalizePathname(pathname);
  switch (path) {
    case "/providers":
    case "/dashboard": // compatibility entry: render the providers page, keep the URL
      return { kind: "providers" };
    case "/usage":
      return { kind: "usage" };
    default:
      break;
  }
  const settings = /^\/settings\/([a-z]+)\/?$/.exec(path);
  if (settings && isSettingsSection(settings[1])) {
    return { kind: "settings", section: settings[1] };
  }
  // Only reached for "/" and unknown paths: an application hash link on the
  // root page selects the route; token fragments match nothing below.
  const h = hash ?? "";
  for (const entry of HASH_ROUTES) {
    if (entry.re.test(h)) return entry.route;
  }
  return { kind: "workspace" };
}

/** Canonical path for a route (what `history.pushState` receives). */
export function routePath(route: UiRoute): string {
  switch (route.kind) {
    case "workspace":
      return "/";
    case "providers":
      return "/providers";
    case "usage":
      return "/usage";
    case "settings":
      return `/settings/${route.section}`;
  }
}

/**
 * Programmatic navigation: push the route's path and notify the app through
 * the same `popstate` channel back/forward uses, so there is exactly one code
 * path that turns a location into state + data loading. (pushState alone
 * fires no event, hence the explicit dispatch.) No-op outside a browser.
 */
export function navigate(route: UiRoute): void {
  if (typeof history === "undefined" || typeof window === "undefined") return;
  history.pushState({}, "", routePath(route));
  // PopStateEvent is browser-only; Node tests run with stub globals.
  const event = typeof PopStateEvent === "function" ? new PopStateEvent("popstate", { state: {} }) : new Event("popstate");
  window.dispatchEvent(event);
}
