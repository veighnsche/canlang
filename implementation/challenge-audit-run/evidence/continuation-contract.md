# T03 ordinary continuation contract (PROPOSED)

Task T03 (L1). RQ02. Status: **proposed evidence only** — DESIGN.md, GRAMMAR.md, and
DECISIONS.md are READ-ONLY in this task; the "Proposed wording" section drafts normative
text for later reserved application, and adopts nothing by itself.
Base: branch `codex/challenge-audit-implementation`, HEAD `c4a9775`, draft `2d67312`.

Companion: [root-causes.md](root-causes.md) sites R01-R06, R26(layer 1), R28 and chains
C1/C2/C4/C5/C7 are the evidence this contract must explain with one rule.

## 1. One-sentence contract

An explicit null test establishes an ordinary typing fact about the tested path for exactly
the continuations in which the test is known to have succeeded, keyed by resolved
declaration and path, invalidated by writes and mutation-capable calls, and conferring no
permission; a fact survives a join only if it holds on every reaching path.

## 2. Null true/false facts

For a path `p` of nullable type tested against `null`:

- `p == null` true-continuation: `p` is null. False-continuation: `p` is non-null.
- `p != null` true-continuation: `p` is non-null. False-continuation: `p` is null.
- Reversed operands (`null == p`, `null != p`) and parentheses change nothing: facts key on
  the resolved tested path, not on surface order. `not (p == null)` is `p != null`;
  `not (p != null)` is `p == null`; double negation cancels.
- Only direct null tests qualify: `==`/`!=` with exactly one side the `null` literal.
  Ordered/arithmetic operators on null remain type errors (DESIGN L165);
  cross-nullable comparisons (`p == q` with both nullable) establish no presence fact.
- Null equals null: in a true-`==null` continuation the path's value is exactly null, so
  dereference there is still an error (it is a known-null use, not a non-null proof).
- Stable paths only: `?.` chains are excluded from §2 keying (they re-evaluate and do not
  resolve to one declaration+path). `p?.f != null` therefore establishes no fact about `p`
  — the existing DESIGN L171 exclusion is retained for all safe-access comparison shapes
  (see IC7), while plain-path null tests gain facts.

## 3. Boolean composition (short-circuit basis)

DESIGN L163: `and`/`or` short-circuit left to right. Facts follow evaluation order:

- AND: the right operand is evaluated only when the left is true, so it receives the
  left-true facts. The true-continuation of `a and b` carries left-true + right-true facts;
  the false-continuation carries nothing (either side may have failed).
- OR: the right operand is evaluated only when the left is false, so it receives the
  left-false facts. The false-continuation of `a or b` carries left-false + right-false
  facts; the true-continuation carries nothing.
- `not` swaps the true/false fact sets of its operand.
- Worked consequence: in `x == null or f(x)` the right arm receives left-false facts,
  i.e. `x != null`, so `f(x)` checks. The rejected mirrors are `x != null or f(x)`
  (right arm gets `x == null`) and `x == null and f(x)` (right arm gets `x == null`).
  Invalid controls in §11 pin all four shapes.

## 4. Branches, joins, and loops

- `if c` body receives the true-facts of `c`; the `else` body receives the false-facts.
  `if prior == null` ... `else` therefore proves `prior` non-null in the else body (R01).
- After the join, only facts valid on **every** reaching path survive (intersection).
  Contradictory branches (`x` non-null on one arm, null on the other) yield no fact —
  see invalid control IC5.
- `for` loops: facts established inside the body do not survive the loop (zero-iteration
  control IC6); facts from before the loop survive only if no invalidation occurs on any
  iteration path. `first(...)` results are always nullable at binding (stable ordering
  required; no non-emptiness inference beyond a statically nonempty literal per DESIGN).
- `??` is unchanged: it is value fallback, not a fact source; the right operand is typed
  under no new facts (the left is merely observed null there, which adds nothing).

## 5. Successful `require` carries facts

An execution/mapper guard `require expr` (GRAMMAR: `require expr`) rejects with
`rule_failed` when `expr` is false. Code after a successful `require` therefore receives
the true-facts of `expr` — for every conjunct shape in §2-§3, including nested
`and`/`or`/`not` structure. Facts from a `require` apply only to statements the evaluation
reached: a fact from conjunct N+1 never flows back above the `require`, and nothing flows
past a diverging statement. This covers R03 (Chat:73), R04 (Check:68), and require-chains
such as `require policy != null` (Leave:86) followed by use.

## 6. Keying: resolved declaration + path

Facts key on the **resolved declaration and path**, never on spelling:

- `let`-bound locals, parameters, query aliases, `row`, `event` payload paths, and member
  paths (`a.b.c`) each carry their own facts. Two spellings resolving to the same
  declaration+path share facts; one spelling resolving to different declarations (shadowing,
  distinct `row` bindings) never shares.
- Parenthesized and aliased re-reads of the same path reuse the fact only while valid
  (§7-8); re-resolution after invalidation starts from the declared type.
- Enum-case and overload resolution may consume established non-null facts to recover an
  expected type (this is how C1/C7 consequences disappear under the contract).

