# A2b: composite-unique convention — evidence + proposal (for B contract review)

Compiler-side draft (A2b scope, base `d93fc4b`). No checker/emitter
edits. Implementation follows B's review + a later grant.

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

## 3. Proposal: sparse `uniques` member + registry rule

Add a sparse member on the model entry in `appDefinition.models`,
mirroring the `locks:[{fields,when?}]` shape, with the predicate as
a registry rule reference (same pattern as invariants):

```js
"shop.M": {
  ...,
  uniques:[{fields:["account"], where:"WorkView.unique.1"}],
}
```

- `fields`: dotted selector paths in source order (from `IrUnique`).
- `where`: registry id of an `async(c,row)=>bool` rule, emitted
  next to invariants; absent when no `where=` was authored.
- Enforcement stays B's runtime contract: admission-time key check
  before write (DESIGN:578 `busy` semantics); the compiler only
  publishes the key + predicate.
- `uniqueKeys` keeps its current string form for descriptor
  consumers (no silent widening there); B decides in review whether
  it should also gain structure.

## 4. Questions for B

1. Confirm the member name/shape (`uniques:[{fields,where?}]`)
   versus extending `uniqueKeys` entries to objects.
2. Confirm the `where` predicate as a registry rule reference
   (vs inline expression or a second member).
3. Who enforces, and where: admission-time check in B's runtime
   against the published key + predicate?
4. Key scope confirmation: containing parent/team/app per
   DESIGN:131 — any key-identity input the compiler must publish
   beyond fields + predicate (e.g. scope tag)?

## 5. Rejected alternatives

- Desugar to `invariant`: rejected — uniqueness is a cross-row key
  reservation with disposal semantics (DESIGN:578), not a row
  predicate; an invariant cannot reserve a key against concurrent
  writers.
- Silent `uniqueKeys`-only publication: rejected — it drops
  `where=` and misleads consumers (see §2); the current leak
  should either gain structure or shed composites, per B's call.
