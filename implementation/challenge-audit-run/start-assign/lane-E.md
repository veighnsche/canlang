# START_ASSIGN lane E (coordinator 01a10f6d-4be0-7560-915d-a8bc1fefe571)

Plan: implementation/REMAINING-IMPLEMENTATION-LANES.md (sha 25337c97…18e130c).
Base: b30d52a22516643533795f79d7d0fb111a6c0f04. Branch: codex/remaining-lane-e-interfaces.
Boundary: packages/interfaces/**, packages/identity/** only. No cross-boundary edits;
send contract requests to coordinator.

## Assignment E1 — bound input/MCP dispatch (then E2)
Wire bound-input checking and MCP visibility/dispatch.
Released inputs: committed T19 derivation.
Acceptance: pure bound checker is actually invoked; binding visibility and
equal-authority inputs preserved through dispatch.

## Protocol
- Native goal: create/reuse your lane goal; complete ONLY on exact LANE_ACCEPTED.
- Heavy commands: send READY_TO_START (exact command, deps, estimate), await my
  exact START_ACK before launching. No .heavy-lock anywhere. Reinspect long
  commands ~every 2 min with handle/deadline. Worktree-local dist/tsbuildinfo only.
- Records: publish acks/lane-e-startup.json + status/lane-e.json in the shared
  run dir via /Users/vince/.codex/skills/muse-implementation/scripts/publish_record.py (exact identity fields; contract: /Users/vince/.codex/skills/muse-implementation/references/runtime-records.md). Never touch monitor.json
  or the central checklist.
- Release: commit focused scoped changes on your branch; report exact commit,
  tests run with results, diff summary, writer/command release.
- AGENTS.md applies; hard language decisions need verified context + 3× JEV.
- Report route: native messages to this coordinator session.
