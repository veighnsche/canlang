# Finite V01 consumed hook contract — B, 2026-10-07

Packet `first:R2:V01-consumed-owner-contracts`; activation base
`c6896fd2dea782d8ed6412769337b76eb899ca53`. Static source review only.
This is a **proposal pending actual R1 values and Codex state/interfaces
review**, not a V02.6 implementation, public adoption API, native parity
claim, owner ACK, or all-V01 gate. Original direct V02.1/V02.2 credit stays.

## Observed routes and the recursion defect

`schema.ts:1392` accepts unknown descriptors. Pass 1 reads their fields,
type IDs, bounds, default presence and raw defaults; pass 2 (`1721–1771`)
validates explicit-complete defaults, trims before bounds, then freezes
fields/sections and returns a fresh schema (`1793–1798`). Public defaults
are decoded canonical values, including Decimal instances. Success does
not certify the caller's descriptor; only the fresh factory output is a
possible schema producer. No factory recording hook currently exists.

`validateValue` first asserts schema, then checks mode, parses the type ID,
and evaluates. `validateOperationInput` asserts schema before operation
lookup/framing. `decodeValue` parses before decoding; `encodeValue` parses
before encoding. These orders and all internal recursion stay canonical.

Current `validatePreparedValue` (`prepared/validation.ts:433`) resolves a
plan, reads the entire candidate schema in `crossCheckSchema`, checks
coverage, then calls **public** `validateValue`. Prepared codec calls also
end at **public** decode/encode. Redirecting those public functions to the
current prepared wrappers recurses. Running their cross-check first adds
schema property reads/ownKeys/parse operations and may change the first
exception on arbitrary schemas. Getter-safe comparison is not a proof of
proxy inertness: descriptor/prototype/ownKeys operations can trap, array
snapshotting uses `.map`, and error digesting reads `constructor`.
These wrappers/comparators remain explicit opt-in preparation/oracles;
they are not the production admission gateway or unknown trace oracle.

## Selected private boundary (proposal PH1)

Keep every existing public export/signature and its full unknown TS path.
No public entry selects a prepared plan in V02.6. The eventual private
entry accepts only a values-owned opaque request capability, not arbitrary
owner/schema/plan/wire arguments and not a caller-provided evaluator.

The finite non-recursive implementation contract is:

1. A **non-public values-owned core module** holds the four whole existing
   bodies: `validateValueTsCore`, `validateOperationInputTsCore`,
   `decodeValueTsCore`, `encodeValueTsCore`. Existing exported functions
   delegate once to the corresponding core with original arguments.
   Core validation retains schema assertion → mode → type parse →
   evaluation; operation retains schema assertion → operation lookup →
   argument framing/evaluation; wire retains parse → conversion. Helpers
   and schema-default normalization call these same non-dispatching
   routines, never a public prepared façade. No changed check, extra
   traversal, duplicate parse, or reordered default/bounds operation.
2. Private owned entry performs **only private identity-map/liveness
   admission** before evaluation: issued request, live owner/generation,
   exact schema/descriptor and operation/type/profile binding, protected
   producer root/direction identity. No structural cross-check of an
   unknown candidate, `Object.keys`, getter/proxy introspection, copying,
   type-string parsing, or registration during admission. Coverage and
   copied metadata were completed under the true owner at preparation.
3. Ineligibility produces a private tagged `abstain` before semantic
   evaluation. The host calls the original TS core once at the existing
   validation position. Eligible requests invoke the selected trusted
   core once. Native selection is later profile/release-gated; V02.6 may
   only use the canonical TS core. No catch-and-retry of `SchemaError`,
   `ValueError`, arbitrary thrown values, or failures after evaluation
   begins. An internal invariant failure is surfaced, never replayed.
4. Core entry symbols and mint/record seams must not be exported through
   `schema.ts`/`wire.ts` (their index uses wildcard exports), package
   exports, stdlib, or installed-client API. A future internal module/file
   placement needs R1's exact ownership/assembly agreement. No source
   allocation or shared-file write is authorized by this evidence.

This chooses a real private core boundary; merely renaming the current
public calls or adding an in-progress recursion flag does not meet PH1.

## Success-only provenance and complete identity (proposal PH2)

Factory lineage and adoption eligibility are separate records. Record the
exact fresh normalized schema only after all existing validation/freezing
succeeds. Use an internal identity-only recorder, with no read of the
source descriptor, output `kind`, or revision accessor. Never automatically
register a plan or impose plan-copy/budget errors on public normalization.
If native preparation cannot support a valid schema, keep public success
and abstain before evaluation. Only genuine owner producer code can mint
capabilities; exported `recordFactoryProvenance(schema, revision)` is a
preparation test seam today, not sufficient production authority.

The private owner record copies ordered metadata **after the owning
factory/loader succeeds** and binds all of:

- source producer identity and exact normalized-schema identity; descriptor
  intake identity/load instance and exact operation identity;
- artifact/load identity (actual owner token, optional owner-verified
  content revision), artifact/execution/state/value/wire schema versions;
- ABI and profile version, trusted backend instance, owner generation;
- request issuer/ID, exact protected raw root, direction/type/mode and
  single live request lifetime; disposed/released/foreign scopes abstain;
