# Chat, creative work and approved collections

Status: app writer released by root on 2026-10-04: these new triplets had no active Muse reservation, M02 released writers and the user transferred ownership to Codex. The acyclic composition is accepted. Root accepted the exact standard schemas, normalization and JavaScript references below as draft contracts and is integrating them into shared DESIGN. All three complete triplets are authored and independently reviewed; this writer is released. Requirements/source/desired-JS destinations are `draft/CanChat.{md,can,mjs}`, `draft/CanCreative.{md,can,mjs}` and `draft/CanGallery.{md,can,mjs}`. No compiler, adapter, renderer or example runner implementation is claimed.

## Minimal shared decision for root

Use existing typed capabilities, `send`, associated deliveries, verified capability events, owner transactions and `page poll=1s`. Add standard typed **generation contracts**, not a second effect or a schedule-cancellation interpretation. The shared adapter owns NDJSON/WebSocket decoding, coalescing, durable request correlation, provider recovery, independent cancellation and file finalization. Apps retain admission/accounting records and derive current views from associated progress, never token journals, transport URLs, browser credentials or provider polling loops.

1. `TextGenerationV1`: `generate(value:TextRequest)->TextRun`, `cancel(source:text,revision:int)->TextRun`, `reconcile(source:text,revision:int)->TextRun`, `changed {value:TextRun}`. Generate delivery success means a valid durable run observation, not necessarily successful generation. Every returned/event snapshot belongs to the same durable adapter run and has a positive monotone sequence. A terminal snapshot is immutable; an unknown run may later resolve. Repeated identical logical requests recover that run; changed input under the same source/revision fails. Independent operations retain their own delivery identities.
2. `ImagesV1`: `inspect(graph:file)->WorkflowInspection`, `validate(value:WorkflowDefinition)->WorkflowValidation`, `submit(value:ImageRequest)->ImageRun`, `cancel`/`reconcile`/`changed` with the same run rules. Inspection/validation cannot queue generation. A provider unable to inspect safely returns a typed failure. Validation freezes graph identity/digest, allowed destination mapping and binding compatibility; publishing does not promise a node/model will remain installed later.
3. A run carries `source`, `revision`, `sequence`, `state=queued|running|succeeded|failed|unknown|cancelled`, safe `detail?`, immutable profile/template evidence, cumulative content or finalized outputs, and settlement evidence. It must never expose model reasoning. `failed` or `cancelled` business state is provider evidence about this run, not an interpretation of a failed delivery. Uncertainty remains visible until reconciled.
4. These drafts cap resource spending: text tokens and image jobs/dimensions. Admission reserves the declared maximum atomically; authoritative terminal usage settles once, and unknown usage retains the reservation. A cancel request or transport failure releases nothing. Bindings must enforce their declared input/output token, job, output-count, dimension and execution-duration bounds or reject before starting. These are not dollar ceilings. An externally billed deployment needing a hard monetary limit must provide a separate enforceable pricing/cap contract; this draft does not invent one.
5. `application/json` workflow uploads need an explicit ordinary `files` policy allowance. The graph remains a finalized Can file. Typed mappings use closed fields `prompt`, `negative`, `width`, `height`, and destinations `{node:text,key:text}`. No arbitrary template string evaluation, raw JS, arbitrary path syntax or `use ... with` grammar is needed.
6. Current `page poll` supplies bounded incremental presentation, reconnect and revocation checks; it promises current retained text, not every token or resumption of a provider stream. Reuse standard list/card/text/file/form/action components. A specialized chat renderer is optional styling, not needed semantics.

Exact schema names, adapter normalization and §13 target imports below are accepted draft contracts. Do not substitute hypothetical builtins for ordinary named derives. Schema field constraints, graph limits, transcript/output caps and budget ceilings are explicit app/adapter policy, not claims about provider defaults.

## Provider facts checked 2026-10-04

