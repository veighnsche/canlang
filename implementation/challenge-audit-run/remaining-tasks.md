# Challenge-audit continuation checklist (coordinator-owned)

Status: **implementation STARTED 2026-10-06 by exact human START.**
Coordinator: native session `01a10f6d-4be0-7560-915d-a8bc1fefe571`,
goal `goal-01a10f85-ee3f-7663-9c34-00092b511d83`,
canonical checkout `/Users/vince/Projects/canlang` branch `main`,
base `b30d52a22516643533795f79d7d0fb111a6c0f04`.
Plan: `implementation/REMAINING-IMPLEMENTATION-LANES.md`
(sha256 `25337c97…b70518e130c` per Codex `implementation-start.json`).
This is the single central continuation checklist. Lane copies are not
communication. Historical `tasks.md` ticks/evidence are preserved and updated
only at justified integration/handoff. Parent tasks never close from mechanism
tests alone. R01/C01 stay with Codex; native completion is not parent review
acceptance.

Finite scope: the 41-task challenge plan remainder plus D01–D08
first-reference supplement bookkeeping. No new language adoption, no localized
MCP, no artifact migration, no AI guides, no automatic translation, no public
publication, no production deployment. The broad file-tree plan authorizes no
unrelated implementation.

## Generation canlang-fresh-20261006T052409Z (current)

Coordinator: native session `01a10fab-ca69-74d3-8b4d-0c0c91611264`,
goal `goal-01a10fbe-bc73-7753-b9a9-5c743f5c6175`,
canonical `/Users/vince/Projects/canlang` @ `ae65a76`.
Human START 2026-10-06 releases the HOLD for this fresh roster.
Prior-generation (01a10f6d-*) S00–S04 ticks and progress log below are
history, not proof for this generation. Language decisions, acceptance
requirements, E1/E2a acceptances and all unresolved packets are preserved.

Run dir: `/private/tmp/canlang-idle-20261006T041507Z/fresh-20261006T052409Z`,
run_id `canlang-fresh-20261006T052409Z`. Coordinator records:
`acks/coordinator-startup.json`, `status/coordinator.json`, `grants.json`
(fresh ledger, starts empty; prior grants all released-complete).
Monitor stays Codex-owned, untouched. Timer: native cron `cab2f3c0`,
`*/5 * * * *`, recurring + permanent + fire-when-active; first received
wake pending. Old timer `3375c66f` NOT inherited.
Verified heads: main `ae65a76`; E `0bfc72f`; A/B/C/D/F/G `b30d52a`;
all clean except preserved canonical dirty bookkeeping; 4 worktree-local
`@canlang` links each; no dist/.tsbuildinfo/target; disk 25G (10G floor).

Current roster (the 01a10f6d-* table under "Registered roster" is history):

| Lane | Session | Handshake send | ACK | State |
| --- | --- | --- | --- | --- |
| A | 01a10fab-cb57-7991-9638-ddd6a2c74b74 | c5583c13 | 9b440231 (verbatim; caveat noted) | ACKed, zero writes |
| B | 01a10fab-cc9d-7331-a23f-ab35f8a99f2d | c46e712a | c03aa275 | ACKed, zero writes |
| C | 01a10fab-cdfb-7072-a580-d5fa9a153d9c | 2d40f753 | 66fee00d (after Vince in-session confirm) | ACKed, zero writes |
| D | 01a10fab-cf5f-7542-a968-fc155d180d76 | 77cbbdab | 3c5ed810 | ACKed, zero writes |
| E | 01a10fab-d0e7-7ab2-aadc-901f4712454f | 636bcbfa | 054d79c0 (verbatim) | ACKed, zero writes |
| F | 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9 | 09c65593 | 529dcd12 (verbatim) | ACKed, zero writes |
| G | 01a10fab-d445-7181-90ad-178498a30c23 | 535cdb7a | 926e7632 (verbatim) | ACKed, zero writes |

All worktree/branch/HEAD claims corroborated via git. START_ASSIGN
packets for this generation are dispatched by message (named coordinator
above); the `start-assign/lane-*.md` files name the prior coordinator
and are history. Dispatch log: (pending — updated as sends/ACKs land).

## Startup joins (coordinator; prior generation, preserved)

- [x] **S00 — Acknowledge + native goal.** Coordinator ID, seven implementers,
  base and finite scope acknowledged; goal created 2026-10-06.
