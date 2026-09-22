/**
 * Arrow / Home / End move focus among sibling controls. Enter and Space stay
 * native (a `<button>` activates on those keys without a custom handler), so
 * this never traps focus and never activates a control by itself.
 *
 * Used by the top nav, the settings section nav, and the inspector tablist.
 * Settings stay page navigation (`aria-current`); only the inspector is a
 * tablist. Do not turn this into a focus trap — notices and confirmations are
 * not modal widgets this module owns.
 */
export function moveFocusOnArrows(
  event: { key: string; target: EventTarget | null; preventDefault(): void },
  items: HTMLElement[]
): void {
  const key = event.key;
  const forward = key === "ArrowRight" || key === "ArrowDown";
  const backward = key === "ArrowLeft" || key === "ArrowUp";
  if (!forward && !backward && key !== "Home" && key !== "End") return;
  if (items.length === 0) return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const current = items.findIndex((item) => item === event.target || (active !== null && item === active));
  if (current < 0) return;
  event.preventDefault();
  const next =
    key === "Home" ? 0 : key === "End" ? items.length - 1 : forward ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

/** Listen on a container; events bubble from the focused control. */
export function installArrowFocus(container: HTMLElement, itemSelector: string): void {
  container.addEventListener("keydown", (event) => {
    const items = [...container.querySelectorAll<HTMLElement>(itemSelector)];
    moveFocusOnArrows(event as KeyboardEvent, items);
  });
}
