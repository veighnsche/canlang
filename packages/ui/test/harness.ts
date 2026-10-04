/**
 * Shared DOM harness for interaction tests (S5+).
 *
 * happy-dom supplies document/focus/keyboard semantics under node --test;
 * linkedom was disqualified because focus() leaves activeElement undefined
 * (see implementation/evidence/jev/lane-05-s5-20261004/review.md).
 * Test-only helper: never imported by src/.
 */
import { Window } from "happy-dom";
import type { Document, Element, KeyboardEvent } from "happy-dom";

export interface LoadedPage {
  readonly window: Window;
  readonly document: Document;
  close(): Promise<void>;
}

/** Parse an HTML string into a live document. Caller must await close(). */
export async function loadHtml(html: string): Promise<LoadedPage> {
  const window = new Window();
  window.document.body.innerHTML = html;
  return {
    window,
    document: window.document,
    close: () => window.happyDOM.close(),
  };
}

/** Dispatch a bubbling keydown event on an element. */
export function pressKey(target: Element, key: string): void {
  const view = target.ownerDocument.defaultView;
  if (view === null) {
    throw new Error("pressKey: element has no default view");
  }
  const event = new view.KeyboardEvent("keydown", { key, bubbles: true });
  target.dispatchEvent(event as unknown as KeyboardEvent);
}
