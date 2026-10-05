# T32a prep: authoritative predicate reads — alternatives for the JEV gate

Status: **PROPOSED / PREP — adopts NOTHING.** Decision requires the
coordinator-run JEV protocol (three fresh, equivalent, independently worded
requests with saved advice/uncertainty) plus full-scope evidence. Every
alternative below carries explicit **JEV-PENDING** markers. No T32b
implementation (state/work/identity code) may begin before the gate accepts
one rule.

Scope note (T32 brief): read/snapshot/revalidation contract — permission,
revision, and revocation fences, stale reads, revocation between read and
effect, no cached snapshot silently authorizing spend, transitive effects.
Done when all claimed contexts preserve revocation/stale-state boundaries
and transitive effects.

## Settled context (read-only inputs, not decisions)

- R26 ([root-causes.md](root-causes.md)): two layers at Chat:15
  (`derive can_use(person:user?,...)` calling `active_member`) and
  Creative:103 (`when=` guard). Layer 1 is bucket **b** (AND-continuation
  fact `person!=null` never reaches the call; T03/T05 consequence, T06
  admission facts). Layer 2 is bucket **c** (conditional on fencing):
  even non-null, `active_member` (cataloged state-read) is rejected from
  pure positions, with **no adopted bounded-authoritative-read contract**.
  Confidence medium-high on layer 1, medium on layer 2 pending the fence
  design. Opposing (retained): actor is genuinely nullable in public
  operations, trusted handlers, and preauthorization defaults; a role test
  on another subject cannot prove caller authentication; stale predicates
  cannot authorize later commits.
- R04 ([root-causes.md](root-causes.md)): Check:65-81 opposing line —
  check-time facts are typing facts, not cross-transaction staleness
  promises; **fencing stays with T32**. The T03/T05 continuation contract
  therefore settles nothing about read freshness.
- R15 provenance areas ([root-causes.md](root-causes.md)): the T30 fix
  must distinguish ordinary parameters, verified declared references,
  before/input data, pending after, and stored records. Any T32a rule
  inherits that provenance split: a read of an immutable snapshot
  (before/input) is not a read of current authority state, and the fence
  must say which positions may observe which.
- R29 (Leave:136, bucket **c**, low confidence): input-vs-observation
  attribution for examples is unsettled pending the T23 emitted-example
  contract — T32b test observations inherit that blocker (input aliases
  may be stale or ambiguous).
- DESIGN revocation boundary (read-only here): a completed membership
  removal prevents new admissions; an already admitted operation may
  finish; on D1 the fenced commit also detects intervening membership
  changes (L291). Role predicates use current admission authorization
  state and the same commit fence as caller-role checks, and must not
  become stored historical invariants that invalidate old records on
  later revocation (L295).
- DESIGN fence (read-only here): admission-time authentication, role, and
  active-membership facts are a **trusted context snapshot** with the
  revocation boundary in §4; business eligibility requiring atomic
  revocation must live at the same owner as the decision (L549). V1 D1
  uses a database-wide optimistic revision fence: read the primary
  revision before all state-dependent reads, evaluate bounded pure DSL,
  assert the same revision in one batch, retry at most three times;
  submitted stale record versions still produce `conflict` (L551-558).
  Pure read operations validate the revision again after dependent
  reads; changed revisions retry rather than return a mixed
  authorization snapshot. A successful mutation rechecks current read
  permission before serializing its result (L558).
- DESIGN settled no-preflight rules (read-only here): no separate
  preflight authorization query is required for payment, since its
  answer cannot authorize a later payment (L650); an unavailable/stale
  source cannot expose an executable old action (L632); a send's
  optional `when` is a pure dispatch guard over current owner state,
  checked atomically with supersession before claiming the provider
  call (L524); mutable receipt status/result/error reads enroll the
  observation revision in the read fence (L668, L1077); completed replay
  returns the saved outcome projected against current access, even
  though its submitted versions are now stale (L562).
- DECISIONS (read-only here): #95 reject stale conflicting edits rather
  than silently overwrite; #124 re-check guards at the authoritative
  storage location; #126 one authoritative coordinator per reservation
  resource; #129 persist recoverable work only after authoritative
  acceptance; #143 transaction-time snapshots for monetary values whose
  configuration can later change; #138 **OPEN** — consistency
  guarantees for D1 mutations, replicas, and read sessions remain
  unspecified. Page-discovery admission reuses guard-needed bindings at
  the same checkpoint (L739); payment dispatch validation was adopted
  over a preflight read (L703).
