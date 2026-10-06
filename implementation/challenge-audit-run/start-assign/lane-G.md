# START_ASSIGN lane G (coordinator 01a10f6d-4be0-7560-915d-a8bc1fefe571)

Plan: implementation/REMAINING-IMPLEMENTATION-LANES.md (sha 25337c97…18e130c).
Base: b30d52a22516643533795f79d7d0fb111a6c0f04. Branch: codex/remaining-lane-g-journeys.
Boundary: packages/testkit/**, tests/e2e/** only. Draft sources: read-only
investigation; NO draft edits without a separate exact-site reservation from me
(one draft-submodule writer, commit/pointer provenance). No cross-boundary edits.

## Assignment LG00 + LG01 (then LG02–LG06)
LG00: adjudicate pilot-relevant T36 fixture cases (collision/cycle/
trusted-selector/handler/fixture-parent/secret/cardinality) with intent,
opposite case, confidence. Your pilot-candidate proposal is received; the
pilot designation decision is mine and follows shortly — do not presume it.
LG01: provision unaffected core fixtures (independent of undecided cases).
Released inputs: selected LG00 decisions as you record them; required producer
slices as released. Acceptance: complete inventory adjudicated; core
model/user/grant fixtures validate; setup failure cannot satisfy business
rejection; unresolved proposals and negatives preserved.

## Protocol
- Native goal: keep your lane goal; complete ONLY on exact LANE_ACCEPTED.
- Heavy commands: send READY_TO_START (exact command, deps, estimate), await my
  exact START_ACK before launching. No .heavy-lock anywhere. Reinspect long
  commands ~every 2 min with handle/deadline. Worktree-local dist/tsbuildinfo,
  fixture stores, and any private draft checkout only with provenance plan.
- Records: publish acks/lane-g-startup.json + status/lane-g.json in the shared
  run dir via /Users/vince/.codex/skills/muse-implementation/scripts/publish_record.py (exact identity fields; contract: /Users/vince/.codex/skills/muse-implementation/references/runtime-records.md). Never touch monitor.json
  or the central checklist. Republish shared-path records (not private /tmp).
- Release: commit focused scoped changes on your branch; report exact commit,
  tests run with results, diff summary, writer/command release.
- AGENTS.md applies; hard language decisions need verified context + 3× JEV.
- Report route: native messages to this coordinator session.