- ordered type/bounds/trim/default/required/ref/error-projection metadata
  copied by the owner, including state loader-derived array/delivery
  channels. A public map/readonly type or frozen tag is never authority.

`artifact-${ARTIFACT_VERSION}` in the older prepared-plan handoff is only
an observed **format-version proposal**. It cannot distinguish artifacts,
loads, requests, schemas or disposal. The current string scope/g0 handle
is preparation evidence, not this complete contract. No source-identity
cache keyed only by version or operation/type string is admitted.

Successful owned decode/validation results may mint result lineage only after
the canonical core completes and only through its true owning producer;
encode admission requires that result capability and matching type/request
binding, never a structural `CanValue` tag. A failure creates no output
capability. Primitive roots/results are bound in the private issued request
record with exact scalar representation (including f64 bits), not branded
by boxing or a public shape. Standalone public unknown calls remain legacy
and do not automatically adopt or create transferable request authority.

Commit provenance/plan registries only after the whole producer succeeds.
State `loadExecutionDescriptorSet` builds individual defs before it checks
late `inputArrays` keys; future private registration must stage these
records and publish only at its final successful return. A failed later
operation or policy/array-marker check grants no surviving capability.
Loader `by`/`when` callbacks may see ordinary metadata at their existing
positions; they may never see protected request graphs or mint authority.

## Defaults and canonical owner authority (proposal PH3)

The canonical schema's literal default is the identity authority:
`omittedField` returns `field.default`; implicit arrays use `EMPTY_ARRAY`;
update omissions use `UPDATE_OMITTED`; server/derived omissions drop keys.
A private `DefaultRef` must resolve the **same canonical factory-produced
immutable object**, not merely a structurally equal copy, across repeated
calls/plans for that schema while its owner lives. Copy metadata, but keep
canonical-default handles in the owning registry. Only audited canonical
factory/carrier output may receive such a handle; unsupported carriers
abstain without adding a public normalization failure. Descriptor raw
objects never become shared default references.

Current plan registration copies default objects, and `copyFrozenValue`
rejects class instances (including canonical Decimal) and numbers. Its
same-ref repeated resolution tests do not establish equality with the
schema's fallback identity or coverage of all successful schema carriers.
PH3 is a required integration correction, not a newly implemented fact.
Exact-values owns Decimal/numeric/carrier codecs; no second authority is
created. Default pass-2 accessor order, trim-before-bounds, explicit nested
completeness and normalized result freeze/identity all remain unchanged.

## Protected graph and consumed state/interfaces boundary (proposal PH4)

Successful capped HTTP JSON parsing can create a private request lineage
at producer creation, preserving cap/TextDecoder/JSON.parse and host number
semantics. Public `parseJsonBody` signatures stay unchanged. HTTP's `_csrf`
removal/spread and MCP's `operation_id` removal/spread create new objects:
only an audited owner-internal derivation can carry lineage onto the exact
business root. Copying/tagging/spreading the public envelope cannot carry
or restore a capability. Public arbitrary `OperationInvoker` sees only
ordinary detached data and always follows legacy state validation; it
never receives a protected root or transferable token.

Only the verified canonical bridge can retain the request privately to
state's existing validation point. The protected root is immutable/private
and inaccessible to callbacks; no identity or permission callback is a
provenance source. Mutation hashing must hash the same untouched submitted
business values before any normalization and remain outside native
validation. If audited end-to-end isolation cannot be proved, abstain.

MCP SDK args lack a demonstrated producer boundary; a deployed MCP
factory alone confers no graph provenance. Forms and generated UI form
projection remain legacy (including JSON-or-string fallback and existing
assignment behavior). Sealed handle mode stays separate TS orchestration.

State mutation order is readRevision → hash(raw) → readReceipt → replay
OR age → membership/by → normalize/ref-extract → ordered loads. No plan,
budget or conversion can fail a replay before receipt return. Read auth
precedes validation. Commit-time membership/revocation/fence behavior,
aggregate error order, explicit null/present-undefined, ordinary-array
fill, strict version parsing, and ordinary shallow-copy output stay exact.

## Review and advice receipts

Actual acceptance is **pending** R1 values review (through worker A) and
Codex state/interfaces review of PH1–PH4. No ACK is inferred from content.
C03/native lifetime/transport and later V08/C04 delivery proof are separate
consumers and remain unreleased. This finite record does not revoke direct
V02.1/V02.2 credit or invent an all-V01 barrier.

JEV advice: three independently worded equivalent `choice` requests with
verified balanced facts compared private-only core entry, public identity
selection with separated core, and deferring all hooks. All chose
`private_only`, confidences 0.96/0.97/0.97 (probabilities 0.97/0.98/0.98).
Model `jev-1.13.0`; no disagreement. Advice supports PH1, does not approve
PH2–PH4 or replace owners/tests. Full requests/responses and source hashes:
`/private/tmp/canlang-rust-port-codex-first-20261006T231809Z/packets/R2-V01/`.
Remaining uncertainty: exact internal source factoring/placement and all
native admission/carrier/transport compatibility need owner review and
future trace gates; none are claimed implemented here.
