# T01 root-cause ledger

Task T01 (L1). RQ01/RQ02. Status: evidence for review; no draft or checker edits made here.
Base: branch `codex/challenge-audit-implementation`, HEAD `c4a9775` (plan base `c681d86`).
Draft submodule: `2d67312` (clean, read-only in this task).

## Repro command and result

Command (saved plan wrapper; sources = 52 sorted `draft/**/*.can`):

`compiler/target/debug/can check --catalog=packages/values/dist/catalog.json --format=json <52 sources>`

- Wrapper exit 0; checker exit **10**; envelope `complete=true`, `omitted=0`, `DIAGNOSTICS=4524`.
- Identities (all match the plan baseline exactly):
  - binary `compiler/target/debug/can` sha256 `f9bc737af0635975655970121df0cd7471b72c7e9e47c2490c7a6bf18bd86a8e`
  - catalog `packages/values/dist/catalog.json` sha256 `cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62`
  - ordered draft bundle sha256 `eca2b18a1d047dca641a5663713037c63c669cd59d50fdd1630c6e14202db762`
- Code counts revalidated identical to the plan table (top: E3001 1301, E2001 1122, E3003 951,
  E2013 403, E3015 208). All site line numbers below were revalidated against this run.

Heavy-lock protocol: lock acquired before the repro, released immediately after; no other
heavy command was run. No `cargo`/`npm`/`tsc` invocation was needed (evidence-only task).

## Reading guide

- Each site records: file/span/context, one-sentence author intent (drafts authoritative),
  root vs consequence, exactly one a-e bucket, strongest opposing case, confidence + flip
  evidence, owner, and positive/negative proof.
- Diagnostic codes are not uniform defects: the same code appears as root in one site and as
  consequence in another (see chains C1-C7). Counts are not independent defects.
- `b4_check.rs` was used only as a navigation aid for existing coverage, never as authority.

## Root sites

### R01 — Affiliate if/else null narrowing (E3003 x13)

- Site: [CanAffiliate.can](/Users/vince/Projects/canlang/draft/CanAffiliate.can:88)
  `let prior=first(...SourceEvidence...)`; L89 `if prior==null` create-branch L90,
  `else` branch L92-L96 dereferences `prior.value.*`, compares `prior.value.revision`,
  and `set prior {...}` at L96. Diagnostics: 12x E3003 on `prior` + 1x E3001 set-target.
- Intent: consume the existing evidence row only in the continuation where the null test
  established its presence.
- Root (missing ordinary continuation facts), not consequence: no earlier failure explains it;
  the `else` of `x==null` carries no `x!=null` fact.
- Bucket: **b**. Owner: L1, T03 contract + T05 implementation.
- Opposing: small narrowing is easier to keep sound around aliases/mutation; DESIGN L171
  currently excludes null equality from narrowing facts.
- Confidence high. Flip: a sampled read executes before its guard, or the guarded value can
  change without an enforceable invalidation boundary.
- Positive proof: L89-L96 checks clean under the T03 contract. Negative proof: unguarded
  `prior.value` with no test still fails E3003; a write/alias-invalidation between test and
  use still fails.

### R02 — Approve AND-continuation (E3003 cascade + E2001)

- Site: [CanApprove.can](/Users/vince/Projects/canlang/draft/CanApprove.can:264)
  L266 `let notice=first(Notice...)`; L267 `if notice!=null and notice.delivery==null`;
  L268 `send Mail.send {to=notice.recipient,...}` with a `when=` guard re-reading
  `notice.*`; L269 `set notice {delivery=attempt}`.
- Intent: deliver a fetched review notice only when it exists and has no delivery yet.
- Root: AND's right operand and the guarded body receive no left-true facts. Consequence
  cluster on L268: 15x E3003 plus E2001 `decision`/`pending` (bare enum cases lose their
  expected type once the receiver check fails; see C1) and E3019 (separate T13 root, R12).
- Bucket: **b**. Owner: L1, T03/T05 (E3019 part owned by R12).
- Opposing: same small-narrowing defense as R01; additionally the `when=` guard re-reads
  `notice` after a `send`, so invalidation order matters.
- Confidence high. Flip: `notice` observably mutated between L267 and L269 without a
  checkable boundary.
- Positive: L267-L269 clean under T03. Negative: deleting the `notice!=null` conjunct keeps
  L268 failing; `notice==null or <use>` still fails (OR-null control).

### R03 — Chat require-continuation (E3003 x9 + E3001 x4)

- Site: [CanChat.can](/Users/vince/Projects/canlang/draft/CanChat.can:71)
  L72 `let allowance=first(Allowance...)`; L73
  `require allowance!=null and allowance.active and allowance.running<allowance.parallel`;
  L75/L78/L80/L81 use `allowance.spent/held/cap/parallel/active`.
- Intent: admit token reservation only after establishing an existing, active, non-saturated
  allowance, then consume its counters.
- Root: successful `require` carries no facts forward (also AND-right facts missing inside
  L73 itself). Consequence: E3001 `set target ... found Allowance?` (L80) and
  `'allowance': expected Allowance, found Allowance?` (L78).
