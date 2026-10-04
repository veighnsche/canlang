# JEV review: lane-02 value semantics (2026-10-04)

Model: jev-1.13.0. Three independently worded equivalent requests (a/b/c),
`choice` type, shared verified context (`context.md`, verbatim excerpts from
origin/main b06d873). Total usage: ~5k input / ~430 output tokens. Results are
advice, not normative rulings; adopted readings below are the coordinator's.

## Results by question

| Question | a | b | c |
| --- | --- | --- | --- |
| Decimal canonical wire form | strip_zeros 0.95 | trimmed_form 0.65 (stored 0.35) | unique 0.99 |
| Currency admission | iso_table 0.94 | pinned_members 0.99 | table_only 0.68 (defer 0.32) |
| Unlike-currency comparison | eq_false_ord_fail 0.87 | equality_open 0.71 (strict 0.29) | strict_everywhere 0.74 |

Unanimous: normalized unique decimal form; pinned-table currency membership.
Split 2-1: mixed-currency equality (a/b: `==` decidable + ordering fails;
c: every operator fails).

## Disagreement investigation (money comparison)

The c-rewrite dissent tracks a genuine ambiguity: DESIGN.md:225 says
"Add/subtract/compare money only with matching currencies", and "compare" can
be read to include `==`. The a/b majority reading rests on three points:

1. DECISIONS.md:387 (MINE-144) requires grouping unlike currencies, and
   `group` groups "by typed equality" (DESIGN.md:263). If `==` failed on
   mismatched currencies, group-by-money over mixed currencies would fail
   instead of grouping.
2. DESIGN.md:261 scopes rejection to ordering-based contexts: "Money min/max
   also reject inconsistent currencies." A blanket `==` failure would more
   likely be stated there.
3. DESIGN.md:209 ("Money comparison requires matching currencies") sits in a
   paragraph about ordered scalars and ordering ("ordering is Unicode scalar
   order"), i.e. relational comparison, while equality is governed by the
   "typed structural equality" sentence in the same line.

Counter-reading risk (c, 0.74 within-rewrite): a future normative clarification
could still go strict-everywhere. Mitigation: centralize the rule in one
equality function so the behavior flips in one place, and record the dissent
here and in the lane status.

## Adopted readings (advice followed)

1. Decimal wire form: unique normalized text — strip trailing fractional
   zeros, omit the point for integral values, encode zero (incl. negative
   zero) as `0`, plain base-10, no exponent. In-memory values may retain
   produced scale ("retained" per DESIGN.md:213); equality is by numeric
   value, so scale never affects `==`.
2. Currency admission: only members of the language-version-pinned ISO 4217
   table are currency values; anything else fails validation at the checking
   boundary. Rationale: `money(decimal,currency)` must round to "that
   currency's minor units" (DESIGN.md:225), impossible with an unknown scale;
   silent scale-2 default would invent semantics and deferred failure would
   weaken checked construction.
3. Unlike-currency comparison: `==`/`!=` are decidable (mismatched currencies
   are unequal); `< <= > >=` fail on mismatched currencies. Same rule applies
   to `min`/`max` (reject) and `group` (groups normally).

## Residual uncertainty

- b gave stored-scale decimal encoding 0.35: if a future wire revision needs
  scale preservation (e.g. display fidelity), it must be a new wire version,
  not a silent second form — the "canonical" requirement forbids two forms
  for one value.
- c gave deferred currency validation 0.32: rejected for the reasons above;
  revisit only if a normative currency-registry workflow appears.
- The strict-everywhere money reading (c) stays flagged until L1/checker or a
  normative clarification weighs in; implementation keeps the rule central.
