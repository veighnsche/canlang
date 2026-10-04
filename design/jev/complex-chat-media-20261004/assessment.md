# Chat / Creative / Gallery design and draft evidence

Disposition: **READY for root review; writer released.** All nine `draft/Can{Chat,Creative,Gallery}.{md,can,mjs}` artifacts are authored. This is draft language/application work, with no implemented compiler, standard adapters, runtime, renderer or BDD runner. No provider request or Git mutation was made.

## Decisions and uncertainty

Requests/results 1–3 independently compare normalized typed capability snapshots, a first-class run language and a lossless event log under the same complete workflow. All select `typed_snapshots`, confidence 0.92/0.72/0.91; selected probabilities 0.95/0.81/0.94. The second call's material uncertainty is retained.

Requests/results 4–6 are a new bounded comparison after actual drafts demonstrated duplicated lifecycle plumbing and the user explicitly prioritized primitive discovery. They compare app mirrors, associated delivery progress and a separate run construct. All select `associated_progress`, confidence 0.99/0.98/0.82; selected probabilities 0.99/0.98/0.88. The third retains 0.11 for app mirrors and 0.01 for a separate construct. The first consultation did not evaluate associated progress and is not overwritten. Six request/result pairs are complete; none retries or rephrases a previously rejected payload.

Root accepted the exact standard schema/normalization/reference catalog, JSON graph test recipe, shared gallery component and associated-progress contract. The latter removes eight bridge handlers, two Observation event declarations and copied protocol state while keeping two app callbacks for actual domain work. Ordinary business-handler failures may remain visible/terminal; technical retries and explicit successful same-sequence reconcile re-notification supply recovery. JEV advice does not prove runtime guarantees.

## Verification performed

- `node --check draft/CanChat.mjs` — pass.
- `node --check draft/CanCreative.mjs` — pass.
- `node --check draft/CanGallery.mjs` — pass.
- `node design/jev/complex-chat-media-20261004/check-descriptors.cjs` — pass; saved `descriptor-check.json`. Inspection loads descriptors only, verifies exact source/target inventories, verifies registry functions referenced by operations/handlers/read/invariants/locks/derives, and checks canonical table versus sequence descriptor shapes. No app operation or BDD body is executed.
- `python3 tools/can_parser.py draft/CanChat.can draft/CanCreative.can draft/CanGallery.can` — prototype limitation: delivery type on Chat line 14 and Creative line 12; sequence example on Gallery line 67. This is recorded as failure/unsupported coverage, not a source-compilation pass.
- `python3 tools/can_parser.py design/jev/complex-chat-media-20261004/syntax-projections/CanChat.can design/jev/complex-chat-media-20261004/syntax-projections/CanCreative.can design/jev/complex-chat-media-20261004/syntax-projections/CanGallery.can` — parses all three, **syntax only**. Projections preserve line positions and include per-file `.changes.txt` manifests: delivery association types become text, sequence suites are omitted, gallery becomes list without its image attribute, and poll attributes are omitted. These artifacts are not replacement applications or type-correct executable witnesses.

Manual contract review covered current authority and readable derive dependencies, acyclic composition, mutable-receipt lowering, fixture dependency closure, full typed result overrides, canonical import/fixture scopes, canonical query/UI descriptors, immutable result bindings in sequences, exactly-once domain guards, frozen template/request evidence, graph-wide allowlists and distinction between resource caps and currency.

Final inventory: 14 models, 19 user scenarios, 6 trusted handlers, 11 pages, 33 fixture declarations, 15 example tables/44 rows and 2 multi-operation sequences. Generated CRUD entries are additional registry operations, derived from source CRUD declarations.

## Remaining implementation acceptance obligations

| Boundary | Required proof |
|---|---|
| Manifest correlation | Verified original binding/owner/team, immutable key/digest, pre-ack association and no stale-handle redirection. |
| Cancel and uncertainty | Pre-start cancellation tombstone; targeted cancellation without other-user interruption; success/stop race; unknown remains recoverable without a replacement job. |
| Progress durability | Monotone matching snapshots, immutable terminal content/outputs, nonterminal usage null, one later bounded usage settlement, atomic current snapshot and durable notification through restart. |
| Domain recovery | Failure rolls back all business effects while current provider evidence stays visible; successful explicit reconcile re-notifies the same sequence and completes once after repair. |
| Authority | Current membership/conversation/collection and exact field grants on page reads, partial text, thumbnail, original file and receipts; delayed removal after rejoin cannot cancel newly authorized work. |
| Files and graphs | Finalized receiving-app PNG/JPEG provenance; interrupted transfers; invalid/foreign/raw URL refusal; graph-wide node/input/model/resource allowlist, mapping/digest consistency and JSON fixture bytes. |
| Resource caps | Serialized admission and enforced token/job/dimension/duration bounds; unknown and terminal-with-null-usage holds remain; unsupported enforcement rejects visibly. |
| Generated UI/examples | Shared gallery accessibility/current grants; polling without resubmission; compiler/type checker and genuine isolated example runner execute the written cases. |

No unresolved design approval blocks this handoff. Earlier C1 fanout is still unadopted/blocked and C5 Mail work remains paused; neither is silently completed by this work.

## Independent focused review (2026-10-04)

Reviewed the actual three source/target pairs and the accepted associated-progress contract for caller/file authority, current collection disclosure, terminal execution versus delayed usage settlement, original receipt correlation, and fixture/sequence validity. Replaced JavaScript `.trim()` in all three targets with the canonical `trim` helper (pinned Unicode White_Space); changed Gallery's two nullable decision assertion type IDs to `gallery.Submission.decision?`. Source behavior and grants were not broadened.

After these repairs, all three `node --check` commands and the existing descriptor inventory/reference check pass. These are syntax/structural checks, not operation execution. Existing source order descriptors, admission gates, frozen invocation inputs, bounded cancellation scans, and locator-based mutable progress observations align with the inspected source. Gallery deliberately attaches only the authorized selected image to a separately governed submission; author access is independent of collection audience access. The sequential approved read/revoke/withdraw example uses genuine canonical reads and fresh fixture references, rather than treating inspection as privacy proof.

The seeded progressed examples establish desired domain reactions to normalized snapshots, including terminal unknown usage and later settlement. They do not simulate provider ordering, cancellation races, restart, receiving-file finalization or shared notification durability. Those remain the explicit runtime obligations above. The coordinator resolved the source authority gap with an explicit app publication policy: a published Revision grants members its complete `definition`, including the finalized graph, only while its parent Template is active. The publish caption names that disclosure; draft graphs remain manager-only. The desired target and requirements match. Canonical send retains the ordinary file source check. Existing self-owned graph fixtures remain valid but do not prove a manager-owned production upload path. A naive `owner=manager` replacement would fail initial self-principal fixture attachment admission before invocation; this review does not count invalid setup as file-authority evidence.
