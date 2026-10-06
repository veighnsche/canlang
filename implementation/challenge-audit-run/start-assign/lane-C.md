# START_ASSIGN lane C (coordinator 01a10f6d-4be0-7560-915d-a8bc1fefe571)

Plan: implementation/REMAINING-IMPLEMENTATION-LANES.md (sha 25337c97…18e130c).
Base: b30d52a22516643533795f79d7d0fb111a6c0f04. Branch: codex/remaining-lane-c-runtime.
Boundary: packages/cloudflare/**, packages/stdlib/** only. No cross-boundary edits;
send contract requests to coordinator.

## Assignment C1 — F7 qualification/generated-serving join (then C2–C4)
Qualify the F7 checkpoint already on main (a1f9cbc97f7c92719670205d6a965aa5080bb365),
previously released ungated — do not treat it as accepted. Join generated
serving: no Cloudflare consumer of emitted appDefinition.cohorts /
ArtifactCohortDescriptor exists yet; F7 uses caller-supplied specs.
Released inputs: committed F1–F5. Independent of F6 completion.
Acceptance: atomic source+intent, durable fenced claim/record, first-attempt
anchoring, fair scheduling, honest admission exhaustion; real gates pass.

## Protocol
- Native goal: create/reuse your lane goal; complete ONLY on exact LANE_ACCEPTED.
- Heavy commands: send READY_TO_START (exact command, deps, estimate), await my
  exact START_ACK before launching. No .heavy-lock anywhere. Reinspect long
  commands ~every 2 min with handle/deadline. Worktree-local dist/tsbuildinfo only.
- Records: publish acks/lane-c-startup.json + status/lane-c.json in the shared
  run dir via /Users/vince/.codex/skills/muse-implementation/scripts/publish_record.py (exact identity fields; contract: /Users/vince/.codex/skills/muse-implementation/references/runtime-records.md). Never touch monitor.json
  or the central checklist.
- Release: commit focused scoped changes on your branch; report exact commit,
  tests run with results, diff summary, writer/command release.
- AGENTS.md applies; hard language decisions need verified context + 3× JEV.
- Report route: native messages to this coordinator session.