- App-intent dispositions (all ACCEPTED-WORKFLOW-INTENT, runtime
  negatives retained): CanChat carries the R26-layer2 blocker and the
  allowance spend workflow (L72-83 `spent/held/cap` reads guarding token
  reservation and an LLM send); CanCreative L103 carries a `when=`-guard
  purity gate; CanCheck reads heartbeat token/state before creating
  Transitions; CanGrant L93 notes "Static user grants are not a live
  role-revocation event" — **ledger-silent**, no T01 root (see gate
  needs). T40 Chat qualification needs matching T32 evidence.

## Workflows each alternative must preserve (acceptance bar)

1. Chat allowance spend: reads of `spent/held/cap/parallel/active`
   authorize exactly one bounded reservation; a stale snapshot must not
   silently authorize a second spend (double-spend is the load-bearing
   negative).
2. Chat `derive can_use` gate: conversation use gated on a present,
   currently-member account — admitted-actor use passes in composite
   policies and CRUD `when=`; public/other-subject/preauthorization
   actor stays nullable.
3. Creative `when=` guard: an authoritative read inside a dispatch guard
   over current owner state.
4. Check heartbeat: token/state reads admit processing for a known check,
   then create Transitions — revocation or state change between the read
   and the create must surface, not silently pass.
5. Spend effects (payment `collect`, LLM/image sends, any provider
   dispatch): no cached or preflight read authorizes the spend; dispatch
   revalidates at claim time.
6. Negatives: revocation denies new access/spending; trusted payload
   users never become callers; transitive effects (hook- or
   handler-triggered consequences of an authorized read) re-fence rather
   than inheriting the original read's authority.

## Alternative A — Single-checkpoint fenced reads with commit revalidation

Rule: every state-dependent read in an operation (guard, `when=`,
`derive`, policy predicate, `active_member`/role check) executes at one
owner checkpoint enrolled in the existing revision fence. The commit
batch re-asserts the checkpoint revision AND re-evaluates
permission + revocation against current authority state; any intervening
change to a read dependency fails the operation with `conflict` (stale
revision) or `forbidden` (revoked permission), never a silent commit.

- Permission fence: admission program + guard predicates evaluate at the
  checkpoint; the mutation rechecks current read permission before
  serializing its result (settled L558), extended to rechecking the
  operation's `by` and every guard predicate at commit.
- Revision fence: the settled D1 database-wide optimistic fence (L551)
  unchanged; all T32a reads enroll their dependencies in it, as receipt
  observations already do (L668).
- Revocation fence: membership/role facts are the trusted context
  snapshot (L549); the fenced commit detects intervening membership
  changes (L291). A revocation landing between checkpoint and commit
  voids the commit — the already-admitted operation does NOT finish
  when its authority was revoked mid-flight. **JEV-PENDING**: whether
  "already admitted may finish" (L291) covers authority revoked between
  admission and commit, or only revocation racing an already-fenced
  commit batch.
- Stale reads: reads are never stale within the fence — a changed
  revision retries (pure reads) or conflicts (mutations). Declared
  eventual views (cross-owner browsing, L547) are explicitly labeled
  eventual and can never feed an authorization decision or a spend.
- Read→effect gap: closed by construction — the effect commits only if
  the checkpoint still holds AND authority revalidates at commit.
- Spend rule: dispatch claims re-run the `when=` guard atomically with
  supersession (settled L524); payment `collect` validates current
  mandate at dispatch (settled L650). No preflight read result crosses
  into the spend.
- Transitive effects: hook bodies and committed handlers are new fence
  scopes — each re-reads current authority state at its own checkpoint
  rather than inheriting the triggering read's snapshot.
- Workflows preserved: bar items 1–6 hold verbatim with zero draft
  edits; Chat spend, `can_use`, Creative guard, and Check heartbeat all
  run inside one fence per operation.
