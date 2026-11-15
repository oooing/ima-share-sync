/** Use the browser top layer so scrollable Obsidian modals cannot clip the menu. */
export function quantityPopover(panel: HTMLElement, anchor: HTMLElement, arrow: HTMLElement): (open?: boolean) => void {
  const win = panel.ownerDocument?.defaultView;
  const topLayer = typeof panel.showPopover === "function";
  let opened = false;
  if (topLayer) panel.setAttribute("popover", "manual");
  else panel.addClass("ima-popover-inline");
  const place = () => {
    if (!opened || !topLayer || !win) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 8, margin = 12;
    const width = Math.min(Math.max(rect.width, 280), win.innerWidth - margin * 2);
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${win.innerHeight - margin * 2}px`;
    const height = panel.getBoundingClientRect().height;
    const below = win.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const top = below >= height ? rect.bottom + gap : above >= height ? rect.top - gap - height
      : Math.max(margin, Math.min(rect.bottom + gap, win.innerHeight - margin - height));
    panel.style.left = `${Math.max(margin, Math.min(rect.left, win.innerWidth - margin - width))}px`;
    panel.style.top = `${top}px`;
  };
  const outside = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (target && !panel.contains(target) && !anchor.contains(target)) toggle(false);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopImmediatePropagation(); toggle(false); anchor.focus();
  };
  const listen = (enabled: boolean) => {
    if (enabled) {
      win?.addEventListener("click", outside, true);
      win?.addEventListener("keydown", key, true);
      win?.addEventListener("resize", place);
      win?.addEventListener("scroll", place, true);
    } else {
      win?.removeEventListener("click", outside, true);
      win?.removeEventListener("keydown", key, true);
      win?.removeEventListener("resize", place);
      win?.removeEventListener("scroll", place, true);
    }
  };
  const toggle = (open = !opened) => {
    opened = open;
    panel.toggleClass("is-hidden", !open);
    arrow.toggleClass("is-expanded", open);
    anchor.setAttribute("aria-expanded", String(open));
    if (topLayer) { if (open) panel.showPopover(); else panel.hidePopover(); }
    listen(open); place();
  };
  panel.addEventListener("toggle", () => {
    // Removing a modal/panel also removes its popover from the top layer.
    if (opened && !panel.matches(":popover-open")) toggle(false);
  });
  return toggle;
}
