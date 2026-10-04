# Demanding AI applications in Can — 2026-10-04

Research only. These are unadopted interface and syntax sketches, not implemented capabilities or runnable apps. Read official public provider documentation and source, plus [tools/jev.py](../tools/jev.py) and [DESIGN §§7–8.1](../DESIGN.md). No live inference, JEV consultation, ComfyUI execution, private endpoint, installed-model inspection, deployment change or implementation was performed.

## Conclusion

Ordinary typed capabilities already express final chat generation, structured suggestions, classifier judgments, image submission, cancellation requests, reconciliation and verified progress/result events. Reusable JavaScript adapters should own provider transport, credentials, model configuration, workflow substitution, response validation, retry classification and file transfer. An LLM is an external effect, not a pure derive or a synchronous call inside a business transaction.

Two narrower authoring/presentation questions deserve language design work: reusable **static adapter configuration in owning source**, including a single workflow-node mapping, and **authorized live presentation of persisted run state**. Neither proves a need for raw HTTP, general JSON dispatch, arbitrary callbacks, a second agent runtime or an AI-specific control-flow DSL. Lossless token replay is a stronger requirement than live snapshots and requires an explicit persistence/ordering contract; it cannot be supplied by adding a `stream` keyword.

## Current provider evidence

| Surface checked | Verified contract and consequence |
| --- | --- |
| Ollama chat | `POST /api/chat` takes model and message history, with optional tools, format and generation options. Streaming defaults true; final responses include the model, assistant message, done reason and usage/timing. Model selection must be validated against the bound implementation rather than assuming every model supports every feature. [Chat reference](https://docs.ollama.com/api/chat). |
| Ollama streaming and errors | Streaming is NDJSON, with `stream:false` selecting one JSON response. A mid-stream error arrives in a later error object without changing the already-sent HTTP status. HTTP 200 and partial text therefore cannot establish a completed assistant reply. [Streaming](https://docs.ollama.com/api/streaming), [errors](https://docs.ollama.com/api/errors). |
| Ollama structured output and tools | A JSON schema can constrain content, but the consumer still parses and validates it. The current documentation excludes structured output on Ollama Cloud. Tool calls are proposals the host handles and returns in follow-up history; streaming requires accumulating content, thinking and tool-call fields. [Structured output](https://docs.ollama.com/capabilities/structured-outputs), [tool calling](https://docs.ollama.com/capabilities/tool-calling). |
| Ollama cancellation | The official JS client's `abort()` aborts all streamed generations on that client instance; the docs recommend a client per stream when managing them independently. This is not a documented durable run ID or token-resume API. [Official JS client](https://github.com/ollama/ollama-js#abort). |
| ComfyUI native server | `POST /prompt` validates and queues an API-format graph; `/history/{prompt_id}`, `/queue`, `/view`, `/object_info` and `/ws` serve distinct purposes. Submission acceptance is not generated-image completion. [Server routes](https://docs.comfy.org/development/comfyui-server/comms_routes). |
| ComfyUI messages | Events include execution start/success/error/interruption, node execution and progress. `executed` means a UI output was returned, not that every node or the entire job completed; previews and queue counts are separate observations. [Server messages](https://docs.comfy.org/development/comfyui-server/comms_messages). |
| ComfyUI native source | Current upstream accepts a supplied UUID `prompt_id`, but its successful POST path visibly queues the prompt without a deduplication check there. It also implements targeted `/api/jobs/{job_id}/cancel` with an atomic running-job check; finished or unknown jobs produce a no-op response. Do not assume either behavior exists in an older installed release. [Upstream server.py](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py). |
| Comfy API v2 | The beta offers durable jobs, polling and cancelable work. Self-hosted ComfyUI currently requires the official proxy to expose v2; it is not interchangeable with a native port 8188 endpoint. Provider output URLs have independent lifetimes and may require authentication; copy validated bytes into Can storage for a durable gallery. [v2 overview](https://docs.comfy.org/api-reference/v2/overview). |
| Comfy v2 recovery | The SDK documents reject-on-duplicate submission keys: reuse returns `422 idempotency_key_reuse`, not the original job. Recovery needs a recorded job ID; a lost initial response has no automatic lookup recovery in the documented recipe. Fresh SDK submit calls mint fresh keys. [SDK submission/retry contract](https://docs.comfy.org/development/api-development/sdks#retrying-a-submit-the-idempotency-key). |
| Comfy v2 observation | Job GET supplies current state, progress and committed outputs. SSE is a live enhancement with no event IDs or resume cursor; missed frames are lost. Named workflow parameters and node introspection are outside this initial v2 surface. [Design notes](https://docs.comfy.org/development/api-development/sdks-design). |
| TypeSafe JEV | `POST https://api.typesafe.ai/v1/systemone` uses bearer authentication and `model,state,questions`; responses contain matching answers, actual model and usage. The HTTP reference distinguishes validation, authentication, rate-limit and overload errors. [API reference](https://docs.typesafe.ai/api). |
| Local System One through Ollama | Current docs specify `POST /v1/systemone`, Ollama 0.35.0+, compatible local scoring models, one JSON response, and no streaming, tools or generation controls. Requests without images are capped at 64 KiB and input is not truncated; image support has separate model/body limits. [System One endpoint](https://docs.ollama.com/api/systemone). |

The upstream ComfyUI source is a moving public branch, not evidence of the user's installed runtime. Comfy v2 is a distinct beta alternative; its advertised idempotence must be interpreted using its more specific rejection/recovery contract. Provider/version negotiation is deployment validation, not inferred compatibility.

## Six realistic journeys

### 1. A private conversational assistant

A member opens an owned thread, sends text, sees a pending assistant turn, then receives a completed reply. The submit scenario freezes the authorized message history, system-policy version and generation budget, associates the typed delivery, and commits before dispatch. The Ollama adapter sends that history rather than depending on a hidden provider conversation. The reply handler verifies current attempt/source/revision before storing content. A second request after a definitive failure gets a new attempt; an uncertain invocation is not silently retried into a different response.

The browser shows retained turns after reopening. Another account cannot browse the thread, delivery result or transcript simply by learning an ID. A reply generated against an earlier edited branch remains evidence for that earlier run; it must not overwrite the current branch. Limit transcript size, output tokens, concurrent runs and retained content. These are ordinary models, policies, guards, sends and completion handlers. Persisting conversation history is an app requirement, not an Ollama-specific language primitive.

### 2. Live chat, disconnect, return and cancel

During generation, the adapter retains an ordered run observation and publishes bounded content snapshots through a verified capability event. The UI refreshes an authorized persisted projection. Returning after a browser disconnect resumes observation of the same run; it does not resubmit generation. Keep private reasoning output separate from user-visible content, even if the provider includes both.

A user cancellation is a new authorized scenario targeting the frozen run identity. The adapter must isolate Ollama streams so it cannot abort another user's generation. `cancel_requested` is distinct from confirmed cancellation; completion racing cancellation may still produce a final answer. Closing the browser is not cancellation.

Existing typed events can carry cumulative snapshots and sequence numbers; coalesce updates rather than authoring a business write per token. Exact replay of every token after an adapter crash is not documented by Ollama. A bounded persisted log could provide it, but it needs deduplication, gap handling, cursor retention, backpressure and recovery semantics. A disconnected nonterminal run whose generating process disappeared remains failed/unknown according to verified evidence; “resume” cannot mean inventing the missing suffix.

### 3. Typed output proposing an image, with real tool authority

The member asks for a poster. The assistant produces a closed `ImageSuggestion` containing prompt, negative prompt, width and height. The adapter derives a JSON schema from that contract, validates the completed content, rejects malformed or over-budget fields, and records the concrete model/configuration. Valid JSON does not prove the dimensions are allowed or the suggestion is appropriate.

The user edits the proposed values and invokes the canonical image-generation scenario. Current thread access, quota, expected version and image policy are rechecked there. A model-emitted tool name or arguments do not manufacture an `action` handle, caller identity, role or protected record binding. If automatic tool execution is later required, it needs explicit delegated authority and a bounded allowlist of canonical operations, not arbitrary JS function lookup.

Tool results return to the next chat request only after the actual authorized operation's receipt/outcome. A message cannot truthfully claim an image exists merely because the model requested generation. Reject unknown tool names, incomplete streamed arguments, repeated tool-call identities with changed arguments, and excessive tool loops. This uses typed capability results and canonical invocation; unrestricted dynamic model dispatch is unnecessary for this journey.

### 4. Chat plus a generated-image gallery

An image run stores the user's exact approved input and the pinned workflow revision. The adapter loads one reviewed API-format graph and substitutes only declared node input keys. It validates input types/ranges and output nodes before enqueueing, preserves other graph edges/model/sampler settings, and records the final graph/configuration digest and resolved seed. A gallery item retains its originating turn/run and immutable asset.

The submission delivery may succeed with a provider job reference while the business image run remains queued. Verified changed events, or reconciliation responses, carry running/final state. Final images are transferred and finalized under DESIGN §8 before the corresponding typed file result/event is admitted. The handler checks current run correlation and declared output identity, then creates gallery items once.

The official native example uses nodes 6/7 for positive/negative text, node 5 for dimensions, and node 9 for saved output. Those IDs belong to that graph, not a universal ComfyUI convention. [Official websocket workflow example](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example.py).

Preview frames may be transient presentation; they are not automatically retained gallery assets. Batch outputs need stable output positions/identities. A partial successful output followed by job failure should remain distinguishable from a completely successful run, according to the app's explicit gallery policy.

### 5. Image uncertainty, reconciliation, cancellation and late results

The provider accepts an image job, then the response connection is lost. With a known job ID, the adapter polls authoritative job state and recovers committed outputs; it can normalize these as verified events without pretending the provider supports webhooks. With Comfy v2 key reuse but no recorded job ID, the documented recipe cannot recover automatically. Preserve unknown state and operator recovery; do not create a new paid job under the label “retry.”

Native ComfyUI with a supplied prompt UUID may improve lookup correlation, but the inspected POST path does not establish idempotent enqueueing. An adapter must serialize and retain submission bookkeeping, and still acknowledge the crash boundary between provider acceptance and its own durable record. Syntax cannot close that provider gap.

Queued/running cancellation is scoped to the bound provider account and exact run, and the adapter uses a verified targeted cancellation surface where available. A no-op cancellation response for an unknown/finished job does not prove that no image was generated. Reconcile afterward. A late old result belongs to its original run and cannot replace a newer selected attempt. Expired provider history or inaccessible bytes are unavailable evidence, never a reason to regenerate silently.

### 6. Noul, Choice and Score controlling a support route

A support request is evaluated against a frozen, minimized state. One batch asks whether a human was requested (Noul), which department fits (Choice), and how severe the issue is on an ordered rubric (Score). Persist the actual model, rubric revision, original probabilities, score/legend, usage and selected local route. A human can inspect an ambiguous distribution and override the route with attributable evidence.

Noul is a probability of yes, not a boolean or degree of severity; there is no separate provider confidence field. Choice returns the selected label, every option's probability and confidence. Score is the probability-weighted zero-based level index, potentially fractional, with probabilities, legend and confidence. Preserve these distinctions in Can types. [Noul](https://docs.typesafe.ai/primitives/noul), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score).

Confidence summarizes the distribution rather than guaranteeing correctness. Thresholds are question/domain policy, evaluated on representative labeled examples; do not use a universal 0.9 rule. For example, synthetic Choice probabilities 0.6/0.3/0.1 imply a winner with 0.4 confidence under TypeSafe's documented formula. Synthetic Score distributions 0/1/0 and 0.5/0/0.5 both average to 1 but carry radically different uncertainty. These are arithmetic illustrations, not model results. [Confidence](https://docs.typesafe.ai/confidence).

JEV permits up to 255 Choice options and up to 10 Score levels; local Ollama documents 2–26 for both. A portable binding must validate the selected provider's supported contract, or explicitly offer the common bounded subset. It must not truncate criteria or claim local Nimble is JEV. [TypeSafe Choice limits](https://docs.typesafe.ai/primitives/choice), [TypeSafe API Score limits](https://docs.typesafe.ai/api), [Ollama decision types](https://docs.ollama.com/capabilities/decision).

## Compact ordinary Can contract sketches

All contracts below are proposals. The declaration mechanisms are existing Can shapes; the provider names and their implementations do not exist in the standard library. These fragments omit surrounding models/policies and are not complete application sources.

### Final chat and normalized run observation

```can
package ai
 Given
  export contract Message { role:enum(system,user,assistant,tool), content:text }
  export contract ChatRequest { source:text, revision:int min=1, messages:Message[]!, max_tokens:int min=1 max=4096 }
  export contract ChatReply { source:text, revision:int, content:text, model:text, finish:text }
  export contract RunView { source:text, revision:int, sequence:int, state:enum(queued,running,succeeded,failed,unknown,cancelled), content:text }
  export capability ChatV1 version=1
   generate(value:ChatRequest) -> ChatReply
   cancel(source:text,revision:int) -> RunView
   reconcile(source:text,revision:int) -> RunView
   event changed { value:RunView }

## In the consuming chat package:
use ai {ChatV1 as LLM} from=deployment.llm
## In a Run schema: request:delivery(LLM.generate)?
## In the submit scenario's do, after ownership/version/quota checks:
send LLM.generate {value=ChatRequest {source=run.id,revision=run.revision,messages=history,max_tokens=4096}} as request
set run {request}
```

The adapter copies source/revision from its frozen causal request, not from model-authored content. Changed-event occurrence identity, sequence, source routing and authorization are binding obligations. A completion handler still verifies `run.request?.id==event.delivery_id` and current domain revision/state. A terminal reply cannot be combined with arbitrary earlier snapshots just because their source strings match.

The minimal final-only Message contract excludes arbitrary tools/images/thinking. Add typed fields only when the app uses them; the vision adapter reads authorized `file` bytes and encodes provider input itself. [Ollama vision](https://docs.ollama.com/capabilities/vision). A provider-neutral envelope must not force every user into a giant catch-all request.

### Image jobs and owned outputs

```can
package ai
 Given
  export contract ImageInput { source:text, revision:int min=1, prompt:text, negative:text, width:int min=256 max=1536, height:int min=256 max=1536, seed:int min=0 }
  export contract ImageAccepted { source:text, revision:int, job:text }
  export contract ImageOutput { position:int min=0, image:file }
  export contract ImageRun { source:text, revision:int, sequence:int, job:text, state:enum(queued,running,succeeded,failed,unknown,cancelled), outputs:ImageOutput[]!, detail:text? }
  export capability ImagesV1 version=1
   submit(value:ImageInput) -> ImageAccepted
   reconcile(source:text,revision:int) -> ImageRun
   cancel(source:text,revision:int) -> ImageRun
   event changed { value:ImageRun }

## Existing consuming form:
use ai {ImagesV1 as Images} from=deployment.images
## In the authorized generate do:
send Images.submit {value=ImageInput {source=run.id,revision=run.revision,prompt,negative,width,height,seed}} as request
set run {request}
```

The bounds are illustrative app policy. The reviewed graph may require stricter multiples/ranges; those are explicit validation, not a silent resize. Adapter state normalizes provider error/cancellation evidence; delivery success remains distinct from image-run success. File-valued changed events use existing receiving-app finalization and immutable occurrence/output-position provenance. A raw filename, URL, preview buffer or Comfy asset ID is not a Can `file`.

### A fixed mixed System One batch

```can
package ai
 Given
  export contract SupportState { message:text, history:text, account_summary:text }
  export contract NoulAnswer { probability:decimal min=0 max=1 }
  export contract RouteProbabilities { billing:decimal min=0 max=1, technical:decimal min=0 max=1, other:decimal min=0 max=1 }
  export contract RouteAnswer { choice:enum(billing,technical,other), probabilities:RouteProbabilities, confidence:decimal min=0 max=1 }
  export contract Level { index:int min=0, description:text, probability:decimal min=0 max=1 }
  export contract SeverityAnswer { score:decimal min=0 max=2, levels:Level[]!, confidence:decimal min=0 max=1 }
  export contract SupportJudgment { model:text, rubric_revision:text, human:NoulAnswer, route:RouteAnswer, severity:SeverityAnswer, input_tokens:int min=0, output_tokens:int min=0 }
  export capability SupportJudgeV1 version=1
   evaluate(value:SupportState) -> SupportJudgment
```

A reusable JS System One adapter serializes the typed state and fixed three-question specification once, then normalizes wire `noul` to the expressly named probability field and string-indexed Score maps to ordered Level entries. Keep the complete rubric specification in the versioned owning provider contract/configuration; a revision alone cannot explain the question. Validate finite numbers/ranges, exact question and option sets, unique ordered levels, complete legends, distribution sums within declared wire tolerance, score consistency, selected label, model identity and usage. Preserve wire numeric values with an explicit decimal conversion policy; do not silently round probabilities into booleans.

The existing [jev.py validation](../tools/jev.py) checks nonempty questions/state presence, answer-key equality, matching answer type and known Choice selection; it does **not** validate all those distribution/range/Score/legend constraints. It makes one request with a 55-second default timeout, performs no retry, and redacts the configured key in saved output. It is research-caller evidence, not a production adapter or a complete typed System One boundary.

Dynamic question catalogs could instead use separate typed Noul/Choice/Score request/result arrays, with stable IDs and validation, then map to the provider's heterogeneous question object internally. Fixed batches are much smaller for this app and retain parallel evaluation. Neither requires Can to expose untyped arbitrary JSON maps. Dependent questions require later requests; answers from one question are not implicitly fed into another question in the same provider batch. [TypeSafe question evaluation](https://docs.typesafe.ai/introduction), [Ollama System One](https://docs.ollama.com/api/systemone).

## Node mapping once, and the actual proposed syntax boundary

The API graph mapping can live once in a reusable JS adapter's typed configuration today, with app source retaining its normal bound capability. That preserves an honest language boundary but leaves business-relevant workflow selection outside the owning Can declaration. If source-owned configuration is a requirement, investigate one generic schema-checked binding option form rather than one new syntax per vendor.

This candidate is **new, unadopted syntax**; current `use` does not support `with`. It replaces the ordinary Images binding above rather than adding a second one:

```can
use ai {ImagesV1 as Images} from=deployment.images with={
 workflow="poster-v1",
 inputs={prompt={node="6",key="text"},negative={node="7",key="text"},width={node="5",key="width"},height={node="5",key="height"},seed={node="3",key="seed"}},
 outputs=["9"]
}
```

This is the sole node mapping in the sketch. `workflow` identifies an immutable reviewed API-format artifact/release, not a caller-supplied filesystem path or arbitrary URL. The compiler/deployment linker would resolve the complete artifact and pin its digest with the source release. The versioned adapter declares this configuration's closed schema and verifies each named request field against the graph input class/type and selected output nodes. No author-created wrapper/build manifest or cloned per-app graph is required; the same artifact is reusable.

Candidate restrictions: static constant configuration only; no secret literal; no caller expression; unknown/duplicate/unmapped keys fail; deployment validates all required graph inputs/nodes/models before exposure; queued work retains its original graph/configuration after a source update. Requests cannot replace the graph or alter undeclared nodes. A mapping invalidated by a changed graph fails deployment rather than generating differently. A generic binding-option schema and source-artifact identity/resolution contract are not yet designed or adopted. The simpler alternative is a provider exporting a fixed `PosterImagesV1` capability whose implementation already owns this mapping; it removes configuration syntax at the cost of additional specialized provider contracts.

Likewise, live presentation could reuse ordinary model queries with shared refresh behavior, or add a single declarative refresh option to an existing scoped UI component. Before adopting a `live`/stream widget, specify authorization rechecks, owner checkpoint snapshots, disconnect/reconnect, output limits, escaping, focus/draft preservation and access revocation. A chat or gallery renderer should be reusable UI library behavior, not authored Preact/HTMX/socket code. None of the existing UI syntax currently guarantees this live-run presentation contract.

## Reusable JS adapter boundary and alternatives

| Concern | Reusable adapter/runtime responsibility | Can app responsibility |
| --- | --- | --- |
| Provider request | Endpoint/auth, model feature validation, NDJSON/SSE/WebSocket decoding, provider request limits, typed normalization | Explicit bound capability, authorized minimized frozen payload |
| Lifecycle | Stable causation/digest, submission evidence, bounded retries/backoff, progress coalescing, reconcile/cancel mapping, retained provider-job correlation | Pending/current attempt, revision guards, branch selection, explicit retry/review actions |
| Tools | Derive/validate wire schemas; expose only declared operations; return actual committed receipts/results | Canonical caller authority, protected bindings, current versions/guards, bounded policy for automatic actions |
| Assets | Authenticate provider bytes, validate MIME/size/quota, finalize immutable receiving-app files, retain delivery/event/path provenance | Destination field grants/limits, current run correlation, gallery selection/history/lifetime |
| Judgments | Exact typed answer normalization, finite numeric validation, complete distributions/legends, model/rubric evidence | Domain thresholds, routing, human override, current business authority |

A long-lived adapter run plus verified events avoids pretending a Worker business transaction remains open for GPU inference. For Comfy v2, server-side polling can be the authoritative observation path and SSE a latency enhancement. For native ComfyUI, a pinned version adapter must compensate for weaker job/retry guarantees or reject a required guarantee. For Ollama, a retained run controller is required for durable live state; its loss cannot be concealed by reconnecting the browser.

A direct browser-to-provider approach is smaller for a disposable local demo, but does not satisfy private persisted history, shared quotas, source-bound tool authority, reconnect evidence or durable gallery provenance. A synchronous capability call inside a business mutation conflicts with current outbox/fence semantics and fails recovery under long inference. A broad workflow/agent engine would add vocabulary and implementation before these journeys demonstrate its necessity. A fixed typed capability per outcome plus shared adapters is the smaller starting point; the two proposed configuration/presentation surfaces remain reviewable alternatives.

## Required acceptance evidence before claiming support

1. Chat completion after normal generation; partial text followed by NDJSON error; browser reconnect without a second generation; adapter restart with terminal and nonterminal runs; cancellation isolated from another concurrent user's run.
2. Malformed structured output and unsupported Cloud schema mode; unauthorized/stale tool proposal; repeated tool call; real authorized image operation and actual committed tool result.
3. Node-map drift and absent model/node; out-of-range dimensions; frozen graph/seed across redeploy; invalid output node; multiple/partial outputs.
4. Lost submit response with and without known job ID; duplicate key rejection; unknown native prompt; targeted queued/running cancellation; completion racing cancel; late old events and repeated output positions.
5. Valid image transfer/finalization; oversized/malformed/partial bytes; inaccessible or expired provider URLs; foreign/mis-correlated file; denial after destination authority changes; no image attachment inferred from provider success alone.
6. Noul near 0/0.5/1; Choice ambiguity and complete option set; equal Score means with different distributions; malformed probabilities/legend/score; rubric change; provider-specific limits; explicit human override preserving original judgment.

These are acceptance requirements, not executed tests. No source parser, compiler, stdlib, runtime, provider execution, concurrency result, latency result or probability calibration was established. Only this research note was written. The next decision should choose the smallest source-owned configuration and authorized live-presentation contracts, while keeping provider uncertainty explicit; it should not reopen unrelated migration work.
