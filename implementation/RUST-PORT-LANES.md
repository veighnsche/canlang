# Four Rust-port implementation lanes

**PROPOSED planning allocation — implementation remains deferred.** This overlay divides the existing port scope into four ownership queues. It launches no workers, creates no worktrees or goals, and changes no acceptance status or human hold.

Source: the [remaining-work ledger](remaining-work/tasks.json) at main `7fd8c6bf4717feeffc70b46819377b74b353e117`, with product/source evidence pinned separately at `fdb059c634c32c83760f35dd9175f49d9821762d`. The [machine-readable allocation](rust-port-lanes.json) assigns every one of the 230 port identities exactly once and preserves their original prerequisites, conditional/deferred disposition and acceptance reference. The original [port plans](../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md) and [ideal ownership](../docs/ideal-filetree-plan/finished-product/ownership.md) remain authoritative for behavior.

These are four workstreams, not four independent Rust packages. Exact values and validation share `packages/values/semantics` and its thin binding crate. Work owns the contracts-only `packages/work-kernel` leaf. Native preparation belongs to Cloudflare. A lane cannot create another arithmetic, validation, authority or catalog engine.

| Lane | Primary responsibility | Required records still open | Work / completion gates |
| --- | --- | ---: | ---: |
| R1 — Exact values + values assembly | Exact arithmetic, temporal math, aggregates, scalar codecs, carriers, one shared crate/binding assembly writer; common complete-call review | 31 values + 1 shared = **32** | 20 / 12 |
| R2 — Owned input validation | Prepared TS, provenance, plans, interpreter/profile policy, whole-input HTTP/state/selected MCP joins; common baseline and ABI review | 61 validation + 2 shared = **63** | 49 / 14 |
| R3 — Work transitions + global delivery | Work/state mechanisms, real runtime/durable consumers; sole global manifests, bundle/assets and release integrator | 33 work + 8 shared = **41** | 29 / 12 |
| R4 — Retained native preparation | Full retained local job, ordered host stages, exact reviewed-byte publication, executable integrity/lifetime, real CLI/installed-host qualification | **30** | 21 / 9 |
| Total | All selected required remaining port work | **166** | **119 / 47** |

Counts include completion/review gates; they are not 166 coding jobs or equal estimates of effort. The 54 completed identities stay credited and are not redispatched. Six accepted-conditional identities and four deferred identities remain separately mapped: validation has five conditional adoption tasks; preparation has one conditional mixed-asset task; work has four deferred optional scheduler tasks.

## Shared work fits inside these four lanes

No fifth implementation lane is added. Each subsystem still supplies its own actual consumer and measurement evidence; the named owner of a common gate assembles all contributors' evidence, and independent review verifies it.

| Lane | The eleven open required shared IDs |
| --- | --- |
| R1 | `C05.complete` |
| R2 | `C02.complete`, `C03.complete` |
| R3 | `C01.complete`, `C04.ready`, `C04.graph`, `C04.values-assets`, `C04.work-assets`, `C04.native-release`, `C04.validation-join`, `C04.complete` |
| R4 | Supplies preparation/native-release evidence to the corresponding gates |

R3 is the proposed global delivery writer because R4's preparation scope remains human-held; ordinary values/work delivery must not be parked behind that unrelated hold. `C04.native-release` retains its own hold and actual prerequisites even though its future writer is assigned to R3. Assigning gate ownership does not release a missing input or permit self-acceptance. Global coverage/checkpoint maintenance has one coordinating reviewer/writer; lane workers submit coverage evidence rather than simultaneously editing the living plan.

## Exact shared-file ownership

**R1 owns common values assembly.** Reserve package-local Cargo manifests/lock, common module registrations and failure/transport roots, binding entry/bootstrap/selection, generated glue/build inventory and public export assembly. R2 owns validation leaf modules and producer/consumer joins; it submits common registration, hook and backend changes to R1. This resolves the original A/V tables' overlapping reservations without duplicating numeric semantics.

The exact unresolved ledger overlaps are `packages/values/semantics/src/lib.rs`, `packages/values/bindings/src/lib.rs`, `packages/values/bindings/{backend,bootstrap}.ts` and `packages/values/src/index.ts`. An R2 task still owns its validation outcome even when R1 applies its requested assembly change. Requests name task, base/source hash, exact change, vectors and returned release hash. A handoff is released only after actual writer acknowledgment; scheduling never infers release from elapsed time.

