/**
 * Settings shell (B2): the Security / Storage / About navigation plus the
 * active section's content. The content element arrives fully built from the
 * section renderer; the shell owns only the section switch and the
 * `aria-current` markers.
 */
import type { SettingsSection } from "../ui-route.js";
import { el } from "../dom.js";
import { installArrowFocus } from "../keyboard-nav.js";

export interface SettingsShellProps {
  section: SettingsSection;
  onSelect(section: SettingsSection): void;
  content: HTMLElement;
}

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: "security", label: "Security" },
  { id: "storage", label: "Storage" },
  { id: "about", label: "About" },
];

export function renderSettingsShell(props: SettingsShellProps): HTMLElement {
  // Page navigation, not a tablist: each section has its own URL, so the
  // selected control is aria-current="page". Arrow keys move focus; Enter
  // activates (native button). Do not add role="tab" here.
  const nav = el(
    "nav",
    { class: "settings-nav", "data-testid": "settings-nav", "aria-label": "Settings sections" },
    ...SETTINGS_SECTIONS.map(({ id, label }) => {
      const item = el(
        "button",
        {
          type: "button",
          class: `settings-tab${props.section === id ? " selected" : ""}`,
          "data-testid": `settings-nav-${id}`,
          ...(props.section === id ? { "aria-current": "page" } : {}),
        },
        label
      );
      item.addEventListener("click", () => props.onSelect(id));
      return item;
    })
  );
  installArrowFocus(nav, "button.settings-tab");
  return el(
    "section",
    { class: "settings-page", "data-testid": "settings-page" },
    el("h2", {}, "Settings"),
    nav,
    el("div", { class: "settings-content", "data-testid": "settings-content" }, props.content)
  );
}
