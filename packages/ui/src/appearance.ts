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
} from "@canlang/contracts";
import { UI_CATALOG } from "./catalog.js";

export interface AppearanceOpts {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
  readonly orientation?: AppearanceOrientation;
}

function pushAppearanceToken(
  classes: string[],
  base: string,
  word: string,
  admitted: readonly string[] | undefined,
  kind: string,
  readValue: () => string | undefined,
): void {
  // Each stage rereads the token, as the original inline checks did: the
  // guard, admission and emission each observe the current value.
  const admittedValue = readValue();
  if (admittedValue === undefined || !(admitted ?? []).includes(admittedValue)) {
    throw new Error(`appearanceClasses: word ${JSON.stringify(word)} does not admit ${kind}=${JSON.stringify(readValue())}`);
  }
  classes.push(`${base}-${readValue()}`);
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
    pushAppearanceToken(classes, base, word, admitted.tone, "tone", () => opts.tone);
  }
  if (opts.size !== undefined) {
    pushAppearanceToken(classes, base, word, admitted.size, "size", () => opts.size);
  }
  if (opts.variant !== undefined && opts.variant !== "solid") {
    pushAppearanceToken(classes, base, word, admitted.variant, "variant", () => opts.variant);
  }
  if (opts.variant !== undefined && opts.variant === "solid" && !(admitted.variant ?? []).includes("solid")) {
    throw new Error(`appearanceClasses: word ${JSON.stringify(word)} does not admit variant="solid"`);
  }
  if (opts.orientation !== undefined) {
    pushAppearanceToken(classes, base, word, admitted.orientation, "orientation", () => opts.orientation);
  }
  return classes.join(" ");
}
