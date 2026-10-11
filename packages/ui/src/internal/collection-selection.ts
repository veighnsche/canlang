import type { PresentationContext } from "@canlang/contracts";

export function selectionHref(context: PresentationContext, occurrence: string, id: string): string {
  const current = context.pollUrl ?? context.path;
  if (!current.startsWith("/") || current.startsWith("//") || /[\\\s\u0000-\u001f\u007f#]/.test(current)) {
    throw new TypeError("Collection selection requires a same-app relative URL.");
  }
  const url = new URL(current, "https://can.invalid");
  if (url.origin !== "https://can.invalid") throw new TypeError("Invalid collection selection URL.");
  url.searchParams.set(`can-row:${occurrence}`, id);
  return `${url.pathname}${url.search}`;
}

/** Clear only the original occurrence, preserving every other GET parameter. */
export function selectionCloseHref(context: PresentationContext, occurrence: string): string {
  const url = new URL(selectionHref(context, occurrence, ""), "https://can.invalid");
  url.searchParams.delete(`can-row:${occurrence}`);
  return `${url.pathname}${url.search}`;
}
