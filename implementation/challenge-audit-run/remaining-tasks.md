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
and are history. Dispatch log (2026-10-06T05:47Z; all transport-accepted, ACKs pending):

| Lane | START_ASSIGN send | First packet | ACK |
| --- | --- | --- | --- |
| A | 593c1434 | A1/F6 qual+repair | E5001 fix db87232->main 7ea4815 (2/2+881/0+clippy 0); Table:59 probe granted, START_ACK redelivery pending |
| B | c55dc84c | B1/B2 | B1+B2 RELEASED (cef9504+a5dceda)->main 3006266+f9dd238; 857/857 + 751/751; acceptance + B3-B5 pending |
| C | d7e6e96f | C1+C4 | BUILD-04 green; suite-02 4F/301P + 500s reproduced; BUILD-05 queued behind F probe; holding |
| D | 74af1f16 | D1 | 3d203e2d — D1+D2 ACCEPTED (4cf70d8->aae8fae); D3 awaiting B3/C3, D standby |
| E | 92320889 | E-carryforward+E2b | E2b RELEASED 0c665df->main ef3f680, canonical 419/419; LANE_ACCEPTED queued |
| F | 4511482d | F1 (+early request-path iface for E) | F1 RELEASED c0f0fd1->main 626611f (869/869); t20a follow-up probe granted, START_ACK redelivery pending |
| G | 27e164a4 | LG00+LG01 | LG00+LG01 ACCEPTED; LG02 RELEASED e75ff4a->main 09ab537, canonical 118/118; acceptance + LG03 dispatch queued |

Cross-lane joins log (fresh generation):

