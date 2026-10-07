# SEQ-009 bounded qualification, before repair

**Partial qualification; SEQ-009 and parent F1 remain open.** The final run captures 35 actual runtime vectors and 42 checks: 38 pass and four retain the nullable-create failure and its dependent success-replay expectation. A separate public-façade preload failure and two arithmetic-control preload failures are also preserved. No product source, artifact, generated module body, test assertion, Git state, decision ledger or file-tree plan was repaired.

## Contracts and route

The governing plan is `design/language-proposals-20261007/task-sequence.json`: SEQ-008 requires generated metadata to match source, unsupported types to fail explicitly, and actual artifacts rather than handbuilt descriptors; SEQ-009 requires authorized success, wrong actor/owner, stale references, rollback and duplicate behavior through real admission/durable storage, record versions/defaults and persisted restart. F1 additionally retains denied/stale/wrong-owner/actor-null and persisted replay/restart gates. A bounded result does not close the parent, and SEQ-008's broader metadata/duration contract remains open.

Source and execution are frozen at `db57c3794d386fcd27f17f54b199272d58106a81` (draft `a55a0f700f07f6f972d9d6091b0fdbceee399eb9`). `../f1-metadata/Bounded.can` and its existing actual Rust CLI artifact are consumed unchanged. The separate complete `MemberControl.can` is compiled by that same built Rust compiler; it adds member/owner admission and a late failure after transition staging. The production `assembleModules` performs its documented import URL mapping, followed by actual `buildInvoker`, State descriptor admission, generated CRUD executor/scenario seam, mutation pipeline, and production `createD1Storage` over persisted local Miniflare D1. No alternate descriptor or storage engine substitutes for this route.

The selected positive route supplies the **existing Cloudflare runtime stdlib** as the assembler's explicit peer URL. This is a production compatibility surface, not proof that the public `@canlang/stdlib` façade works. Canonical CRUD dispatch consumes actual generated descriptors/policy/model metadata and calls the generated CRUD executor; it does not execute the emitted CRUD handler body. The actual emitted scenario handler executes both ordered transitions and the late guard.

Identity uses the actual resolver and live membership reader backed by the package's test memory identity store. State uses the production D1 adapter. The host Node process remains alive while Miniflare is disposed and reopened with the same private persistence directory; D1, its handle, and invoker are recreated. This proves local persisted adapter restart, not installed/deployed identity, cross-owner routing, or a host crash.

## Actual results

| Vector | Receipt |
| --- | --- |
| Account scalar default | Actual canonical create commits `name="account"`. |
| Job with supplied current versioned Account ref | Actual create commits title, count, bool and machine defaults. Runtime/default/persisted exact types are captured, not inferred from JSON formatting. |
| Authorized scalar update | One record version increment; omitted defaults/ref/state preserved; duplicate and post-restart saved-result replays add no effects. |
| Two emitted ordered machine edges | `idle -> queued -> ready`, one net row version increment, two ordered history entries at that net version. |
| Wrong model id/missing ref/missing expected version/stale ref | `not_found`, `not_found`, `validation`, `conflict` respectively. Descriptor-owned model identity governs lookup; no caller model tag is trusted. |
| Duplicate successful create/transition/update | Saved result replays with unchanged D1 rows/history/receipts/fence; matching transition/update replay precedes stale-reference checks. |
| Changed raw payload, same operation identity | `conflict`, no effects. |
| Anonymous actor/member lacking owner/other-team member owner gate | Actual live admission returns `forbidden`. Other-team owner-role denial is not a storage-routing wrong-owner proof. |
| Controlled late failure | Actual transition stages, then emitted guard fails `rule_failed`/`forbidden`; domain rows/history remain unchanged and rejected receipt persists. Matching retry and persisted restart replay the same rejection. |
| Held identity after membership revocation | Fresh operation denies from current membership. A previously committed matching receipt still replays; admission denied calls have no receipt and may commit after membership restoration. This is the observed existing posture, not a new policy decision. |
| Managed state bypass | Actual compiler rejects authored direct `set` with E3001; direct CRUD extra managed input refuses closed shape; selected runtime create/set/transition outside canonical scope refuse and alter no state. |
| Read input omission | A separate single read-only production check over the same persisted final DB asserts the exact known Job id/version/title/count/enabled/status/current Account reference and unchanged SQL snapshots (`read-control-results.json`, `read-control-account-validation.json`). The initial weaker array-shape check and harness hash are preserved. An invented `inputs.fields` selector refuses `validation`; generated read descriptors publish no such input. This does not prove source-declared selector/secrecy variants. |
| D1 dispose/reopen | All rows/history/receipts/fence/fence-log match byte-for-byte snapshots; fresh invoker replays successful create/update and rejected late-failure receipts without duplicate versions/history. |

