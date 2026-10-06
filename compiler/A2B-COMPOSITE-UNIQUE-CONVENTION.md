# A2b: composite-unique convention — evidence + proposal (for B contract review)

Compiler-side draft (A2b scope, rev2 vs `9c1d35c`, base `d93fc4b`).
No checker/emitter edits. Implementation follows a later grant.

## 1. Corpus evidence (1 site)

`evidence/G-b8-raw-diags.json` row 13, `CanDo.can:36`:

```can
unique WorkView fields=account where=row.current
```

Single field + conditional predicate. DESIGN:131 fixes the
semantics: `unique Model fields=a,b [where=expr]` declares composite
uniqueness "within its containing parent, team, or app. Null values
do not participate unless the predicate explicitly includes them.
Retained archived rows participate." DESIGN:578 adds enforcement
posture: stored uniqueness "remains reserved until physical
disposal"; admission returns retryable `busy` (never silent success)
when a retention-blocked key cannot be disposed.

Evidence note (rev2, per B caveat): the raw-diags file lives in the
generation scratch evidence dir (lane-G evidence), not in the lane-A
repo tree — the "1 site" count is cited from there. The DESIGN
citations above verify independently.

## 2. What the compiler already carries

- Fully decoded IR: `IrUnique{fields, where_predicate, span}`
  (`ir.rs:315-322`); `where=` is an ordinary row predicate.
- The emitter reports `E6008` at `js.rs:3774-3781` ("no §13 member
  shape") and omits the constraint from `appDefinition.models`.
- **Partial leak**: the T15a descriptor path already folds
  composites into `uniqueKeys:["a,b"]` (comma-joined,
  `js.rs:4851-4853`) alongside field-level `unique` modifiers —
  but drops the `where=` predicate and the field structure. Any
  consumer reading `uniqueKeys` today sees the fixture key as an
  unconditional single-field key, which is wrong on both counts.
  Rev2 ruling (per B): SHED composites from `uniqueKeys` (see §4).

## 3. Proposal: sparse `uniques` member + registry rule

Add a sparse member on the model entry in `appDefinition.models`,
with the predicate as a registry rule reference:

```js
"shop.M": {
  ...,
  uniques:[{fields:["account"], where:"WorkView.unique.1"}],
}
```

- `fields`: dotted selector paths in source order (from `IrUnique`).
- `where`: registry id of an `async(c,row)=>bool` rule, emitted
  next to invariants; absent when no `where=` was authored.
- Shape precedent (rev2 CORRECTION, per B): the rev1 `locks:` mirror
  claim was wrong — emitter `locks:` is flat string ids
  (`js.rs:3742,4219`). `uniques` is a NEW object-member shape; the
  real registry-ref precedent is `invariants:[ids]`
  (`js.rs:3732,4211`). Do NOT extend `uniqueKeys` to objects
  (string-typed in `CanonicalModelDescriptor.uniqueKeys` +
  `ArtifactModel.uniqueKeys`, consumed by T16/T17 L3 intake).
- Registry conditions (per B): namespaced rule ids
  (`<Model>.unique.<n>`); rule purity/signature documented (row
  predicate, no writes).
- Enforcement stays B's runtime contract: admission-time key check
  vs the published key + predicate, DESIGN:578 `busy` semantics
  (nulls excluded unless predicate includes; retained archived
  rows participate; reservation until disposal; bounded attempt
  then retryable `busy`). Reservation sits inside the fence/commit
  path, not a row hook. The `where` rule MUST resolve server-side
  in the admission runtime (T04b/I00 loader-join), never from the
  envelope. SCOPE FLAG: this is NEW B work beyond accepted
  B1-B5/B7 — implemented only under scoped dispatch + grant.
- Scope (per B): NO extra scope tag. The §13 model entry already
  publishes `parent`/`scope:"app"` (`js.rs:3715-3725`); each
  `uniques` entry INHERITS its enclosing entry scope — document
  this invariant, and keep scope members on every entry carrying
  `uniques` (no scope-less model entry may carry `uniques`).
- T15a migration (per B): `uniqueKeys` = field-level names only;
  the comma-joined composite form is actively false and now a
  documented contract (`artifact.ts:316`), load-bearing for T16/T17.
  The artifact.ts:316 comment update ships in the same
  implementation commit (contracts package, owner lane to edit);
  C re-verifies the T16 fold for comma-splitting (none found in
  `packages/` outside tests).

## 4. B review answers (vs `9c1d35c`, ADOPTED rev2)

1. Member shape: CONFIRM sparse `uniques:[{fields,where?}]` as a
   separate member (with the §3 locks/invariants correction).
2. `where` form: CONFIRM registry rule reference, namespaced ids +
   documented purity (vs inline expression or a second member).
3. Enforcement: CONFIRM admission-time check in B's runtime
   (DESIGN:578 busy semantics, fence/commit path, server-side
   rule resolution) — flagged as new B work under later dispatch.
4. Scope: NO tag — inherit enclosing entry scope; invariant
   documented (§3).
5. T15a: SHED composites from `uniqueKeys` + `artifact.ts:316`
   comment migration in the same commit.

## 5. Rejected alternatives

- Desugar to `invariant`: rejected — uniqueness is a cross-row key
  reservation with disposal semantics (DESIGN:578), not a row
  predicate; an invariant cannot reserve a key against concurrent
  writers.
- Silent `uniqueKeys`-only publication: rejected — it drops
  `where=` and misleads consumers (see §2); composites shed from
  `uniqueKeys` per B's call (§4.5).