- E->F (E2b): E requested F1-F5 exact inputs (35575d55); routed to F as 76679158 (receipt pending). Scope ruling sent to E (356fd630): HTTP action_handle OUT of E2b — pin loud-reject boundary, MCP-only posture recorded.
- B->C (B1->C2): B will pin serverInits/nullableFields threading + archived-gating flag in B1 release; coordinator dispatches to C at C2 time.
- B rulings sent (58f82b69): (1) B2 consumes existing QueryPredicate/PolicyTable only, descriptor-input reads refused-pending-T04b; (2) B1 resolvedDefaults collision gets loud state-side guard, no Receipt contract change now (per-write keying deferred to T04b/I00 with evidence).
- Grants: E-VERIFY/E2B-01/E2B-02 complete (403, 414, 416/416); D-D1-01 complete; C-BUILD-01/02/03 failed-released, BUILD-04 complete (exit 0); A-A1-01/02 complete; C-SUITE-01 complete (vitest 14F/290P single vendor root cause, 500s masked; nodetest malformed, disclosed); C-SUITE-02 active re-run (deadline 06:30Z); A-A4-01 active (t29 6/6 interim), A-A4-02 active re-pin+gates (deadline 06:20Z).
- C4: vendor-bridges root cause diagnosed (B test-only bridges trip workerd link check); C fixed in-boundary (bundler TEST_ONLY_VENDOR_KEYS skip + pin); G warned re e2e loader mirror.
- Syncs/integrations: E1 4-file interfaces slice -> C branch as 7a36306 (C dirty preserved); A1 6dcf919 -> main 65fc60d (test-only, filetree no-impact record integration-20261006-a1.json); coordinator contract pins (C1 delivery rule, C2 suffixes, datetime wire note) -> main 2ed85d1 (tsc green). Vince committed prior bookkeeping as 276e75e + pushed; my live checklist edits continue on top. 65fc60d/2ed85d1 unpushed (no push authorization; handoff will address).
- E-F join: F early interface v1 (R1-R8) relayed to E; B answered Q2 (verbatim yes, ISO at L2 not admission) + Q5 (L3 presence-only, values-wire decode at boundary) — both relayed, F reworked Q2/Q4 accordingly; E answered Q1 yes/Q3 L3-carried-currents-needed/Q4 no-HX. RESOLVED: carried-currents BusinessError.conflict pinned (coordinator bb1ca7a, B2 carried); F generatedDraftValues released with F1. OPEN: E full E2b release (R5 + C1-C3 pins, then commit).
- G: LG00 accepted (15 cases); pilot PROVISIONAL CanDo (G pre-verifies T37 fit); LG01 slices released (T16/T17/T18 + T15a core + LG00); draft reservation granted (R20x4+E5004x2+Report flip exact-sites, R21 held); E5001 Table:59 = checker defect per A probe (missing conflict+overdue — actually derive-only per G; fix routed to A's queue: required_create_fields must exclude derived, examples.rs T23/T35).

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

- [x] **A1 — Recovered T34/F6.** Prereq: committed F1 + T18 release.
  Accept: both `each=` spellings check/emit; original guards/body behavior
  preserved; unsupported forms and ordinary loop overflow still rejected.
  ACCEPTED (fresh generation, cf8ba8ed): lane 6dcf919 -> main 65fc60d,
  test-only +10/-7 (panic guard + sort-order fix); F6 qualified as-is
  (17/17 F6, full cargo 873/0, clippy 0, fmt-own-clean). A on A4 +
  E5001 probe; A2 queued for T04b/I00.
  E5001 (fresh generation): lane db87232 -> main 7ea4815 (+44/-2:
  examples.rs DeriveField skip + 2 e5001_ tests + table re-pin 33->31);
  2/2 + 881/0 + clippy 0; fresh-binary Table:59 probe granted (G-A-PROBE-01,
  START_ACK redelivery pending after route cap).
- [ ] **A2 — T04/T15, T19 lowering.** Prereq: matching contract slice.
  Accept: canonical recursive/provider descriptors and required
  decimal/default/delivery lowering consumed; no hand-built descriptors.
- [x] **A3 — T35 remaining packets.** Prereq: each packet's producer.
  Accept: named titles, request bindings, query/datetime ordering prove
  valid/invalid boundaries; delivered ICU/CRUD/payload fixes retained.
  ACCEPTED (fresh generation): lane b1d979c -> main 011fced (+54 test-only:
  5 a3_ proofs); canonical 5/5 + request_selectors 1/1. Survey verdict:
  all 3 packets READY survey-only, no checker edits (P1 E3001 arm
  parser-shadowed by E1204; P2 4/4 arms; P3 datetime ordered).
- [x] **A4 — T29 static rules.** Prereq: adopted T28.
  Accept: canonical imported owners resolve with parent/team/lifetime/cycle
  negatives; unrelated metadata decisions do not gate.
  ACCEPTED (fresh generation): lane 5cb456c -> main db3a739 (+135/-3:
  Imported{bound:false} ChildOf + 6 t29_ tests); 6/6 + 879/0 + clippy 0;
  corpus 2062->1709, E2008 20->0, 5 audited unmaskings. (ACCEPT notice
  + E5001/A3 dispatch later DELIVERED; E5001 complete, probe pending.)
- [ ] **A5 — T08 parity (A+F).** Prereq: bounded disputed-site adjudication.
  Accept: compiler/UI agree in the same grant context; safety negatives and
  fair opposing evidence preserved.

### Lane B — Core state

- [x] **B1 — T18 state/scenario consumers.** Prereq: T18 mechanism + matching
  descriptor slice. Accept: defaults/server fields/parent/context/order/replay
  agree on CRUD and scenario paths; unsupported computed init stays explicit.
  INTEGRATED (fresh generation): lane cef9504 -> main 3006266
  (gateArchivedTargets + same-batch net uniques + loud default-collision
  guard); lane gate state 857/857 incl. miniflare-D1 + workerd-DO suites.
  Canonical gate + acceptance pending (TS slot order: F probe, C build).
- [x] **B2 — T17/T04 reads and schema consumers.** Prereq: published
  read/policy/type contract. Accept: filtered/owner/archived/policy reads
  execute canonically; denial/history/replay/restart proofs match scope.
  INTEGRATED (fresh generation): lane a5dceda -> main f9dd238
  (StateError.conflict + admission stale currents + ConflictServerOnly via
  invoke + D1/DO version-row attach + 3 values pins); values 751/751.
  Scenario self-cancel fails at commit with version error — flagged for
  C2/I00 clearer verdict. Canonical gate + acceptance pending.
- [x] **B3 — T25 receipt/schema consumers.** Prereq: matching A/coordinator
  receipt-schema output. Accept: declared schemas replace interim hand-built
  schemas; current/stale receipt authorization and disclosure hold.
  ACCEPTED (fresh generation): lane 4575dc5 -> main 3d1f8f0 (loader-built
  deliveryFields from kind:delivery tags; join/auth/disclosure unchanged;
  policy stays interim per T04b/I00 ruling); canonical state 889/889 +
  values 751/751. D3 prereq half-met (C3 pending).
- [ ] **B4 — T31/T32 review gaps (B + owning peers).** Prereq: specific
  hook/authority contract. Accept: applicable bounds, revocation/spend race,
  retry/recovery qualified; refinements/exclusions explicit.
  PARTIAL (fresh generation): authority slice DONE (lane 8b1f7f4 -> main
  bb479c2: by-aware check + compound suite; canonical 899/899; JEV
  keep_wide stands). OPEN: hook-bounds (waits C fanout proposal),
  per-write keying (T04b/I00), revocation/spend-race (E follow-up),
  retry/recovery (D follow-up).
- [x] **B5 — T29 canonical containment.** Prereq: A4 matching static owner
  contract. Accept: imported storage/team/lifetime/cycle boundaries hold;
  receipt wiring does not wait for this packet.
  ACCEPTED (fresh generation): lane d22830b -> main 96cf12f (containment
  channel + pipeline enforcement); canonical state 884/884. Explicit
  remainders: no subtree cascade (needs design), lifetime unenforceable
  (L1 owes descriptors), team vacuous, parent.* T04b-owed. B3(2) ruled to
  T04b/I00; B4 gap set enumerated (by-aware check, narrower-fence,
  per-write keying, fan-out bound) with producer routing.

### Lane C — Production runtime

- [x] **C1 — Recovered T34/F7.** Prereq: committed F1–F5.
  ACCEPTED (fresh generation): lane c16692e -> main 30e211d
  (cloudflare-only +1234/-37: emitted-cohorts consumer + MCP derivedFor
  mirror + T15b delivery-kind); canonical build 0 + vitest 316/316 +
  nodetest 203/203; ROOT BUILD GREEN.
  Accept: atomic source+intent, durable fenced claim/record, first-attempt
  anchoring, fair scheduling, honest admission exhaustion; real gates pass.
  State: open. Inputs: F7 checkpoint
  `a1f9cbc97f7c92719670205d6a965aa5080bb365` (released ungated; qualify).
- [x] **C2 — Production T18/read joins.** Prereq: B1/B2 released slice.
  Accept: generated Cloudflare invocation uses state/default/read behavior,
  not earlier passthrough/refusal posture.
  ACCEPTED (fresh generation): lane 8dcbf04 -> main afd2eed (5 B-threading
  sites + T32c pins + T17b B1/B5 alignment); canonical root 517/517 +
  8-file 187/187 + C1-shape 316/316 + 209/209. D1 model-level only;
  scenario multi-call with B.
- [x] **C3 — Production T19/T25 joins.** Prereq: matching B3 receipt slice +
  E input/visibility slice. Accept: registry/dispatch consumes checked inputs
  and receipt/schema ports; browser/MCP rules and real receipt paths agree.
  ACCEPTED (fresh generation): lane 73bf860 -> main fa5c8e3 (T19 op-route
  join + deploy bundle + L3 delivery-strip retry + B3 deliveryFields
  threading + ruling-B receipt agreement + 17 pins + update+remove seam
  pin closing recorded I00 gap; F1 confirm); canonical build 0 + vitest
  58/58 + 535/535 + memory 162/162 + t32b 27/27. Follow-ups: R01-C3-01
  P2 (stripDeliveryInputs pre-validation drop, C investigating) +
  unavailable-member transport half batched to C; live serving =
  D3-with-B.
- [x] **C4 — Deployment/boot repair.** Prereq: reproduce exact two 500
  failures. Accept: both repaired; real compiled boot/load/dispatch controls
  pass; no unsupported production deployment.
  ACCEPTED (fresh generation): both DB-boot 500s reproduced 2x exact,
  bodies captured (single root: staged invoke.js const-held
  @canlang/contracts import -> worker-assembly-failed); repaired via t16b
  vendor seam + pin + TEST_ONLY skips; deploy-bundle 24/24; full gates
  316/316 + 203/203.

### Lane D — Work/files/providers

- [x] **D1 — Recovered T26.** Prereq: existing T25 contract.
  Accept: per-relation duplicates/cancellation/late usage/terminal
  immutability/notifications + real durable restart qualified.
  ACCEPTED (fresh generation, 8a0410a7): verify-only zero-diff at b30d52a —
  work tsc 0, pure t26 297/297 (matches prior independent count), durable
  4/4 real kill/restart (D1+DO), package 201/201, contracts 8/8; c53ce1d
  confirmed latest boundary commit. Production call-site/B3/C3/D3
  explicitly out. Writer released; D on D2.
- [x] **D2 — T27 finalized images.** Prereq: image-relevant D1 + real file
  lifecycle. Accept: receiving-app finalized file; ownership/provenance/
  permission/invalid output/replay through owning lifecycle.
  ACCEPTED (fresh generation, 3e4dab8d): lane 4cf70d8 -> main aae8fae
  (+1053/-0: finalize module +241, catalog +1, tests +811); 26/26 new +
  82/82 files + 146/146 services + red-check reviewed; canonical re-run
  queued for TS slot. D3 blocked on B3/C3 (D standing by).
- [ ] **D3 — Receipt/bound-dispatch follow-ups.** Prereq: matching
  B3/C3/producer contracts. Accept: re-pointing to existing receipt and
  mirror conformance; admitted bound sends execute; unavailable Handbook
  capabilities stay explicit.
  IN PROGRESS (fresh generation): D3a DONE — lane 5d8a9d0 -> main 1f5c1b5
  (31 T25 mirror pins, test-only; work suite 232/232). D3b: live-serving
  read-envelope proposal filed (D proofs 9/9), B state-side APPROVED
  C1-C7, E envelope-side review dispatched; B-C3 identity satisfied by
  construction. D3c: dispatch-unavailable verdict (7/7 pins); invoke.ts
  transport half queued to C batch. Gate queued behind G suite-3.

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
  rebuild + 403/403 green; filetree reconciled). E2b DONE (fresh
  generation): lane 0c665df (interfaces-only +907/-63, 16 new tests) ->
  main ef3f680; canonical interfaces 419/419. R5/R6 F1 joins, HTTP
  action_handle OUT (loud MCP-only reject), MCP datetime decode +
  null-defers-to-binding. LANE_ACCEPTED queued (E2b acceptance met).