The final run is `runtime-results.json`; `qualification-checks.json` retains every expectation, including failures. SQLite table snapshots, receipt input hashes and outcome snapshots are stored before/after each vector. `logs/cloudflare-final.stdout` is the compact result. Earlier raw failed attempts are preserved in separate directories; they are not overwritten by the supported route.

## Observed failures and representation limit

1. **Public façade import join:** actual unchanged Bounded module imports `create`, `set`, and `deleteRecord`; the frozen public façade exports none. Preload returns `rule_failed` naming missing `create`, with revision 0 and no receipts. See `public-facade-before-failure/runtime-results.json`.
2. **Omitted nullable reference:** metadata correctly declares nullable `account`; actual create fills null, then `pipeline.checkRefs` rejects `Invalid reference in field "account"`. A rejected receipt persists; exact retry replays that rejection. Two failed creation/default checks and the dependent success-replay check remain failures.
3. **Explicit null reference:** `account:null` rejects `Invalid operation inputs` during closed ref admission. No receipt is written. The fourth failing check remains.
4. **Typed arithmetic unavailable on either complete peer surface:** separate complete `NumericControl.can` declares `Job.count:int=1` and `increment(job)->int` returning `job.count+1`. The compiler emits `return int64(job.count + 1n)`. Its actual module cannot preload with Cloudflare runtime stdlib (missing `int64`) or public façade (missing `create`). Both actual D1 attempt receipts remain revision 0. Expected numeric result 2 is **unqualified**; no row, reference, scalar conversion, union shim, or inferred runtime result is invented. See `numeric-control-results.json`.

For the supported Bounded route, descriptor default `count` is wire string `"1"`; the actual returned CRUD result and persisted parsed D1 data also contain a string `"1"`. Title/state are strings, enabled is boolean, and runtime/persisted row version is a number. The emitted `appDefinition` model initializer is JavaScript `1n`. This receipt qualifies those exact observed carriers and scalar default attribution only; **it does not qualify typed integer arithmetic or value validation.** `scenarioParameters` exposes `admitted[field]`/staged `data[field]` directly; only record `version` is explicitly converted with `BigInt`. That source inspection is static evidence, not proof that numeric execution returned 11, threw, or yielded any particular result.

## Remaining owner handoff

Defining Compiler/Contracts/State/Stdlib/Values and Cloudflare owners must release an exact production scalar/default/ref hydration and import-surface contract, resolve nullable reference admission/pipeline agreement, and qualify the real numeric operation. The public façade vs compatibility peer distinction must remain explicit. Values validation ownership/revision association, unsupported duration language-execution metadata versus MCP exposure, full original apps and default contexts remain open.

Wrong owner storage routing remains unqualified: this harness supplies a selected StoragePort; member/owner predicates evaluate the selected identity team, but do not attest deployment selection of a team's storage. Root bounded models lack emitted containment scope metadata and persisted rows show empty owner. `buildModelTableFromCanonical` explicitly sets hooks, invariants and locks to empty arrays; the scenario collector's per-call staging comments rely on that core scope. Full generated hook/locking/invariant integration and their version observations are not accepted by these ordered machine receipts. These authored controls contain no actor/time/trusted context free variables; generated handlers bind their declared parameters and the supplied `c`, and imported guard/effect functions remain real production exports. Broader original app context lowering is not inferred from this fixture.

## Build and replay

Frozen identity, UI and stdlib packages build with installed TypeScript 5.9.3. Cloudflare's selected production module closure builds cleanly through `cloudflare-tsconfig.json`, with normal strict options and `noEmitOnError`; the initial broad build's missing unbuilt dependencies/test packages and an initial too-broad custom include attempt are retained as failed logs. Neither failure is labeled a full package regression or erased. All `@canlang` resolution links stay frozen; only installed external tooling is borrowed from main.

Reproduce the bounded runtime run with a fresh private tag (Miniflare needs loopback permission):

```sh
F1_RUNTIME_MODE=cloudflare-runtime F1_RUN_TAG=new-independent-run node implementation/capability-roadmap-20261008/f1-invocation/run.mjs
node implementation/capability-roadmap-20261008/f1-invocation/numeric-control.mjs
node implementation/capability-roadmap-20261008/f1-invocation/verify-pins.mjs
```

The harness finishes all available vectors while writing `failed_before_repair` when retained acceptance checks fail. Completion of execution is not a green qualification. `pins.json` records frozen source/dist files, compiler/catalog provenance, external packages/tooling, workspace resolution links and all owned evidence. `source-facts.json` records exact owning source excerpts and original task gates. `read-control.mjs` strengthens the projection assertion without rerunning mutations; its receipt and independent reference check preserve the original run untouched. No repair or JEV decision was performed in this slice.
