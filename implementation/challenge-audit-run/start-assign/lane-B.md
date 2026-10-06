# START_ASSIGN lane B (coordinator 01a10f6d-4be0-7560-915d-a8bc1fefe571)

Plan: implementation/REMAINING-IMPLEMENTATION-LANES.md (sha 25337c97…18e130c).
Base: b30d52a22516643533795f79d7d0fb111a6c0f04. Branch: codex/remaining-lane-b-core-state.
Boundary: packages/state/**, packages/values/** only. No cross-boundary edits;
send contract requests to coordinator.

## Assignment B1/B2 — state defaults/read/schema consumers (then B3–B5)
B1: close state-side defaults/receipt/read consumers using released existing
contracts. Released inputs: existing T18 mechanism, matching descriptor slice
(T15a/T19a committed). Acceptance: defaults/server fields/parent/context/order/
replay agree on CRUD and scenario paths; unsupported computed init stays explicit.
B2: required filtered/owner/archived/policy reads execute canonically;
denial/history/replay/restart proofs match claimed scope.

## Protocol
- Native goal: create/reuse your lane goal; complete ONLY on exact LANE_ACCEPTED.
- Heavy commands: send READY_TO_START (exact command, deps, estimate), await my
  exact START_ACK before launching. No .heavy-lock anywhere. Reinspect long
  commands ~every 2 min with handle/deadline. Worktree-local dist/tsbuildinfo only.
- Records: publish acks/lane-b-startup.json + status/lane-b.json in the shared
  run dir via /Users/vince/.codex/skills/muse-implementation/scripts/publish_record.py (exact identity fields; contract: /Users/vince/.codex/skills/muse-implementation/references/runtime-records.md). Never touch monitor.json
  or the central checklist.
- Release: commit focused scoped changes on your branch; report exact commit,
  tests run with results, diff summary, writer/command release.
- AGENTS.md applies; hard language decisions need verified context + 3× JEV.
- Report route: native messages to this coordinator session.
