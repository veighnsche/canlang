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
   [COMPLETE — enumeration writer: see "Gate evidence enumeration §1" below.]
2. Spend-effect inventory: every effect that moves money, consumes a
   capped allowance, or dispatches to a provider (Chat spend+send,
   payment `collect`, image/LLM sends, delivery claims) with its
   current guard→effect read path — the gate must see each path its
   rule has to fence.
   [COMPLETE — enumeration writer: see "Gate evidence enumeration §2" below.]
3. Grant L93 role-revocation note: "Static user grants are not a
   live role-revocation event" is ledger-silent with no T01 root.
   Adjudicate what revocation timeliness the Grant workflow intends
   (immediate vs eventual) before the gate picks a revocation fence.
   [COMPLETE — revocation-note writer: see "Revocation-timeliness adjudication (gate evidence)" below.]
4. R29 input from T23: whether behavior examples may observe through
   input bindings or must reload stored state — every alternative's
   T32b proof tests inherit this.
5. T06 admission-fact input: the R26-layer-1 rule (which admitted
   expressions carry non-null actor facts into which calls) so the
   gate judges fence rules, not missing narrowing.
   [COMPLETE — admission-fact writer: see "T06 admission-fact input (gate evidence)" below.]
6. T28/T29 ownership input where reads cross package boundaries
   (policies reading `row.parent.*` on imported parents) — a fence
   scoped to one owner must say what an imported-parent read enrolls.
   [QUALIFIED — ownership-input writer: see "T28-ownership input (gate evidence)" below.]
7. Durable-fence evidence plan: per T32 acceptance, memory evidence
   cannot prove fence behavior. Memory stores lack the properties
   the gate must verify — no D1 batch/commit boundary, no revision
   assertion, no concurrent-transaction interleaving, no crash-
   recovery path. Revision/revocation-fence claims therefore require
   D1/DO-backed execution evidence (T16/T17 canonical runtime), not
   memory-store tests; the gate must say which alternative's proof
   runs where. DECISIONS #138 (consistency guarantees unspecified)
   stays open until that evidence exists.
   [COMPLETE — durable-fence writer: see "Durable-fence evidence plan (gate evidence)" below.]
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

## Gate evidence enumeration §1 — purity-gate read-site census (checklist item 1)

