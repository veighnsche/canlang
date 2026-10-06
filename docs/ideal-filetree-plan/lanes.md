# Parallel lanes and writer ownership

This is a future scheduling plan. The prior implementation was stopped by the user; its three prematurely allocated replacement worktrees were removed. Before any future dispatch, reconcile preserved source and establish the authorized coordinator, exact reservations and released handoffs. Preserve the finite original/supplemental goals.

| Lane | Packets | Exclusive source families and joins |
| --- | --- | --- |
| L-A language | C01/C02 producer portions, C11/C12/C13 consumers, R01 | Rust syntax/analysis/codegen/CLI/docs/LSP and Rust tests; editor work can be a disjoint subpacket. One writer for `js.rs`, `ir.rs`, `types.rs`, `resolve.rs`, `effects.rs` and their future module successors at a time. |
| L-B contracts/values | C01/C02 contract, C11/C13 producers, R02 | All shared contract barrels and value schemas/catalog/locale/default semantics. Consumers read a frozen handoff; other lanes request schema changes, never concurrently edit the barrel. |
| L-C canonical state | C01 state, C08/C14 state, R03 | Registry/admission/invoke/read/transaction/mutation/query/storage/migration. `pipeline.ts`/`models.ts`/`invoke.ts` stay single-writer; no simultaneous T18/T32/refactor patches. |
| L-D durable effects | G01/C08/C09, C07/C13 provider portions/R04 | Work dispatch/observation/receipt/commands and services/files lifecycle/catalog exporters. Shared contracts/value exporter belongs to L-B; shared work/state staging is a frozen handoff, not overlapping writers. G01 incorporation can proceed independently before producer dispatch. |
| L-E identity/presentation | C04, C08 transports/UI, R05 | Identity sessions/D1, interfaces HTTP/MCP/uploads/reference, UI input/rendering. Split disjoint session versus renderer work only after exact file reservations. |
| L-F platform/delivery | C03/C06/C15/R06, qualification portions C01/C02 | Cloudflare runtime/worker/deploy/dev and testkit/e2e. `runtime/invoke.ts`, `worker/assembly.ts` and artifact loader are serial within this lane; C01/C02/C06/C15 and structural R06 cannot share writers. |
| L-G graph/evidence | C05/C10/R07/R08 | Root manifests/lock/tsconfig/workflows, release/usage documentation, inventory/tree/task convergence. Per-package manifest requests serialize through this graph writer; recorded source-moving cutovers update graph once. |

Initial independent work can prepare G01 requirements, C04 identity/browser cases and C05 graph/test inventory while the C01 contract writer freezes producer facts. Then release C01 compiler/state/platform consumers in dependency order, followed by C02 context/app identity. C03 gate and C04 identity fixes can run together if shared env/auth files are explicitly disjoint. C05 configuration cutover serializes manifests/workflows. C06 installed journeys start only after producer joins; C08 follows individual original gates rather than waiting for unrelated fanout. R decompositions follow stabilized semantics, with R02 producer exports before dependent consumers; R08 closes the union.

Apply the user's current Muse hierarchy on authorized execution: more than four genuinely parallel lanes use a dedicated coordinator and separate implementer instances/worktrees; four or fewer use one coordinator's native subagents within its actual limit. Each implementer may use its locally limited subagents. Isolate mutable outputs and schedule expensive commands with explicit grants; there is no shared directory-lock protocol or global three-worker cap. Read-only challengers use a named immutable baseline. No execution or timer is started by this plan.

Each dispatch must name exact current/successor files, frozen producer interface, requirement and failure cases, revision/dirty baseline, challenger, release evidence and verification scope. A packet completes when the intended path is exercised, not when code or a review document exists. After every merge, reconcile all accumulated changes into the single current plan before advancing its complete checkpoint.

## Main merge reconciliation, 2026-10-06

All 118 branch commits were fast-forwarded onto `main` through `1126544`, preserving
their hashes and the exact source tree. The [merge record](main-merge-20261006.json)
accounts for all 487 changed paths since the complete checkpoint and registers
44 newer source inputs with exact defining owners/targets. Current structural
coverage is updated; primary audit evidence remains pinned to its historical source.
The complete checkpoint stays at `8249342`: deep joined-path review and product
qualification remain unfinished. This bookkeeping is not implementation acceptance.

F1–F5 fanout mechanisms, T25 receipt persistence/fences, T18 engine initialization,
T19 derivation and T20 form factories now exist in committed source. F6/F7/T26 are
explicitly unfinished checkpoints. Historical blanket absence claims are superseded
at that mechanism scope; generated serving, production receipt/default/form joins,
C05 discovery/import cutover, C08/C09 and original R01 remain open. New test drivers
and colocated witnesses have testing successors gated on actual caller/discovery
cutover. Existing retirement decisions remain unchanged.

The old implementation run is user-stopped, its heartbeat paused, and only the main
checkout remains. No Muse instances, timers, worktrees or implementation are launched
by this merge. The separate [remaining implementation plan](../../implementation/REMAINING-IMPLEMENTATION-LANES.md)
defines that finite authorized backlog; this file-tree plan does not expand it.
