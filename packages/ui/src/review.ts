/**
 * C7 company-policy review leaf: `review`.
 *
 * Renders a company review STRICTLY from declared policy content passed in
 * props. Every slot renders its supplied message value verbatim through
 * resolveCaption; absent slots render the explicit shared unavailable
 * presentation, never a guess. Absent policy throws: there is no review
 * without source content. Pure async string builder: no h(), no hydration,
 * no client state.
 *
 * Props live in the presentation contract. No policy shape is declared in
 * services.ts/wire.ts/files.ts, so nothing here invents schema — the caller
 * supplies already-declared content as message values.
 */

import type {
  AppearanceOrientation,
  AppearanceSize,
  AppearanceTone,
  AppearanceVariant,
  MessageValue,
  PresentationContext,
  ReviewProps,
} from "@canlang/contracts";
import { appearanceClasses, type AppearanceOpts } from "./appearance.js";
import { escapeAttr, escapeHtml } from "./escape.js";
import { message, resolveCaption } from "./messages.js";

/** Shared structural captions (ui.review.*): en source + nl variant. */
const REVIEW_LABEL = message("Review", { nl: "Beoordeling" });
const POLICY_LABEL = message("Policy", { nl: "Beleid" });
const DECISION_LABEL = message("Decision", { nl: "Beslissing" });
const RATIONALE_LABEL = message("Rationale", { nl: "Motivering" });
const ACTOR_LABEL = message("Actor", { nl: "Actor" });
const TIME_LABEL = message("Time", { nl: "Tijd" });
const UNAVAILABLE = message("Unavailable", { nl: "Niet beschikbaar" });

/**
 * Collect every appearance key present at runtime (including undeclared
 * extras from JS callers) so appearanceClasses() judges them against the
 * word's admitted matrix: unadmitted tokens throw, never silently drop.
 */
function pickAppearance(props: object): AppearanceOpts {
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

function slotText(
  slot: string,
  value: MessageValue | null | undefined,
  context: PresentationContext,
): string {
  if (value === undefined || value === null) {
    return resolveCaption(UNAVAILABLE, context);
  }
  try {
    return resolveCaption(value, context);
  } catch {
    throw new TypeError(`review: slot "${slot}" must be a message value`);
  }
}

/**
 * Company review from real declared policy content: a labelled section with
 * a five-slot description list (policy text, decision, rationale, actor,
 * time) in source order. Unknown/missing slots render "Unavailable"; an
 * absent policy throws. No policy intent, wording or outcome is invented.
 */
export async function review(props: ReviewProps): Promise<string> {
  // "review" admits no appearance: unstyled leaf; any runtime token throws.
  appearanceClasses("review", "review", pickAppearance(props));
  const policy = props.policy;
  if (policy === null || policy === undefined || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("review: policy is absent");
  }
  const name =
    props.caption !== undefined
      ? resolveCaption(props.caption, props.context)
      : resolveCaption(REVIEW_LABEL, props.context);
  if (name === "") {
    throw new Error("review caption must not be empty");
  }
  const rows: ReadonlyArray<readonly [MessageValue, MessageValue | null | undefined, string]> = [
    [POLICY_LABEL, policy.text, "text"],
    [DECISION_LABEL, policy.decision, "decision"],
    [RATIONALE_LABEL, policy.rationale, "rationale"],
    [ACTOR_LABEL, policy.actor, "actor"],
    [TIME_LABEL, policy.time, "time"],
  ];
  const items = rows
    .map(
      ([label, value, slot]) =>
        `<div><dt>${escapeHtml(resolveCaption(label, props.context))}</dt>` +
        `<dd>${escapeHtml(slotText(slot, value, props.context))}</dd></div>`,
    )
    .join("");
  return `<section aria-label="${escapeAttr(name)}"><dl>${items}</dl></section>`;
}
