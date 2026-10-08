# Narrow verified context repair — candidate frozen for independent review

Only the acknowledged three product paths changed: `packages/cloudflare/src/runtime/context.ts`, the `runScenarioSeam` context-construction slice of `packages/cloudflare/src/runtime/invoke.ts`, and new `packages/cloudflare/src/runtime/verified-context.test.ts`. The leased preimages were checked immediately before writing: context `497e1bbc7cbecd984e2ea7119cd1f4913688b2044158eaaaa0a74f3af0fbb98b`, invoke `6b135086c8d0c904008f2100ed0930fd8ebfed60769e73efc8944bed45f50997`; new test absent. Root obtained the package owner's explicit API ACK for optional `CreateContextDeps.qualified?:InvocationContext` before authoring.

The constructor now installs readonly optional `actor/team/now/operation` source fields **only when qualified admitted facts are explicitly provided**. Existing owning `makeUserRef` and `makeDatetime` provide canonical user/datetime values; team `id/timezone` and operation `id/source` are copied/frozen. The actor is derived from the admitted principal, not caller labels, membership strings or attribution. Null actor/team remain null. No generic UserRef extension, account directory, full actor auth-fact mapping or global null-team policy was introduced.

The canonical scenario seam supplies `qualified:call.context` and captures its admitted numeric `now` once for `clock:()=>admittedNow`. It retains the existing caller/canonical effect scope and changes no admission, descriptor, staging, default, result or stored-value policy. Unqualified construction retains its exact existing keys and lazy/supplied clock behavior. An internal constructor input is not authentication; production resolver/admission remains the source of authority.

## Author verification

The immutable BEFORE packet remains at `../verified-context-execution-before`; its manifest hash is `5ebc87bb3823dd4b5846692a5a7a38d52484fc89a1e75efc7817a6313796c9b1`. Its **unchanged actual compiler artifact**, hash `161da074987f6af7c96212cb240507ac18f8a725687049eaa1333e0bd85f1f20`, was copied byte-for-byte and executed after repair. No handler body, context shim, clock wire-string substitution or test split facade was used.

Private selected TypeScript build and no-emit typecheck pass. New maintained constructor suite is **6/6**: exact unqualified own-key shape/supplied clock evaluation; lazy default clock; owning canonical value/admitted identity projection; copied/frozen facts; genuine null actor/team; owning error identity/order and no clock sampling. Raw TAP and commands are retained. These unit contexts are fixtures, not an authority proof; the separate actual compiled-source integration supplies that evidence.

The private `/private/tmp/canlang-verified-context-after-153de375-7d80-4724-845c-cafcb9669969` snapshot copies the compatible frozen nullable-after foundation and overlays only exact current context/invoke/new test plus already accepted pure stdlib source. All 65 own-package links were redirected into the new copy. Only selected Cloudflare source/output was emitted there. No existing snapshot, main dist/dependency, compiler/build target or unrelated product source was changed.

Source compatibility is deliberately bounded: the **10-file relative Cloudflare source closure** matches the foundation except the exact two repair sources and accepted pure stdlib overlay; the **four current nullable State source bytes** match the foundation. Fifteen separately named consumed State/Identity/contracts/Values constructor source entries also match. `support-compatibility.json` and `other-selected-source-compatibility.json` record exact hashes. Other copied historical bodies are not relabeled an arbitrary whole-current graph. Private source/output, runtime relay/function identity, tool resolution, and current source hashes are pinned separately.

Actual production `assembleModules`/`buildInvoker` executes the unchanged current-CLI fixture through real session credential resolution/current membership admission and canonical State over the actual test memory StoragePort. Author after results are **17 observations / 18 passing assertions**:

| Actual source/control | After result |
| --- | --- |
| `actor.id` | Exact resolved authenticated member id |
| `team.id`, `team.timezone` | Exact selected team id and `Europe/Brussels` |
| `operation.id`, `operation.source` | Exact envelope UUIDv7 and `mcp`, not operation name |
| `now==datetime(stamp)` | `true` for `2026-10-08T10:20:30.123Z`; `false` for `.124Z` |
| Caller-text datetime baseline | Remains `true` through the actual Values relay |
| Public anonymous `actor==null` | `true`, correcting BEFORE's committed `false` |
| Exact successful actor scalar replay | Same string, `replayed`, unchanged selected snapshot |
| Anonymous member / wrong selected team / removed membership | `forbidden`, no receipt/revision change |
| Forged ambient fields as business inputs | Closed-input `validation`, no receipt/revision change |
| Malformed caller datetime text | Actual constructor `rule_failed: invalid datetime text: malformed` |

## Real retry observation

The retry control observes the existing StoragePort boundary; it does not replace the emitted handler or manufacture a conflict. At the first pending `nowEquals` commit, a **distinct actual canonical datetimeBaseline operation** commits against the same actual memory store and moves its fence from 10 to 11. The pending commit then raises the real storage owner's `FenceConflictError: expected revision 10, actual 11`. State catches it and re-admits/re-executes the unchanged scenario.

Both actual handler-result commit attempts record `result:true` and receipt `createdAt:1791454830123`; expected revisions are 10 then 11, and the second commit returns revision 12. The injected advancing host clock records **one sample**, `1791454830123`, despite two observed attempts. Only one receipt for the retried operation exists, alongside the distinct competitor receipt; selected revision moves 10→12. `retry-control.json` preserves attempts, actual error identity/message, host samples, competitor and retried raw snapshots/outcomes.

The initial after harness imported `FenceConflictError` from `storage/schema.js` rather than its real owner `storage/port.js`. Its `instanceof undefined` masking error prevented the intended retry observation. The complete initial harness/results/checks/retry record/logs are preserved in `initial-after-harness/`. Correcting **only that observer import** produced the fresh final 18/18 run; no product source or check was weakened, and constructor/build tests were not needlessly rerun. The earlier BEFORE snapshot-query typo is independently preserved in its frozen packet.

Exact runtime executable is `/Users/vince/.vite-plus/js_runtime/node/24.21.0/bin/node`, version **v24.21.0**, SHA-256 `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`; both prepare/after records retain process argv/execPath/hash. Build commands are bounded to 60 seconds and all completed. The original approved compiler/source/catalog pins remain attached to the immutable BEFORE artifact; no compiler rerun/rebuild occurred after the repair.

## Limits and release

This is author evidence for the selected canonical source-read projection, clock/retry and scalar receipt behavior, **pending different-author independent review**. It does not close Task 10, SEQ-010, Task 9 or F1. Only scalar text/timezone/bool observations cross receipts; no tagged datetime/user persistence, defaults, schema/provenance mapper or hydration is accepted. Full actor `email/email_verified` admission facts remain accepted but unqualified by this id-only projection. Direct/unqualified contexts, null-team applicability, trusted occurrences, hooks, pages/locale, installed identity/provider, deployed owner routing and whole-original-app gates remain separate.

Runtime storage here is **memory only**: no D1 listener/reopen, external process restart or crash/durable acceptance is claimed. Eager Values import initialization is acknowledged, and actual Node preload succeeds in this selected graph; no whole-host/backend/WASM initialization equivalence follows. Root may commission a separate narrow durable review if needed for a specific claim.

Source writer and all author build/test/runtime commands are **released and frozen**. `candidate.diff`, source-before/after and private-output pins preserve the exact three-file candidate. Root/package coordinator own Git integration and shared DECISIONS/filetree maintenance; neither was changed. No JEV call was needed to observe or repair this settled bounded binding mismatch. Further candidate writes or runs require an explicit review-driven follow-up.