- [ ] **S01 — Bidirectional handshake all lanes.** CORRECTION 2026-10-06:
  only A (`03d48a3e`) was accepted/read; B–G handshakes were
  receiver-REJECTED (`containment_limited`/`causal_metadata_invalid`, never
  read) — the `Allowed` footer is sender admission only. Prior
  pending-delivery claims retracted. A ACK `d5e34b8c` + C/D/G messages await
  my receiver admission (Codex operates Allow; I verify read). B: nudge
  `6cd51bc6` accepted/read; full re-send `42108da5` with explicit
  delivery/wake params sent from fresh control turn; C–G re-sends held for
  B outcome. Exact ACK must name message, lane, assignment, coordinator
  and self.
- [x] **S02 — Five-minute timer.** Native cron `3375c66f`, `*/5 * * * *`,
  recurring, permanent, fire-when-active. Setup ACK in
  `acks/coordinator-startup.json`; first received wake evidenced in
  `status/coordinator.json`.
- [x] **S03 — Checkout readiness.** All 7 worktrees verified at `b30d52a`,
  clean, on lane branches; bun 1.4.2 matches `packageManager`; cargo env
  unset (lane A target will be worktree-local). Provisioned: `bun install`
  in all 7 (183 pkgs each); 4 relative worktree-local `@canlang` links each,
  identical to canonical layout; no `dist`/`.tsbuildinfo`/target; disk 23G.
  Grant G-PROV-01 released-complete.
- [ ] **S04 — START_ASSIGN dispatch.** After S01/S02/S03 evidence per lane.
  Packets drafted at `implementation/challenge-audit-run/start-assign/lane-<X>.md`
  (each <8KiB, sendable verbatim); dispatch held for exact handshake ACKs.

## Registered roster

