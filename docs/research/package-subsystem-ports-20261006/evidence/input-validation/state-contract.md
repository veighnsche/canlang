# V01.3 — State sequencing and bridge contract

Task: V01.3 (lane `V-state`, wave 1, after `C01.ready`). Produced
2026-10-06T08:39:11Z by lane F session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9.
Planning record only; no implementation authorized.

- Head verified: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06`
- Line anchors refer to head; the implementation must refresh them rather
  than copy stale numbers.
- Companion: `contracts.md` (`state-generated/v1` profile),
  `caller-inventory.json` (state admission entries).

## Frozen mutation sequence (admit — admission.ts:299+)

Verified call order inside `admit`; every owned-input extraction must
preserve it exactly:

1. `store.readRevision()` — fence checkpoint revision first.
2. `hashInputs(inputs)` (replay.ts) — raw hash over the untouched inputs.
3. `store.readReceipt(receiptIdentityFor(context))` — existing receipt
   lookup; a hit short-circuits to replay (rejected receipts rethrow
   code/message; `result ?? null` — the receipt shape carries no fields).
4. `assertOperationIdAge(...)` — replay OR age: replayed calls never
   reach the age check; fresh calls must pass it.
5. `memberships.findMembership(...)` + `evaluateBy(def.by, ...)`
   (roles.ts) — membership fetch then `by` evaluation, including the B4
   by-aware commit-time revocation rule at head.
6. `validateCallInputs(def, inputs)` — normalize/ref-extract: the owned
   `state-generated/v1` validation point. Nothing before this step may
   normalize, fill defaults, or traverse with a new-plan lookup.
7. Ordered `store.load(ref.model, ref.id)` — ref loads in validated
   order after validation.

Invariants: raw hash stays exactly where it is (never after
normalization); no eagerly allocated Rust validation session is needed
to replay; an existing receipt returns before any plan lookup, budget,
conversion, or normalization can fail; persisted receipt digests are
unchanged; rejected receipts commit fenced with empty effects (S5) and
respect the fence on contention (T32b-wire rule).

## Read path (invokeRead — invoke.ts:431+)

Read auth-first is frozen: `evaluateBy(def.by, ...)` precedes
`validateCallInputs(def, ...)` (verified order). Reads reject through
the shared implementation so reads and writes agree; read operations
cannot run through mutation `invoke` (explicit `validation` refusal).
Generated reads route via `invokeReadCanonical`
(cloudflare `runtime/invoke.ts`); generated mutations via
`invokeMutationCanonical` — both are existing canonical bridges, not
new seams.

## Bridge contract (OperationInvoker)

- Contract: `OperationInvoker` — `invokeMutation(envelope, identity)` /
  `invokeRead(envelope, identity)` returning `MutationOutcome` /
  `ReadOutcome` (`interfaces/src/ports.ts:97`). The identical interface
  at `worker/assembly.ts:155` is a documented mirror, replaced by the
  real import at the interfaces join.
- Canonical bridge: `buildInvoker` (`worker/assembly.ts:753`) constructs
  the audited invoker from artifact + store + identity. Only this
  audited bridge may ever associate a protected raw graph with
  admission, and only through a fully audited path that never exposes
  the protected graph to untrusted callbacks.
- Protected-graph rule: the owned root must never reach an untrusted
  callback before conversion. Initial safe design: retain a private
  protected raw snapshot while the public envelope carries an ordinary
  detached materialization. Caller mutation cannot modify the protected
  snapshot; a modified public copy loses the token (no inertness
  inspection). An arbitrary injected `OperationInvoker` (as tests
  inject) never receives a transferable token — inputs through an
  unverified callback use legacy state validation.
- No provenance inference: TypeScript types, freezing, schema tags,
  property inspection, or structural validity never grant provenance.
  Loader-derived channels (incl. delivery-field membership) stay with
  the state owner; public `ReadonlyMap` types/copies do not establish
  immutable private provenance.

## Legacy retainers (stay TS)

Unproven inputs; generated-handler/internal calls (`invokeFanoutChild`,
executor callbacks, internal direct `invoke`/`invokeRead` callers);
forms; SDK objects without producer evidence; interim identity paths;
model-pipeline/emitted-callable defaults; receipt replay/hash itself.
These are explicit scope boundaries, not migration debt.

## Owner review status

Required (recorded, not assumed): state owner (sequence, replay/hash
freeze, array-fill/copy semantics, loader channels), interfaces owner
(invoker contract + bridge audit), cloudflare owner (canonical
mutation/read bridges, assembly delegation).