- Costs: every guarded operation pays fence enrollment + commit-time
  revalidation; contended dependencies (hot allowance rows, membership
  table) raise `conflict`/retry rates; error attribution must name
  which read dependency invalidated the commit; D1 fence contention is
  already the first material runtime uncertainty (DESIGN L1013).
- Strongest opposing case: failure coupling at the authority layer — a
  membership-table write anywhere in the deployment can now void an
  unrelated user's in-flight operation via the database-wide revision
  assertion, turning revocation bookkeeping into a global contention
  source; and commit-time revalidation doubles predicate evaluation
  cost on every mutation. **JEV-PENDING**: whether the database-wide
  fence is an acceptable revocation boundary or revocation needs a
  narrower, per-team/per-record fence to avoid global coupling.

## Alternative B — Read-at-effect: no predicate crosses a boundary

Rule: no read result may travel from a guard into an effect. Every
effect re-reads the current authority state it needs immediately before
executing — guards compute control flow only, and each `create`/`set`/
`send`/`collect` performs its own fresh authorization + state read at
claim time. There are no snapshots to go stale because nothing is
carried.

- Permission fence: per-effect admission — each effect's `by`,
  target-record grants, and business guards re-evaluate on freshly
  read state at effect time, inside the same owner transaction.
- Revision fence: the settled fence still bounds the transaction, but
  T32a adds no checkpoint-carry semantics: each effect's reads enroll
  at effect time, so an earlier guard's revision is irrelevant.
- Revocation fence: revocation between guard and effect is always
  caught, because the effect never trusts the guard's read. The L291
  "already admitted may finish" question is moot for carried
  predicates — but **JEV-PENDING** whether per-effect re-admission
  changes the meaning of operation-level admission (is each effect a
  new admission?).
- Stale reads: impossible by construction for authorization paths;
  display-only reads keep the L791-793 reread/stale-marking contract.
- Read→effect gap: eliminated rather than fenced — the gap has no
  carried state in it.
- Spend rule: strongest form — the spend effect's own validation read
  IS the authorization (matches the adopted payment-dispatch rule,
  DECISIONS L703, generalized to every spend).
- Transitive effects: trivially fenced — every transitive effect is
  just another effect with its own fresh reads.
- Workflows preserved: bar items hold, but Chat L72-83 style code
  (`let allowance=first(...)`, guard, then `set` using the bound row)
  needs a semantics ruling: either the `let` binding is a live
  re-read (**JEV-PENDING** — contradicts the `let`-captures-value rule,
  DESIGN L475) or authors must re-query before each effect, which is a
  per-site authoring cost with T36-style proof burden.
- Costs: N effects = N authorization reads; hot-path read amplification
  on every multi-effect operation; the `let`-as-value rule (L475) must
  be carved out or every multi-step draft workflow rewritten; TOCTOU
  reasoning moves from one checkpoint to N effect points.
- Strongest opposing case: it discards the drafts' plainly staged
  intent (read once, guard, act on the guarded row) and pays maximum
  read amplification to avoid specifying a snapshot contract — while
  still needing the revision fence for write-write conflicts, so it
  keeps fence complexity AND adds per-effect reads. Authors will
  re-introduce carried values via `let` bindings, recreating the gap
  informally. **JEV-PENDING**: whether any multi-effect workflow
  (Chat spend-then-send, Check read-then-create-Transition) is
  expressible without carried bindings, and what the `let` rule means
  if bindings silently re-read.

## Alternative C — Version-pinned snapshots with a declared staleness contract

Rule: reads pin the exact record versions (and the owner checkpoint
revision) they observed. An effect proceeds iff every pinned version is
unchanged at commit; otherwise `conflict`. Separately, source may
declare explicitly eventual reads (cross-owner browsing, candidate
pickers, progress views) that pin nothing, are labeled stale-tolerant,
and are statically barred from authorization decisions and spends.

- Permission fence: guard predicates evaluate against the pinned
  snapshot; commit re-asserts pins AND re-checks `by`/revocation
  against current state (as A for authority, as pins for data).
- Revision fence: pins narrow the settled database-wide assertion —
  only pinned records + the authority tables must be unchanged, so an
  unrelated write elsewhere does not void the operation.
  **JEV-PENDING**: whether a narrowed assertion is implementable on
  the D1 batch contract (L551-556) or the database-wide revision is
  the only checkable unit.
