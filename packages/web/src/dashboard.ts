/**
 * Provider dashboard — served at /dashboard.
 *
 * B2 compatibility adapter: the dashboard is no longer its own app. It mounts
 * the same provider components the workspace uses (provider-page + the shared
 * controller), the shared usage table, and the dashboard-only quick chat, all
 * through providers/compatibility.ts. The URL stays /dashboard (no redirect),
 * the dashboard.css mount is untouched, and the token flow is the shared
 * fragment/sessionStorage one.
 */
import { loadToken } from "./api.js";
import { mountProviderCompatibilityPage } from "./providers/compatibility.js";

const token = loadToken();

mountProviderCompatibilityPage({
  token,
  mode: "dashboard",
});