**R3 owns global delivery.** Reserve root `package.json`/`bun.lock`, Cloudflare/state/stdlib/testkit consumer manifests, Cloudflare `deploy/bundle.ts`, `dev/local-run.ts`, `release/{stamp,manifest}.ts`, testkit `src/scopes/local.ts` and shared deployment-asset contract exports. R1/R2/R4 submit exact requests and consume released source/asset hashes. Package-local values, work-kernel and preparation Cargo/source manifests stay with their defining lane. Internal JS consumption must respect declared manifest dependencies and exported package/subpath boundaries; no new sibling-source shortcut is introduced.

**Runtime source changes transfer from R3 to R2.** The original ordered handoff remains `W06.2 → W06.runtimehandoff → V09.1 → W06.3`. R3 finishes its `packages/cloudflare/src/runtime/invoke.ts` change and releases that file; R2 then owns the final protected-input provenance bridge. R3 subsequently changes/runs its durable pilot tests, without writing `invoke.ts` again. Other work/state and validation leaf duties can overlap throughout this sequence.

## Narrow joins and parallel progress

Preserve the exact DAG; broad parent gates are not blanket barriers when their original plan exposes a smaller reviewed readiness handoff. Important existing joins include:

- `A03.1 → A03.foundation`: shared representations/failures/workspace for independent validation work.
- `A07.foundation → V03.5 → A07.3`: serialized shared module/binding assembly, while disjoint arithmetic and validation files progress independently.
- `V02.6 → A08.1`: prepared public hook release; final routing also needs its other original prerequisites.
- `A07 + V03.5 → V06.8 → V06.9 → V06.10 → V04.4 → V05.3`: profile registration/materialization/callback joins through the same shared assembly owner.
- `W05.1 → W05.2 → C04.work-assets → W05.4 → W05.3`: actual work binary/package request, delivery, installed consumer and workerd qualification.
- `P05.2 → C04.preparation-join → P05.3 → P05.4`: native host consumes the existing bundle builder. The narrow shared join is already credited; consumption and native integration remain open.
- `P09.1 + C04.graph → C04.native-release`: preparation supplies actual executable/release inputs; R3 performs only the released global integration and returns it for R4's consumer verification.

The initial static candidate queues are embedded in the JSON and come from the current remaining ledger. R1 has native/carrier/codec verification and integration work; R2 has source/profile/provenance inventory and prepared hook work; R3 has kernel/demand contract work plus independent graph/readiness integration. R4's implementation queue remains held until explicit human release. A static candidate is not authorization, and current contracts/files/resources must be reconciled before a later start.

Four lanes are ownership queues, not permanent worker silos. A worker whose packet finishes can assist a different queue on a released, file-disjoint task; record the transfer instead of inventing duplicate authority. The larger R2 queue can receive such help. Waiting for another lane or a heavy command must not park a whole worker when fixtures, adapters or other prerequisite-unblocking work is genuinely ready. Preserve unfinished edits and reservations. Serialize only overlapping files, Git integration and exact command resources; mutable target/dist/fixture outputs remain private. Existing inner lane labels are subqueues, not additional independent writers.

## Completion and limits

Keep whole owned operations as the target seam: arithmetic internal to the validator, ordered work batches with TS authority/commit, one retained preparation job with coarse host phases. Fine-grained scalar JSON adapters are conformance scaffolding, not evidence of optimality. Actual bindings, installed assets, complete supported consumers, semantic/identity/byte/order parity, startup/resources, measured adoption and rollback still close their named tasks.

Narrow matching challenge/product producer, descriptor, authority and dispatch-availability contracts remain readiness inputs when the chosen consumer requires them. This overlay neither imports the entire product backlog into Rust nor drops required consumer behavior. Public JS compatibility remains explicit; compiler lowering, optional W09 scheduling, unrelated product work and production deployment are not authorized here.

Planning validation: 230 unique source identities allocated once; 166 required open = 119 work + 47 gates; 54 complete + 6 conditional + 4 deferred preserved; all eleven unresolved shared IDs assigned; six exact cross-lane planned source overlaps have explicit assembly/handoff resolutions. No product build/test or implementation was performed.
