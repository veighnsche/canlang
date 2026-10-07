# Control flow, lifecycle and concurrency audit

Planning-only source checkpoint: `fecf84196e38679646d221ee18aa4383ed0d0e83`.
Implementation remains deferred. The audit records **93 resource families,
119 invariant statements and 140 failure-scenario groups** across all 13 package
owners. Counts include safeguards, conditional/unjoined paths and tooling;
they are **not counts of production bugs**. Three Sol high reviewers challenged
15 selected cases independently with prior conclusions visible.

The [owner inventory](inventory.md) and searchable [catalog](resources.jsonl)
record lifecycle, cleanup responsibility, restart rule, required invariants,
minimal failure scenarios, stage, sources and limits for each family. The
[395-file crosswalk](file-coverage.tsv) and [316-duty crosswalk](duty-coverage.tsv)
retain the earlier caller inventory, refreshed to this pin. Lexical signals in
142 files are review prompts, not proof of ownership or exhaustive behavior.
Contextual owner-family links do not prove every inherited duty is implemented.

## Material scenarios and their limits

| Area / references | Required invariant and source-derived failure | Scope / strongest counterevidence |
| --- | --- | --- |
| Fanout stale recovery: LSW-18 / GAP-L01 | Release scans must eventually reach every frozen child. A terminal first row and later stale running row at pageLimit 1 recur indefinitely when each turn starts release at null and drops its continuation. | Helper accepts/returns honest cursor; separate full release sweep fixes coverage. This is the scheduler caller composition, not every release helper or live claim. |
| Fresh fanout facts: LSW-16 / GAP-L03 | Each re-admission must execute with its admitted current facts. Driver retains old domainRow while fresh invoke admits an unversioned ref, and callback discards admitted call. Read-derived effect can use old facts. | A write using stale expectedVersion would be blocked; successful witness avoids such a write. Existing fresh admission/global fence remain valid for enrolled facts. |
| Checkpoint and authority: LSW-04/17 | Each checkpoint must match its own child outcome, not borrow another checkpoint's terminal outcome. Authority revocation racing an already-fenced commit remains explicitly unresolved. | Existing transaction rollback/fence/re-admission controls are retained. Known SW-041 converse gap and already-fenced policy are not newly accepted design choices. |
| Credential consumption: LI03/04/06/09/12 | Conditional consume must return an actual winner before minting effects; interrupted password/session/grant cascade must recover. Two readers can proceed after void conditional delete/update; crash after password write leaves later revocations unfinished. | Current D1 statement-level source, not proven cross-store exploit. Interim OAuth HTTP adapter is unmounted; valid43 exchange race differs from prior invalid44 challenge witness. |
| Upload/finalization: LF01/02/03; LR04 | Actual blob length, declared/count metadata and final file identity must agree through crashes/retries. Independently persisted append survives count write loss, direct retry duplicates bytes; finalize has several partial-write windows. Client retry can mint new file IDs under old operation. | Count drift requires detached persistent intent + separately persistent blob; memory alias cannot prove it. Provider-output resume checks exact length/prefix and refuses drift. Actual durable pair/mounted consumer remains an original join. |
| Browser response/cancel: LR01/06/07 | Re-prove current context/logout/alive/visibility after body await before delivery. Context change during body read can beat next tick; SubmitFetch adapter abort rejects result without signal to physical request. | Tick/stop/sequence supersession works; body window requires no intervening stop/tick. Actual rendering requires delivery hook. Export guards logical late acceptance; remote effects are not undone. |
| Browser leases/once: LR02/03 | Acquisition rollback and teardown must release every owned listener/binder despite hook failure; every accepted once action needs a settled producer. | Only fixed core selectors are bound. Initial failure can be recovered by retrieving client and stopping; swap-release throw after stopped=true blocks later cleanup. No settled producer found, no mounted incident claimed. |
| Readers/SDK: LR08/12; SV02 | Acquire/use/finally release on failures, and qualify genuinely stalled reads/handlers under real host. Byte cap or per-frame timer alone is not whole-call liveness. | HTTP stream early return owns cancel/release; Ollama run consumes/closes its iterator. Local pinned SDK cleans settled correlations/controllers. Per-request cycles are collectable; no ordinary persistent MCP leak asserted. |
| Prepared owners: LR16/17/18 | Failed private plan construction must not publish/retain inaccessible partial defaults. Native owners/retired handles need actual joint bounds and release; startup failure must not return accepted backend. | Private provenance hook prerequisite; public normalizeSchema alone refuses first. Successful default refs surviving retirement are deliberate N3; owner/profile scaffolds are not adopted business authority. |
| Scratch/process/publication: CF01/04/05/06/07 | Cleanup protects acquisition before writes, child/session/reader lifetime and asynchronous callback; run/test root ownership differs. | Bun entry write precedes try; test scratch lacks root removal. Returned run URL may intentionally retain root. Native frame/whole-job/close/grace/publication gaps are held, not authorization to resume them. |
| Partial effects/remote truth: CF02/03/08; SV04..09; LSW-08 | Failure/nonzero exit must retain uncertain remote/partial outcome and durable provider identity; qualification must cover actual installed checkpoint/release. | Wrangler failing status alone cannot prove no deployment. Mail/model/media cancellation is local/targeted and scoped, not rollback. Existing HTTP H01/H02 controls remain credited. |
| Cache/byte exposure: LR09/13/19/25/27 | Owned pinned bytes and immutable artifact+assembly profile must remain valid; raw-key domain determines cache bound. | Asset input bytes copied, but get exposes mutable owned buffer. Artifact mutation/different assembly violates assumed immutable profile; no deployed stale cache proved. Decimal power memo is bounded and should stay simple. |
| Test scope: LR21/22/26 | Every successfully acquired row scope disposes on unexpected comparison failure while preserving first error. | Normal caught setup/invoke/snapshot errors do reach disposal. Getter/cycle witness is outside intended JSON-safe plain report profile; cleanup on unexpected errors still needed. Fakes do not prove durable restart. |
| Absent/durable owners: LSW-13/14/20/22; SV12; LR10/11/14/23 | Real notifications, jobs/status/expiry, shared files, quotas, selected provider and installed upgrade consumers need actual lifecycle owners. | Port declarations, symbolic observers, one bounded page or helper tests do not close workflows. No new generic resource manager or unrelated provider implementation is selected. |

