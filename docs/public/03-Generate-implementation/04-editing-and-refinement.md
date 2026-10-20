# Editing and refinement

Generated implementation is ordinary tracked, editable code. Refinement and retry create candidates while preserving the accepted implementation until a validated promotion succeeds.

## Direct editing

Edit the owning JavaScript or CSS file under the workspace write-lease protocol. A compatible byte edit is immediately the current implementation; it does not require another model call or candidate ceremony. If the edit changes lasting intent or a declaration contract, update source and reconcile compatibility. Provenance reports edits without misattributing them to the original generator.

## Refinement and retry

Refine starts from current code plus a new instruction and produces a candidate. Fresh generation starts from source intent. Manual retry freshly captures every prompt in the active app/build dependency closure, including successful styles; unrelated apps are excluded. All required outputs validate as one acceptance set.

Interrupted sessions can resume only when the adapter supports it and the captured inputs remain applicable. Reset/cancel fence pending work without deleting current code. Leases do not expire or get stolen automatically; recover an interrupted lease only after its writer has stopped. Promotion checks source, target, current bytes and attempt fences, stages the whole scope, and recovers idempotently before or after commit. See [generation controls](../15-Tooling-reference/04-generation-controls.md).
