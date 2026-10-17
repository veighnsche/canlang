# Verified context: lane-02 value-semantics round (2026-10-04)

Verbatim normative excerpts from worktree revision b06d873 (origin/main).
Paths are repo-relative; line numbers are exact.

## Decimal

- DESIGN.md:107 — "`text`, `bool`, `int`, `decimal` | Unicode string, boolean,
  signed 64-bit integer, exact decimal with at most 38 significant digits and
  18 fractional digits; overflow is an error"
- DESIGN.md:213 — "Decimal arithmetic computes the mathematical result, rounds
  half-even to at most 18 fractional places, then checks the 38-significant-digit
  representation bound. An exact terminating result needing fewer places is
  retained; trailing zero normalization does not change its value. Out-of-range
  results, division by zero and invalid inputs fail; no NaN or infinity. Decimal
  literals/inputs remain checked representations rather than silently rounded
  inputs."
- DESIGN.md:872 — "All int/decimal values use canonical decimal strings at the
  MCP boundary, including money.minor and record.version; there is no
  magnitude-dependent wire type."
- DESIGN.md:231 — "Decimal/money/datetime interpolation is outside this
  plain-template overload until canonical encodings are specified".
- GRAMMAR tokens: `DECIMAL=[0-9]+\.[0-9]+`; no exponent literals, no numeric
  separators; sign is an operator, never part of the token.

## Money and currency

- DESIGN.md:112 — "`currency`, `money` | ISO currency code;
  `{minor:int,currency:currency}` with pinned currency minor-unit scales"
- DESIGN.md:159 — "A string literal can inhabit an expected validated
  string-like type, such as currency, email, or URL, after validation; this does
  not coerce an arbitrary text variable." and "Currency values never coerce to
  decimal."
- DESIGN.md:209 — "Money comparison requires matching currencies." and
  "Array/contract equality is typed structural equality; references compare
  identities of their declared reference type."
- DESIGN.md:225 — "`money(decimal,currency)` rounds once to that currency's
  minor units. Add/subtract/compare money only with matching currencies.
  Currency conversion requires an explicit typed provider/result workflow."
- DESIGN.md:261 — "Money sums require an explicit currency unless a nonempty
  literal supplies it; amounts and any explicit currency must all match. Money
  min/max also reject inconsistent currencies."
- DESIGN.md:263 — "`group` groups by typed equality (including one null group),
  preserves item encounter order and emits groups in first-encounter order."
- DESIGN.md:888 — "The language version pins builtin signatures, wire schemas,
  currency scales, timezone data, runtime defaults, and component behavior."
- DECISIONS.md:387 — "144. **MINE** — Group unlike currencies rather than
  implicitly sum them together."
- DECISIONS.md:389 — "145. **MINE** — Require explicit currency conversion
  support before combining currencies."
- REQUIREMENTS.md:184 — "Store money with a currency and deterministic rounding,
  never binary floating-point totals. Snapshot prices, rates, and costs when a
  transaction is committed so later configuration changes cannot rewrite history.
  An app must explicitly support currency conversion before combining currencies."

## Operator matrix (money rows)

- DESIGN.md:190-193 — "money, money | `+ -` | money, same currency",
  "money, money | `/` | decimal, same currency". No `money+int`, no `money%`.