## 7. Immutable-local vs mutable-field distinction

- Immutable locals (`let` bindings never reassigned, parameters never written): facts persist
  for the binding's whole scope unless invalidated through an alias (§8) — locals have no
  aliases in v1 beyond explicit re-reads of the same path, so persistence is the norm.
- Mutable fields (stored model fields, `event.after` pending data, any `set` target):
  facts persist only until the next write to that path, or any mutation-capable call that
  could reach it. Field facts never outlive the statement sequence that guards them without
  re-testing.
- `event.before`/snapshot/pending inputs are immutable within the handler; their facts
  persist, but their values confer no write authority (R15/T30 provenance stays separate).

## 8. Invalidation around writes and mutation-capable calls

A fact on path `p` is dropped when any of the following occurs on a reaching path:

- `set p` or `set <prefix-of-p>` or `set <p-extended>` (a write to `p`, its container, or
  anything beneath it);
- `create`/`delete` of a record that could alias `p`'s container;
- a `call`/`send`/hook-adjacent operation classified mutation-capable over `p`'s owner
  (pure derives, comparisons, `format`, and reads never invalidate);
- entry to a `for` body for facts on paths the loop may write (conservative: any path
  written on any iteration path is dropped for the whole body unless re-established inside).
- Alias writes (IC4): a write through a proven-same declaration+path invalidates; a write
  through a merely possibly-aliasing reference invalidates conservatively. The contract
  never requires whole-program alias proof — uncertainty resolves to rejection.

## 9. Existence supplies no permission

Every fact in this contract is a **typing fact** (nullability only). It never establishes:

- read/grant/write authority on any record, field, or team (DECISIONS records the same
  non-interference principle: `staff(actor) and (location==null or
  can_work(actor,location))` must not lose its staff check);
- caller authentication or non-null `actor` (actor facts are T06's separate rule; a role
  test on another subject never narrows the caller);
- directory access, record access, or privilege (as with `?.` and safe-access narrowing);
- staleness or cross-transaction currency: facts are check-time typing facts within one
  evaluation; revision/revocation fencing stays with T32.
- A schema selector or readable path supplies no non-null fact and no permission grant
  (R07/R08 boundary preserved).

## 10. The six sampled patterns under one rule

Each pattern checks clean under §§2-9 with no per-site exception:

1. Affiliate ([CanAffiliate.can](/Users/vince/Projects/canlang/draft/CanAffiliate.can:88)):
   `if prior==null` create-branch / `else` consume-branch — §4 if/else facts (R01).
2. Approve ([CanApprove.can](/Users/vince/Projects/canlang/draft/CanApprove.can:264)):
   `if notice!=null and notice.delivery==null` then body + `when=` re-reads — §3 AND facts
   flowing into the body, §8 invalidation checked at the `send` (R02).
3. Catch ([CanCatch.can](/Users/vince/Projects/canlang/draft/CanCatch.can:91)):
   `(task==null or task.location==null or can_work(actor,task.location))` — §3 OR-right
   facts applied twice in one disjunction chain (R05).
4. Chat ([CanChat.can](/Users/vince/Projects/canlang/draft/CanChat.can:71)):
   `require allowance!=null and ...` then counter consumption L75-L81 — §5 require facts
   + §3 AND facts (R03).
5. Check ([CanCheck.can](/Users/vince/Projects/canlang/draft/CanCheck.can:65)):
   `require check!=null` then token/state reads and `parent=check` construction — §5
   require facts (R04).
6. Contract ([CanContract.can](/Users/vince/Projects/canlang/draft/CanContract.can:33)):
   `(row.previous==null or row.previous.parent==row.parent)` in a Given invariant — §3
   OR facts in invariant position (R06).

Supporting positives that must also pass: `null != p` reversed form; `(p != null)` extra
parens; `not (p == null)`; `require not (x == null)`; nested `a and (b or c)` distribution
of facts per §3; observation `condition -> true` followed by use of the narrowed path
(consistent with the existing sequence rule, GRAMMAR L393).

## 11. Invalid controls (all must still fail)

- IC1 unguarded: `p.field` / `f(p)` with no preceding null test on `p` — E3003/E3001 retained.
- IC2 read-before-guard: use of `p` textually before its `require`/`if` test, including
  uses in an earlier conjunct (`f(p) and p != null` fails on the left conjunct).
- IC3 OR-null: any use in an arm whose incoming fact is `p==null` fails — including
  `p != null or f(p)`, and null admitted by another OR arm: in
  `(p != null and ok) or fallback`, uses inside `fallback` get no `p` fact and uses after
  the join get nothing (§4 intersection).
- IC4 alias-write: fact on `p` dropped after `set q` where `q` provably or possibly aliases
  `p`'s container; use after a mutation-capable call over `p`'s owner fails.
- IC5 contradictory branches: `if c { test p != null; use } else { use p }` — the else-arm
  use fails; post-join uses fail unless every arm established the fact.
- IC6 zero-iteration: facts established inside a `for` body are unavailable after the loop;
  domains typed nullable before the loop stay nullable inside unless re-tested (R28 shape).