### Lane F — Presentation

- [x] **F1 — T20b rich presentation.** Prereq: committed T19 descriptors +
  incremental E handoffs. Accept: delivery/decimal/file/bound/datetime/null/
  reference/conflict behavior + client/exports execute; tampering/authority
  negatives retained.
  INTEGRATED (fresh generation): lane c0f0fd1 -> main 626611f (ui-only
  +3253/-66: forms depth, client.ts, t20b suites, T20a re-pins, delivery
  hook); lane gate build 0 + ui 869/869. R5 generatedDraftValues released
  for E. Canonical gate + acceptance pending (TS slot order: F probe,
  C build). C1 delivery-notice rule already pinned on main
  (presentation.ts:1771-1787); F branch predates it.

### Lane G — Fixtures/journeys

- [x] **LG00 — T36 residual adjudication (+ reserved draft/design owner).**
  Prereq: fresh site evidence + applicable repaired roots; pilot cases first.
  Accept: complete collision/cycle/trusted-selector/handler/fixture-parent/
  secret/cardinality inventory adjudicated with intent, opposite case,
  confidence; only demonstrated corrections under exact reservations;
  unresolved proposals and negatives preserved.
  ACCEPTED (fresh generation): 15 cases adjudicated (R21 held, E5001
  revised to checker defect); reservation fulfilled exactly (draft
  40656da +53/-52, pointer c87bebf on main; R20x4+E5004x2+Report flip;
  differential E2017 5->0/E5004 2->0/E5008 2->0, no new codes).
  (ACCEPT notice UNDELIVERED — route contained; queued with LG02 dispatch.)