- Revocation fence: authority pins (membership/role rows) are always
  pinned and always rechecked — revocation of any relied-upon grant
  voids the commit. Display-only eventual reads pin nothing and grant
  nothing.
- Stale reads: two statically separated kinds — pinned reads (fresh
  by assertion, `conflict` on change) and declared-eventual reads
  (may be stale, must be labeled, can never authorize or spend).
  **JEV-PENDING**: the exact declaration syntax/label for eventual
  reads and whether any current draft read needs it.
- Read→effect gap: bridged by pins — the effect trusts the snapshot
  exactly when the pins hold, and the pins are rechecked atomically
  with the commit.
- Spend rule: spend effects additionally require a fresh
  dispatch-time validation read (L524/L650), even when pins hold —
  pins prove data freshness, not provider/mandate state.
- Transitive effects: inherit the pin set plus enroll their own
  reads; a transitive effect may narrow but never widen the snapshot.
- Workflows preserved: bar items 1–6 hold with zero draft edits for
  same-owner workflows; cross-owner/eventual views need the new
  stale-tolerant label wherever they exist (none sampled yet — see
  gate needs).
- Costs: pin bookkeeping per read (version capture, pin-set commit
  assertion); a new static separation between authorizing and
  eventual reads to specify, diagnose, and teach; narrowed-assertion
  storage semantics to prove on D1; boundary disputes on every new
  read ("is this read authorizing?").
- Strongest opposing case: arbitrary-line drawing with a dangerous
  default — if the eventual label is ever inferred rather than
  declared, stale reads silently lose their fence; and pins give a
  false precision promise (version-unchanged ≠ semantically fresh
  when derived state changed without a version bump). The narrowed
  assertion may also be unimplementable on D1's batch contract,
  collapsing C into A with extra bookkeeping. **JEV-PENDING**:
  whether pin-narrowing is real on the D1 contract, and what the
  default is for an unlabeled read (pinned-safe vs eventual).

## Alternative D — Bounded authority grants minted by reads

Rule: an authorizing read mints an explicit bounded grant —
(operation, target records + versions, predicate outcome, owner
checkpoint, short expiry) — that the effect presents at commit. The
commit validates the grant: versions unchanged, checkpoint fence
holds, grant unexpired, and the grant's authority NOT on the
revocation list. A read without a grant (display, eventual view) can
never authorize an effect — passing no grant is a check-time error
where authority is required.

- Permission fence: the grant IS the permission evidence — explicit,
  auditable, bounded. Policy predicates and `active_member`/role
  checks mint grants; effects consume them.
- Revision fence: grants carry the checkpoint; commit asserts it as
  in A. Grant scope may narrow the assertion to grant-listed records
  (same **JEV-PENDING** implementability question as C).
- Revocation fence: revocation appends to a per-owner revocation
  list; commit rejects any grant touching revoked authority with
  `forbidden`. Grant expiry bounds the read→effect window even when
  nothing changed. **JEV-PENDING**: expiry values and whether expiry
  is wall-clock (fixed test clock, L477) or revision-distance based.
- Stale reads: a read result without a live grant is just data —
  usable for display, unusable for authorization. Staleness becomes a
  grant-validation failure with a precise cause (expired / revoked /
  version-moved).
- Read→effect gap: made explicit — the grant names exactly what
  crossed the gap, with bounds. No ambient carried authority exists.
- Spend rule: spend effects require a fresh grant minted inside the
  dispatch claim (L524 atomic guard+claim); a guard-phase grant can
  never be presented for a spend. Strongest static form of "no
  cached snapshot silently authorizes spend."
- Transitive effects: must mint their own grants from their own
  reads — grants are non-transferable across fence scopes.
- Workflows preserved: bar items hold semantically, but every
  authorizing read→effect path needs grant plumbing — either
  compiler-inferred (invisible, must be proven sound) or
  source-visible (new syntax on every guarded effect).
  **JEV-PENDING**: inferred vs declared grants, and the migration
  shape for Chat/Check/Creative sites.
- Costs: largest new surface — grant type, minting/consumption
  rules, revocation list storage + retention, expiry semantics,
  grant-aware diagnostics; revocation-list writes add fence
  contention of their own; replay/projection must re-derive or
  carry grants (L562 projection rule needs a grant story).
