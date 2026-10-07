/**
 * Collect every appearance key present at runtime, including undeclared
 * extras from JS callers, so appearanceClasses judges them against the
 * word's admitted matrix without silently dropping unadmitted tokens.
 */
import type {
  AppearanceOrientation,
  AppearanceSize,
  AppearanceTone,
  AppearanceVariant,
} from "@canlang/contracts";
import type { AppearanceOpts } from "../appearance.js";

export function pickAppearance(props: object): AppearanceOpts {
  const record = props as Record<string, unknown>;
  const opts: {
    tone?: AppearanceTone;
    size?: AppearanceSize;
    variant?: AppearanceVariant;
    orientation?: AppearanceOrientation;
  } = {};
  if (record["tone"] !== undefined) {
    opts.tone = record["tone"] as AppearanceTone;
  }
  if (record["size"] !== undefined) {
    opts.size = record["size"] as AppearanceSize;
  }
  if (record["variant"] !== undefined) {
    opts.variant = record["variant"] as AppearanceVariant;
  }
  if (record["orientation"] !== undefined) {
    opts.orientation = record["orientation"] as AppearanceOrientation;
  }
  return opts;
}