Writer: L3 T32a-enumeration. Status: **PREP — adopts NOTHING.**
Method: read-only syntactic census over all 52 `draft/**/*.can` sources
(49 apps + 3 shared; every statement is single-line — zero `\` continuations
verified). Predicate tiers: **T1** direct authority reads
(`active_member`, call-form membership/role tests: `can_work reviewer staff
leave_reviewer knowledge_reviewer is_staff has_role has_location_role owns
operator technician legal sales property_manager finance recipient
inbox_admin mail_staff researcher organizer`); **T2** gate derives wrapping
T1 (`can_use can_read can_view can_review readership editorial eligible
customer_staff queue_access queue_route queue_reply allowed host_eligible
current_access delegate_eligible permitted_collector editable
allocation_eligible request_requires_review may_move can_read_booking_details
coverage_met plan_eligible can_complete eligible_term eligible_account
location_account permitted_hours revoke_needed inspection_pending
venue_covers manage`); **T3** adjacent business-state reads in pure positions
(`available settled live is_open may_reserve`). Bare role atoms (`finance`,
`hr`, `members`, …) in `by=`/`read=` are admission atoms, not calls —
excluded. Quantifiers/aggregates (`any all count`), `first`, `now`,
constructors (`money date`), `input` (pure local prompt-builder derive) are
assumed pure builtins — the gate must confirm. Self-name matches on
`derive`/`scenario` definition lines and `##` comments excluded.
Caveat: no build was run (enumeration brief); classes below are
syntactic-position candidates for the R26-layer-2 E3010 purity shape. The
exact compiler rejection set needs a coordinator-owned checker run; every
line below is independently re-grepable (commands in §3).

Counts (pure-position lines with ≥1 T1/T2/T3 call; call occurrences:
T1 844 + T2 236 + T3 49):

| Class | Lines | Fence context (per-site: same-owner checkpoint unless noted) |
| --- | --- | --- |
| policy predicate | 273 | read-admission eval; 126 read-part-only / 142 where-part-only / 5 both |
| derive guard (definition) | 46 | callee fence = caller's checkpoint; imported derives cross owner (T28 input) |
| crud `when=` guard | 81 of 93 (12 data-only) | CRUD admission at operation checkpoint |
| send `when=` guard | 31 of 68 (37 data-only) | dispatch-claim guard, atomic with supersession (settled L524) |
| lock `when=` guard | 1 of 48 (47 data-only) | field-lock predicate at update commit |
| invariant (Given) | 10 | per-row stored invariant; no checklist class — reported separately |
| page gate (`list/table/gallery where`) | 8 | page-discovery checkpoint (DECISIONS L739 reuse rule) |
| corpus `where=` | 1 | retrieval-scope predicate (Knowledge:25 `live(row)`) |
| review input: example observation | 20 | T23 observation rows (`->`) asserting predicate outcomes |
| review input: `form review=` binding | 7 | CSV-import review reads (targets below; bodies are pure field compares) |
| ui-display (`text`) | 2 | display-only T3 (Affiliate:248/290 `available(row,"EUR")`) |
| **Pure total** | **473 lines (+7 bindings) across 50/52 files** | zero-pure files: CanBoard, CanStats (bare roles only, verified) |
| Excluded effectful (no E3010 expected) | require 384, `if` 38, do-block 12 = 434 | admission/effect-time reads inside the fence |

Cross-owner reads: `use employee {can_work,…}` in 40 files; `use customer
{owns,has_role,…}` in 20 files — most policy/crud sites read an imported
owner's predicate (checklist item 6 input).

### §1a — `active_member` 20/20 (every direct occurrence in `.can`)

| # | Site | Class | Fence context |
| --- | --- | --- | --- |
| 1 | Chat:15 `derive can_use` | derive | callee of policy/require/send-guard callers (Chat:26-28/67/81) |
| 2 | Chat:145 `if not active_member(event.user,team)` | if (effectful, NOT rejected) | member_removed handler; refutes purity-only reading |
| 3 | Creative:18 `derive can_view` | derive | imported by Gallery (`use creative {can_view,…}`) |
| 4 | Creative:103 send `when=` | send-when | Images.submit claim guard (R26 sampled site) |
| 5 | Creative:152 `if not active_member(event.user,team)` | if (effectful) | member_removed handler |
| 6 | Decide:22 `derive can_read` | derive | callee of Decide:30-32 policies |
| 7 | Do:39 `invariant Task` | invariant | per-row assignee invariant + `staff()` |
| 8 | Do:91 `if active_member(view.account,team)` | if (effectful) | observation handler gate |
| 9 | Gallery:15 `derive can_read` | derive | callee of Gallery:20-21 policies, :94 page gate |
| 10 | Gallery:38 crud `when=` | crud-when | Access activation requires live membership |
| 11 | Hire:163 `require` | require (effectful) | hiring gate, pre-`set` admission |
| 12 | Knowledge:20 `derive readership` | derive | callee of 4 policies + ask require + Handbook send guard |
| 13 | Knowledge:86 crud `when=` | crud-when | Topic expert must be live member |
| 14 | Knowledge:87 crud `when=` | crud-when | Audience activation requires live membership |
| 15 | Knowledge:245 `require` | require (effectful) | escalate gate on another subject's expert |
| 16 | Onboard:37 crud `when=` | crud-when | Step assignee must be live member |
| 17 | Onboard:54 `require` | require (effectful) | assignment gate |
| 18 | Shift:251 send `when=` | send-when | Mail.send claim guard + `eligible()` |
| 19 | shared/Employees:8 `derive staff` | derive | root: imported by 40 files via `use employee` |
| 20 | shared/Employees:9 `derive can_work` | derive | root: 193 policy call occurrences corpus-wide |

Pure-position direct sites: 13 (7 derive + 4 crud-when + 2 send-when);
effectful (require/if): 7. R26 sampled 2 of 13 pure (Chat:15, Creative:103).

### §1b — derive guards 46/46 (definition site : called predicates, self-name excluded)

Book:25(is_open) Chat:15(active_member) Contract:26(can_work,legal,sales,
property_manager,finance) Creative:18(active_member,can_use) Customer:28
(can_work) Decide:22(active_member,reviewer) Discover:64(can_work,researcher)
Enrich:36(researcher) Gallery:15(active_member) Gallery:16(reviewer,can_read)
Inbox:29/30/31(inbox_admin,mail_staff ×3) Knowledge:20(active_member)
Knowledge:21(knowledge_reviewer) Learn:26(can_work,is_staff,eligible_term)
Mail:36(has_role,recipient) Mail:37(eligible_term) Mail:40(recipient,
delegate_eligible) Maintain:38(can_work,technician) Member:152
(has_location_role×2,owns,eligible_account) Member:153(eligible_term,
location_account,permitted_hours) Member:154(allocation_eligible) Member:155
(has_role×2,owns) Member:156(eligible_account) Member:157(eligible_term)
Member:167(eligible_term,location_account,permitted_hours,is_open) Onboard:17
(staff) Reception:71(has_location_role×2,owns) Reception:72(current_access)
Reception:73(host_eligible,is_open) Rent:188(venue_covers) Rent:189(is_open)
Rent:190(has_location_role×2,owns) Rent:191(can_work,may_reserve) Rent:256
(can_work×2) Shift:73(coverage_met) Shift:75(can_work) Shift:76(eligible)
Stock:42(available) Sync:35(reviewer,operator) Trade:17(eligible_term)
Volunteer:25(venue_covers) Workbench:27(can_work,staff) shared/Employees:8-9
(active_member ×2). Exported (cross-package callees): Chat:15, Creative:18,
Rent:256, Employees:8-9, Customer:25(has_role, body pure), Customer:28.

### §1c — policy predicates 273/273 (`file: line(calls), …`)

Affiliate: 35,37,39,41(can_work). Approve: 18(can_work×2),22,23,25,26
(can_work). Book: 32,34,37(can_work). CRM: 20,24,27,28(can_work). Catch:
34-40(staff). Chat: 26,27,28(can_use). Check: 20,21,22(can_work). Contract:
28-32(allowed). Creative: 29,31(can_view). Customer: 29,30,33,34,37,39,40,
41,42,43,45,46(customer_staff; :46 ×2), 31(has_role×3,owns), 35,36,38
(has_role), 44(has_role,owns). Decide: 30,31,32(can_read). Desk: 27,29
(can_work). Discover: 38-45(can_work). Do: 30-34(can_work,staff). Event:
40-44(can_work). Expense: 20,24,25,27,29,30(can_work), 26(can_work×2).
Field: 33,35,36(can_work). Gallery: 20(can_review), 21(can_read). Grant:
34,35,37-43(can_work). Hire: 36,38,40,41,42(can_work). Inbox: 36
(queue_access×3), 38-43(queue_access). Invoice: 64,65,83,85,110,134,136,
138,140,142,144,146,152(can_work), 84,86,135,137,139,141,143,145,147,153
(has_role,owns). Knowledge: 34(readership,editorial), 36(readership,
editorial,live), 37(editorial), 38(readership), 45(readership,live). Learn:
28,29,30,32,34,36(can_work), 33(eligible). Leave: 39,41,44(can_work).
Loyalty: 38,41,43,45,47,49(can_work). Mail: 32,41,46,48,50(can_work), 42,43
(manage), 47,49(recipient). Maintain: 45-50,52-55(can_work). Member: 171,
174,176,179,180,182,184,186(can_work), 169(has_role,owns), 172(has_role×2),
175,177,178,183,185(has_role), 181(eligible_term). Onboard: 21,22(can_work).
Propose: 46,47,49(can_work). Purchase: 48,49,51-61(can_work). Reception:
46,48,50,51,52(can_work). Refer: 38,40,42,44,46,48(can_work), 241(has_role
×2,owns). Rent: 142,198,201,203,204,218,232-235,252,253,258-263,265,266,
269,270,272,274(can_work), 143(has_location_role,owns), 257
(can_read_booking_details). Report: 34(can_work). Shift: 60,62,64,67
(can_work). Stock: 37,47,48(can_work). Success: 28,35,36,37(can_work).
Table: 18,19,20(can_work). Time: 26,28,30,32(can_work). Trade: 24
(eligible), 25(eligible×2). Volunteer: 31,32,34(can_work). Workbench: 31,
33(eligible). shared/Employees: 11(staff). shared/Suppliers: 9,10(can_work).

### §1d — crud `when=` 81/81, send `when=` 31/31, lock `when=` 1/1, invariant 10/10

crud-when — Affiliate:70 Approve:86 Book:61-65 CRM:47(×2),52 Catch:93(staff)
Contract:54(can_work,allowed),55,56,57(allowed) Customer:73,74,75
(customer_staff) Desk:56(can_work×2,staff) Discover:79 Do:55-58(can_work,
staff) Event:69 Expense:70 Feedback:56 Gallery:38(active_member) Grant:73,
74(can_work; :54 is lock, see below) Hire:54 Inbox:92(inbox_admin,
mail_staff) Invoice:273,279 Knowledge:86,87(active_member) Learn:58,59
Loyalty:76-79 Mail:86(has_role,owns,delegate_eligible) Maintain:79,91
(can_work),80(can_work×2,technician) Member:23,24,25,226,227 Onboard:37
(active_member) Propose:69,70 Purchase:103,104,105 Reception:81,82 Refer:63
Rent:335,336,337,1157 Shift:104 Stock:62 Success:45(×2),46,47(×2) Table:39,
40,58 Time:51 Trade:36(eligible),43(eligible×2) Volunteer:43,44
shared/Locations:29-32 shared/Suppliers:12 (all can_work except as noted).
send-when (guard calls only; payloads carry zero authority calls, verified
31/31) — Approve:268(can_work,reviewer→Mail.send) Chat:81(can_use→
LLM.generate) Creative:103(active_member,can_use→Images.submit) Decide:107
(reviewer→Judge.evaluate) Discover:161,244,251(eligible) Enrich:68,106,127
(live) Hire:283(can_work→Mail.send) Inbox:212,241(queue_reply) Knowledge:159
(readership→Handbook.answer) Mail:120,177,305,324(recipient) Maintain:355
(plan_eligible,inspection_pending→Mail.send) Reception:103,253,328,358,363
(current_access) Shift:251(active_member,eligible→Mail.send) Success:109,
118(can_work→Mail.send) Sync:75(operator),105,124(editable→Remote.*)
Workbench:72(eligible→Planner.next).
lock-when — Grant:54(can_work,reviewer) is the ONLY authority call among 48
lock guards (field-lock on reviewer reassignment).
invariant — Purchase:24 Do:44 Field:23 Stock:12 Contract:46 Check:34 CRM:43
(can_work preferences ×7) + Do:39(active_member,staff Task) + Stock:51,
Table:24(available T3).

### §1e — page gates 8/8, corpus 1/1, review inputs 20+7, ui-display 2/2

Page gates: Gallery:94(list,can_read) Gallery:125(gallery,can_review)
Knowledge:305(list,readership,live) Knowledge:317(table,editorial) Expense:
365(list,can_work) Creative:199(list,can_view) Hire:426(list,can_work)
Invoice:888(list,owns,has_role). Corpus: Knowledge:25(where=live(row)).
Example observations (`->` asserting predicate outcomes): Affiliate:79,113,
118,197(available) Stock:68,146,151(available) Approve:187 Expense:159
Grant:184(can_work,reviewer) Expense:91(reviewer) Inbox:184(queue_access×2)
Mail:142,155(delegate_eligible) Mail:159(recipient,live) Mail:169
(recipient×2) Maintain:82,288(inspection_pending) Maintain:303
(plan_eligible,inspection_pending) Member:659(has_location_role).
`form review=` bindings (read=true review scenarios; bodies are pure
field-compare queries gated by by=): Expense:485→:337(by=authenticated)
Rent:1444→:313 Invoice:827→:220 Customer:233→:82 Customer:252→:89
(by=customer_manager) CRM:172/180→imported customer duplicates (cross-package
review read via `use customer`). No authority CALLS in review bodies —
the fence question is caller-visibility (examples assert finance→1 /
members→0 / public→forbidden), not purity.
ui-display: Affiliate:248/290(text available(row,"EUR")).

### §1f — alternatives discrimination (which sites separate A–D)

- A-vs-B (checkpoint-carry vs re-read-at-effect): decided by multi-use
guard rows — Chat:72-83 (allowance bound once, used across guard+set+send),
Creative:97-103 (budget bound, guarded, held, sent), Knowledge:148-159
(readership evaluated in require AND re-evaluated in send guard), all 273
policy rows consumed far from their eval point. Under B each needs a
fresh-read ruling; under A/C/D they enroll once.
- A-vs-C (database-wide vs pinned assertion): decided by hot-row coupling
— 193 can_work policy occurrences all enroll the membership/Employee tables;
under A any membership write voids any in-flight guarded op. Contended
witnesses: Chat:26-28, Knowledge:34-45, Member:169-186.
- C-vs-A (eventual-read label): only candidates for declared-eventual are
T3 display/lookup reads — Affiliate:248/290, Stock:51, Table:24,
Knowledge:25/305; every T1/T2 site above authorizes (no T1/T2 site is
display-only). If C requires labels, exactly the T3 set needs them.
- D-vs-A/C (grants): no site mints portable evidence today; D's customer
would have to be cross-package reads (40 `use employee` files, Gallery←
Creative can_view, CRM←Customer duplicates) — the only reads whose
authority crosses an owner boundary.
- B-fatal shape if present: `let`-bound guard rows used by later effects
(Chat:72-83, Creative:97-103, Knowledge:151-159, Inbox:112-117/137-142) —
B must rule `let` re-reads or force rewrites; A/C/D preserve verbatim.

## Gate evidence enumeration §2 — spend-effect inventory (checklist item 2)

Status: **PREP — adopts NOTHING.** Every effect that moves money, consumes
a capped allowance, or dispatches to a provider, with its current
guard→effect read path (`scn=name@line gate=by=…|on=… req=[…]`).
Legend: `[auth]` send guard holds T1/T2 calls (§1d) · `[data]` guard is
data-only · `[nowhen]` no guard (scenario require/by only).

Counts: **236 send lines** (231 line-initial + 5 `do send`; zero lines hold
2+ sends) across **39/52 files** (zero-send: Board CRM Expense Feedback
Gallery Learn Onboard Stock Table Trade + 3 shared) to **69 targets**: 68
with `when=` (31 authority + 37 data-only), **168 unguarded**.
Money-record creates **22**; capped-allowance sets **27** + bucket creates
**3**. Out of scope (noted, not inventoried): `emit` (internal events),
`schedule` (timers), `call` (internal scenario calls), delivery-attempt
counters (Purchase:163/188/307/315/319/326/330 `attempts=`, retry state not
a capped allowance), Mail `collect` scenario (physical-item custody, not
money). Total inventory: **288 records**.

Targets (69): Accounting.record 1, Alerts.notify 5, Analysis.extract 2,
Billing.cancel 17, Billing.charge 13, Billing.reconcile 10, Billing.refund
8, Catch.report 1, Commissions.account 1, Commissions.onboard 1,
Commissions.reconcile 2, Commissions.settle 1, Devices.apply 5,
Devices.reconcile 1, Dimensions.read 1, Documents.invoice 1, Documents.quote
1, Documents.receipt 1, ErrorJobs.publish 1, Handbook.answer 1,
Handbook.cancel 1, Handbook.reconcile 1, Handbook.refresh 1, Images.cancel
3, Images.inspect 1, Images.reconcile 1, Images.submit 1, Images.validate 1,
Judge.evaluate 3, LLM.cancel 3, LLM.generate 1, LLM.reconcile 1, Mail.send
39, Membership.commit 1, Membership.consume 3, Membership.eligibility 4,
Membership.reconcile 2, Membership.release 13, Membership.reserve 4,
Payments.cancel 3, Payments.collect 2, Payments.reconcile 2, Payments.refund
2, Planner.next 1, Post.reconcile 1, Post.reply 2, Remote.read 2,
Remote.replace 2, Reports.reports 1, Rooms.accept_offer 1, Rooms.affected 1,
Rooms.confirm 4, Rooms.downtime 2, Rooms.hold 2, Rooms.hold_offer 1,
Rooms.release 5, Rooms.release_offer 1, Rooms.restore 2, Rooms.stage 2,
Sources.lookup 3, Sources.page 1, StaffSchedule.release 18,
StaffSchedule.reserve 5, StaffSchedule.stage 3, Stock.post 4,
WebDimensions.write 1, WebJobs.publish 1, WorkSources.work 1, Writer.draft 1.

### §2a — money-movement records 22/22 (create + guard path)

Affiliate:104(create Sale amount/commission ← qualification req 86,87,92,
94,98,102) :109(create Adjustment reversal ← req +106). Chat:78(create Run
reserved ← ask/members req 67-70,73,75). Expense:215(create Decision amount
← decide/reviewer req 213) :272(create Reimbursement ← finance req 270).
Invoice:366(Attempt ← collect req 361,362) :421(refund Attempt ← finance req
417-419) :620(auto-collection Attempt, on=CollectionDue, NO require — timer
path) :799/:806(source_refund ← on=BillingRequests.refund req 792,795,796).
Loyalty:84(create Redemption ← redeem/authenticated req 82) :176/:181
(Earning ← on=Sales.qualification req 164,166,172). Member:278(term/price ←
on=RenewalDue req 259,268,273,275) :371(reserve ← req 345-370 ×13).
Refer:83(Settlement ← settle/finance req 70,74,76) :119/:125(qualify ←
on=Sales.qualification req 99-123) :153(reject_source ← program_manager req
148). Rent:584(Adjustment overage ← on=MovementObserved req 566,571) :1093
(extend Adjustment ← authenticated/reception/billing req 1086-1092).
Time:151(Correction amount/collected ← project_manager req 146,149).
Money-moving sends without local create (claim-only): Payments.collect
Invoice:367/:621, Payments.refund Invoice:422/:807 + Member:536 + Rent:636/
641/777/1136/1149 + Time:222 + Event:436, Billing.refund×8 / charge×13 /
cancel×17 / reconcile×10 (paths in §2c), Commissions.settle Affiliate:75.

### §2b — capped-allowance consumption 27+3 (set/create + guard path)

Chat:80(held/running+ ← ask req 73,75) :132-133(release held/running, used=0
← release_skipped req 130) :161-164(spent+=used, running- ←
reply_progressed req 158,159). Creative:102(held/running+ ← generate req 98,
100) :140-141(release ← req 138) :165-168(spent+= ← image_progressed req
162,163). Knowledge:154(create DailyUsage ← ask req 148,152) :156
(requests+1). Inbox:115/140(create DailyUsage) :117/:142(requests+1 ←
received req 105,108 / classify req 133,134,138; cap check :113/:138).
Discover:163(requests+1 ← fetch_page on=PageDue, NO require — capped at
:223 max_pages on a LATER scenario). Member:377-378(reserve held ← req
345-370) :420-421(consume ← req 415,417). Rent:1270/1272/1290(allowance
snapshot/consume ← on=AllowanceObserved req 1251,1252,1266) :597
(reserved window ← on=MovementObserved) :1093-adjacent. Propose:195/285
(hold_state ← provider-completed, NO require). Table:71(state=reserved ←
host req 70). Guard pattern: `let x=first(Allowance…)` + require
 active/unsaturated + set — the EXACT shape §1f flags for B.

### §2c — provider-dispatch sends 236/236 (full table; `DO-SEND` = `do`-prefixed)

Affiliate(5): 75:Commissions.settle[nowhen] settle@72 by=finance req73.
125:onboard[nowhen] req123. 137:Commissions.account[nowhen] req134,135.
205/211:Commissions.reconcile[nowhen] (211 on=SettlementCheck, NO req).
Approve(1): 268:Mail.send[auth] notify@264 on=Notice.created, NO req.
Book(11): 75:StaffSchedule.reserve + 79:Rooms.hold [nowhen] book@67
req68-71. 99:stage + 102:Rooms.stage [nowhen] reschedule@90 req91-94,97.
202/217/275:Rooms.confirm[nowhen] (on=completed/changed +1 req each).
313/369:Mail.send[data] (on=AttemptProgress/Reminder). 338:release +
342:Rooms.release [nowhen] cleanup@333.
Catch(3): 96:ErrorJobs.publish[nowhen] DO-SEND accepted@94
on=ErrorIntake.accepted req95. 151/154:Alerts.notify[data] notify@147.
Chat(5): 81:LLM.generate[auth] ask@66 by=members req67-70,73,75. 120/126/
141/148:cancel/reconcile/cancel/cancel[nowhen] (148 on=member_removed).
Check(3): 76/120/130:Alerts.notify[data] (on=Pings/Check.update/Deadline).
Contract(2): 130/144:Mail.send[data] (on=Notice/ObligationDue, NO req).
Creative(7): 68:inspect + 76:validate [nowhen] by=creative_manager. 103:
Images.submit[auth] generate@93 req94,95,98,100. 128/134/148/155:
cancel/reconcile/cancel/cancel[nowhen] (148/155 on=revoked/removed).
Customer(1): 129:Mail.send[nowhen] invite@123 req124,125. Decide(2): 60:
Writer.draft[data] generate@53 req54,55. 107:Judge.evaluate[auth]
evaluate@101 by=reviewer req102-104. Desk(1): 96:Mail.send[nowhen] reply@91
req92. Discover(3): 161:Sources.page[auth] on=PageDue NO req. 244/251:
Analysis.extract[auth] (244 by=researcher req241,242; 251 on=Evidence.
create). Do(2): 85:WorkSources.work[nowhen] refresh@79 req80,81. 115:
Catch.report[nowhen] DO-SEND report_error on=instrumentation.error.
Enrich(3): 68/106/127:Sources.lookup[auth] (106 on=Assess NO req). Event
(21): 88:Billing.charge[nowhen] register@75 req76-80,87. 129:Rooms.stage +
132:hold [nowhen] change@115. 146/158:release[nowhen]. 223:Rooms.confirm
[data]. 253:release[nowhen]. 274:Billing.cancel[nowhen] cancel@266. 284/
299/311/341/358:reconcile[nowhen]. 292/400/415/484:cancel[nowhen]. 436:
Billing.refund[nowhen] on=RefundCheck. 512/524:Mail.send[data].
Field(9): 48:reserve[nowhen] dispatch@44 req45. 75/85/102:release/stage/
reserve[nowhen]. 77:Mail.send[data]. 172/175/179:release[nowhen]
on=every(1m). Grant(1): 283:Mail.send[nowhen] decide@275 by=reviewer
req276,279. Hire(13): 90:reserve 98:stage 111/116/127/150/181:release
[nowhen] by=recruiter/authenticated. 206/219/236/251/257:release[nowhen]
(on=completed/changed/accepted). 283:Mail.send[auth] on=Reminder req281.
Inbox(5): 120/145:Judge.evaluate[data]. 212/241:Post.reply[auth]
submit/resubmit by=mail_staff|inbox_admin. 227:Post.reconcile[nowhen].
Invoice(15): 296:Mail.send[data] issue@287. 302:Documents.invoice[nowhen].
328:Documents.receipt[nowhen]. 367:Payments.collect[data] collect@360
req361,362. 404/456:Payments.cancel[nowhen] by=finance. 422:Payments.
refund[nowhen] refund@416 req417-419. 496/753:Mail.send[data]. 571/605:
Payments.reconcile[nowhen]. 621:Payments.collect[data] on=CollectionDue NO
req. 635:Mail.send[data] DO-SEND on=Overdue req634. 770:cancel[nowhen].
807:refund[nowhen] on=BillingRequests.refund req792,795,796. Knowledge(4):
145:Handbook.refresh[nowhen] DO-SEND reindex req144. 159:Handbook.answer
[auth] ask@147 req148,152. 213:cancel + 223:reconcile [nowhen].
Leave(3): 131:reserve[data] decide@124 req125,129. 154/181:release[data]
cancel/retry_release by=hr|leave_reviewer. Loyalty(1): 85:Mail.send
[nowhen] redeem@81 req82. Mail(7): 120/177/305/324:Mail.send[auth] (305
on=Reminder NO req). 211/293:Billing.charge[nowhen]. 264:Billing.reconcile
[nowhen]. Maintain(8): 181/187/355:Mail.send[data/data/auth] (355 on=
Reminder). 202/216/363/367:downtime/restore[nowhen]. 404:affected[nowhen].
Member(4): 279:Billing.charge[data] on=RenewalDue req259,268,273,275.
536:Billing.refund[nowhen] refund_term@526 req527. 558:charge[data]. 583:
reconcile[nowhen] on=PaymentCheck. Propose(5): 94:Mail.send + 100:
Documents.quote + 181:hold_offer + 221:accept_offer [nowhen] by=
salesperson/authenticated. 348:release_offer[nowhen] on=HoldProgress.
Purchase(5): 162/187/325/329:Stock.post[nowhen] (325/329 on=every(5m)).
306:Accounting.record[nowhen] by=budget_manager req304. Reception(13):
91/167/186/203:Membership.eligibility[nowhen]. 103/358/363:Mail.send[auth].
253/263/279/321/328/342:Devices.apply×4/reconcile/apply[auth on 253,328].
Refer(1): 126:Mail.send[nowhen] qualify@95 on=Sales.qualification req99-
123.

Rent(51, ZERO authority guards — all Mail sends data-only): 525/538:
reserve[nowhen] move_membership@516/528. 548/558/590/661/669/682/687/767/
772/1229/1262/1425:release[nowhen]. 550/560/592/663/671/769/774/1132/1231/
1434:Billing.cancel[nowhen]. 579:commit + 585:charge[nowhen]
movement_result@565 on=MovementObserved req566,571. 636/641:refund[nowhen]
refund_movement_credit@629 req630,631,635(+640). 692/1238/1315/1431:
reconcile[nowhen]. 720:reserve + 725:charge[nowhen] prepare@716.
777/1136/1149:refund[nowhen]. 942/1035/1050/1082/1095/1275:charge/consume/
charge[nowhen]. 1045:reserve + 1050/1281/1345:consume[nowhen]. 1198/1205/
1212:Mail.send[data] on=ReservationChanged/Reminder. 1218:Mail.send[nowhen].
Report(1): 45:Reports.reports[nowhen] refresh@42 req43. Shift(1): 251:
Mail.send[auth] duty_notice@249 on=DutyNotice NO req. Stats(3): 50:
WebJobs.publish[nowhen] DO-SEND intake on=Tracker.accepted req48,49. 63:
WebDimensions.write[nowhen] on=WebJobs req59. 128:Dimensions.read[nowhen]
by=analyst req121,127. Success(2): 109/118:Mail.send[auth] on=FollowUpDue/
RenewalDue. Sync(4): 67:Remote.read[data] by=operator|reviewer req64. 75:
Remote.replace[auth] on=RefreshDue NO req. 105/124:Remote.replace[auth]
approve/rebase by=reviewer. Time(5): 157:cancel 198:charge 210:cancel 216:
reconcile 222:refund [all nowhen] by=project_manager. Volunteer(4): 150/
170/184/191:Mail.send[data]. Workbench(1): 72:Planner.next[auth] next@63
by=members req64,65.

### §2d — guard→effect path patterns + alternatives discrimination

- Dominant path (168/236 = 71%): NO send guard — authorization lives
entirely in scenario `by=` + `require` evaluated before the `do` block.
Under B every such send needs its own effect-time re-read ruling (168
rulings); under A/C/D the scenario checkpoint + commit fence covers them.
Highest-exposure unguarded money sends: Payments.collect Invoice:621
(timer, NO require at all), Billing.charge ×13, Billing.refund ×8.
- Guarded money path: Payments.collect Invoice:367 has a DATA-only guard —
no authority revalidation at claim time in source today. Under A the commit
fence must add it; under B the effect re-reads; C pins + fresh dispatch
read; D mints the spend grant inside the claim. This site + Chat:81 +
Creative:103 + Knowledge:159 are the four load-bearing spend guards.
- Stale-read→spend gaps visible in source: Chat:72-83 (allowance read at
:72, guard :73/75, hold :80, send :81 — revocation between :72 and commit
is exactly the T32 question); Knowledge:151-159 (usage read :151, cap :152,
consume :156, send :159); Discover:163 (counter bump with NO require in
scenario; cap enforced only at :223 in a later scenario — cross-operation
fence gap under every alternative).
- A-vs-C on spend: 51 Rent sends + 21 Event sends share Billing/Membership
provider rows — under A one fence covers the batch; C must pin per-record
versions across the provider boundary (implementability question for the
gate). D: each of the 236 sends would need a grant presentation rule —
no source site has one (D's annotation burden is total).
- Event-handler sends (on=…, ~90 of 236) carry NO caller admission —
their only authority input is the event payload + require rows; the fence
for handler-triggered transitive effects (bar item 6) must be the scenario
checkpoint (A/C) or per-effect reads (B), never inherited caller authority.

## Gate evidence enumeration §3 — commands run + release

All read-only (`rg`/`grep`/line census scripts in /tmp; no builds, no Git,
no JEV — tools/jev.py untouched):

1. `ls draft/*.can draft/**/*.can` — 52 sources (49 + 3 shared).
2. `grep -rn active_member` — 20 lines, 10 files (§1a).
3. Role-predicate line counts per name (can_work 586-line raw incl.
effectful; reviewer/staff/eligible/… per-name counts).
4. Python census `/tmp/t32a_census.py` (boundary-aware `name(` matching,
def-name self-exclusion, comment exclusion, send guard/payload split,
policy read/where split) → 907 matching lines: 473 pure + 434 effectful;
tiers T1 844 / T2 236 / T3 49; full per-site JSON `/tmp/t32a_rows.json`.
5. Corroboration: independent `grep -c` recounts (policy can_work 191
lines / 193 occurrences; require 369 + 17 overlap-lines = 384 ✓);
`send`-target recount 236 (231 line-initial + 5 `do send`); `when=` 209 =
93 crud + 68 send + 48 lock ✓; zero-pure Board/Stats verified bare-role
only; zero-send 13 files verified.
6. Python spend inventory `/tmp/t32a_spend.py` + manual `do send`/`review=`
/DailyUsage follow-ups → `/tmp/t32a_spend.json`, `/tmp/t32a_sendtable.txt`
(236 rows); money/allowance record verification by targeted `sed` reads.
7. `form review=` ×7 + target-scenario reads (Expense:337 Rent:313
Invoice:220 Customer:82/89; CRM imports customer's).

Checklist items 1–2 are COMPLETE per the gate-needs text; items 3–8
untouched (coordinator-owned). Alternatives A–D, fairness record, and all
other checklist text UNCHANGED (two pointer lines added only).
Prep status preserved: adopts NOTHING; no code, no normative-doc, no
tasks/monitor/inbox edits.

Release: implementation/challenge-audit-run/evidence/read-decision.md is
RELEASED to the coordinator for JEV-gate scheduling.

## Revocation-timeliness adjudication (gate evidence)

Writer: L3 T32a-revocation-note. Status: **PREP — adopts NOTHING.**
Method: full read of `draft/CanGrant.can` L1-446 (all grant/role-check/
revocation paths, examples, policies) + read-only `rg` census for absence
confirmation + `draft/shared/Employees.can` L6-25 (imported `deactivate`/
`can_work` definitions, read-only). Checklist item 3 only; all other
checklist text, alternatives A-D, and fairness record UNCHANGED.

Verdict: **NOT silent — immediate live-membership revocation; static role
grants explicitly excluded as a revocation channel.** Partially silent on
exactly one point: no in-flight (admit-then-revoke-before-commit) timing
evidence exists. Details and read ranges below; no intent invented.

### §1 — the two authority channels in Grant (every path traced)

Static role channel (grants, never revoked in-workflow):

- Role declarations: Grant:16-17 (`coordinator`, `reviewer`).
- Fixture grants: Grant:60-64 (`reviewer_user`/`replacement_user`
  `roles=[reviewer]`, `coordinator_user` `roles=[coordinator]`, `hr_user`
  `roles=[hr]`, `ordinary_user` `{}`).
- Role checks: `by=` admission atoms (Grant:73,74,275,293,312,322; page
  gates :375,379) and `reviewer(x)` predicate calls (Grant:54,83,215,
  261,295,296).
- Absence (confirmed by `rg`, not assumed): zero in-workflow mutations of
  `user.roles` — `rg 'set .*roles|grant\(|revoke'` returns ONLY the four
  fixture lines; no scenario creates, grants, or revokes a role. Grant
  never contains the substring `revok` except the L93 note itself.

Live membership channel (the actual revocation path):

- `can_work` imported from employee (Grant:7); conjoined in 10 policy
  lines (Grant:34,35,37-43), 2 crud `when=` (Grant:73,74), 1 lock `when=`
  (Grant:54 — the ONLY authority call among 48 lock guards, per §1d),
  requires (Grant:83,215,239,260,261,276,294,295,296,313,323), page
  Grant:390.
- Definition (Employees.can:9): `can_work` holds iff some Employee row
  has `e.active` AND `active_member` AND a location match.
- Revocation op (Employees.can:18-21): `deactivate` by `hr`, sets
  `active=false`, emits `EmployeeChanged`. Grant's only call site:
  Grant:183 (`call deactivate {employee=colleague,...} by=hr_user`,
  where `colleague` is `reviewer_user`'s Employee row per Grant:68).

### §2 — post-revocation behavior IS asserted (timeliness verdict)

Sequence Grant:169-201 (seed includes `colleague`, `replacement_worker`,
`coordinator_worker`, `hr_user`):

- Grant:183: `deactivate` succeeds. Grant:184, the immediately following
  line: `colleague.active,reviewer(reviewer_user),can_work(
  reviewer_user,test_site) -> false,true,false` — the static `reviewer()`
  grant SURVIVES deactivation (`true`) while live `can_work` flips
  (`false`). This observation IS the L93 note's exact meaning, asserted
  as an example row.
- Grant:185: `decide` by the deactivated reviewer → `error(rule_failed)`
  (require `can_work` at Grant:276). Zero intervening operations between
  the revoke (L183) and the denial (L185): **immediate effect**.
- Grant:189: `recover` to `replacement_user` succeeds (require Grant:295
  second disjunct, `not can_work`); Grant:195: old reviewer `decide` →
  `error(rule_failed)` again; Grant:196: replacement `decide` succeeds;
  Grant:201: final approval assertions.
- Caveat (honest): L93 sentence 1 says these sequences use proposed,
  parser-unsupported `do` grammar — L183-185 are draft-authoritative
  intent (RQ01), not yet-executable shape. The verdict rests on intent,
  which is what this gate adjudicates.
- Eventual timeliness has ZERO support: no example anywhere in L1-446
  shows a post-deactivation success or a tolerated stale read. Any
  eventual-revocation variant would contradict Grant:184-185.

### §3 — confirmed silences (read ranges, no invention)

- No static-role revocation event exists in the workflow (see §1
  absence). `recover` Grant:295's first disjunct (`not reviewer(...)`)
  is exercised only by static fixture difference (Grant:303:
  `ordinary_user` as reviewer → success), never by a grant→revoke
  transition. The workflow contemplates role-loss as a recovery trigger
  but never models it as an event.
- No in-flight timing: nothing revokes between admission/read and
  commit within one operation; no concurrent/interleaved shape exists.
  Stale-version conflicts ARE asserted (Grant:192,231,291,310: wrong
  `request.*.version` → `error(conflict)`) but those are version
  fencing, not revocation. DESIGN L291 "already admitted may finish"
  therefore remains UNANSWERED by Grant — genuine partial silence,
  still a JEV question under every alternative.
- No post-deactivation policy-read denial example: policies conjoin
  `can_work` (denial follows by rule) but no `->` row after Grant:183
  asserts a read denial. The timeliness verdict rests on the
  `decide`/`recover`/`can_work` observations, not on reads.

### §4 — alternatives discrimination (supports/constrains)

- Timing: A-D as specified are ALL immediate, hence all COMPATIBLE
  with §2; the finding rules out adding an eventual-revocation
  variant but does not separate A from B from C from D on timing.
- Fence-scope constraint on ALL alternatives: the revocation fence
  must enroll LIVE membership state (`Employee.active` / `can_work` /
  `active_member`), never static role atoms alone — Grant:184 proves
  a role-grant-keyed fence would wrongly allow Grant:185's `decide`
  (`reviewer()` stayed `true`). Concretely: A must revalidate
  `can_work` at commit, not just `by=` atoms; C must pin membership
  rows as authority pins; D's revocation list must record membership
  changes (it cannot be the roles table); B must re-read `can_work`
  per effect rather than caching `by=` admission.
- A-vs-C coupling: Grant is a contended witness — `can_work` in 10
  policy lines plus 7+ guards means every `deactivate`/membership
  write can void in-flight Grant ops under A's database-wide
  revision assertion. Supports C's motivation; C's narrowed-
  assertion implementability stays JEV-PENDING.
- D: Grant contains no portable/expirable authorization artifact
  anywhere in L1-446, and L93 explicitly disclaims static grants as
  the revocation channel — reinforces D's "machinery without a
  customer" opposing case for this workflow.
- B/R29 note: Grant:184's observation row is itself a display read
  asserting predicate outcomes (same class as §1e review inputs) —
  usable for display, unusable for authorization under any
  alternative; T23/R29 input (checklist item 4) governs its proof
  status.

### §5 — commands run + release

Read-only inspection only (no builds, no Git, no JEV —
tools/jev.py untouched):

1. Full read `draft/CanGrant.can` L1-446 (this file's sole intent
   source) + `draft/shared/Employees.can` L6-25 (imported
   `deactivate`/`can_work` definitions).
2. `rg -n 'roles=|deactivate|revok|active|can_work\(|reviewer\('
   draft/CanGrant.can` — every grant/role/revocation path (§1).
3. `rg -n 'set .*roles|roles.*=|grant\(|revoke'
   draft/CanGrant.can` — only the four fixture lines: no
   in-workflow role mutation (§1 absence).
4. `rg -n 'deactivate|can_work|active'
   draft/shared/Employees.can` — Employees.can:6-25 (§1 definitions).

Checklist item 3 is COMPLETE per the gate-needs text; items 4-8
untouched (coordinator-owned). Prep status preserved: adopts
NOTHING; no code, no normative-doc, no tasks/monitor/inbox edits.

Release: implementation/challenge-audit-run/evidence/read-decision.md
is RELEASED to the coordinator for JEV-gate scheduling.

## T06 admission-fact input (gate evidence)

Writer: L3 T32a-item5. Status: **PREP — adopts NOTHING.**
Method: read-only reads of the landed T06 checker code
(`compiler/src/analysis/types.rs` actor-fact paths,
`compiler/src/analysis/resolve.rs` scope paths,
`compiler/tests/b4_check.rs` T06 tests) + `tasks.md` T06 evidence +
`root-causes.md` R26. Checklist item 5 only; all other checklist
text, alternatives A–D, fairness record, and prior appends
UNCHANGED. No JEV run; tools/jev.py untouched; no code, no
normative-doc, no tasks/monitor/inbox edits.

Verdict: **COMPLETE — R26-layer-1 actor rule CONFIRMED as landed
(T06 ticked COMPLETE in tasks.md).** No narrowing semantics
invented: every clause below cites landed code lines or tasks.md.
Absences carry exact grep evidence.

### §1 — the landed R26-layer-1 rule (which admitted expressions carry non-null actor facts into which calls)

T06 is COMPLETE per tasks.md: writer released types.rs + resolve.rs
(two-polarity admission, role_call_on_caller no-leak,
collect_narrow hook, by→when) + 19 b4 tests + table; coordinator
stash-differential 0 added / 219 removed, ALL actor-shaped (E3001
-213, E3003 -6, rest bit-identical); suite 27 green. (19-test
count re-confirmed: `grep -c "fn t06_" compiler/tests/b4_check.rs`
→ 19.)

What counts as an ADMITTED expression (true polarity —
`auth_proves_actor`, types.rs:2939-2994; resolver mirror
`proves_auth`, resolve.rs:4192-4229):

- Bare `members` / `owner` / `authenticated` (both layers).
- Bare declared Role references (checker only, types.rs:2949-2956;
  the resolver leaves these nullable — comment types.rs:2819-2821).
- Call form `r(actor)` where `r` resolves to a `Role` symbol and the
  single UNNAMED subject resolves to the `actor` contextual fact
  (`role_call_on_caller`, types.rs:3049-3085;
  resolve.rs:4281-4317).
- Groups transparent; `and` needs ONE admitting side,
  `or` needs BOTH (types.rs:2971-2978); `not X` admits iff X
  admits-when-false (types.rs:2982-2991).
- False polarity (`auth_proves_actor_when_false`,
  types.rs:3003-3041; `proves_auth_when_false`,
  resolve.rs:4235-4273): ONLY a failing `public` test admits (a
  non-public request is authenticated); `and`-false needs both
  sides, `or`-false needs either; `not` flips to true polarity.

What NEVER admits (no-leak, all landed + tested): member paths
(`SyntaxKind::Member => false`, types.rs:2959,
resolve.rs:4202); role tests on another subject (`r(owner)`,
non-caller args); derive/builtin/non-role calls; `public` in true
polarity, including `by=public or r` (or-needs-both);
preauthorization parameter defaults; trusted-handler scopes
(`ActorKind::Null`, resolve.rs:3799). Tests: t06_no_leak_*,
t06_public_guard_use_rejected, t06_or_with_public_rejected,
t06_crud_public_when_rejected, t06_preauthorization_default_rejected,
t06_trusted_actor_stays_null.

Where the non-null actor fact is CARRIED (exactly four
`DeclKey::CtxActor` insert sites in types.rs — grep evidence:
`grep -n "DeclKey::CtxActor"` returns ONLY 2827 / 4515 / 5423 /
11150 plus keying line 7418):

1. Scenario `by=` → guards (require chain) + body
   (types.rs:2818-2832); resolver sets the scenario scope
   `ActorKind::NonNull` for the same predicate
   (resolve.rs:3823-3832).
2. Policy `read=` → `where=` (types.rs:4507-4520).
3. CRUD `by=` → `when=` (types.rs:5416-5428; the T06 by→when edge).
4. Boolean continuations via the `collect_narrow` hook
   (types.rs:11134-11155): within-expression `and`-right
   (left-true facts) / `or`-right (left-false facts) during expr
   checking (types.rs:10281-10323); `if` then/else branches
   (types.rs:2555-2557); do-block/scenario `require` chains — a
   successful require carries forward (types.rs:793,
   types.rs:2854 via walk_seq/walk_guard). Keyed
   `DeclKey::CtxActor`, invalidated like any continuation fact
   (T03 §§6-8); a TYPING fact only — grants no permission and no
   currency (T03 §9; comment types.rs:11137-11140).

NOT carried by any dedicated edge (ABSENT — follows from the
closed 4-site grep above): derive bodies, send `when=`, page
gates, invariants, lock guards receive admission facts ONLY via
ambient continuation flow (e.g. send `when=` is checked in the
un-narrowed scenario cx, types.rs:2310-2314 — it sees the
enclosing body's facts, with no per-guard admission insert of
its own). R26-layer-1's original Chat:15 shape (`person!=null
and active_member(person,…)` reaching the call) is the §4
within-expression mechanism: left-conjunct facts (T05 null
facts AND T06 admission facts alike) reach right-operand calls.

### §2 — alternatives impact (proof obligations changed vs still needing fence rules)

Global upshot for ALL alternatives: T06 changes NO fence proof
obligation — it is a typing fact (grants no permission, no
freshness; T03 §9; R04 boundary: check-time facts never become
staleness promises). What changes is the gate's BURDEN OF
PROOF: remaining E3010 purity rejections at §1's pure-position
sites are NOT missing narrowing — actor-nullability at authority
calls is settled (219 removed / 0 added, all actor-shaped). The
fairness-record cross-cutting risk ("AND-fact delivery to
`active_member(person,…)` calls (T06) must land regardless") is
DISCHARGED for actor facts — keep as landed premise, drop from
gate-open questions. Any still-rejected admitted-actor site is
either layer-2 purity (needs the adopted fence contract) or a
genuine negative. The gate's starting line is pinned by test
t06_bounded_read_stays_gated (b4_check.rs:958-965): a
state-reading call in a pure position STILL yields E3010 until
T32 adopts.

- A (single-checkpoint fenced reads): obligations UNCHANGED.
  T06 feeds A: admitted-actor typing already reaches every guard
  predicate A evaluates at the checkpoint (policy `where=`,
  CRUD `when=`, require chains, AND-right calls). A must still
  define checkpoint enrollment, commit-time revalidation, and
  the L291 in-flight question. Proof burden reduced in one
  respect only: T32b tests need no "admit the actor first"
  scaffolding beyond landed narrowing — failures at admitted
  sites are fence failures, not narrowing gaps.
- B (read-at-effect): obligations UNCHANGED. T06 gives B no
  carried VALUES: admission facts type `actor` only; they are
  not value pins, and `let`-bound guard rows are T05/T07 facts
  (T07 filtered-row facts still OPEN per tasks.md). B's
  `let`-as-value JEV-PENDING question is therefore untouched —
  T06 neither resolves nor worsens it.
- C (version-pinned snapshots): obligations UNCHANGED. Pins are
  a runtime freshness mechanism; T06's typing facts pin
  nothing. The authorizing/eventual static separation still
  needs its own rule — and the gate must NOT conflate T06's
  admit/never-admit classification (caller authentication)
  with C's authorizing/eventual split (read freshness). They
  are different questions answered by different machinery.
- D (bounded authority grants): obligations UNCHANGED. No
  grant minting, consumption, expiry, or revocation-list
  concept exists anywhere in the T06 paths (ABSENT — the
  admitting predicates above are pure boolean tests; nothing
  mints portable evidence). D's "machinery without a
  customer" stance is unaffected.

Preserved negatives the gate must not regress: public /
other-subject / preauthorization actor stays nullable; trusted
payload users never become callers; revocation denies new
access/spending (layer-2 fence work, not narrowing).

### §3 — commands run + release

Read-only inspection only (no builds, no Git, no JEV —
tools/jev.py untouched):

1. Full read of the T32a section + fence alternatives in
   CHALLENGE-AUDIT-PLAN.md; full read of read-decision.md
   (alternatives + fairness record + §§1-3 + revocation
   appends); tasks.md T06 evidence section; root-causes.md
   R26 (L499-522).
2. Landed-code reads (READ ONLY): types.rs:2818-2832,
   2928-3085, 4500-4529, 5415-5439, 10270-10324, 11126-11200;
   resolve.rs:3815-3832, 4184-4331; b4_check.rs T06 tests
   (L776-965).
3. `grep -n "DeclKey::CtxActor"
   compiler/src/analysis/types.rs` → 2827/4515/5423/11150 +
   keying 7418 (closed insert set; exit 0).
4. `grep -c "fn t06_" compiler/tests/b4_check.rs` → 19
   (exit 0, corroborates tasks.md).
5. `grep -n "proves_auth\|collect_narrow\|auth_proves"`
   across types.rs/resolve.rs → caller map (§1 item 4;
   exit 0).

Checklist item 5 is COMPLETE per the gate-needs text; items
4, 6-8 untouched (coordinator-owned). Prep status preserved:
adopts NOTHING; no code, no normative-doc, no tasks/monitor/
inbox edits.

Release: implementation/challenge-audit-run/evidence/read-decision.md
is RELEASED to the coordinator for JEV-gate scheduling.

## Durable-fence evidence plan (gate evidence)

Writer: L3 T32a-item7. Status: **PREP — adopts NOTHING.**
Checklist item 7 evidence only; a PLAN, not proof. All
alternatives stay unranked and every **JEV-PENDING** above is
preserved. Grounded in a read-only survey of the state engine
plus T16/T17/T24 runtime status in tasks.md; no builds, no JEV,
no Git.

### Surveyed substrate inventory (read-only)

- Fenced single-shot commit: `createTransactionPort` commits one
  batch over one store, NO retry; fence conflicts surface as
  retryable `busy` via `storageToStateError`
  (`packages/state/src/ports/transact.ts:1-48`).
- One atomic batch shape: `CommitBatch { expectedRevision,
  writes, history, receipt, outbox, schedules, uniqueClaims, ...
  }` (`packages/contracts/src/state.ts:281-298`).
- D1 adapter: every commit is ONE `db.batch()` led by a
  `fence_log` INSERT (`expected+1`); a stale `expectedRevision`
  fails atomically with nothing applied; record UPDATEs/DELETEs
  stay unconditional on version inside the batch; stale or
  missing rows fail up front with kind `version`, never as
  silent overwrites (`packages/state/src/storage/d1.ts` header).
- DO adapter: same fence semantics through synchronous
  `storage.sql` inside `storage.transactionSync`, which rolls
  back on throw
  (`packages/state/src/storage/durable-object.ts` header).
- Memory adapter: header-marked TEST-ONLY, never a production
  backend; mirrors fence/constraint/query semantics for unit
  tests, including multi-touch batch order and three-valued
  predicates (`packages/state/src/storage/memory.ts` header).
- Admission order is load-bearing: read the revision first,
  then receipt/age/authorization/shape/version/business
  (`packages/state/src/invocation/admission.ts` header). A
  matching receipt replays its saved outcome even though its
  submitted versions are now stale.
- Bound read port: viewer-projected vs owner-full authority;
  `authority: 'owner'` performs NO membership check —
  caller-supplied capability, admitted paths only
  (`packages/state/src/ports/read.ts:48-55`).
- Identity revocation entries (session/MCP-grant revocation,
  sign-out-everywhere:
  `packages/identity/src/authentication/revocation.ts`) cover
  session/grant revocation only. The T32 revocation fence
  concerns LIVE membership state (`Employee.active` /
  `can_work` / `active_member`, per the Grant adjudication
  above) — a distinct layer no identity entry point fences.
- Runtime status in tasks.md: T16, T17, T24 all OPEN with
  "Evidence: pending" (tasks.md:163-168, 170-175, 219-224) —
  no generated-invocation join, no canonical data-plane
  migration, no durable dispatch exists yet. This plan is
  therefore conditional on T16/T17 landing, which T32b already
  requires; it says where each alternative's proof must run,
  not that the substrate is ready.

### Per-alternative proof map (which proof runs where)

- Alternative A (single-checkpoint fenced reads + commit
  revalidation): checkpoint-enrollment + revision-assertion
  proof on D1 (`db.batch` led by the `fence_log` INSERT) AND
  DO (`transactionSync`) — read revision, evaluate guards,
  commit batch re-asserts the checkpoint AND re-evaluates
  `by` + every guard predicate against current authority
  state; an intervening membership write voids the commit
  (`conflict`/`forbidden`), never a silent commit. The
  A-vs-C coupling question (database-wide assertion voiding
  unrelated ops) must be DEMONSTRATED on D1/DO — a
  membership-table write racing an unrelated guarded op —
  not argued. The L291 in-flight question stays
  JEV-PENDING; whichever ruling wins, its timing proof runs
  on D1/DO.
- Alternative B (read-at-effect): per-effect fresh-read proof
  on D1/DO — guard-phase reads provably unused by effects:
  a revocation landing between guard and effect is caught
  because each effect re-reads at claim time inside the same
  owner transaction. Interleaving proof: revoke-then-effect
  AND effect-then-revoke orderings on D1/DO with the exact
  commit outcome asserted per ordering. The `let`-as-value
  ruling (JEV-PENDING) splits: the ruling itself is proven
  by checker tests (substrate-independent), but carried-vs-
  reread VALUES at commit are proven by D1/DO execution —
  memory may show the shape, never the fence outcome.
- Alternative C (version-pinned snapshots): pin-assertion
  proof on D1/DO — pinned record versions + authority pins
  rechecked atomically with the commit; an intervening write
  to any pinned row (membership/authority rows included)
  aborts with `conflict`. The narrowed-assertion
  implementability question (JEV-PENDING) is itself a D1/DO
  substrate question: if the D1 batch contract can only
  check the database-wide revision, C's narrowing proof
  FAILS on D1 and C collapses into A — that verdict must
  come from D1/DO execution, never from memory. The
  authorizing/eventual static separation is proven by
  checker tests; any default-safety claim for an unlabeled
  read is proven by D1/DO fence execution, not by the label
  rule alone.
- Alternative D (bounded authority grants): grant-validation
  proof on D1/DO — the commit validates each grant
  (versions unchanged, checkpoint fence holds, unexpired,
  authority not on the revocation list); a revocation-list
  append racing a grant-bearing commit rejects with
  `forbidden` on D1/DO. Expiry semantics (wall-clock vs
  revision-distance, JEV-PENDING) proven on D1/DO, using
  the fixed test clock wherever wall-clock is claimed. The
  revocation list's own storage + retention proven on D1/DO
  (it is itself a hot table under the fence). Inferred-vs-
  declared grants (JEV-PENDING): inference soundness proven
  statically, enforcement proven on D1/DO.
- Spend/dispatch paths (ALL alternatives): Chat:81,
  Creative:103, Knowledge:159, Invoice:367 guards plus the
  168 unguarded sends (§2) — dispatch-claim atomicity
  (`when=` guard + supersession, settled L524; payment
  mandate validation, settled L650) proven on the T24
  dispatch substrate once it exists (outbox intents,
  receipts, redelivery identity: `CommitBatch.outbox` /
  `outboxAck`). Single-owner batch atomicity never implies
  the spend claim; T24 acceptance already forbids inferring
  cross-store atomicity. Until T24 lands, spend-fence
  claims are UNPROVEN — not memory-proven.
- Concurrent-transaction interleaving (ALL alternatives):
  two live committers racing one row on the D1/DO adapters;
  exactly one fence INSERT wins. The memory store is
  single-threaded and proves no interleaving.
- Crash-recovery (ALL alternatives' atomicity claims):
  kill/restart mid-commit against local D1
  (workerd/miniflare) and DO SQLite; `fence_log` must show
  no partial batch, and pure-read retries after a revision
  change must not return a mixed authorization snapshot. No
  crash claim may rest on the memory store.
- Cross-owner reads (checklist item 6 input: 40
  `use employee` files, Gallery<-Creative `can_view`,
  CRM<-Customer duplicates): whichever alternative wins
  must say what an imported-parent read enrolls, and that
  enrollment proof runs on D1/DO across the owner boundary
  — a same-owner fence proof never covers a cross-owner
  read.

### What memory-store tests may and may not claim

- MAY claim: deterministic unit semantics — batch shape,
  checkpoint/pin/grant bookkeeping logic, fence/conflict
  error mapping, guard-evaluation logic, admission
  revision-first ordering, replay-shape and receipt
  identity, static negatives (eventual-read misuse,
  grantless authorization, carried-value bans).
- MAY NOT claim: durability, atomicity under crash, fencing
  under real concurrency, interleaving outcomes, cross-owner
  fencing, revocation timeliness, or anything the item-7
  checklist text names as a D1/DO property (batch/commit
  boundary, revision assertion, concurrent-transaction
  interleaving, crash-recovery path). Any T32b proof citing
  memory-store results for those properties is
  miscategorized evidence, not a pass.

### DECISIONS #138 stays open

- #138 (consistency guarantees for D1 mutations, replicas,
  and read sessions unspecified) stays OPEN — cited here,
  DECISIONS.md untouched. It closes only when D1/DO-backed
  execution evidence for the adopted alternative's fence
  exists. Memory-store tests cannot close it under any
  alternative.

### Handoff

- Writer: L3 T32a-item7. Single file appended
  (`implementation/challenge-audit-run/evidence/read-decision.md`
  only); existing alternatives/fairness/enumeration/checklist
  text untouched except the item-7 marker above; DESIGN.md/
  GRAMMAR.md/DECISIONS.md, drafts, code, tools/jev.py,
  tasks.md/monitor.md/inbox untouched (read or
  coordinator-owned); no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate
  scheduling.

## T28-ownership input (gate evidence)

Writer: L3 T32a-item6. Status: **PREP — adopts NOTHING.**
Method: read-only reads of the T32a fence alternatives + fairness
record + all prior appends in this file, the ADOPTED T28-A rule +
JEV-outcome + standing obligations in
`containment-decision.md`, the T28 COMPLETE evidence + T29 status in
`tasks.md`, and the T28/T29/T32 task briefs in
`CHALLENGE-AUDIT-PLAN.md`. Checklist item 6 only; all other
checklist text, alternatives A–D, fairness record, and prior
appends UNCHANGED. No JEV run; tools/jev.py untouched; no code, no
normative-doc, no tasks/monitor/inbox edits. No T29 behavior
invented: every owed clause below cites absence evidence.

Verdict: **QUALIFIED — T28 half CONFIRMED (adopted rule + JEV +
enumeration), T29 half ABSENT-with-reason (implementation not
started; needs matching T15/T16/T17).** The fence rule for
imported-parent reads is settled; its checker acceptance,
descriptors, and D1/DO fence execution are owed.

### §1 — what ADOPTED T28-A settles for reads crossing package boundaries

T28 is COMPLETE with Alternative A adopted (tasks.md T28 evidence:
unanimous JEV ADOPT A, 3/3; standing obligations: T29/T16/T17
atomicity proof + split diagnostic; DECISIONS recording left for
Codex review). The adopted rule (containment-decision.md:65-72):
`Child in ImportedParent` has exactly local-containment semantics
(team/storage inheritance, immutable `parent` binding, atomic
subtree archive/delete, parent-scoped uniqueness,
`parentRecord.Child` typed collection) whenever the parent arrives
via a plain import whose owning package is included in the
selected app; bound (`from=`) parents are rejected as containment
targets with a diagnostic.

What that settles for each imported-parent read — policies reading
`row.parent.*` (Invoice `row.parent.locations`, Propose
`row.parent.location`, containment-decision.md:53-55),
`parent.parent` chains (Onboard default, Leave derives, Invoice
deep policies), reverse-collection reads (`claim.parent.Expense`,
containment-decision.md:344-353), and creation defaults reading
`parent` — is the fence they enroll in:

1. Plain = same deployment, same fence. Plain import = same
   deployment, owner transaction rules apply
   (containment-decision.md:76-78); storage owner = the parent's
   owner, already the same included store
   (containment-decision.md:79-82); a plain import includes the
   whole owning executable package internally (DESIGN, via
   containment-decision.md:24-27). An imported-parent read therefore
   enrolls in the SAME owner checkpoint / revision fence as a local
   read — no cross-owner fence, no cross-store read, no remote
   boundary. Workflows hold verbatim including `parent.parent`
   chains and `row.parent.*` policies
   (containment-decision.md:86-87). This answers item 6's question
   directly, and it covers the §1 census shape: most policy/crud
   sites read an imported owner's predicate (`use employee` in 40
   files, `use customer` in 20 — this file §1), and those reads
   enroll at the caller's checkpoint (derive-guard row: callee fence
   = caller's checkpoint).
2. The DESIGN same-owner rule is satisfied by construction. Business
   eligibility requiring atomic revocation must live at the same
   owner as the decision (DESIGN L549, via this file's settled
   context) — under T28-A the imported parent and its cross-package
   children share one owner, one store, one atomic commit (spec
   entailment, containment-decision.md:860-918), so
   imported-parent reads need no relocation; they are same-owner
   reads by rule.
3. Authority split settled. Child CRUD is owned by the declaring
   package; the parent package policy still governs parent rows;
   the consumer cannot mutate the parent or extend its policy
   (containment-decision.md:79-82). Reverse collections resolve
   through the whole-app index, readable only where child read
   policies grant (containment-decision.md:83-84). For reads: the
   fence enrolls the read, but the grant decision stays with the
   owning policy — parent-row reads are governed by owner-package
   policy, reverse-collection reads by child grants. Combined with
   the Grant adjudication above: the revocation fence must enroll
   LIVE membership state (`Employee.active` / `can_work` /
   `active_member`), never static role atoms alone — imported-parent
   reads of membership state enroll live rows.
4. Bound rejected: no bound-parent containment read exists to fence.
   Bound (`from=`) parents stay rejected as containment targets
   (JEV outcome, containment-decision.md:1108-1111). Corpus verdict:
   zero bound parents anywhere — all 76 `from=` lines bind only
   capability interfaces or value types, none binds
   `Employee`/`Customer`/`Location`
   (containment-decision.md:312-328) — so the bound-rejected clause
   is untested by draft evidence in both directions
   (containment-decision.md:330-336). Any future bound
   reference-field read is an ordinary cross-owner reference read
   under the DESIGN cross-owner rules (a reference identifies
   another owner but implies no atomic read or write there;
   cross-owner workflows use durable events and explicit pending
   state — via containment-decision.md:989-993), NOT a same-fence
   containment read.
5. Retained B-opposing-case caveat (fairness, not waived). A's risk:
   cross-package cascade/coupling and future deployment-split
   breakage (containment-decision.md:211-212); the full opposing
   case — a consumer's delete/archive cascade touching
   owner-package rows' children, `unique ... fields=parent`
   constraining owner-adjacent state, a future split silently
   breaking atomicity promises, foreign-policy extension risk if
   reverse collections leak readability, and whether
   same-deployment inclusion is a sufficient atomicity boundary
   plus what diagnostic fires on a later split
   (containment-decision.md:95-102) — is retained for T29 review
   per the JEV outcome (containment-decision.md:1111-1114). For
   reads: the same-fence enrollment holds ONLY while the deployment
   stays shared. A later split turns today's same-owner read into a
   cross-owner read, and no split-time diagnostic exists in evidence
   (storage item 5: split diagnostic ABSENT,
   containment-decision.md:1007-1015). The gate must carry this as
   an open hazard, not a settled promise.

### §2 — what remains owed from unimplemented T29 (never invented)

T29 (Implement imported containment) is NOT started: tasks.md T29
"Evidence: pending". Its prerequisites are accepted T28 (now
satisfied) plus matching T15/T16/T17 (tasks.md T29; plan T29 brief:
preserve canonical Employee/Customer relationships; aliases/
composition agree; invalid parent/team/lifetime/cycle cases fail in
checking and applicable actual storage) — and T15, T16, T17 are all
themselves pending. Owed, with absence evidence:

a. Checker (L1): E2008 still rejects imported parents at 20/20
   sites (containment enumeration). T29 must flip plain-import
   acceptance while keeping bound rejection + diagnostic, and prove
   alias/order/composition parity plus wrong-parent, cross-team
   parent, missing/archive-state parent, and cycle failures
   (containment bar item 5). T08 (readable selector resolution,
   R07) is landed for path SHAPE only — it does not legalize the
   containment target. Do not conflate the two.
b. Descriptors (T15): canonical ownership descriptors for imported
   containment (recursive schema/ownership/callable) — T15 pending,
   no handbuilt alternates allowed.
c. Runtime (T16/T17): generated-invocation join + canonical
   data-plane migration, and the standing-obligation proof of
   same-store atomic cross-package subtree commits on D1/DO, with
   parent-policy governance and reverse-collection readability
   enforced in execution. Engine today: delete archives one row,
   no cascade code exists (`cascad` grep over state engine +
   contracts: zero hits), and the generated path is still the B1
   interim data plane (direct fenced commits, `history: []`,
   `receipt: null`) — containment-decision.md:949-974. Even
   single-package subtree atomicity is unexercised through
   generated operations.
d. Split diagnostic: ABSENT. No check keys on deployment topology;
   E2008/E4040/E4051 do not cover it; the migration plan has no
   store-sharing assertion (containment-decision.md:1007-1015).
e. Normative recording: the DECISIONS entry for adopted A is left
   for Codex review; DESIGN/GRAMMAR/DECISIONS untouched (JEV
   outcome, containment-decision.md:1114-1115).

Net for reads: enrollment is RULED (same fence) but UNPROVEN — no
checker acceptance, no descriptors, no D1/DO fence execution
across the import boundary. The durable-fence plan's cross-owner
clause governs proof: enrollment proof must run on D1/DO across
the owner boundary; a same-owner fence proof never covers a
cross-owner read (this file, durable-fence plan). This input claims
no T29 checker behavior, no E2008 flip, no atomicity proof, and no
grant semantics.

### §3 — per-alternative inheritance (settled half vs owed half)

- A (single-checkpoint fenced reads + commit revalidation):
  inherits settled — imported-parent reads enroll in the single
  owner checkpoint + database-wide revision fence + commit-time
  `by`/guard revalidation exactly as local reads; no second fence.
  Owes: T29 checker + T16/T17 D1/DO proof that cross-package
  parent/child rows actually share one fence (revision assertion
  covers both; parent-policy reads revalidate at commit;
  reverse-collection reads enroll). The L291 in-flight question
  stays open and now spans the import boundary (an imported
  membership revocation landing between checkpoint and commit voids
  the commit — same rule, owed proof). Hazards combine: A's
  database-wide contention (any membership-table write can void an
  unrelated in-flight op) plus the T28 split hazard (a later split
  silently breaks the single-checkpoint premise with no
  diagnostic).
- B (read-at-effect): inherits settled — per-effect fresh reads
  execute inside the same owner transaction for plain-import
  parents (no remote read to forbid); bound containment reads do
  not exist to re-read. Owes: the same T29 checker/storage absence
  as A, plus B's `let`-as-value question now includes
  imported-parent `let` bindings (allowance-style
  `let x=first(...)` guard+set shapes, §1f; cross-package defaults
  such as Onboard's `parent.parent.user`,
  containment-decision.md:382-386) — B must rule re-read vs rewrite
  for those too. T06 gives B no carried values (admission facts
  type `actor` only — T06 input above); unchanged.
- C (version-pinned snapshots): inherits settled — pins cover
  imported-parent records + authority pins (membership/role rows in
  the owner package) under the same-store assertion; the
  eventual-label question is unchanged, and no sampled
  imported-parent read takes the eventual label (only T3
  display/lookup reads are label candidates; every T1/T2
  imported-predicate site authorizes — §1f). Owes: T29 plus the
  narrowed-assertion implementability question on D1, now spanning
  the package boundary — D1/DO execution must prove the pin
  assertion covers cross-package records in one batch, or C
  collapses into A with extra bookkeeping. The default for an
  unlabeled imported-parent read (pinned-safe vs eventual) stays a
  gate question.
- D (bounded authority grants): inherits settled — grants minted by
  imported-parent reads carry the same owner checkpoint; the
  revocation list is per-owner = the same owner, so grant
  non-transferability across fence scopes does not trigger for
  plain imports. Owes: T29 plus all of D's machinery
  (grant type, mint/consume rules, revocation-list storage +
  retention, expiry semantics), entirely unimplemented. The
  customer question sharpens against D: cross-package reads were
  D's only hypothesized customer (40 `use employee` files,
  Gallery←Creative `can_view`, CRM←Customer duplicates — §1f) —
  but T28-A rules those same-deployment, same-owner reads, so D's
  portability story has no customer even here. On a deployment
  split, containment itself is rejected (bound forbidden), so a
  grant cannot rescue the relation — D adds nothing over A/C for
  ownership reads.

### §4 — commands run + release

Read-only inspection only (no builds, no Git, no JEV —
tools/jev.py untouched):

1. Full read of this file's alternatives + fairness record + all
   prior appends (1339 lines pre-edit); full read of
   containment-decision.md Alternative A rule
   (L65-102), fairness record (L209-217), storage gate evidence
   (L829-1088), and JEV outcome + standing obligations
   (L1090-1117); tasks.md T28 COMPLETE evidence + T29 status
   (L247-259); CHALLENGE-AUDIT-PLAN.md imported-containment brief
   (L296-306), membership-reads brief (L332-342), and T28/T29/T32
   task lines.
2. `cp implementation/challenge-audit-run/evidence/read-decision.md
   /tmp/read-decision.before.md` — pre-edit baseline (exit 0).
3. Post-edit: `diff -u /tmp/read-decision.before.md
   implementation/challenge-audit-run/evidence/read-decision.md` —
   exactly two hunks (item-6 marker + this section), all other
   text byte-identical (exit 1, the diff-found-changes code).
4. Post-edit: `grep -n "T28-ownership input"
   implementation/challenge-audit-run/evidence/read-decision.md` —
   three hits (item-6 marker + section header + this step's own
   quoted pattern); checklist markers for items 1-5, 7-8 unchanged
   (exit 0).

Checklist item 6 is QUALIFIED per the gate-needs text (T28 half
CONFIRMED, T29 half ABSENT-with-reason); items 4 and 8 untouched
(coordinator-owned). Prep status preserved: adopts NOTHING; no
code, no normative-doc, no tasks/monitor/inbox edits.

Release: implementation/challenge-audit-run/evidence/read-decision.md
is RELEASED to the coordinator for JEV-gate scheduling.