- Strongest opposing case: machinery without a customer — no
  sampled draft workflow needs named, expirable, revocable grants;
  the fence (A) or pins (C) already close the gap with far less
  surface. Grants reintroduce exactly the ambient-authority risk
  they claim to fix if the compiler infers them invisibly, or a
  crushing annotation burden if declared. The revocation list is a
  new hot table that every commit must consult.
  **JEV-PENDING**: whether any workflow needs grant-shaped
  evidence (portable, expirable, auditable authorization) rather
  than fence-shaped evidence, and who pays the annotation or
  soundness-proof cost.

## Fairness record (preserved opposing cases)

- A's risk: global contention coupling — database-wide revision
  assertion turns unrelated writes (membership bookkeeping) into
  in-flight operation failures; double predicate evaluation cost
  (this file).
- B's risk: maximum read amplification + `let`-as-value contradiction;
  discards staged read-guard-act intent; authors recreate the gap
  informally via bindings (this file; R26 flip burden).
- C's risk: arbitrary authorizing/eventual line with a dangerous
  default; false precision of version pins; narrowed assertion may be
  unimplementable on D1, collapsing C into A with extra bookkeeping
  (this file).
- D's risk: largest new surface for no sampled customer; invisible
  inference vs crushing annotation; revocation list becomes its own
  hot table (this file).
- Cross-cutting R26-layer-1 risk (independent of this gate): AND-fact
  delivery to `active_member(person,...)` calls (T06) must land
  regardless of which alternative wins; a fence cannot fix a missing
  non-null fact.
- Cross-cutting R04 boundary: check-time typing facts never become
  freshness promises under any alternative; T03/T05 stay staleness-free.
- No alternative is ranked or adopted here. Ranking is the JEV gate's job.

## What the gate still needs (evidence checklist)

1. Full enumeration of purity-gate read sites: only Chat:15 and
   Creative:103 are sampled for R26-layer-2 (E3010 purity shape).
   Every `active_member`/role-predicate/authoritative-read rejection
   across all 52 sources needs per-site classification (derive guard
   / `when=` guard / policy predicate / page gate / review input)
   with per-site fence context.
2. Spend-effect inventory: every effect that moves money, consumes a
   capped allowance, or dispatches to a provider (Chat spend+send,
   payment `collect`, image/LLM sends, delivery claims) with its
   current guard→effect read path — the gate must see each path its
   rule has to fence.
3. Grant L93 role-revocation note: "Static user grants are not a
   live role-revocation event" is ledger-silent with no T01 root.
   Adjudicate what revocation timeliness the Grant workflow intends
   (immediate vs eventual) before the gate picks a revocation fence.
4. R29 input from T23: whether behavior examples may observe through
   input bindings or must reload stored state — every alternative's
   T32b proof tests inherit this.
5. T06 admission-fact input: the R26-layer-1 rule (which admitted
   expressions carry non-null actor facts into which calls) so the
   gate judges fence rules, not missing narrowing.
6. T28/T29 ownership input where reads cross package boundaries
   (policies reading `row.parent.*` on imported parents) — a fence
   scoped to one owner must say what an imported-parent read enrolls.
7. Durable-fence evidence plan: per T32 acceptance, memory evidence
   cannot prove fence behavior. Memory stores lack the properties
   the gate must verify — no D1 batch/commit boundary, no revision
   assertion, no concurrent-transaction interleaving, no crash-
   recovery path. Revision/revocation-fence claims therefore require
   D1/DO-backed execution evidence (T16/T17 canonical runtime), not
   memory-store tests; the gate must say which alternative's proof
   runs where. DECISIONS #138 (consistency guarantees unspecified)
   stays open until that evidence exists.
8. Coordinator-run JEV protocol: three fresh equivalent independently
   worded formulations, saved responses + uncertainty, disagreement
   investigated. **No JEV was run for this prep file; tools/jev.py
   untouched.**

## Handoff

- Writer: L3 T32a-prep. Single new file; DESIGN.md/GRAMMAR.md/
  DECISIONS.md untouched (read-only); state/work/identity code
  untouched (T32b is post-gate); tasks.md/monitor.md/inbox untouched
  (coordinator-owned); no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.
