# A5 phase 1 — T08 parity (A+F): bounded disputed-site adjudication proposal

Status: PROPOSAL (docs-only phase 1). No checker/emitter edits until the
coordinator approves these rulings. Lane F reviews next. R01 preserves final
acceptance (see `implementation/challenge-audit-run/monitor.md:79`).

Base: main `46a5ece` merged into `codex/remaining-lane-a-compiler`.

## 1. Normative base (read)

- T08 task (`implementation/challenge-audit-run/tasks.md:107-112`, COMPLETE):
  canonical parent/safe-metadata/money selectors agree across policy/UI;
  unknown leaf, invalid descent, disclosure, metadata-write controls retained;
  selector checking provides no flow or permission fact.
- R07/R08 (`implementation/challenge-audit-run/evidence/root-causes.md:151-180`):
  R07 intent is authorized history/relationship disclosure (`parent`, safe
  record metadata); opposing warns readable metadata must not become
  writable/grantable and permissive selectors must not expose protected
  identities. R08 intent is filtering by a money value leaf.
- DESIGN §4 (`DESIGN.md:306-312`): omitted `fields` grants ordinary fields
  and safe record metadata; leaf grants descend only through singular
  embedded typed values (never model/user/member references, arrays, JSON,
  files, secrets, actions); a leaf grant excludes container/ID/siblings and
  cannot grant another record's fields; viewer queries preserve the exact
  granted paths; denied leaves are withheld, never null.
- DESIGN §8.1 (`DESIGN.md:662-682`): delivery observations (`id`/`status`/
  `result`/`error`, plus normative `progress` for manifest-declared
  observable ops); mutable-observation dependencies in queries enroll the
  receipt revision in the read fence; type checking/observation support for
  progress remains unimplemented.
- Delivery leaf-grants contract (`design/delivery-leaf-grants-20261004.md:35-45`):
  explicit leaf paths, nullable-prefix presence only, no parent expansion,
  projection-not-handle.
- Disputed-site seed: monitor note (`monitor.md:79`) — compiler accepts
  policy `fields=id,version` while `policyPage.ts` prohibits them as
  readable grants; requires explicit contract evidence and aligned
  same-context tests before judging.

## 2. Comparison method

Same-context accept/reject of one selector through both implementations:

- A: `check_selectors` + `navigate_selector`
  (`compiler/src/analysis/types.rs:5212-5264`, `:5340-5482`) plus the
  policy-only E4012 reference check
  (`compiler/src/analysis/effects.rs:2051-2090`, call site `:1766-1771`).
- F: `resolveReadableSelector` (`packages/ui/src/policyPage.ts:338-384`)
  with `SAFE_READABLE_METADATA` (`:226-232`).

Read contexts compared: policy `fields=`, UI `columns=`/`filter=`/`search=`.
Out of scope (no F counterpart in the T08 surface): form/edit `fields=`
(T20b), board `by=`/calendar endpoints, `order=`, lock/unique/crud
(write contexts, `allow_reserved=false`).

## 3. Already-agreed inventory (no ruling needed)

Both sides accept: contained-model bare `parent`; safe metadata
`created/updated/created_by/updated_by/archived_at`; money `minor/currency`;
contract descent with nullable unwrap; explicit delivery leaves
`id/status/error/result` in policy `fields=` and UI `columns=`
(draft shape: `draft/CanApprove.can:18` `delivery.id,delivery.status`;
`columns=request.status,request.result,request.error` across drafts).

Both sides reject: unknown leaves; scalar-leaf descent; `parent` interiors
(`parent.t`, `parent.location`); reference/array/file/secret/action
interiors; metadata writes (compiler E2013/E3001; UI grants no writability).

Both sides confer: no narrowing fact, no permission, no writability
(compiler `t08_selector_grants_no_fact`; UI `fact:null/permission:null/
writable:false`).

Outcome-agreed, code differs: policy `fields=owner.id`-class reference
interiors — compiler denies via E4012, UI denies as unreadable. F may map
E4012 to its unreadable-reason surfacing; no checker change proposed.

## 4. Disputed sites and proposed rulings

### S1 — Bare `id`/`version` roots in policy `fields=` and UI selectors

