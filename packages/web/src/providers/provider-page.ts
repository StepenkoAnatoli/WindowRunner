/**
 * Provider page composition (B2) — one component used by BOTH the main
 * workspace's Providers route and the /dashboard compatibility page.
 *
 * Pure render: receives the provider slice + callbacks and builds DOM; all
 * effects live in the provider controller (owned by the host). Every element
 * the E2E suites touch carries a stable `data-testid`; the card-level ids are
 * the dashboard's originals (see provider-cards.ts).
 */
import type { ProviderUiState } from "../app-state.js";
import type { ProviderFormField } from "./provider-form.js";
import { renderProviderForm } from "./provider-form.js";
import { renderProviderCards } from "./provider-cards.js";
import { renderActiveProviderBanner } from "./active-provider-banner.js";
import { button, el } from "../dom.js";

export interface ProviderPageProps {
  state: ProviderUiState;
  onAdd(): void;
  onEdit(profileId: string): void;
  onTest(profileId: string): void;
  onActivate(profileId: string): void;
  onDelete(profileId: string): void;
  onSubmit(): void;
  onCancelForm(): void;
  onFieldChange(field: ProviderFormField, value: string): void;
  onDismissNotice(): void;
  /** Explicit re-fetch of the provider list (the route caches otherwise). */
  onRefresh(): void;
  /** In-app navigation back to the workspace (an `<a href="/">` fallback). */
  onBackToWorkspace(): void;
}

export function renderProviderPage(props: ProviderPageProps): HTMLElement {
  const state = props.state;
  const editingProfile = state.form?.mode === "edit" ? state.profiles.find((p) => p.id === state.form?.profileId) : undefined;

  const children: Array<HTMLElement | null> = [
    el(
      "div",
      { class: "page-head" },
      el("h2", {}, "Providers"),
      el(
        "div",
        { class: "row" },
        button("providers-refresh", "Refresh", props.onRefresh, "secondary", state.status === "loading"),
        button("providers-add", "Add provider", props.onAdd, "primary", state.form !== undefined)
      )
    ),
    renderActiveProviderBanner(state),
    state.error
      ? el(
          "div",
          { class: "banner error", role: "alert", "data-testid": "providers-error" },
          el("strong", {}, state.error.code),
          " ",
          state.error.message,
          " ",
          button("providers-retry", "Retry", props.onRefresh, "link")
        )
      : null,
    state.status === "loading" && state.profiles.length === 0
      ? el("p", { class: "hint", "data-testid": "providers-loading" }, "Loading providers…")
      : null,
    state.profiles.length === 0 && state.status === "ready"
      ? el("p", { class: "hint", "data-testid": "providers-empty" }, "No profiles yet — add one. The environment-configured provider is registered as “default” on first boot.")
      : renderProviderCards({
          profiles: state.profiles,
          activeProfileId: state.activeProfileId,
          testingProfileId: state.testingProfileId,
          deletingProfileId: state.deletingProfileId,
          activatingProfileId: state.activatingProfileId,
          onEdit: (profile) => props.onEdit(profile.id),
          onTest: (profile) => props.onTest(profile.id),
          onActivate: (profile) => props.onActivate(profile.id),
          onDelete: (profile) => props.onDelete(profile.id),
        }),
    state.form
      ? renderProviderForm({
          form: state.form,
          maskedApiKey: editingProfile?.apiKeyMasked,
          onChange: props.onFieldChange,
          onSubmit: props.onSubmit,
          onCancel: props.onCancelForm,
        })
      : null,
    state.notice
      ? el(
          "div",
          { class: `banner ${state.notice.tone}`, role: "status", "data-testid": "providers-notice", "data-tone": state.notice.tone },
          state.notice.text,
          " ",
          button("providers-notice-dismiss", "Dismiss", props.onDismissNotice, "link")
        )
      : null,
    // Navigation back to the workspace. A real href keeps middle-click/open-
    // in-new-tab working; a normal click is intercepted for in-app routing so
    // the in-memory session and form state survive.
    el(
      "a",
      { href: "/", class: "muted", "data-testid": "providers-main-link" },
      "← Back to workspace"
    ),
  ];

  const page = el("section", { class: "provider-page", "data-testid": "providers-page" }, ...children.filter((c): c is HTMLElement => c !== null));
  const link = page.querySelector('[data-testid="providers-main-link"]');
  link?.addEventListener("click", (e) => {
    const me = e as MouseEvent;
    if (me.metaKey || me.ctrlKey || me.shiftKey || me.altKey || me.button !== 0) return; // let modified clicks through
    e.preventDefault();
    props.onBackToWorkspace();
  });
  return page;
}
