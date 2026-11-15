// Obsidian treats aria-label/title as hover hints. Use referenced text for names.
let nextLabel = 0;
const labels = new WeakMap<HTMLElement, { node: HTMLElement; text: string }>();

export function setQuietLabel(element: HTMLElement, text: string, host: HTMLElement = element): void {
  let entry = labels.get(element);
  if (!entry || entry.node.parentElement !== host) {
    entry = { node: host.createSpan({ cls: "ima-visually-hidden", attr: { id: `ima-quiet-label-${++nextLabel}` } }), text };
    labels.set(element, entry);
  }
  entry.text = text;
  entry.node.setText(text);
  element.setAttribute("aria-labelledby", entry.node.id);
  element.removeAttribute("aria-label");
  element.removeAttribute("title");
  element.removeAttribute("data-tooltip-position");
}

/** Run after each owned surface renders, including host-generated control labels. */
export function silenceHoverHints(root: HTMLElement): void {
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("[aria-label], [title]"))]) {
    const previous = labels.get(element);
    const text = element.getAttribute("aria-label") || element.getAttribute("title") || (previous && !previous.node.parentElement ? previous.text : "");
    if (text && (!element.getAttribute("aria-labelledby") || labels.has(element))) {
      const host = /^(INPUT|TEXTAREA|SELECT|IMG|BR|HR)$/.test(element.tagName) ? element.parentElement ?? root : element;
      setQuietLabel(element, text, host);
    }
    element.removeAttribute("aria-label");
    element.removeAttribute("title");
    element.removeAttribute("data-tooltip-position");
  }
}