- A: ACCEPTS everywhere read (`is_reserved_name` includes both,
  `types.rs:8045-8049`; pinned for policy at
  `compiler/tests/b4_check.rs:247-252`, unpinned for UI `columns=`).
- F: REJECTS everywhere (`policyPage.ts:380-381`; comment claims "no draft
  grants it via `fields=`").
- Draft evidence: the comment is wrong — `draft/CanEvent.can:41,46`
  explicitly grant bare `id,version` (organizer/finance + self reads).
  No draft uses bare `id`/`version` in `columns=`/`filter=`/`search=`.
- RULING (proposed): ACCEPT as terminal readable roots in policy `fields=`
  and UI `columns=`/`filter=`/`search=`. Authored draft grants beat F's
  stricter rule; no adopted T08 negative names bare `id`/`version`
  (the disclosure negative is account-contact class, `owner.email`);
  IDs/versions already circulate as opaque locators and concurrency tokens
  (DESIGN §5), so reading one's own row identity discloses nothing new.
- A change: none behavioral. Add pins: `id,version` accepted in UI
  `columns=`; `id.x`/`version.x` rejected (already rejected via the
  scalar-fail arm — pin the terminality).
- F change: admit `id`/`version` as terminal readable roots (no descent,
  no fact/permission/writability); same-context tests mirroring the A
  pins; correct the "no draft grants it" comment with the CanEvent cite.
- Opposing (preserved): UI rationale (identity/concurrency naming is for
  lookup, not grants); R07-opposing "protected identities"; DESIGN L310
  "not its container, ID or siblings" (embedded-leaf context, not root
  metadata). Flip: an adopted safety negative naming bare identity reads,
  or draft evidence that the CanEvent grants were unintended (T36 call).

### S2 — Typed delivery leaves in UI `filter=`/`search=`

- A: REJECTS (`selector_delivery_leaf` gate admits Policy/`columns=` only,
  `types.rs:5249-5258`; pinned at `b4_check.rs:704-712` as B4 scope).
- F: ACCEPTS (no context parameter; `policyPage.ts:433-454`).
- Draft evidence: none either way — no draft filters/searches by a
  delivery leaf. Churn-free in both directions.
- RULING (proposed): KEEP the exclusion (compiler-way). The T08 pin is
  landed, reviewed acceptance; per-row receipt observation in predicates
  enrolls fences per evaluated row (§8.1) and its lowering is unbuilt
  runtime work — the checker must not accept what emission cannot lower.
  F's own T20b posture ("delivery: notice field, no member") already
  restricts delivery members outside projections.
- A change: none behavioral. Fix the stale `DESIGN §7.1` citation in the
  gate comment (`types.rs:5249-5251`; §7.1 is retention — the rule is
  §8.1 + B4 scope) bundled with the phase-2 touch.
- F change: add a projection-vs-predicate context parameter to the
  readable path; reject delivery leaves in `filter=`/`search=`; tests.
- Opposing (preserved): DESIGN L312 "viewer queries preserve these
  exact paths" + §8.1 "queries enroll the fence" contemplate delivery
  leaves in queries; R08 generalizes filter-by-leaf. Revisit when
  predicate-observation lowering lands (B-side runtime work).
- JEV candidate (coordinator discretion): the balanced question is
  pre-drafted in §6. F review may also settle it.

### S3 — Unavailable-schema (opaque) interiors, incl. `request.progress.*`

- A: DEFERS silently (accepts, no diagnostic; `Opaque` arm,
  `types.rs:5395-5407`; pinned for policy + UI at `b4_check.rs:300-306`).
- F: REJECTS (`progress` under delivery rejected at
  `policyPage.ts:434-440`; no opaque/unavailable-schema representation
  exists in `ReadableFieldKind`).
- Draft evidence: `draft/CanChat.can:28-29` and
  `draft/CanCreative.can:29-30` grant `request.progress.state`,
  `request.progress.detail`, `request.progress.content` in policy
  `fields=` — accepted via deferral today. UI rejection contradicts
  these grants. DESIGN §8.1 makes progress normative for
  manifest-declared observable ops (with per-read enforcement), not
  blanket-denied — though its checking/observation support is
  explicitly unimplemented.
- RULING (proposed): DEFER on both sides for unavailable-schema bases.
  F cannot out-reject the checker on paths whose schemas have not
  landed (T13/T14), or authors get contradictory verdicts.
- A change: none (deferral pinned; opaque delivery-leaf terminality
  already enforced at `types.rs:5399-5405`).
- F change: represent unavailable-schema (opaque) models/fields and
  defer (accept silently) rather than rejecting `progress`/unknown
  interiors on them; same-context tests mirroring
  `t08_opaque_interior_defers` (CanChat:28 shape).
- Conditional contract item: if the artifact schema erases
  unavailable-schema marking so F cannot distinguish opaque from
  declared deliveries, A emission must preserve it (phase-2 A/F
  contract change, B7-adjacent).
- Follow-up (not A5): declared-schema `delivery.progress.*` handling
  aligns with the T25 observation-grant rule (E4012-class) when
  progress checking lands; F's current rejection reason is preserved
  as that follow-up's starting point.

### S4 — Reference interiors in UI `columns=`/`filter=`/`search=`

- A: ACCEPTS (navigation resolves `user`/`member` interiors,
  `types.rs:5435-5454`, mirroring expressions; E4012 visits Policy
  nodes only — single call site `effects.rs:1770`, verified no UI
  call site; UI `columns=`/`filter=`/`search=` go only through
  `check_selectors`, `types.rs:6649-6654`). Covers declared
  `owner.id`-class chains AND reserved-root `created_by.id`/
  `updated_by.id` (the E4012 helper models reserved heads at
  `effects.rs:2119-2128`, but never runs on UI nodes).
- F: REJECTS (reference traversal at `policyPage.ts:455-461`;
  metadata terminal at `:371-379`).
- Draft evidence: no draft uses user/member interiors or
  `created_by.X`/`updated_by.X` in any UI selector list (verified by
  grep over `columns=`/`filter=`/`search=`; dotted usages are money
  leaves, contract descents, delivery leaves, and already-rejected
  `parent.*`/`project.*` interiors). Expected churn-free, but the
  implementation phase must prove it (below).
- RULING (proposed): REJECT (UI-way). A UI selector naming a path no
  policy could ever grant (E4012 in policy context) is dead at best:
  it either renders denied data or always withholds. DESIGN L310
  forbids reference interiors; L312's exact-paths rule cuts against
  UI naming ungrantable paths.
- A change: extend `check_leaf_grant_reference` to UI table nodes
  (`columns=`/`filter=`/`search=`), same E4012 code with a
  context-aware message; pins for declared (`owner.id`) and
  reserved-root (`created_by.id`) sub-cases in UI contexts.
  Verification gate: corpus recount must show ZERO new UI-context
  E4012 firings, else this site re-opens (draft intent beats the
  ruling, T02-style).
- F change: none (already rejects). F review should confirm the
  E4012↔unreadable mapping covers UI contexts for error surfacing.
- Opposing (preserved): T08's "UI agrees with policy" was pinned via
  navigation agreement, and expressions legitimately read `owner.id`;
  a UI column could be seen as expression-like. Flip: draft or
  consumer evidence needing reference-interior UI selectors.

## 5. Safety negatives preserved (all sites)

Unknown leaf / invalid descent / unauthorized traversal still fail;
metadata writes still rejected; selectors confer no fact, permission,
or writability; denied leaves withheld never null; delivery
result/error/file/lifetime checks untouched; E4012's
no-directory-authority rule extended, never narrowed.

## 6. Pre-drafted JEV question (S2 only, coordinator discretion)

Genuinely difficult only if F review disputes S2. Verified context:
no draft usage; landed T08 pin excludes delivery leaves from
`filter=`; DESIGN L312 + §8.1 contemplate delivery leaves in queries
with fence enrollment; predicate-observation lowering unbuilt.
Balanced alternatives: (a) keep exclusion until lowering lands
(fail-closed, pin stands); (b) accept per DESIGN with fence
enrollment (normative-text-first). Three independently worded
equivalent requests would be written at dispatch time; results
advisory only.

## 7. Phase-2 implementation gates (after ruling approval)

Per approved ruling: focused pins first, full `cargo test`, `clippy`,
corpus recount with per-family attribution (S4: zero-new-firings
rule; S1: CanEvent grants stay green), F same-context tests landed,
then joint report. No checker/emitter edits before approval.
