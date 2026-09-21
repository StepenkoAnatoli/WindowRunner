/**
 * The compatibility page's server connection: connect with a token, sign out,
 * refresh the provider + usage views, and the one place its request failures
 * are turned into a message.
 *
 * `client` is a live ES-module binding: the view modules import it and read
 * the current value, which is what keeps `if (!client) return;` guards working
 * across a Sign out without passing the client through every function.
 *
 * B2: the provider list/CRUD itself runs through the shared provider
 * controller (provider-controller.ts); `refresh()` only refills both slices
 * from the server (used after a quick-chat turn lands and by the usage
 * Refresh button), preserving the transient form/notice fields.
 */
import { ApiClient, ApiRequestError, clearToken, saveToken } from "./api.js";
import { describeError } from "./describe-error.js";
import { render, resetForSignOut, state } from "./dashboard-state.js";

export let client: ApiClient | undefined;

/**
 * The shared error describer with the dashboard's own 401 wording, plus the
 * provider routes' per-field `errors` list (so "profile is invalid" says
 * which field). Kept here so every dashboard module phrases failures the same
 * way without re-declaring the options.
 */
export function describeDashError(err: unknown): string {
  return describeError(err, { auth: "the server rejected the token", fieldErrors: true });
}

export async function connect(token: string): Promise<void> {
  const candidate = new ApiClient({ token });
  state.auth = "checking";
  render();
  try {
    await candidate.health();
    client = candidate;
    saveToken(token);
    state.auth = "ok";
    await refresh();
  } catch (err) {
    client = undefined;
    clearToken();
    state.auth = "invalid";
    state.authError = describeDashError(err);
  }
  render();
}

export function signOut(): void {
  client = undefined;
  clearToken();
  resetForSignOut();
  render();
}

export async function refresh(): Promise<void> {
  if (!client) return;
  try {
    const [providers, usage] = await Promise.all([client.listProviders(), client.usage(50)]);
    // Spread-first: the transient form, notice, and pending-action fields are
    // UI state and must survive a data refresh untouched.
    state.providers = {
      ...state.providers,
      status: "ready",
      activeProfileId: providers.activeProfileId,
      profiles: providers.profiles,
      error: undefined,
    };
    state.usage = {
      ...state.usage,
      status: "ready",
      records: usage.records,
      retained: usage.retained,
      bounded: usage.bounded,
      error: undefined,
    };
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      signOut();
      return;
    }
    state.notice = `refresh failed: ${describeDashError(err)}`;
  }
  render();
}

export function reportError(err: unknown): void {
  if (err instanceof ApiRequestError && err.isAuth) {
    signOut();
    return;
  }
  state.notice = describeDashError(err);
  render();
}
