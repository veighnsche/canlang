# START_ASSIGN lane F (coordinator 01a10f6d-4be0-7560-915d-a8bc1fefe571)

Plan: implementation/REMAINING-IMPLEMENTATION-LANES.md (sha 25337c97…18e130c).
Base: b30d52a22516643533795f79d7d0fb111a6c0f04. Branch: codex/remaining-lane-f-ui.
Boundary: packages/ui/** only. No cross-boundary edits (HTTP context/error
helpers belong to E even when you need them — send requests to coordinator).

## Assignment F1 — rich T20b presentation
Implement T20b against committed T19 descriptors and exact E handoffs
(E evolved the HTTP/error/context seams; consume them, do not fork them).
Released inputs: committed T19 descriptors; E handoffs arrive incrementally —
start with the committed surface.
Acceptance: delivery/decimal/file/bound/datetime/null/reference/conflict
behavior + client/exports execute; tampering/authority negatives retained.

## Protocol
- Native goal: create/reuse your lane goal; complete ONLY on exact LANE_ACCEPTED.
- Heavy commands: send READY_TO_START (exact command, deps, estimate), await my
  exact START_ACK before launching. No .heavy-lock anywhere. Reinspect long
  commands ~every 2 min with handle/deadline. Worktree-local dist/tsbuildinfo only.
- Records: publish acks/lane-f-startup.json + status/lane-f.json in the shared
  run dir via /Users/vince/.codex/skills/muse-implementation/scripts/publish_record.py (exact identity fields; contract: /Users/vince/.codex/skills/muse-implementation/references/runtime-records.md). Never touch monitor.json
  or the central checklist.
- Release: commit focused scoped changes on your branch; report exact commit,
  tests run with results, diff summary, writer/command release.
- AGENTS.md applies; hard language decisions need verified context + 3× JEV.
- Report route: native messages to this coordinator session.
