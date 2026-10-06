# W01.1 — Work-transitions caller profiles

Task: W01.1 (lane `work-contracts`, wave 1, after `C01.ready`). Produced
2026-10-06T09:36:24Z by lane F session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9.
Planning record only; no implementation authorized.

- Head verified: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06`
- Companion: `callers.json` (tables, shells, callers, delivery schema).

## Profile 1 — Production Cloudflare orchestration (F7/durable)

The only production consumer class. `runtime/invoke.ts` owns dispatch
execution rows, the worker registry/join loader, `driveDispatchIntent`,
`runRecoverySweep`, F7 table/outcome mirrors, the producer loader, the
trigger join, claim/record/release, scheduler turns/progress, and
provider cancellation. F7 loads state-dist builders and commits through
`StoragePort`; D1 uses atomic `db.batch`, DO transaction-backed
storage; both enforce revision/version semantics. Evidence: t24b
(execution + durable), t34-f7 (fanout + durable + emitted cohorts),
t32b (cloudflare + durable), state F5, work F4 durable suites. These
suites — and only these — prove races, kill/restart, fences, and
durable claim/record. The ordinary recovery driver re-reads evidence
and live rows when acting; `runRecoverySweep` rereads
not-found/delivered/failed evidence at action time.

## Profile 2 — State-owned mirrors and staging (F2/F5, T25)

State consumes matching semantics through its own wrappers:
`fanout/tables.ts` F2 structural mirrors (never importing work
sources — verified layering comment; byte-parity via the test-only
`fanout/work-loader.ts`), `fanout/outcome.ts` F5 staging (child
terminal outcomes + checkpoint cover co-staged in one child-unit
commit; pending pins differ from the F3 record API), T25 receipt
tables/join/grants with loader-owned delivery schema, and
`ports/transact.ts` join assertions (dispatch staging co-stages
outbox+dispatch; child units co-stage outcome+checkpoint; one store
commit; caller decides retries). State keeps row codecs,
`ReceiptTableError`, loader schema, grants, retention, loads, fence
enrollment, and the `createSystemRegistry` reader-only seam
(load/query only; no commit capability crosses to Rust).

## Profile 3 — Memory fixtures and test-only bridges (never production)

`TestOnlyMemoryFanoutChildStore`, `TestOnly*Grants` ports, and the
fanout work-loader are fixtures/bridges consumed by F3 memory tests,
F5 join tests, and the non-durable halves of F7 suites. The
receipt work-loader is additionally consumed by the invoke.ts D3b
Node/memory serving edge (see DRIFT-SUPPLEMENT D3b below) — do not
describe ALL receipt-loader consumers as test-only. The memory-store
winner proof is synchronous single-process serialization: not
durability, not multi-handle fencing, not restart. No production
claim may cite these paths; Cloudflare bundling excludes
`vendor/state/fanout/work-loader.js` and `receipt/work-loader.js`.

## Profile 4 — Absent named wait (explicit non-coverage)

No `waitFor`/`wait`/WaitApi export exists in work/state/cloudflare/
stdlib sources (verified). Wait coverage in this project means only
the existing held-child / unknown-provider / awaiting-evidence
states, progress observation, and later re-drive/recovery — and must
not manufacture successful completion for them. A Rust continuation
scheduler is the separately gated W09 project, not this one. If an
emitted/services-level wait consumer is later selected, its real
integration fixture must land before any await-continuation claim.

## Cross-profile rules (frozen)

- Demand stays in TS: callbacks are never converted by eager verdict
  collection; facts are prepared only where already demanded, in
  original order, stopping on the same first exception.
- Clone profiles stay distinct: work JSON-safety-traversal-then-clone
  (repeated identity treated as seen/cyclic, kept on unwind) vs state
  clone-only row replacement; completion "never throws" comments do
  not override real getter/proxy throws.
- Freshness/authority/commit stay host-owned: `expectedRevision`
  acquisition, live membership re-reads, fenced atomic commits, and
  caller-owned retry/exhaustion never move into the kernel; kernel
  output is a proposed batch, and every commit seam stays single-shot.
- Bootstrap/selection: load/verify the pinned module once before
  publishing synchronous façades; TS-or-Rust selection precedes
  operations; post-selection Rust failure fails loudly; rollback is a
  new release/startup choice. No lazy init in semantic calls, no
  promise-ified signatures, no mid-call TS recovery, no duplicate
  kernel instances.

## Owner review status

Required (recorded, not assumed): work owner (tables/shells/decision
split), state owner (mirrors/staging/transact/registry), cloudflare
owner (F7 orchestration/producer seam), C04 delivery owner (vendor/
bundle/manifest). Each profile and cross-profile rule above needs
its owner's review before W02 extraction begins.

## DRIFT-SUPPLEMENT D3b (2026-10-06, session 01a10fab-cc9d-7331, head `ef35e95`)

`packages/cloudflare/src/runtime/invoke.ts:3321-3330` loads
`STATE_RECEIPT_WORK_LOADER_SPECIFIER`
(`../../../state/dist/state/src/receipt/work-loader.js`, `:2965`)
through `loadProducerModule` + `requireProducerFn(loadWorkReceiptFns)`
(`:1259`), the canonical producer-read helper shared with the
registry/invoke/crud/models state producers. This is a genuine
Node/memory serving edge: receipt-loader consumers are not all
test-only. The fanout loader stays test-only (no invoke.ts
consumer). Packaged/deployed observer loading stays UNQUALIFIED:
`deploy/bundle.ts:212-213` still excludes both vendor work-loaders
as TEST-ONLY bridges with node-only imports, and no deployed
assembled/driver consumer is evidenced — Node is not relabeled as
deployed. Retained: `invoke.ts:4508-4516` availability is a
deferred host injection/mapping seam; kernel
unavailable-before-guard does not establish equal host
orchestration; F7 Miniflare D1/workerd DO test consumers are
tests, not deployed-consumer evidence. Source identity:
c07c51e→ef35e95 invoke.ts +439/−3, assembly.ts unchanged,
2071631→ef35e95 neither file changed. Full record:
`callers.json` `drift_supplement_d3b`.
