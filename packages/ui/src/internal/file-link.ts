/** Shared strict File presentation checks; source authority stays with the presenter. */
import type { FileLinkView, FileValue, PresentationContext } from "@canlang/contracts";
import { safeHref } from "../escape.js";
import { message, resolveCaption } from "../messages.js";

export const OPEN_FILE = message("Open file", { nl: "Bestand openen" });

export function checkedFile(value: unknown, sink: string): FileValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${sink} File entries must be File values`);
  }
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  const id = Object.getOwnPropertyDescriptor(value, "id");
  if (kind === undefined || !("value" in kind) || kind.value !== "file" ||
      id === undefined || !("value" in id) || typeof id.value !== "string" || id.value === "") {
    throw new TypeError(`${sink} File entries must be File values`);
  }
  return value as FileValue;
}

export function checkedFileLink(view: FileLinkView, context: PresentationContext, sink: string): {
  href: string; caption: string; status: FileLinkView["status"];
} {
  const invalid = () => new TypeError(`${sink} File presenter returned an invalid authorized link`);
  if (typeof view !== "object" || view === null || Array.isArray(view)) throw invalid();
  const properties = Object.getOwnPropertyDescriptors(view);
  for (const key of ["href", "name", "caption", "status"]) {
    if (properties[key] !== undefined && !("value" in properties[key]!)) throw invalid();
  }
  const href: unknown = properties.href?.value;
  const name: unknown = properties.name?.value;
  const suppliedCaption = properties.caption?.value as FileLinkView["caption"];
  const status: unknown = properties.status?.value;
  if (typeof href !== "string" || safeHref(href, "") === "" ||
      (name !== undefined && typeof name !== "string") ||
      (status !== undefined && (typeof status !== "string" ||
        !["pending", "succeeded", "failed", "unknown", "skipped"].includes(status)))) throw invalid();
  const caption = suppliedCaption === undefined ? name ?? resolveCaption(OPEN_FILE, context) :
    resolveCaption(suppliedCaption, context);
  return { href, caption, status: status as FileLinkView["status"] };
}
