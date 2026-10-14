import type { MessageValue, PresentationContext } from "@canlang/contracts";
import { escapeAttr, escapeHtml } from "../escape.js";
import { assertRegionId } from "../htmx.js";
import { resolveCaption } from "../messages.js";

/** Presentation wrapper only: the canonical form and its transport stay unchanged. */
export function menuDialog(context: PresentationContext, idPrefix: string, caption: MessageValue, form: string): string {
  const id = `${idPrefix}-menu-dialog`;
  assertRegionId(id);
  const label = escapeHtml(resolveCaption(caption, context));
  return `<div data-can-menu-dialog>` +
    `<button type="button" class="btn can-action-entry" data-can-menu-dialog-open aria-haspopup="dialog" aria-controls="${escapeAttr(id)}">${label}</button>` +
    `<dialog id="${escapeAttr(id)}" class="modal can-menu-dialog" data-can-menu-dialog-panel aria-labelledby="${escapeAttr(id)}-title">` +
    `<div class="modal-box"><h2 id="${escapeAttr(id)}-title" class="text-lg font-bold">${label}</h2>${form}` +
    `</div></dialog></div>`;
}