- Bucket: **b**. Owner: L1, T03/T05.
- Opposing: require-conditions can be long conjunctions; carrying facts past a later failing
  conjunct must not certify code that never runs (facts apply only where evaluation reached).
- Confidence high. Flip: a use site provably unreachable-after-success, or a mutation of
  `allowance` between L73 and L80.
- Positive: L72-L83 clean under T03 (except separate E2001/E3019 std/capability roots).
  Negative: use-before-require ordering still fails.

### R04 — Check require-continuation on lookups (E3003 + E3001)

- Site: [CanCheck.can](/Users/vince/Projects/canlang/draft/CanCheck.can:65)
  L67 `let check=first(Check as row where row.id==event.value.check)`; L68
  `require check!=null`; L69-L76 read `check.token/enabled/state` and
  `create Transition {parent=check,...}`.
- Intent: process a heartbeat only for a known check, then read its token and state.
- Root: same missing require-facts rule as R03. Consequence: E3001 `'parent': expected
  Check, found Check?` (L73/L75) and E2001 bare cases `up/down/late` (C1).
- Bucket: **b**. Owner: L1, T03/T05.
- Opposing: `check` is a stored record that concurrent work could change; facts must be
  check-time typing facts, not cross-transaction staleness promises (fencing stays with T32).
- Confidence high. Flip: same class as R03.
- Positive: L67-L81 clean under T03. Negative: dropping L68 keeps L69+ failing.

### R05 — OR/AND continuation family across sinks (E3003)

- Primary site: [CanCRM.can](/Users/vince/Projects/canlang/draft/CanCRM.can:30)
  invariant `Activity: (row.appointment==null or (row.kind==tour and ... row.appointment.customer
  ...)) and (row.revision==null or (... row.revision.parent ...))` — 6x E3003.
- Same root at: [CanCatch.can](/Users/vince/Projects/canlang/draft/CanCatch.can:91)
  `(task==null or task.location==null or can_work(actor,task.location))`;
  [CanGrant.can](/Users/vince/Projects/canlang/draft/CanGrant.can:260)
  `(override_reason!=null and trim(override_reason)!="")` (E3005 consequence);
  [CanDo.can](/Users/vince/Projects/canlang/draft/CanDo.can:131) Then-sink
  `task.due!=null and (... local_date(task.due,...) ...)` (E3005+E3002 consequences);
  [CanEvent.can](/Users/vince/Projects/canlang/draft/CanEvent.can:72)
  `(event.venue==null or event.venue.venue_state==confirmed)` (E3003 + E2001 `confirmed`);
  [CanCRM.can](/Users/vince/Projects/canlang/draft/CanCRM.can:43)
  `row.location==null or can_work(actor,row.location)` (E3001 consequence);
  [CanCheck.can](/Users/vince/Projects/canlang/draft/CanCheck.can:53)
  `(check.location==null or can_work(actor,check.location))` (E3001 consequence).
- Intent (each): take the nullable branch only when the preceding disjunct established
  presence; pass non-null values into typed calls.
- Root: OR's right operand receives no left-false facts; AND's right operand receives no
  left-true facts. Applies uniformly in Given invariants, When guards, and Then filters.
- Bucket: **b**. Owner: L1, T03/T05.
- Opposing: OR-arms are easy to misread (`==null or <use>` is the dangerous shape the
  contract must still reject); short-circuit evaluation order must be the semantic basis.
- Confidence high. Flip: a cited arm that can evaluate without its left sibling (no
  short-circuit) would invalidate the rule for that operator.
- Positive: all cited lines clean under T03. Negative: `x==null or f(x)` still fails;
  `x!=null` in one OR arm never leaks into a sibling arm.

### R06 — Contract invariant continuation (E3003)

- Site: [CanContract.can](/Users/vince/Projects/canlang/draft/CanContract.can:33)
  L33 category-implication invariant (no diagnostic) and L34
  `(row.previous==null or row.previous.parent==row.parent) and (not row.executed or
  (row.snapshot!=null and ...))` — E3003 on `row.previous.parent`.
- Intent: require same-agreement previous terms only when a previous term exists, and
  execution evidence only when executed.
- Root: OR-right facts missing (same rule as R05), in a Given invariant.
- Bucket: **b**. Owner: L1, T03/T05.
- Opposing: invariants quantify over stored rows; facts must not leak across rows or
  survived failed conjuncts.
- Confidence high. Flip: evidence that invariant disjuncts do not short-circuit.
- Positive: L34 clean under T03. Negative: `row.previous.parent` outside the guarded arm
  still fails.

### R07 — parent/safe-metadata selectors (E2013)

- Primary site: [CanApprove.can](/Users/vince/Projects/canlang/draft/CanApprove.can:18)
  policy fields list: `unknown member 'parent'/'created_by'/'created'/'updated_by'/'updated'/
  'archived_at' on model Notice`. Same root at [CanContract.can](/Users/vince/Projects/canlang/draft/CanContract.can:32)
  (NoticeDelivery), [CanCheck.can](/Users/vince/Projects/canlang/draft/CanCheck.can:22)
  (Notice), [CanChat.can](/Users/vince/Projects/canlang/draft/CanChat.can:28) (Run).
- Intent: disclose authorized history/relationship fields (`parent`, safe record metadata)
  through policy field grants.
