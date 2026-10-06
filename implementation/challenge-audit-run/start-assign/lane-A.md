# START_ASSIGN lane A (coordinator 01a10f6d-4be0-7560-915d-a8bc1fefe571)

Plan: implementation/REMAINING-IMPLEMENTATION-LANES.md (sha 25337c97…18e130c).
Base: b30d52a22516643533795f79d7d0fb111a6c0f04. Branch: codex/remaining-lane-a-compiler.
Boundary: compiler/** only. No cross-boundary edits; send contract requests to coordinator.

## Assignment A1 — F6 qualification/repair (then A2–A5)
Qualify the F6 checkpoint already on main (9aa3d420456713f0c2f6b30fc835bea425f7c75f):
do not replay it blindly. Repair: effects.rs unconditional
tables.by_canonical["volunteer.cancel_signup"] lookup (Shift iteration panics);
documented parser/child-binding/trigger-lowering gaps.
Released inputs: committed F1; T18 release (ticked complete).
Acceptance: both each= spellings check/emit; original guards/body preserved;
unsupported forms and ordinary loop overflow still rejected.

## Protocol
- Native goal: create/reuse your lane goal; complete ONLY on exact LANE_ACCEPTED.
- Heavy commands: send READY_TO_START (exact command, deps, estimate), await my
  exact START_ACK before launching. No .heavy-lock anywhere. Reinspect long
  commands ~every 2 min with handle/deadline. Private worktree target/ is yours.
- Records: publish acks/lane-a-startup.json + status/lane-a.json in the shared
  run dir via /Users/vince/.codex/skills/muse-implementation/scripts/publish_record.py (exact identity fields; contract: /Users/vince/.codex/skills/muse-implementation/references/runtime-records.md). Never touch monitor.json
  or the central checklist. Republish shared-path records (not private /tmp).
- Release: commit focused scoped changes on your branch; report exact commit,
  tests run with results, diff summary, writer/command release.
- AGENTS.md applies; hard language decisions need verified context + 3× JEV.
- Report route: native messages to this coordinator session.