## Ordering and repair preparation

State/SQL batch rollback, dense fences and exact operation replay are existing
controls. Identity mutations are often separate statements; file blob/intent
operations are separate phases. Those cannot inherit transaction guarantees from
an adjacent package. Unknown provider/command outcome must remain unknown until
its actual owner reconciles it. First business failure/rejection and unexpected
host bug have different receipt/retry behavior; neither permits blanket replay.

The [12-group proposed queue](fix-queue.json) releases each seam independently,
then fixes fanout facts/cursors, credential consumption/cascades, durable files
and browser progress, total cleanup, prepared ownership and host lifecycle.
File-disjoint repairs can proceed in parallel after their own inputs release;
held native work and unrelated adapter families are not a blanket dependency.
[Proposed constraints](proposed-decisions.md) protect original requirements and
avoid adding more generic adapters. Every repair requires its own actual supported
consumer/negative/crash gate; this audit executes none of them.

## Evidence and limitations

[Source manifest](sources.json) pins repository inputs plus a separate exact local
installed SDK copy. [SDK evidence](sdk-evidence.json) explains normal cleanup and
unsettled-handler limits. [Review index](reviews.json) links independent source
challenges; their corrections are reflected in the normalized catalog and table.
[Scope](scope.json) and [static verification](verification.json) distinguish source
checks from product acceptance. Run `python3` on the local `verify.py` to reproduce
metadata, source hash, anchor, crosswalk and link checks; it imports/runs no Can
package or SDK.

No product source, dependency, build, test, runtime, installation, Wasm instance,
network, CI, schedule, Muse session, compiler, canonical task acceptance or living
filetree checkpoint changed. No new product mechanism/security policy was selected.
Existing narrow accepted asset/backend/control receipts remain narrow; original
T08/T26, durable/authority/notification/app and installed consumer duties close only
through their own evidence. Preparation holds and TS backend retirement gates stay
intact. This is source-derived planning evidence, not proof of deployed incidents
or exhaustive correctness of every possible host/resource interaction.