| Lane | Session | Worktree | Branch | Boundary |
| --- | --- | --- | --- | --- |
| A | 01a10f6d-4be0-74e3-a08c-c440ca24f292 | canlang-a-compiler | codex/remaining-lane-a-compiler | compiler/** |
| B | 01a10f6d-4be0-75c0-bd1d-afa72a7c503f | canlang-b-core-state | codex/remaining-lane-b-core-state | packages/state/**, packages/values/** |
| C | 01a10f6d-4be0-7db1-a707-a60fed22b6c4 | canlang-c-runtime | codex/remaining-lane-c-runtime | packages/cloudflare/**, packages/stdlib/** |
| D | 01a10f6d-4be1-7a00-901e-90edd5122d85 | canlang-d-work-providers | codex/remaining-lane-d-work-providers | packages/work/**, packages/files/**, packages/services/** |
| E | 01a10f6d-4c14-70c2-9822-5529774fcc57 | canlang-e-interfaces | codex/remaining-lane-e-interfaces | packages/interfaces/**, packages/identity/** |
| F | 01a10f6d-4c35-7f42-9b66-3a48a7694b15 | canlang-f-ui | codex/remaining-lane-f-ui | packages/ui/** |
| G | 01a10f6d-4c54-7490-bfe4-7160ef283b75 | canlang-g-journeys | codex/remaining-lane-g-journeys | packages/testkit/**, tests/e2e/** |

Coordinator owns `packages/contracts/**`, root manifests/build/CI, central
design/checklist/evidence and integration. Command grants ledger:
`/private/tmp/canlang-idle-20261006T041507Z/grants.json`
(initial: one Rust + one isolated TS/durable heavy command).

## Recorded source gates (first follow-ups, not accepted behavior)

- `compiler/tests/effects.rs:1685` unconditionally indexes
  `tables.by_canonical["volunteer.cancel_signup"]` for both Shift and Volunteer
  iterations (the `contains_key` guard checks a different map, too late).
  Coordinator-corroborated at base; lane A repairs under A1.
- F6 parser/child-binding/trigger-lowering gaps (lane A, packet A1).
- No Cloudflare consumer of emitted `appDefinition.cohorts` /
  `ArtifactCohortDescriptor`; F7 uses caller-supplied cohort specs (lanes A/C).
- T26 durable witnesses use a test-only model/commit driver; production
  receipt integration and notifications need their own proof (lane D).

## Implementation packets

State key: open / assigned / editing / command-running / awaiting-grant /
awaiting-input / blocked-communication / released-ungated / released-verified /
integrated / accepted. Handoff records exact commit, paths, contract
input/output, checks, command outcomes and writer/command release.

### Lane A — Compiler

- [ ] **A1 — Recovered T34/F6.** Prereq: committed F1 + T18 release.
  Accept: both `each=` spellings check/emit; original guards/body behavior
  preserved; unsupported forms and ordinary loop overflow still rejected.
  State: open. Inputs: F6 checkpoint
  `9aa3d420456713f0c2f6b30fc835bea425f7c75f` (qualify, do not replay blindly).
- [ ] **A2 — T04/T15, T19 lowering.** Prereq: matching contract slice.
  Accept: canonical recursive/provider descriptors and required
  decimal/default/delivery lowering consumed; no hand-built descriptors.
- [ ] **A3 — T35 remaining packets.** Prereq: each packet's producer.
  Accept: named titles, request bindings, query/datetime ordering prove
  valid/invalid boundaries; delivered ICU/CRUD/payload fixes retained.
- [ ] **A4 — T29 static rules.** Prereq: adopted T28.
  Accept: canonical imported owners resolve with parent/team/lifetime/cycle
  negatives; unrelated metadata decisions do not gate.
- [ ] **A5 — T08 parity (A+F).** Prereq: bounded disputed-site adjudication.
  Accept: compiler/UI agree in the same grant context; safety negatives and
  fair opposing evidence preserved.

### Lane B — Core state

- [ ] **B1 — T18 state/scenario consumers.** Prereq: T18 mechanism + matching
  descriptor slice. Accept: defaults/server fields/parent/context/order/replay
  agree on CRUD and scenario paths; unsupported computed init stays explicit.
- [ ] **B2 — T17/T04 reads and schema consumers.** Prereq: published
  read/policy/type contract. Accept: filtered/owner/archived/policy reads
  execute canonically; denial/history/replay/restart proofs match scope.
- [ ] **B3 — T25 receipt/schema consumers.** Prereq: matching A/coordinator
  receipt-schema output. Accept: declared schemas replace interim hand-built
  schemas; current/stale receipt authorization and disclosure hold.
- [ ] **B4 — T31/T32 review gaps (B + owning peers).** Prereq: specific
  hook/authority contract. Accept: applicable bounds, revocation/spend race,
  retry/recovery qualified; refinements/exclusions explicit.
- [ ] **B5 — T29 canonical containment.** Prereq: A4 matching static owner
  contract. Accept: imported storage/team/lifetime/cycle boundaries hold;
  receipt wiring does not wait for this packet.

### Lane C — Production runtime

- [ ] **C1 — Recovered T34/F7.** Prereq: committed F1–F5.
  Accept: atomic source+intent, durable fenced claim/record, first-attempt
  anchoring, fair scheduling, honest admission exhaustion; real gates pass.
  State: open. Inputs: F7 checkpoint
  `a1f9cbc97f7c92719670205d6a965aa5080bb365` (released ungated; qualify).
- [ ] **C2 — Production T18/read joins.** Prereq: B1/B2 released slice.
  Accept: generated Cloudflare invocation uses state/default/read behavior,
  not earlier passthrough/refusal posture.
- [ ] **C3 — Production T19/T25 joins.** Prereq: matching B3 receipt slice +
  E input/visibility slice. Accept: registry/dispatch consumes checked inputs
  and receipt/schema ports; browser/MCP rules and real receipt paths agree.
- [ ] **C4 — Deployment/boot repair.** Prereq: reproduce exact two 500
  failures. Accept: both repaired; real compiled boot/load/dispatch controls
  pass; no unsupported production deployment.

### Lane D — Work/files/providers

- [ ] **D1 — Recovered T26.** Prereq: existing T25 contract.
  Accept: per-relation duplicates/cancellation/late usage/terminal
  immutability/notifications + real durable restart qualified.
  State: open. Inputs: T26 checkpoint
  `c53ce1d37d6400a26bb15fe8ba0bd1123614f2c1` (qualify).
- [ ] **D2 — T27 finalized images.** Prereq: image-relevant D1 + real file
  lifecycle. Accept: receiving-app finalized file; ownership/provenance/
  permission/invalid output/replay through owning lifecycle.
- [ ] **D3 — Receipt/bound-dispatch follow-ups.** Prereq: matching
  B3/C3/producer contracts. Accept: re-pointing to existing receipt and
  mirror conformance; admitted bound sends execute; unavailable Handbook
  capabilities stay explicit.

### Lane E — Interfaces/identity

- [x] **E1 — T19 bound/MCP/interface dispatch.** Prereq: committed
  derivation + matching published contract. Accept: pure bound checker
  actually invoked; binding visibility and equal-authority inputs preserved
  through dispatch. DONE: lane 55a3b8b (395/395) → canonical 2d59697
  (builds + 395/395 green); filetree reconciled. Queued: C1 mcp-registry
  derivedFor mirror → lane C; C2 null-on-refs layering → E2/contract note.
- [ ] **E2 — T20 HTTP/error/context seams.** Prereq: matching F request +
  operation contract. Accept: bracket names, CSRF/context, safe errors,
  full/partial request path agree with dispatcher; no parallel engine.
  State: E2a DONE (lane 0bfc72f test-only 403/403 → canonical ae65a76,
  rebuild + 403/403 green; filetree reconciled). E2b F-dependent
  full/partial path held for F delivery; E standing by. (Message route to E
  recovered after 2 rejections; recent sends accepted.)

### Lane F — Presentation

- [ ] **F1 — T20b rich presentation.** Prereq: committed T19 descriptors +
  incremental E handoffs. Accept: delivery/decimal/file/bound/datetime/null/
  reference/conflict behavior + client/exports execute; tampering/authority
  negatives retained.

### Lane G — Fixtures/journeys

- [ ] **LG00 — T36 residual adjudication (+ reserved draft/design owner).**
  Prereq: fresh site evidence + applicable repaired roots; pilot cases first.
  Accept: complete collision/cycle/trusted-selector/handler/fixture-parent/
  secret/cardinality inventory adjudicated with intent, opposite case,
  confidence; only demonstrated corrections under exact reservations;
  unresolved proposals and negatives preserved.
- [ ] **LG01 — T22a core fixtures.** Prereq: selected LG00 fixture decisions
  + required producer slices. Accept: core model/user/grant fixtures
  validate; setup failure cannot satisfy business rejection; independent
  expectations preserved.
- [ ] **LG02 — T22b/c + T23.** Prereq: matching fixture/provider/file
  output. Accept: rich fixtures and compiled tables/sequences execute actual
  callers/prior commits/observations; deliberately broken expectation fails.
- [ ] **LG03 — T37 basic pilot (G + C/E/F).** Prereq: own source blockers,
  core LG01/LG02, required production/UI/MCP slices. Accept: one unchanged
  original app proves two actors, denied read, persistence, stale update,
  replay, browser/MCP parity, genuine examples.
- [ ] **LG04 — T34/F8 (G + A/B/C/D).** Prereq: A1, C1 + required
  authority/fixture joins. Accept: full M1–M10 matrix incl. 499/500/501/1000,
  crash boundaries, duplicates, insert/move/delete, rejection/revocation
  isolation, exhaustion, fairness, two occurrences, unchanged Shift/Volunteer,
  all negatives.
- [ ] **LG05 — T38/T39/T40 (G + affected producers).** Prereq: reusable LG03
  harness + each app's own capabilities. Accept: Expense/Leave/Onboard,
  Approve/Grant/Mail/Sync, Chat, Creative/Gallery, Shift/Volunteer qualified
  independently; no unrelated all-app gate.
- [ ] **LG06 — T41 (G + coordinator).** Prereq: repaired roots +
  qualification for advertised scope. Accept: fresh source-built 52-source
  corpus, per-app dispositions, negatives, real runtime evidence; exact
  supported/deferred scope; no false total completion.

## Historical task mapping (open parents stay open)

Open T parents: T04, T15, T20, T22, T23, T26, T27, T29, T34, T35, T36, T37,
T38, T39, T40, T41. Open gates: G1–G5, H01. R01/C01: Codex-owned, Muse leaves
unticked. Ticked tasks (T01–T03, T05–T14, T16–T19, T21, T24, T25, T28, T30–T33)
are inputs with recorded remainders, not blanket proof of new joins.

## Coordinator integration gates

- [ ] **I00 — T04 compatibility/consumer matrix.** Map rich/nested/date/
  duration/union/default schemas, providers, generated policies,
  hooks/invariants/locks, file/progress extensions to defining contract +
  actual consumer; version compatibility + positive/negative witnesses.
  Missing mandatory joins keep T04 open.
- [ ] **I01 — G1–G5 + H01 from integrated evidence.** Source/checker/
  descriptors, durable core, pilot/work/authority, per-app journeys, corpus
  claims; all writers/reservations/commands released; unsupported mandatory
  workflows stay blockers.
- [ ] **D-CLOSE — Accepted description/reference supplement.** Preserve six
  resolved findings + evidence; annotate superseded locale observations;
  reconcile bookkeeping/native handoff + exact owned thin resources.
  Localized MCP, artifact migration, AI guides, automatic translation,
  public publication remain outside first-reference acceptance.
- [ ] **R01 — Independent Codex acceptance.** (Codex ticks.) Preserve T08
  parity, E4012 context, T18/T19/T25 production joins, T16/T17 limits,
  deployment failures, hook/fence/recovery limits, full fanout matrix.
- [ ] **C01 — Preserve evidence, close owned resources.** (Codex ticks.)
  Stop owned timers after acceptance; preserve uncommitted work; clean only
  released owned worktrees/caches/prompts; retain viewers; retire heartbeat
  after no follow-up remains.

## Dependency corrections (binding)

- A1 needs F1 + released T18 only, not F1–F5. C1 uses F1–F5, not F6.
- T29 joins only workflows using imported containment, not global fanout.
- LG01 waits for applicable fixture decisions, not all T36.
- Core pilot does not wait for rich providers, images or fanout.
- Released contract slices (with exact slice/base) unblock matching
  consumers; full parents are not universal prerequisites.
- LG05 app families are parallel packets.

## Progress log

- 2026-10-06 S00/S02: goal + 5-min cron `3375c66f` live; first wake received.
  S01: A handshake sent (`03d48a3e…`), ACK pending. S03: worktrees verified,
  provisioning pending. Records: `acks/coordinator-startup.json`,
  `status/coordinator.json`, `grants.json` published.
- 2026-10-06 wake-1: all 8 processes alive; A send transport-confirmed,
  delivery unconfirmed, ACK pending (B–G handshakes held). S03 DONE:
  `bun install` ×7, worktree-local links match canonical, disk 23G.
  Ledger typo repaired/revalidated; status record updated.
- 2026-10-06 wake-2: panes prove A received handshake and sent HANDSHAKEACK
  (not yet delivered in-session); B/C/D/E/F/G all READY, no edits anywhere.
  Coordinator→lane direction proven; lane→coordinator likely idle-gated.
  Handshakes sent to B–G (IDs in status record; F/G sends carried a
  containment_limited receipt wrapper, still progress=sent — verify via ACK).
  G has honest blocked 27% goal after read-only prep; D/G used private
  /tmp record paths (republish to shared run dir with START_ASSIGN).
- 2026-10-06 wake-3: all peers reachable, panes idle, no lane records, no
  worker grants. B–G still show handshake arrived but unprocessed (~10min;
  A processed in ~2min). Bounded nudge sent to B only (`6cd51bc6`,
  transport-confirmed); C–G nudges held pending B outcome.
- 2026-10-06 Codex steering: B–G original handshakes were REJECTED
  (containment_limited/causal_metadata_invalid, never read). Correction:
  explicit delivery_policy+wake_policy sends are accepted/read (B nudge
  + re-send `42108da5` proven). Re-sends to C–G all read+ACKed
  (pane-verified; exact texts pending admission/delivery). E exact ACK
  `236f7e9c` received → HANDSHAKE_CONFIRM + START_ASSIGN `4b73da39`
  dispatched; E goal active, E1 underway. A/B ACKs pending admission.
- 2026-10-06 wake-4: E working E1 (0%, exploration, tree clean); B/C/D/F
  idle awaiting START_ASSIGN, no code; all trees clean; no lane records or
  grant requests; 6 exact ACKs still pending admission/delivery.
- 2026-10-06 BLOCKED-ON-ADMISSION: 6 peer ACKs unsettled, admission cards
  not surfacing ("6 peer approvals" footer). Goal continuation snoozed via
  native wait; 5-min cron retained; E + instances preserved; no heavy
  grants. No dispatch to unadmitted recipients. Codex to operate Allow.
- 2026-10-06 wake-5: E goal 0→25% (implementing, tree clean, record stale at
  05:03:35Z); others idle awaiting START_ASSIGN; no new records/grants;
  admission blocker persists.
- 2026-10-06 wake-6: E1 accepted+integrated (`2d59697`, 395/395 both sides);
  E2a failing-first grant G-E2A-01 START_ACK received by E, launching
  (deadline 05:21:21Z). 6 ACKs still unadmitted; other lanes idle.
- 2026-10-06 wake-7: E2a accepted+integrated (`ae65a76`, 403/403 both
  sides); acceptance delivered to E (goal 78%); E2b held for F. No
  active grants; 6 ACKs still unadmitted; other lanes idle.