- Root: selector checking uses a narrower path than ordinary member lookup, which already
  recognizes implicit parent and metadata. Consequence check: none locally; these E2013s
  are roots.
- Bucket: **b**. Owner: L1 with L3/L5 review, T08.
- Opposing: permissive selectors might expose protected identities or turn readable metadata
  into writable/grantable fields; readability must not imply writability or permission.
- Confidence high. Flip: a proposed leaf that cannot be fenced by a precise authority check.
- Positive: cited field lists accepted with purpose-specific checks. Negative: unknown leaf,
  invalid terminal descent, unauthorized traversal, and metadata mutation still fail; a
  selector supplies no non-null fact and no permission grant.

### R08 — value-member selector in UI (E2013)

- Site: [CanAffiliate.can](/Users/vince/Projects/canlang/draft/CanAffiliate.can:253)
  `table row.Sale ... filter=reversed,qualified_at,amount.currency` —
  `unknown member 'amount.currency' on model Sale`.
- Intent: filter the sales table by the currency leaf of the money value.
- Root: same narrow selector path as R07, for singular embedded typed values.
- Bucket: **b**. Owner: L1, T08.
- Opposing: descent must stop at references/arrays/files/secrets; a leaf grant includes only
  that leaf plus nullable-prefix presence.
- Confidence high. Flip: `amount` proves to be a reference rather than an embedded money value.
- Positive: `amount.currency` accepted as a filter/sort leaf. Negative: descent through a
  model reference, or granting siblings/container by naming a leaf, still fails.

### R09 — ordinary array omission in fixtures (E3015)

- Site: [CanApprove.can](/Users/vince/Projects/canlang/draft/CanApprove.can:36)
  `reviewer_worker=Employee {...}` — `missing required field 'skills'`.
  Same at [CanCRM.can](/Users/vince/Projects/canlang/draft/CanCRM.can:32).
- Intent: construct a valid employee fixture while omitting the ordinary (non-`!`) array.
- Root: fixture requiredness diverges from the declared default (`T[]` omits to `[]`;
  only `T[]!` requires input). Emission agrees with the wrong side (all non-null arrays
  emitted `requiredArray:true`).
- Bucket: **b**. Owner: L2 with exclusive L1 Rust writer, T09 (then T15/T18/T19 chain).
- Opposing: explicit fixture inputs reduce hidden assumptions; but requiring ordinary arrays
  contradicts a declared language default, and a fixture-only repair leaves emission wrong.
- Confidence high. Flip: `skills` proves to be required-array (`!`) syntax.
- Positive: fixtures omit ordinary arrays; descriptors/conformance agree. Negative: omitting
  a genuine `T[]!` field still fails; contradictory old `[]` expectations are repaired, not
  re-pinned.

### R10 — contextual structural literals (E3015)

- Sites: [CanAffiliate.can](/Users/vince/Projects/canlang/draft/CanAffiliate.can:50)
  `'value': expected invoice.Qualification, found object{source,revision,...}`;
  [CanCRM.can](/Users/vince/Projects/canlang/draft/CanCRM.can:34)
  `'input': expected ResearchLead, found object{customer,contact,...}`.
- Intent: embed typed value snapshots (attributed qualification; research intake) inline.
- Root: literal construction is not validated recursively against the known expected closed
  contract. Consequence: E2001 bare cases inside such literals (`completed` at Affiliate:50)
  lose their expected enum type (see C2).
- Bucket: **b**. Owner: L2 with L1 Rust checking, T10.
- Opposing: named contracts may carry nominal meaning; loose matching could accept missing
  fields, unrelated enums, forged references, or incompatible versions.
- Confidence medium-high. Flip: the expected contract proves explicitly nominal, or closed
  checking cannot preserve a meaningful identity boundary.
- Positive: qualification/research/alert/executed-party shapes accepted with recursive
  validation. Negative: wrong shape/enum/reference/provenance still rejected; no broad
  coercion.

### R11 — `use std` unresolvable everywhere (E2005 x24)

- Primary site: [CanBook.can](/Users/vince/Projects/canlang/draft/CanBook.can:9)
  `use std {DeliveryResult}` — `import provider 'std' names no known app or package`.
  Identical failure in all 24 files importing `std`
  (Book, Catch:10, Chat:5, Creative:8, Decide:5, Desk:13, Event:12, Gallery:8, Grant:8,
  Hire:13, Inbox:10, Invoice:13, Knowledge:7, Loyalty:9, Mail:11, Maintain:13, Member:77,
  Purchase:11, Reception:9, Rent:80, Shift:12, Stock:9, Success:11, Workbench:6).
- Intent: import standard value contracts and capability protocols, not arbitrary JSON.
- Root: the standard provider is not wired into checker resolution/catalogs. Consequence
  fan-out: E2001 for every std-imported name (`TextMessage`/`TextRequest` Chat:66/76/77,
  `DeliveryResult` Contract:22), E3013 label cases on `DeliveryResult.status` (Book:24, C3).
- Bucket: **b**. Owner: L4 inventory with L1 consumption, T12 then T13.
- Opposing: unknown interfaces must fail; accepting names/shapes blindly would falsely
  certify authority, accounting, and file provenance.