Ollama chat streams newline-delimited JSON by default and exposes completion and usage fields. A later stream error can follow an HTTP success response. Buffer cumulative displayable content and only label it complete from valid terminal evidence. [Chat](https://docs.ollama.com/api/chat), [streaming](https://docs.ollama.com/api/streaming), [errors](https://docs.ollama.com/api/errors).

The official JS client's `abort()` affects the streams on that client; independent cancellation needs separate instances or equivalent isolation. The documented API does not provide a durable token-resume facility. Closing the viewer must not be treated as confirmed inference cancellation. [Official Ollama client](https://github.com/ollama/ollama-js#abort).

Native ComfyUI `/prompt` validates **and enqueues**. `/object_info`, `/history`, `/queue`, `/ws` and `/view` supply metadata/observations/assets, but the generic `/interrupt` route is unsuitable as an unqualified multiuser cancel. A binding must validate its deployed targeted-cancel behavior or isolate workers. [Server routes](https://docs.comfy.org/development/comfyui-server/comms_routes). `executed` describes UI output; use actual workflow terminal evidence and transfer all declared files before success. [Messages](https://docs.comfy.org/development/comfyui-server/comms_messages).

Workers provide native Streams APIs. A disconnected HTTP request and `waitUntil` are insufficient run durability: post-disconnect work is limited, and runtime updates also impose shutdown grace. A durable adapter controller must persist correlation/observations separately from the browser request. [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/), [limits](https://developers.cloudflare.com/workers/platform/limits/).

## Ownership and composition

`CanChat` owns package `chat`. `CanCreative` imports chat's explicit readable conversation/turn and authority contracts, owns package `creative` and composes `[chat,creative]`. `CanGallery` imports finalized creative outputs, owns package `gallery` and composes `[chat,creative,gallery]`. Creative supplies the conversation-context generation page; Chat has no reverse Creative import. Gallery review gives access only to submitted image/evidence, never private conversation history. No cycle, copied application identity or inferred cross-owner authority.

All business writes occur in a selected composed deployment's ordinary owner transaction. Cross-owner/cross-deployment tools remain capability sends with their existing authority contract; the draft must not silently invoke imported implementation functions to get privileged writes.

## Frozen business evidence and state transitions

Chat admissions freeze an ordered readable branch prefix, prompt, finalized readable attachments, model/policy revision, output limit and spend reservation. Append-only turns have stable ordinal positions. Regenerate creates an explicit new branch from a completed authorized prefix; editing old messages does not rewrite running input. One current pending run per branch and a declared transcript bound avoid hidden truncation. The associated delivery retains cumulative partial text; the app derives that display separately from completed assistant turns. A returned run may settle after the current selected branch changes, but only its own branch receives its final turn. Revoke disables reads/current dispatch and requests independent cancellation; it cannot assert a remote stop or erase resource-accounting uncertainty.

Creative templates have editable drafts and immutable published revisions. Publication explicitly shares the immutable revision definition and finalized graph with current members while its Template is active; the draft Template graph stays manager-only. Ordinary generation therefore sends an already-readable published attachment, without an owner-authority file bypass. Company configurators select typed node/key mappings for prompt/negative/width/height from inspection results, validate, then publish the exact graph and mappings. Editing/publishing a newer revision affects only later runs. Inputs are frozen with selected revision and dimensions; substitutions are confined to those destinations. Missing nodes/models, incompatible types, unauthorized graph files and unsupported resource limits fail visibly. Unknown submission does not authorize a fresh job. Manual reconcile/cancel targets the retained identity, with receipt feedback separate from business state.

Every finalized image output is unique by run and position. An output is available only after the receiving app has finalized its bytes and provenance. Partial failure may retain finalized outputs as private recovery evidence, but does not silently approve a batch or publish a collection. Gallery submissions freeze selected output, creator statement and license/consent evidence. Reviewers receive only that material. Approval creates an immutable decision; later removal stops collection exposure without rewriting the review. Shared collections show only current approved entries and enforce membership/revocation for original file downloads too.

## Required meaningful examples

| Journey | Success | Boundary/failure/recovery |
|---|---|---|
| Private chat | Owner submits, partial sequence arrives, final reply creates one assistant turn and settles reservation once. | Other account/removed member denied; stale or duplicate sequence ignored; changed identity payload rejected; failed stream retains partial label and reservation until authoritative usage settles. |
| Reconnect/stop | Reopen sees same retained run; targeted stop receives confirmed cancelled state. | Closing browser causes no send; stop receipt pending/failed/unknown differs from run state; completion racing stop remains completed; another run unaffected. |
| Branch | Regenerate from chosen completed prefix creates separate branch. | Cannot fork arbitrary hidden turn, exceed transcript bound, edit frozen input or append a second active run; late first branch result cannot overwrite second. |
| Budget | Two transactions serialize reservation checks; final usage releases unused hold once. | Exactly-at-cap succeeds; over-cap admits no send; unknown holds all reserved amount; cancelled without usage evidence retains its resource reservation. |
| Template | Inspect, map, validate and publish revision; generate with exact revision. | Wrong node/key/type, invalid JSON, unavailable required model and unauthorized edit rejected; old run retains old graph after new publication. |
| Images | Submit yields queued state; completion finalizes declared outputs and exposes private preview. | Submission lost after acceptance becomes unknown; reconcile reuses identity; duplicate/out-of-order events cannot duplicate outputs; forged URL is not a file. |
| Review/share | Creator submits a finalized image; reviewer approves; authorized collection member downloads it. | Partial/unapproved output excluded; reviewer cannot read chat; creator cannot approve own submission; revoke membership blocks page and bytes; withdrawn approval hides entry. |

## Consultation and release

All three independently rewritten requests completed. JEV 1.13.0 selected `typed_snapshots` at confidence 0.92/0.72/0.91, probabilities 0.95/0.81/0.94; first-class-run probabilities were 0.04/0.17/0.06, event-log 0.01/0.02/0.00. The lower-confidence second result is retained; agreement does not establish implementation or prove correctness. This supports ordinary typed adapter snapshots plus existing authorized UI polling. Exact files: `../jev/complex-chat-media-20261004/{1,2,3}.{request,result}.json`. None reuses or retries the rejected C1/owner-fanout payload.

## Standard schemas and adapter normalization

The accepted draft standard catalog is below. Bounds in request values are enforced, never silent truncation. Operation result snapshots and verified events use the same normalization. Interface versions are pinned, not provider discovery. The standard declarations below specify desired catalog types; no new grammar production is needed.

```can
export contract TextMessage {role:enum(system,user,assistant),content:text max=65536,attachments:file[] max=8}
export contract TextRequest {source:text,revision:int min=1,profile:text,policy_revision:text,messages:TextMessage[]! min=1 max=128,max_input_tokens:int min=1,max_output_tokens:int min=1,max_duration:duration}
export contract TextRun {source:text,revision:int min=1,sequence:int min=1,state:enum(queued,running,succeeded,failed,unknown,cancelled),content:text max=65536,used_tokens:int? min=0,detail:text?}
export capability TextGenerationV1 version=1
 generate(value:TextRequest) -> TextRun
 cancel(source:text,revision:int) -> TextRun
 reconcile(source:text,revision:int) -> TextRun
 event changed {value:TextRun}
export contract WorkflowInput {node:text,key:text}
export contract WorkflowField {node:text,key:text,kind:enum(text,int),label:text}
export contract WorkflowInspection {fields:WorkflowField[]! max=256,detail:text?}
export contract WorkflowDefinition {graph:file,prompt:WorkflowInput,negative:WorkflowInput,width:WorkflowInput,height:WorkflowInput}
export contract WorkflowValidation {valid:bool,digest:text?,detail:text?}
export contract ImageRequest {source:text,revision:int min=1,workflow:WorkflowDefinition,validation:text,prompt:text max=8192,negative:text max=8192,width:int min=256 max=1536,height:int min=256 max=1536,max_outputs:int min=1 max=4,max_duration:duration}
export contract GeneratedImage {position:int min=0 max=3,image:file}
export contract ImageRun {source:text,revision:int min=1,sequence:int min=1,state:TextRun.state,outputs:GeneratedImage[]! max=4,charged_jobs:int? min=0 max=1,detail:text?}
export capability ImagesV1 version=1
 inspect(graph:file) -> WorkflowInspection
 validate(value:WorkflowDefinition) -> WorkflowValidation
 submit(value:ImageRequest) -> ImageRun
 cancel(source:text,revision:int) -> ImageRun
 reconcile(source:text,revision:int) -> ImageRun
 event changed {value:ImageRun}
```

`TextRun.used_tokens` is the authoritative total input plus generated output token usage, at most the frozen sum of limits. Queued/running/unknown execution snapshots require null usage; only a terminal execution may carry final usage. Null means unsettled, including a terminal execution whose resource measurement is unresolved. `ImageRun.charged_jobs` is 0 only when the binding proves no execution charge and 1 for the single admitted job; null retains one held job. Queued/running/unknown snapshots likewise require null `charged_jobs`. These are app resource allocations, not currency or provider invoices.

Adapter state has a monotone `sequence` per `(binding,source,revision)` and a frozen originating request/delivery digest. An event is authenticated and routes only to its originating owner/team. Duplicate sequence and body must match; conflicting duplicates are rejected by the binding. Queued/running/unknown may advance or resolve; succeeded/failed/cancelled execution fields are terminal and immutable. Settlement may change null to one authoritative bounded value at a later sequence, including after terminal execution. Final content/output identities cannot subsequently change. Partial content remains visibly partial after failed/cancelled/unknown. The shared associated-progress layer validates sequence/identity and retains the current snapshot; apps settle business resources once from that snapshot. Same-sequence operation-result/event arrivals are harmless duplicates. Run identity is never supplied by model-authored output.

Cancel is idempotent for a run, retained even when it arrives before submission, and reports current evidence. It does not mint another generation. A confirmed terminal success racing cancel stays success. If targeted cancellation is unsupported/uncertain, preserve state and safe diagnostic; never call a global provider interrupt against other users. Reconcile observes this identity without starting a replacement. Browser reconnect performs only ordinary authorized page reads. Outbox guards can skip undispatched work; the resulting authoritative skipped generation receipt proves no dispatch and may settle its reserved resource to zero through an explicit app recovery operation.

For images, output positions are stable and unique across cumulative snapshots; the adapter never remaps a position to different bytes. It transfers supported PNG/JPEG image bytes and supplies receiving-app finalized files under the existing delivery/event provenance before admitting snapshots; a PDF or other non-image file cannot satisfy `GeneratedImage.image` merely because the app accepts that upload type. A succeeded run has at least one declared output and no more than its frozen maximum. Failed/unknown runs may retain finalized private recovery outputs; only successful runs are eligible for gallery submission. Graph validation has no execution side effect. It validates the complete graph against the configured node-class/input/model/resource allowlist, rejects arbitrary filesystem paths/network destinations/embedded secrets, and does not let four correct mappings authorize unrelated unsafe nodes. The standard JSON test graph uses prompt node `6` key `text`, negative node `7` key `text`, width node `5` key `width`, and height node `5` key `height`; it is provisioned with `fixture graph=file {type="application/json"}` and never a fabricated file ID. Its digest binds graph bytes, the four distinct mappings, compatible node metadata and binding-contract revision. Submit rejects a mismatching graph/map/digest or unsupported runtime feature; it never silently chooses another model/node/dimension.

## Desired JavaScript standard references

Standard type metadata uses canonical strings such as `std.TextRequest`, `std.TextRun`, `std.WorkflowDefinition` and `std.ImageRun`; app targets do not copy their schema. Bindings use `{capability:"std.TextGenerationV1",from:"deployment.llm"}` and `{capability:"std.ImagesV1",from:"deployment.images"}`. Existing `send(c,"chat.LLM.generate",{value:...})`, `delivery(c,{record,field},[...])`, `records`, `set` and verified handler descriptors supply effects. Exact integers and limits are BigInt, durations exact milliseconds, and the UI descriptor's `poll` uses `1000n`. No new standard helper implementation is part of these drafts.

## Associated progress contract

Status: accepted by root after the bounded second consultation; this is the normative draft contract. The actual first pass revealed the same five handlers in Chat and Creative: three operation-completion bridges, one provider-change bridge, and an Observation consumer; each also copied sequence/state/content into a business Run. The identical part is original-request correlation, ordering, current snapshot storage and durable observation notification. Token/job reservation, final assistant turns, image Output records and approval are business choices. A small extension to the existing associated delivery is sufficient to separate them.

For an operation whose pinned standard manifest declares an observable run, `delivery(Target)` exposes nullable read-only `.progress` of that declared snapshot type, plus a trusted `Target.progressed` event carrying `{delivery_id:text}`. Other deliveries do not acquire this property. The source send/association, cancel and reconcile forms are unchanged; there is no global run directory, raw-ID observation API, new run constructor or new effect grammar.

The standard manifest declares the relation once:

| Original observable operation | Snapshot schema | Original request key | Verified producers |
|---|---|---|---|
| `TextGenerationV1.generate` | `TextRun` | `value.source`, `value.revision` | `generate`/`cancel`/`reconcile` results and `changed.value` |
| `ImagesV1.submit` | `ImageRun` | `value.source`, `value.revision` | `submit`/`cancel`/`reconcile` results and `changed.value` |

The adapter/controller resolves that key within its verified original binding/account/app/owner/team and immutable request digest. The app does not wire three result paths or copy this table. A producer cannot select another team or original operation by writing source text. Conflicting request reuse is rejected. A cancellation or reconciliation result updates the original start receipt's progress; its own transport receipt remains separately associated to the command. Ordinary `.status`, `.result` and `.error` retain their existing meanings. In particular, succeeded start transport can have queued progress, and failed/unknown transport can later have authoritative terminal progress.

### Admission, replacement and cancellation

Register the original admitted outbox identity and immutable key/digest before provider dispatch. This permits authenticated pre-ack snapshots to correlate while the start transport is pending. A cancel arriving first retains a binding-owned tombstone for exactly that logical run. It can prevent a later start under that identity; it cannot cancel unrelated work or invent an associated receipt before an original request is admitted. A later compatible original admission attaches the retained evidence. An unknown/conflicting original mapping remains visible uncertainty/rejection, never a guessed source lookup or a new job.

Replacing a business record's associated handle selects another original delivery. Old progress stays with its original delivery and can update only a still-matching retained attempt record. It never follows the new handle or overwrites its run. These apps keep one immutable start handle per Run and preserve earlier run records, so late outcomes can settle their own allowance entry. Revoking conversation/member access suppresses content reads and undispatched starts; it neither erases retained resource-accounting evidence nor forges remote cancellation.

### Observation, transactions and recovery

The shared receipt layer validates all producer snapshots against the same normalization above, including source/revision/digest, sequence, terminal immutability, bounded one-time usage and finalized file provenance. It atomically commits the latest snapshot and a durable progressed notification under the owner revision fence. `.progress` stays null until a verified snapshot exists. Null is no verified progress, not success/zero usage; app `state` therefore stays nullable instead of guessing remote queued state.

Multiple queued notifications may coalesce because the consumer rereads the **current** associated progress at its own fenced checkpoint. Notifications are durable independently of the business handler, and cannot be marked consumed merely because the provider call succeeded. A failed handler rolls back its business writes. Technical failures use ordinary durable retries; an ordinary business-rule failure may remain terminal and visibly failed. Explicit successful reconciliation can request another current-progress notification after the business cause is resolved. Restarts preserve both latest progress and outstanding notification. A successful explicit reconcile schedules a current-progress notification even when its snapshot sequence is unchanged, so an app can repair an earlier failed finalization without another generation or a fake newer provider sequence. Duplicate notifications are allowed; business effects must be idempotent. No per-token event log or replay claim follows.

Current association reads use the existing `delivery(c,{record,field},[...])` helper with static `progress` or selected nested progress leaves, and enroll the progress revision in the same conflict fence as other mutable receipt state. Policy field grants must name those leaves; a readable status does not grant progress/content/files. Revoked callers cannot retrieve old snapshots via polling, previews, original URLs or stale receipt objects. Safe recovery diagnostics omit prompt/file/graph content. Finalized progress files retain original adapter/delivery/path provenance when an authorized consumer attaches them; no URL or structural file is accepted.

### Exact source and target reduction

```can
## Run retains allowance, reserved, used, unfinished, immutable request and command receipts.
derive Run.state:TextRun.state? = row.request?.progress?.state
derive Run.partial:text = row.request?.progress?.content ?? ""
scenario reply_progressed on=LLM.generate.progressed
 do
  for run in Run as row where row.request?.id==event.delivery_id limit=1
   let value=run.request?.progress
   if value!=null
    ## Settle the token reservation once, release concurrency once,
    ## and create the immutable assistant Turn once for a succeeded run.
```

Desired target uses model `derived` metadata and registry `derives`, for example `"Run.state":async(c,row)=>(await delivery(c,{record:row,field:"request"},["progress.state"]))?.progress?.state??null`. The one handler descriptor is `{handler:"reply_progressed",on:"chat.LLM.generate.progressed"}`; it reads `["progress"]` under trusted owner authority. Images uses the same shape with `Images.submit.progressed`; its remaining body settles the job allowance and admits bounded finalized Output records by stable position. There are no three completed bridges, provider-changed bridge, local Observation event, stored sequence, stored partial text or copied run state in either app.

Business exactly-once effects remain ordinary atomic guards: `used==null` before releasing a held allowance; `unfinished` before decrementing concurrency; unique `(run,role)` before assistant creation; unique `(run,position)` before image admission. Repeated/current reconciliation notifications cannot duplicate these effects. A business failure leaves the shared snapshot available to the authorized UI while keeping the unsettled reservation visible for recovery.

### Fixture and consultation boundary

No new delivery recipe attribute is needed. For an observable original operation, a valid succeeded fixture's existing typed `result` initializes `.progress` through the same normalized-result path during isolated provisioning, without executing send, emitting production callbacks or pretending to simulate a stream. A pending/failed/unknown recipe without such evidence has null progress. Explicit trusted-handler examples provide `{delivery_id:recipe.id}` and read the associated provisioned progress. Tests involving later event-only progress after a failed start receipt, pre-ack events, cancel tombstones, restart, live revoke and notification retries remain shared-runtime acceptance cases, not invented fixture mutations or executed provider evidence.

Fresh requests 4/5/6 compared current app snapshots, associated progress and a separate run construct. JEV 1.13.0 selected associated progress in all three, probabilities 0.99/0.98/0.88 and confidence 0.99/0.98/0.82. The third retained 0.11 probability for app snapshots and 0.01 for a separate run construct. This is advisory support for the demonstrated reduction, not proof of new runtime guarantees. The earlier three-call round remains intact and addressed a different alternative set; no rejected request was retried.

## Final draft handoff

The nine owned app files are complete requirements/source/desired-JavaScript drafts with focused independent review completed. Chat has 6 models, 7 user scenarios, 2 trusted handlers and 3 pages; Creative has 5 models, 8 user scenarios, 4 trusted handlers and 4 pages; Gallery has 3 models, 4 user scenarios and 4 pages. Their isolated examples contain 44 table rows and two multi-operation sequences, including actual branch creation, send/stop/revoke and review/share/revoke/withdraw behavior. Runtime lifecycle edge cases are separately required, not represented as fake receipt mutations.

The demonstrated language reduction is one shared associated-progress extension: ten app lifecycle handlers became two domain handlers, with no app Observation events or persisted protocol mirrors. The accepted shared gallery component replaces repeated image widget authoring. Standard schemas and JSON file fixtures are catalog/test contracts, not adapter implementations. No chat-specific transport or generic new run language was added.

Verification: all three JavaScript files pass Node syntax checks; descriptor inspection matches source model/scenario/handler/page/fixture inventories and all referenced rule functions. The prototype Can parser lacks accepted delivery types, sequence examples, polling and galleries. Syntax-only projections documenting those four substitutions parse all three files; this is not acceptance of full source by the current parser. Detailed commands/results and all six JEV request/results remain in [the evidence directory](../jev/complex-chat-media-20261004/assessment.md).

There is no unresolved design blocker for these drafts and no pending JEV call or approval. Provider bindings, shared delivery-progress durability/authority, gallery renderer, compiler/type checking and the example runner remain implementation/proof obligations. Earlier blocked C1 and paused C5 work was not adopted or retried. No Git mutation, shared-document edit, Muse launch or compiler/library implementation was performed by this writer. Writer released to root.

Final cross-app review restricted default receipt text to its declared status projection; inspection fields remain a separate explicit authorized selection. The target no longer expands inspection/validation IDs, errors and full results merely because a receipt is shown. Canonical result descriptors, lazy page builders and field/fixture conventions match the other new targets.