- IC7 safe-access comparisons invent nothing: no `?.`-chain comparison (`p?.f == q`,
  `p?.f != q`, `p?.f == null`, `p?.f != null`) supplies a narrowing fact about `p`
  (existing DESIGN L171 boundary retained for these shapes); only plain-path null tests
  under §§2-5 add facts.
- IC8 stale-row: a fact never converts into cross-statement currency — revision-gated uses
  still require their own checks (T32 territory, not this contract).

## 12. Opposing small-narrowing defense (retained) + costs

The defense for keeping narrowing small (the current DESIGN L171 position):

> "A true equality between a safe-access result and a statically proven non-null value
> narrows every traversed nullable receiver ... Equality to null, comparison to a nullable
> value and `!=` do not supply this true-branch narrowing fact; keep the necessary explicit
> checks."

Fair points: (a) small narrowing is easier to implement soundly around mutable records,
aliases, and compound conditions; (b) each new fact shape is a new soundness obligation at
every join, loop, and invalidation point; (c) explicit `?.`/`??` rewrites keep the unsound
surface minimal.

Why the contract is still proposed: the drafts use ordered null guards pervasively (R01-R06
plus CRM:30/43, Grant:260, Do:131, Event:72/77, Leave:86/129, Invoice:739-744); without
continuation facts, hundreds of coherent sites fail (E3003 alone: 951 diagnostics, most
with E3001/E3002/E3005/E2001 consequence cascades), and the only "fix" would be mass draft
rewrites the plan forbids. The rule is adopted as a typing fact with conservative
invalidation, not as permission or currency reasoning.

Costs of adoption: more flow bookkeeping in analysis; conservative rejection where alias
mutation is uncertain; the DESIGN L171 exclusion must be narrowed to the shapes IC7 retains
(visible spec delta, proposed below); T05 must prove every §11 control still fails.

## 13. PROPOSED normative wording (not adopted; reserved application later)

The following is draft text for a later exact-reservation edit of the normative docs. It
has no force until applied through the owning lane with affected-consumer review.

PROPOSED DESIGN delta (narrows the L171 exclusion; appends a continuation-facts rule):

> An explicit null test `p == null` / `p != null` (either operand order, any parentheses,
> `not`-negation canceling) establishes an ordinary typing fact about the resolved path `p`
> for the continuations in which the test is known to have succeeded. `and` evaluates left
> to right: the right operand receives the left-true facts. `or` evaluates left to right:
> the right operand receives the left-false facts. An `if` body receives the condition's
> true facts and the `else` body its false facts; after the join only facts valid on every
> reaching path survive. Statements after a successful `require` receive the guard's true
> facts. Facts key on resolved declaration and path; immutable locals persist while
> mutable-field facts drop at writes to the path or its container and at mutation-capable
> calls. Uncertainty resolves to rejection. These are typing facts only: they grant no
> read/grant/write authority, no caller authentication, and no cross-transaction currency.
> Safe-access (`?.`-chain) comparisons still supply no narrowing fact about the receiver;
> keep the necessary explicit checks there.

PROPOSED GRAMMAR note (no production change; semantic-check clarification):

> `require expr`, `if`/`else`, and Boolean operators perform the ordinary null-narrowing
> semantic check: no new syntax is introduced and no truthiness/coercion is added.

PROPOSED DECISIONS entry (records the ruling, not the mechanism):

> Adopted ordinary continuation facts for explicit null tests (T03): true/false facts for
> `==`/`!=` null tests flow through `and`/`or`/`not`, branches, joins, and successful
> `require`, keyed by resolved declaration+path with write/call invalidation. Typing facts
> only; presence grants nothing. Small-narrowing defense and costs retained in T03 evidence.

## 14. Interactions with existing rules (unchanged)

- Safe-access narrowing for `?.`-vs-proven-non-null equality is retained as is.
- `??` remains value fallback with no fact production (§4).
- `is`-narrowing (contract/union tests) is untouched.
- Observation `condition -> true` narrowing (GRAMMAR L393) is consistent with §5 and stays.
- T06 actor facts, T07 row facts, T08 selectors, and T32 read fences are separate rules
  that consume this contract's machinery; none is implied by it.

## 15. Acceptance mapping and checks

- Covers: true/false null tests (§2), reversed operands/parens/NOT (§2), AND-right/OR-right
  (§3), branch joins (§4), successful require (§5), resolved declaration+path keying (§6),
  immutable-local vs mutable-field (§7), write/call invalidation (§8), presence-grants-
  nothing (§9), six sampled patterns (§10), invalid controls incl. unguarded/read-before-
  guard/OR-null/alias-write/contradictory-branches/zero-iteration (§11), opposing defense +
  costs (§12).
- Checks run: repro from [root-causes.md](root-causes.md) (exit 10, 4524 diagnostics,
  identities match); read-only envelope + span analysis; DESIGN L129/L163/L165/L167/L171/
  L593, GRAMMAR L238/L393, and DECISIONS narrowing/queue/secret lines consulted read-only.
  No normative file was modified. Revision: `c4a9775` + draft `2d67312`.
- Consumer: T05 implements this contract; T05 acceptance re-runs the §10 positives and §11
  negatives as checker tests.