- Confidence high on missing production; medium per unresolved member until reconciled
  against the actual owner contract.
- Flip: a cited `std` member conflicts with its actual accepted owner after resolution.
- Positive: each accepted std member resolves with versioned schema. Negative: missing,
  private, or misspelled members still fail.

### R12 — opaque deployment-bound sends and recipes (E3019 x86)

- Sites: [CanApprove.can](/Users/vince/Projects/canlang/draft/CanApprove.can:44)
  delivery recipe for `Mail.send`; L268 `send Mail.send {...}`;
  [CanChat.can](/Users/vince/Projects/canlang/draft/CanChat.can:49) recipe and L81
  `send LLM.generate {value}`; [CanLeave.can](/Users/vince/Projects/canlang/draft/CanLeave.can:131)
  `send StaffSchedule.reserve {value={...}}` (here surfacing as E3015 + E2001 `absence`
  consequences of the same opacity).
- Intent: call typed bound capabilities (email, generation, scheduling) with checked
  requests and receipts.
- Root: deployment-bound capability signatures are opaque to the checker, so sends, recipes,
  and their request/result/error shapes cannot verify. Distinct from the T03 roots sharing
  the same lines (R02/R05): fixing narrowing still leaves these failing until schemas exist.
- Bucket: **b**. Owner: L4 schemas with L1 checking, T13 then T14 (T13a/T14a common slice
  first, e.g. email/delivery).
- Opposing: E3019 remains valid while the real schema is absent; wrong associations and
  protected-handle fabrication must keep failing after schemas land.
- Confidence high on missing production; medium per recipe.
- Flip: a named operation conflicts with its actual accepted owner contract.
- Positive: sends/recipes validate against owner request/result/error/effect schemas.
  Negative: incompatible bindings, wrong associations, forged handles still fail.

### R13 — declared queue not wired to send/event resolution (E2001 + E3010)

- Sites: [CanCatch.can](/Users/vince/Projects/canlang/draft/CanCatch.can:4)
  `queue ErrorJobs type=catch.ErrorWork`; L96 `send ErrorJobs.publish {value=event.value}`
  (E2001 `ErrorJobs`); L97 `scenario process on=ErrorJobs` (E3010 unknown event).
- Intent: publish accepted error intake into an app-owned queue and process it in a typed
  handler.
- Root: the `queue` declaration introduces no `Jobs.publish` send target or `on=Jobs` event
  source, although DESIGN documents exactly that contract (DESIGN L593:
  `queue Jobs type=Work` gives `send Jobs.publish {value}` and `on=Jobs` typed delivery).
- Bucket: **b**. Owner: L1 queue/send/event resolution (nearest backlog: T14/T24 area;
  exact slice to confirm at G0).
- Opposing: if queue syntax were an unadopted proposal the bucket would be d; the DESIGN
  contract rules that out for this shape.
- Confidence medium-high. Flip: the DESIGN queue row proves scoped out or superseded.
- Positive: `send ErrorJobs.publish` and `on=ErrorJobs` resolve with the declared payload
  type. Negative: undeclared queue names, wrong payload shapes, and unknown event sources
  still fail.

### R14 — imported containment target (E2008 x20)

- Primary site: [CanExpense.can](/Users/vince/Projects/canlang/draft/CanExpense.can:11)
  `Expense in Employee` — `containment target 'Employee' is imported; containment needs a
  package-local parent`. Same at Invoice:58 (`Customer`), Reception:40 (`Location`),
  Leave:22, Onboard:15, Propose:40, and 14 further sites.
- Intent: retain canonical Employee/Customer identities as parents instead of copying them.
- Root: checker-side local-only containment rule; semantic ownership/storage/authority
  consequences genuinely unsettled (design gate required before implementation).
- Bucket: **b** with a JEV-gated decision. Owner: L3 design T28, then L3/L1 T29.
- Opposing: uncontrolled containment risks ownership/schema cycles, unstable reverse
  relationships, foreign policy extension, and impossible cross-store transaction promises.
- Confidence medium. Flip: concrete unsafety that cannot be enforced, plus a comparably
  concise alternative preserving the workflow.
- Positive: source relationships retained with alias/order/composition parity and accepted
  lifecycle rules. Negative: wrong parent, cross-team parent, missing/archive state, and
  cycles fail in checking and applicable storage; import supplies no parent mutation
  authority.

### R15 — spelling-based event/provenance rejection (E3009)

- Primary site: [CanEvent.can](/Users/vince/Projects/canlang/draft/CanEvent.can:71)
  user scenario `publish(event:Event)` with ordinary parameter `event`; L73
  `do set event {published=true}` rejected as `set target 'event' is read-only; only
  event.after adjusts the pending record`.
- Same root class at: [CanAffiliate.can](/Users/vince/Projects/canlang/draft/CanAffiliate.can:161)
  `set event.partner {...}` and L191-L195 `set event.settlement {...}` (verified declared
  `event AccountObserved {partner:Partner,...}` / `SettlementObserved` references);
  [CanCheck.can](/Users/vince/Projects/canlang/draft/CanCheck.can:128)
  `set event.check {state=down,...}` (declared `event Deadline {check:Check,...}`).
