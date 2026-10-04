/**
 * Closed appearance-token renderer (C3+).
 *
 * Maps finite semantic tokens (tone/size/variant/orientation) to pinned
 * daisyUI classes for one base class, enforcing the word's admitted catalog
 * matrix: unadmitted tokens throw, never degrade to a guessed class.
 * `solid` is the base class itself and emits no modifier.
 */
import type {
  AppearanceOrientation,
  AppearanceSize,
  AppearanceTone,
  AppearanceVariant,
} from "../../contracts/src/presentation.js";
import { UI_CATALOG } from "./catalog.js";

export interface AppearanceOpts {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
  readonly orientation?: AppearanceOrientation;
}

/**
 * Render modifier classes for `base` under `word`'s admitted matrix.
 * Throws when a token is not admitted for the word. Orientation maps to
 * `<base>-horizontal` / `<base>-vertical` (upstream directional pattern).
 */
export function appearanceClasses(
  word: string,
  base: string,
  opts: AppearanceOpts,
): string {
  const entry = UI_CATALOG.entries.find((candidate) => candidate.id === word);
  if (entry === undefined) {
    throw new Error(`appearanceClasses: unknown catalog word ${JSON.stringify(word)}`);
  }
  const admitted = entry.appearance;
  if (admitted === undefined) {
    if (
      opts.tone !== undefined ||
      opts.size !== undefined ||
      opts.variant !== undefined ||
      opts.orientation !== undefined
    ) {
      throw new Error(`appearanceClasses: word ${JSON.stringify(word)} admits no appearance`);
    }
    return "";
  }
  const classes: string[] = [];
  if (opts.tone !== undefined) {
    if (!(admitted.tone ?? []).includes(opts.tone)) {
      throw new Error(`appearanceClasses: word ${JSON.stringify(word)} does not admit tone=${JSON.stringify(opts.tone)}`);
    }
    classes.push(`${base}-${opts.tone}`);
  }
  if (opts.size !== undefined) {
    if (!(admitted.size ?? []).includes(opts.size)) {
      throw new Error(`appearanceClasses: word ${JSON.stringify(word)} does not admit size=${JSON.stringify(opts.size)}`);
    }
    classes.push(`${base}-${opts.size}`);
  }
  if (opts.variant !== undefined && opts.variant !== "solid") {
    if (!(admitted.variant ?? []).includes(opts.variant)) {
      throw new Error(`appearanceClasses: word ${JSON.stringify(word)} does not admit variant=${JSON.stringify(opts.variant)}`);
    }
    classes.push(`${base}-${opts.variant}`);
  }
  if (opts.variant !== undefined && opts.variant === "solid" && !(admitted.variant ?? []).includes("solid")) {
    throw new Error(`appearanceClasses: word ${JSON.stringify(word)} does not admit variant="solid"`);
  }
  if (opts.orientation !== undefined) {
    if (!(admitted.orientation ?? []).includes(opts.orientation)) {
      throw new Error(`appearanceClasses: word ${JSON.stringify(word)} does not admit orientation=${JSON.stringify(opts.orientation)}`);
    }
    classes.push(`${base}-${opts.orientation}`);
  }
  return classes.join(" ");
}
