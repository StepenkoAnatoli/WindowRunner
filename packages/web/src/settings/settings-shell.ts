/**
 * Settings shell (B2): the Security / Storage / About navigation plus the
 * active section's content. The content element arrives fully built from the
 * section renderer; the shell owns only the section switch and the
 * `aria-current` markers.
 */
import type { SettingsSection } from "../ui-route.js";
import { el } from "../dom.js";

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
  return el(
    "section",
    { class: "settings-page", "data-testid": "settings-page" },
    el("h2", {}, "Settings"),
    el(
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
    ),
    el("div", { class: "settings-content", "data-testid": "settings-content" }, props.content)
  );
}