- Intent: update an ordinary parameter (Event) or a verified event-declared stored record
  (partner/settlement/check revision state).
- Root: mutation checking routes paths beginning with `event` into hook-snapshot handling
  regardless of resolved provenance. Renaming the parameter must change no validity (T30
  acceptance), and verified declared references are not snapshots.
- Bucket: **b** for the spelling correction. Owner: L1 with L3/L4 review, T30.
  Permitted secondary-hook writes are a separate medium-confidence semantic package (T31a
  decision + T31), not implied by this fix.
- Opposing: hook snapshots must stay immutable; pending-source deletion and recursive
  triggering CRUD are dangerous; secondary writes need real owner fencing and revision
  invalidation.
- Confidence high for the spelling correction; medium for secondary-write semantics.
- Flip: an accepted prohibition with a supported replacement preserving revision invalidation.
- Positive: L73 and resolved-reference writes check; provenance distinguishes ordinary
  parameters, verified references, before/input data, pending after, and stored records.
  Negative: writes to immutable snapshots/pending data, recursion, and deletion still fail.

### R16 — integral literals in decimal bounds (E3012)

- Site: [CanAffiliate.can](/Users/vince/Projects/canlang/draft/CanAffiliate.can:23)
  `rate:decimal min=0 max=1` — `min=/max= needs decimal, found int`.
- Intent: write ordinary integral bounds where the expected type is uniquely decimal.
- Root: no contextual literal rule; the checker demands decimal-typed literal syntax.
- Bucket: **c**. Owner: L2 with L1 Rust behavior, T11.
- Opposing: implicit numeric conversion can hide rounding, change overload selection, and
  blur exact representations.
- Confidence high. Flip: real ambiguity or exactness loss caused by the narrow rule.
- Positive: integral literals in uniquely-decimal defaults/bounds/arguments/fixtures/wire
  positions stay exact (no `Number` intermediary, no i64 parsing limit). Negative: variable
  coercion, ambiguous overloads, and precision/range violations remain.

### R17 — secret ingress value vs server initialization (E3011)