- [x] **LG01 — T22a core fixtures.** Prereq: selected LG00 fixture decisions
  + required producer slices. Accept: core model/user/grant fixtures
  validate; setup failure cannot satisfy business rejection; independent
  expectations preserved.
  ACCEPTED (fresh generation): lane 22fd3ce -> main 4594011 (+742/-19:
  recipes validation/provisioning + loader real setup + loadExampleSuite
  + 12 tests); 52/52 vitest, tsc zero testkit errors, T22a
  setup-failed control retained. report/playback/isolation suites
  deferred (need dists+miniflare). (Notice UNDELIVERED — route contained.)
- [x] **LG02 — T22b/c + T23.** Prereq: matching fixture/provider/file
  output. Accept: rich fixtures and compiled tables/sequences execute actual
  callers/prior commits/observations; deliberately broken expectation fails.
  INTEGRATED (fresh generation): lane e75ff4a -> main 09ab537 (+1015/-73:
  row expansion + sequence runner + ExampleHooks seam + T22b/c validation);
  CANONICAL GATE GREEN (vitest testkit 118/118, 9 files; lane 62/62 +
  tsc 0). Broken-table/sequence controls green. Gaps recorded (dispatch
  invokers, observation scope, CallOutcome payload, file finalization,
  delivery allowlist, query cells). Acceptance + LG03 dispatch queued.
