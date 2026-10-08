# Independent verified context repair review

**Accepted for the bounded canonical source projection and memory retry slice. No technical blocker remains.** This does not complete Task 9, Task 10, SEQ-009, SEQ-010, F1 or the full-app gate.

The reviewer is different from the candidate author. I inspected AGENTS, the API/write lease and contract review, the immutable BEFORE source/artifact/raw observations, the three-file candidate diff, source/tests, frozen AFTER observations and retry receipts, and selected source/output compatibility records. I made no product, frozen snapshot, shared dist/dependency, Git or shared-document changes.

## Exact scope and integration gate

The only candidate product changes remain `packages/cloudflare/src/runtime/context.ts`, the context-construction slice of `packages/cloudflare/src/runtime/invoke.ts`, and `packages/cloudflare/src/runtime/verified-context.test.ts`. Their final live/private hashes match the released hashes:

- context: `6c79953696b9b5a2332d4291bfc70aee45d09b959bfa98dac609ee8f9b496450`
- invoke: `48f4c79ab213f0fe95b4e8e3b01dd643793ed1a345d075f27aef214101d0bbe5`
- test: `65cf5be12155008a41ec091d0057a01288c3e9eed7935a15972e7cd60f51fb11`

The coordinator relayed the package owner's explicit amendment ACK for this exact `src/runtime/verified-context.test.ts` placement and hash. The inconsistent earlier `test/` spelling is superseded for this single test; the original frozen lease and evidence remain untouched. Current rootDir/include and existing runtime node:test placement agree with the amended path. That path gate is resolved, subject to preserving these reviewed bytes during integration.

## Contract and authority

Optional `CreateContextDeps.qualified?: InvocationContext` installs only the acknowledged facts. Actor maps the admitted principal id through the public owning `makeUserRef`; null stays null. `now` maps admitted integer milliseconds through public `makeDatetime(BigInt(...))`. Team and operation copy/freeze their exact scalar fields, with operation id derived from the envelope UUIDv7 rather than operation name. The added fields are readonly in the interface; compound values are frozen copies. The outer context and supplied internal carrier are not newly frozen. Neither structural shape nor caller labels become authentication.

Absent `qualified` retains exact existing own keys, caller identity, memberships/preferences defaults and the lazy/supplied clock. Constructor tests meaningfully cover misleading caller labels, mutation of the original carrier, null preservation, owning error order, no construction-time clock sample, and omission of fabricated fields.

Only canonical `runScenarioSeam` passes `call.context`; State's host clock sample occurs before its retry loop. The seam captures that admitted time for `c.clock`, and `c.now` uses the same value. Identity resolution, current membership checks, closed input validation, effect staging and receipt policy are unchanged. The actual credential resolver and storage owner implementations are used; no synthetic combined peer, patched handler, shape-authentication shortcut or manufactured conflict is present.

Receipt lookup remains before age and current membership, as required by the existing State contract. Independently, new calls using either a held identity or newly resolved identity deny after membership removal with identical records/effects/receipts/revision; an existing matching successful receipt still replays after removal with no effects. This preserves receipt-first semantics and does not qualify a broader view-replay authorization policy.

## Independent verification

All **263 targeted pin comparisons** passed: immutable BEFORE/AFTER file manifests; live/private three-file candidates and exact preimages; 22 selected output entries/realpaths; the 10-file relative Cloudflare closure and 15 named State/Identity/Contracts/Values source entries; all 65 redirected own-package links; executable Node 24.21.0. The scope remains bounded, including the four accepted nullable State source bytes, rather than claiming an arbitrary whole-current dependency graph.

I independently ran the maintained constructor suite: **6/6**. My separate harness assembled the unchanged actual compiler artifact into reviewer-owned directories and executed the public production assembler/invoker. **8 BEFORE observations and 20 AFTER observations passed 35 assertions.** BEFORE reproduces all six missing ambient reads and the incorrect false anonymous-null branch. AFTER observes exact actor/team/timezone/operation id/source and millisecond equality, false `.124Z` mismatch, true public null, exact scalar replay and owning datetime rejection/replay. Anonymous/wrong-team/spoof/current-revocation denials compare complete selected snapshots, including absent receipts, rather than just revisions.

A distinct actual canonical commit forced a real memory storage fence conflict: expected revision 10, actual 11. Two target handler-result commit attempts both observe true and receipt time `1791454830123`; the second succeeds at revision 12. The advancing host clock is sampled once. Exactly one final target receipt and one competitor receipt exist. This observes genuine retry through the owning State implementation.

A further **21 raw audit checks** passed, independently checking author's exact admitted values, complete denial snapshots, real error identity/revisions/results/time and receipt cardinality; both reviewer assemblies retain byte-identical compiled handler bodies after reversing only producer URL substitution and the trailing source-map comment. Final live/private candidate and frozen manifest hashes remain unchanged. Author build/typecheck evidence was inspected; I did not repeat a compiler rebuild or blanket dependency-graph run.

Raw independent harness, TAP, pin comparisons, runtime envelopes/outcomes/snapshots, audit and receipt manifest are in [verified-context-repair-review-receipts](./verified-context-repair-review-receipts/). The JSON review records exact frozen packet hashes and released private assembly handles.

## Retained limits and release

The positive claim is scalar source reads, exact bool/time comparisons, memory admission/refusal/replay and retry stability. There is no new D1/reopen/crash or installed/deployed identity qualification. Full actor `email/email_verified`, generic UserRef changes, null-team applicability, trusted occurrences, hooks/pages/locale, contextual defaults, tagged datetime/user persistence/results/hydration, typed integer arithmetic, whole-current graph and all-host/WASM eager Values initialization remain open. Existing exact void replay `undefined` versus `null` remains a separate failure.

All reviewer commands and source reads are released; there are no pending processes, servers or writer handles. Root/package owners retain integration and shared decision/filetree ownership. The bounded acknowledged projection introduces no consequential unresolved design alternative requiring JEV.