- Site: [CanCheck.can](/Users/vince/Projects/canlang/draft/CanCheck.can:11)
  `contract Heartbeat { check:text, token:secret }` —
  `secret fields need a server initializer` (DESIGN L129: "`secret` fields always require
  server initialization").
- Intent: carry a caller-supplied opaque heartbeat token in an ingress payload for later
  comparison (`check.token==event.value.token` at L69), not a server-minted value.
- Root: the server-init rule admits no supplied-opaque-secret form for ingress contracts.
- Bucket: **c**. Owner: draft owner T36 adjudication with L1; residual decision per plan.
- Opposing: secrets must never be replaceable, loggable, or disclosable; a supplied-secret
  form needs fencing so it cannot mint authority or leak.
- Confidence medium. Flip: an adopted ingress-secret contract, or proof the token must be
  server-established (then bucket a: draft restructures).
- Positive: supplied ingress secrets validate under an adopted fenced form. Negative: no
  replacement secret, no disclosure, no server-init bypass for stored secrets.

### R18 — cross-enum comparison (E3002)

- Site: [CanAffiliate.can](/Users/vince/Projects/canlang/draft/CanAffiliate.can:103)
  `event.value.milestone==partner.milestone` — `cannot compare
  enum(paid,completed,cancellation_passed,reversed) with
  enum(paid,completed,cancellation_passed)`.
- Intent: compare the same conceptual milestone across the intake boundary and the partner row.
- Root: no rule defines comparison between distinct enum types (DESIGN comparison matrix
  covers typed equality/membership within a type, not across types).
- Bucket: **c** (directionally right rejection, needs a defined mapping or comparison rule).
  Owner: draft owner T36 with L2/L1 (T10-adjacent).
- Opposing: nominal enums may mean different things per owner; silent cross-type comparison
  could equate unrelated cases.
- Confidence low. Flip either way: an adopted nominal-enum rule makes this bucket a (draft
  maps explicitly); a demonstrated structural-compatibility rule makes it bucket b.
- Positive under either fix: valid comparisons check with explicit mapping or adopted rule.
  Negative: unrelated-enum comparison still fails.

### R19 — unadopted fanout attribute (E1203 x4)

- Site: [CanShift.can](/Users/vince/Projects/canlang/draft/CanShift.can:237)
  `scenario review_commitment on=EligibilityReview each=Commitment as commitment` —
  `unsupported scenario attribute 'each'` (also L243 and two Volunteer sites).
- Intent: traverse a bounded owner cohort when eligibility events arrive.
- Root: no adopted fanout contract (cohort/cutoff, identity, checkpoints, failure/retry,
  supersession semantics all unsettled).
- Bucket: **d**. Owner: L4 with L1/L3/L7, T33 decision then T34.
- Opposing: population traversal can omit owners, repeat children, lose checkpoints, or
  misrepresent partial execution as atomic; ordinary continuations are fair if given equal
  traversal support.
- Confidence medium. Flip: a continuation design with equal completeness/recovery at lower
  cost, or an adopted finite durable fanout contract (then this becomes bucket b work).
- Positive: adopted contract proves 499/500/501/1000 cohorts, crashes, duplicates,
  concurrent change, rejected children, retry, supersession. Negative: unsupported fanout
  stays blocked; ordinary bounded loops still reject overflow.

### R20 — fixture reference cycle (E2017)

- Site: [CanGrant.can](/Users/vince/Projects/canlang/draft/CanGrant.can:70)
  L70 `corrected=Application {...,correction=submitted,...}` and L71
  `submitted=Application {...,state=submitted}` — `fixture reference cycle through
  'submitted'` (same family at Mail:74, Report:38, Shift:83).
- Intent: stage a corrected application against its submitted original.
- Root: the fixture initializer references the fixture under construction (`state=submitted`
  resolves to the fixture itself, almost certainly a case/name mix-up for a state enum).
- Bucket: **a**. Owner: draft owner, T36 (demonstrated individual correction only).
- Opposing: if `submitted` were a resolvable enum case in that position there would be no
  cycle; the checker's cycle path through the fixture name rules that out here.
- Confidence medium-high. Flip: a reading under which `state=submitted` resolves to a
  declared enum case with no cycle.
- Positive: corrected fixture pair initializes without a cycle. Negative: genuine fixture
  cycles still fail; no silent reinterpretation.

### R21 — scenario redeclaring a closed builtin name (E2002)

- Site: [CanEvent.can](/Users/vince/Projects/canlang/draft/CanEvent.can:376)
  `scenario money on=SettlementObserved` —
  `scenario 'money' redeclares the closed builtin name 'money'`
  (also Refer:65 `join`).
- Intent: handle settlement observations under a short business name.
- Root: the authored scenario name collides with the closed value-builtin namespace.
- Bucket: **a** (leaning; residual decision per plan: closed builtin operation names).
  Owner: draft owner, T36.
- Opposing: scenario and value-builtin namespaces could in principle be separated (bucket c
  reading), but no such scoping rule is adopted, and shadowing `money(...)` at business
  scope risks silent misreads.
- Confidence low-medium. Flip: an adopted namespace-separation rule, or a second same-name
  use proving systematic intent rather than collision.
- Positive: renamed handler keeps the identical workflow. Negative: closed-builtin
  shadowing still fails unless a scoping rule is adopted.

### R22 — server-owned field as CRUD input (E3009)

- Site: [CanCRM.can](/Users/vince/Projects/canlang/draft/CanCRM.can:47)
  `crud Deal ... fields=title,owner,...` — `'owner' is server-owned and cannot be a CRUD
  input` (adjacent E3001s on `row.owner` nullability are separate T03/T06 consequences).
- Intent: let a salesperson set the deal owner through the CRUD path.
- Root: the draft lists a server-assigned field as a client input, contradicting
  server-ownership; no privileged-input exception is adopted.
- Bucket: **a** (leaning). Owner: draft owner, T36.
- Opposing: a role could conceivably supply owner-equivalent input under a distinct
  declared input name; the current spelling claims the server-owned field itself.
- Confidence medium. Flip: an adopted server-owned-input exception with demonstrated value,
  or proof `owner` is not server-owned on this model.
- Positive: CRUD inputs exclude server-owned fields (or use an adopted exception shape).
  Negative: server-owned inputs still rejected; fixture/setup authority stays a separate
  explicit decision.

### R23 — imported CRUD update/delete not enabled (E5006)

- Site: [CanMail.can](/Users/vince/Projects/canlang/draft/CanMail.can:143)
  `call Contact.update {record=delegate_contact,...}` — `'Contact.update' is not enabled`
  (also L152 `Contact.delete`; Workbench:128 `Task.update`).
- Intent: drive the owning package's canonical contact lifecycle from a mail journey.
- Root: imported CRUD sequences do not resolve to the canonical owner's exported
  operations (T35 packet: resolve canonical owner and exported operation).
- Bucket: **b**. Owner: L1 with relevant producers, T35.
- Opposing: the owning package may genuinely disable update/delete; then the journey must
  use an enabled path and this site flips to bucket a.
- Confidence medium. Flip: the owner contract shows Contact update/delete disabled (a) or
  enabled-but-unresolved (b confirmed).
- Positive: enabled imported CRUD sequences resolve and check. Negative: disabled/private
  CRUD stays unavailable.

### R24 — payload `version` vs reserved metadata (E5008)

- Site: [CanPropose.can](/Users/vince/Projects/canlang/draft/CanPropose.can:253)
  example header `...,event.result.version -> ...` —
  `'version' is reserved metadata and cannot be overridden`
  (same packet at Desk:139 `id`, Report:110 `parent`).
- Intent: observe the provider result payload's own `version` field through the example.
- Root: payload-contract fields named `id`/`version` collide with reserved runtime metadata
  handling (T35 packet: distinguish payload contract from runtime metadata).
- Bucket: **b**. Owner: L1 with relevant producers, T35.
- Opposing: stored identity/audit fields must stay protected; the fix must key on resolved
  payload-vs-metadata provenance, not on field-name spelling.
- Confidence medium. Flip: the observed `version` proves to be runtime metadata rather than
  payload (then bucket a: example observes the wrong thing).
- Positive: payload `id`/`version` observable where the contract declares them. Negative:
  stored identity/audit overrides still rejected.

### R25 — ICU select-branch literals misread as placeholders (E3016)

- Site: [CanEvent.can](/Users/vince/Projects/canlang/draft/CanEvent.can:63)
  `message notice_title(kind:Notice.kind) = "{kind,select,confirmation{Event ticket
  confirmed}...}"` — `message placeholder '{Event}'/'{Planning}'/'{Toegangsbewijs}'/
  '{Toegang}' names no message parameter`.
- Intent: render a kind-selected localized title with literal branch text.
- Root: ICU structural parsing misreads select-branch literal words as `{placeholder}`
  references (T35 packet: structural parsing under the accepted profile).
- Bucket: **b**. Owner: L1 with L2 (`icu.ts`), T35.
- Opposing: genuinely unknown placeholders must keep failing; the accepted ICU profile
  bounds what parses.
- Confidence medium-high. Flip: the accepted profile proves narrower than select-with-
  literals (then a scoped-syntax decision, bucket d, with reasons).
- Positive: well-formed select/plural patterns resolve real parameters. Negative: unknown
  real parameters and malformed patterns still fail.

### R26 — actor facts and authoritative-read purity (E3005 + E3010)

- Site: [CanChat.can](/Users/vince/Projects/canlang/draft/CanChat.can:15)
  `derive can_use(person:user?,conversation:Conversation):bool = person!=null and
  active_member(person,team) and ...` — `no overload of 'active_member' matches
  (user?, Team)` (E3005) and `derived function value must be pure; 'active_member' is not
  allowed here` (E3010). Same purity root at Creative:103 (`when=` guard).
- Intent: gate conversation use on a present, currently-member account.
- Root (two layers): (1) the AND-continuation fact `person!=null` never reaches the
  `active_member(person,...)` call (T03/T05 consequence, same rule as R05); (2) even
  non-null, `active_member` (cataloged state-read) is rejected from pure positions, with no
  adopted bounded-authoritative-read contract.
- Bucket: **b** for layer 1; **c** (conditional on fencing) for layer 2. Owner: L1 T06
  for admission facts; L3 T32a/T32b for the read/fence contract.
- Opposing: actor is genuinely nullable in public operations, trusted handlers, and
  preauthorization defaults; a role test on another subject cannot prove caller
  authentication; stale predicates cannot authorize later commits.
- Confidence medium-high on layer 1; medium on layer 2 pending the fence design.
- Flip: a supposedly admitted expression succeeding without an authenticated caller, or a
  context that cannot obtain/revalidate the required authoritative state.
- Positive: admitted-actor use passes in composite policies and CRUD `when=`; bounded
  reads allowed in adopted contexts with snapshots/revalidation. Negative: public/other-
  subject/preauthorization actor stays nullable; trusted payload users never become callers;
  revocation denies new access/spending.

### R27 — inconsistent server-owned enforcement, `armed` (E3001)

- Sites: [CanCheck.can](/Users/vince/Projects/canlang/draft/CanCheck.can:58)
  `set check {enabled=true,...,armed=now,...}` in `resume` —
  `server-owned field 'armed' cannot be set`; contrast L99 `set event.after {armed=now,...}`
  in the `Check.create` hook, which draws no such diagnostic.
- Intent: re-anchor the deadline when resuming a paused check.
- Root: server-owned enforcement differs between the ordinary-update path and the hook
  path; one rule must cover creation defaults, server initialization, updates, and hooks.
- Bucket: **b**. Owner: L2/L3 with L1 emission, T18 + T31.
- Opposing: `server=now` may mean runtime-stamped and never author-settable, in which case
  resume needs a supported re-anchor mechanism rather than a direct write (then the hook
  side is the hole to close).
- Confidence medium. Flip: an adopted default/server/update/hook rule assigning `armed`
  writes to exactly one mechanism.
- Positive: actual creation/null/parent/actor/time/replay cases agree on one rule.
  Negative: update omission vs explicit null, protected fields, and replay-once behavior
  stay enforced.

### R28 — query domain over else-narrowed array (E3006)

- Site: [CanInvoice.can](/Users/vince/Projects/canlang/draft/CanInvoice.can:742)
  L739 `if event.value.items==null` create-single-line else-branch L742
  `require count(event.value.items)>0 and all(event.value.items as item,...)` —
  `query domain must be a model or collection, found array of DocumentLine?`.
- Intent: validate every line item only when an item list was supplied.
- Root (probable): the else-branch of `==null` carries no non-null fact, so the domain
  keeps its nullable type (T03 rule applied to query domains). The message prints the
  un-narrowed type.
- Bucket: **b**. Owner: L1, T05.
- Opposing: if the element type is genuinely nullable (array OF nullable), a different
  nullability rule is needed and this site is mis-attributed; v1 excludes nullable
  elements, which supports the narrowing reading.
- Confidence medium. Flip: resolved element type proves nullable, or the message's `?`
  proves to be element rather than container nullability.
- Positive: else-branch domains check after narrowing. Negative: genuinely nullable or
  non-collection domains still fail; zero-iteration loops still drop facts (T03 control).

### R29 — example input-vs-observation attribution (E5002)

- Site: [CanLeave.can](/Users/vince/Projects/canlang/draft/CanLeave.can:136)
  examples header for `decide`: `as,request.parent.parent.user,... -> request.state,...`
  — `unknown field 'parent' on Calendar` and `'request' is an input, not an observation`.
- Intent: assert the decided request's new state and the allowance remainder.
- Root: unclear attribution between input bindings and post-call observations (is observing
  through the input binding allowed, or must observations reload stored state?), plus a
  possible Calendar `parent` selector gap (T08-adjacent).
- Bucket: **c/b** unresolved — recorded as **c** (too-strict-or-misattributed example rule)
  pending T23 semantics. Owner: L7 T23 with draft owner T36.
- Opposing: observations must read reloaded isolated stored state; input aliases may be
  stale or ambiguous, so rejecting them could be correct (bucket a reading).
- Confidence low. Flip: the adopted emitted-example contract explicitly allows or forbids
  input-alias observations.
- Positive: the example's intent (new state + remainder) expressible in one adopted shape.
  Negative: setup failures still cannot satisfy business expectations; wrong-identity
  observations still fail.

### R30 — multi-root convergence on one line (method note)

- Site: [CanLeave.can](/Users/vince/Projects/canlang/draft/CanLeave.can:131)
  `send StaffSchedule.reserve {value={...}}` draws E3015 (object vs opaque request),
  E2001 (`absence` case), and E2013 (`parent` on Calendar) from one statement.
- Attribution: E2013 `parent` is an R07-class selector root (T08); E3015 + E2001 are R12-
  class opacity consequences (T13/T14 + T10 for nested cases). Fixing any one root leaves
  the others failing — the ledger's root/consequence split exists for exactly this shape.
- No separate bucket; see R07/R10/R12. Owner: coordinator G0 join.

## Consequence chains (roots produce multi-family diagnostics)

- C1 — bare enum cases lose expected types: E2001 `up/down/late` (Check:72-76),
  `pending/decision` (Approve:268), `succeeded` (Affiliate:142/147/174/182),
  `confirmed` (Event:72) are consequences of E3003/E3019 roots failing first; DESIGN L165
  requires a uniquely expected enum type, which the failed receiver/operation cannot supply.
- C2 — cases inside unvalidated literals: E2001 `ready` (Affiliate:162), `allocated/failed`
  (Affiliate:196) are consequences of the R10 root (nested expected-type propagation
  missing). The `use creative {completed}`-style suggestions on such sites are misleading
  engine guesses, not intent evidence.
- C3 — std opacity fan-out: E3013 label cases on `DeliveryResult.status` (Book:24) and
  E2001 `DeliveryResult` (Contract:22) are consequences of the R11 root.
- C4 — nullable-argument cascade: E3001 `expected user/Location..., found ...?` sites
  (Affiliate:70, Catch:81/93, CRM:28/43, Book-side `can_work` calls) are predominantly
  consequences of R03-R06 roots (facts never established), not independent arity defects.
- C5 — set-target cascade: E3001 `set target must be a stored model record, found X?`
  (Affiliate:96/109, Approve:269, Chat:80, Check:70) are consequences of the same missing
  facts as their neighboring E3003s.
- C6 — hook-payload opacity: E3001 `{opaque}` cluster (Check:99-100) is a consequence of
  incomplete `Check.create` after/before payload typing (R15/T30-T31 area), not five
  independent type defects.
- C7 — overload-no-match as narrowing consequence: E3005 `trim(text?)` (Grant:260),
  `local_date(datetime?,...)` (Do:131), `active_member(user?,...)` (Chat:15, layer 1) and
  E3002 nullable-order diagnostics (Do:131, Affiliate:296, CRM:414) are consequences of
  R05-class roots: the call/operator is fine once the continuation fact exists.

## Family coverage

Sampled roots cover E1203, E2001, E2002, E2005, E2008, E2013, E2017, E3001, E3002, E3003,
E3005, E3006, E3009, E3010, E3011, E3012, E3013, E3015, E3016, E3019, E5002, E5006, E5008.
Unsampled low-count families deferred to T02/T41 with no verdict here: E5001 (2, Table:59),
E5004 (2, trusted-handler `as` caller), E2008 beyond containment-target shape (none observed
beyond the one message). E3010 appears both as unknown-event (R13) and purity-gate (R26)
roots — never treat the code as one defect.

## Handoff

- R01-R06 + C1/C2/C4/C5/C7 feed T03 (contract, same writer, companion file
  `continuation-contract.md`) and T05.
- R07/R08 feed T08; R09 T09; R10 T10; R11/R12 T12-T14; R13 L1 queue resolution;
  R14 T28; R15 T30/T31; R16 T11; R17/R20/R21/R22 T36 (+L1/L2 as noted); R18 T36+T10;
  R19 T33; R23/R24/R25 T35; R26 T06+T32; R27 T18+T31; R28 T05; R29 T23+T36; R30 G0 join.
- No draft file was modified (draft owner only, later, per T36). No diagnostic was
  reclassified by code alone; every bucket above is site-evidenced.
- Checks run: repro command above (exit 10, 4524 diagnostics, identities match); read-only
  envelope analysis in `/tmp` (no repo writes); source reads of all cited draft spans.
  Revision: `c4a9775` + draft `2d67312`.