- [ ] **LG03 — T37 basic pilot (G + C/E/F).** Prereq: own source blockers,
  core LG01/LG02, required production/UI/MCP slices. Accept: one unchanged
  original app proves two actors, denied read, persistence, stale update,
  replay, browser/MCP parity, genuine examples.
  LG03a SCOPED START INTEGRATED (fresh generation): lane 5e53f25 -> main
  2c9da87 (dispatch adapters + vendor exact-keys skip + CanDo seed plan +
  held live binding, no callers); CANONICAL GATE GREEN (vitest testkit
  122/122; lane 66/66 + 6/6 playwright). Live runs held for C1/E2b.
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

## Conditional port backlog (human via Codex CODEX-CONDITIONAL-PORT-BACKLOG-20261006T082351Z; does not close/alter original work)

- Free released workers do Rust port backlog first (plans main bf68e17, checkpoint 3d1f8f0, 205+25 tasks). A/B/C/D/G NOT free (unfinished tasks). F (F1 closed, clean tree) ASSIGNED C01.1 (scope.json only, separate native goal, ACKed with startup evidence). E second reserve. C01.2+ queued on C01.1 + free worker.

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

## Fresh-generation integrations 2026-10-06 (coordinator, uncommitted bookkeeping)
- O2 ACCEPTED: 6d12056 -> main 1b6a63b; cargo 894/894 exit0 (lane-side 2 fails = draft-pointer 2d67312 vs main 40656da artifacts; zero O2-shift). Evidence: lane-a.json o2_evidence, grants COORD-CARGO-O2-VERIFY, filetree integration-20261006-o2.json.
- R01 (R01-C3-01 + unavailable half) ACCEPTED: fea1539 -> main 8f5cdf8; build0, vitest 535/535, node 220/0 (miniflare exclusion moot). Real-kernel unavailable join queued; B7 out of batch. Evidence: lane-c.json r01_release, COORD-TS-R01-VERIFY, integration-20261006-r01.json.
- Port prereqs committed: F d0fde92 (16 files) -> main ec81b09 (parity 16/16) + coordinator 8d3c566 (ownership/C02.ready/C01.ready.json). CORRECTION: prereq bytes were worktree-only until E's catch; 'integrated' claims before ec81b09/8d3c566 meant worktree copies. C05.1 (F) + C03.2 (E) proceed from committed bytes.
- LG03b/c + suite-3 ACCEPTED: 565a151/ae244bc/abfd2ae -> main 556627c/9bbb6d1/02cb62e; testkit 125/125. Served legs + live-leg greens + LANE_ACCEPTED remain. Evidence: lane-g.json grant_release_lg03_reverify, COORD-TESTKIT-LG03-VERIFY, integration-20261006-lg03.json.
- A B8-triage + B7-analysis delivered read-only (lane-a.json @10:14Z): 17 families/101 sites; ops public already emitted; models-side provenance gap; B7 atomicity critical (loading-fix must land with trivially-public honoring or T04b evaluation); A1-vs-A2 join question open. C serve-time half dispatched; joint decision follows.
- D lane CLOSED (LANE_ACCEPTED_ACK aa67e6ac, full release). I00/T26/parents stay open: selected-receipt serving, nonempty membership/revocation, durable notification/restart, T04b rich-descriptor join (see coordinator.json joins_open).
- R01-C3-01 RESIDUAL repaired: fb1f226 -> main 96ff246; build0, vitest 59/59 538/538, node 231/231 (+11), root probe retargeted to main 11/11 owning reasons. Fresh release to root for re-review; independent verdict root's.
- C03.2 FULLY accepted (d535571 -> 6cc645b; self-check 44ok confirmed); C05.1 FULLY accepted (5711a67+8584198 -> 6283fca+9014119; digest-identical confirmed).
- B7 JOINT DECISION: A2 phased atomic-first (A+C consensus, S13-clean; rule-fn rejected; T04b deferred). A-emitter started (canApp-policy + models provenance, behavior-neutral); C serve-time queued after.
- R01-C3-01 INDEPENDENTLY ACCEPTED-NARROW by root (CODEX-C-RESIDUAL-INDEPENDENT-ACCEPTANCE): 11/11 on fb1f226 byte-identical to 96ff246. Unavailable mapping accepted at declared scope only; parents/joins open.
- Port gates authored: C03.ready + C05.ready signoffs -> main 1dce8d4 (reviews of accepted C03.2/C05.1).
- B7-emitter ACCEPTED: bb9903e -> main 51b16ea; cargo 896/896 exit0 (894 + 2 b7_ pins).
- C04.1 FULLY accepted: 3c45852 -> main 247d9a8; test 3/3 --locked, wasm build ok, node 6/6 + bun 6/6 confirmed by coordinator.
- C04.asset dispatched to F (both handoffs ACKed: C 26332cdc disjoint-confirmed, G e825aa94 no-conflict); F started.
