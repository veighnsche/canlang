# Harder company apps: AI, services and durable work

Research and proposal, 2026-10-04. No syntax in this report is adopted by being shown here. This round adds research artifacts, not new app implementations or a claim that the existing drafts already support these cases.

## Direction

Can should be tested as **a language for company business workflows: records, permissions, rules, external services and bounded automation, including AI**. CRUD remains a useful foundation; it should not be a ceiling that excludes an email sorter, research assistant or media approval process. Keep Given declarations, When operations and Then presentation, shared defaults, inline behavior examples, canonical operations and composition. Changing current restrictions costs no backward compatibility with a deployed Can implementation.

AI-authored and AI-powered are different properties. Every Can app should be economical for an agent to author; only some apps need to call models. AI capabilities should add no setup or dependencies to apps that do not use them.

The existing apps already have workflows beyond CRUD, including reservations, asynchronous provider outcomes, compensation and frozen business evidence. These new examples should add genuinely different pressure rather than more models with similar create/update screens. The two supporting investigations contain [16 candidate apps and bounded vendor comparisons](research-demanding-apps-20261004.md) and [six AI journeys with provider evidence and contract sketches](research-ai-capabilities-20261004.md).

## What exists, and what is actually missing

[DESIGN §8](../docs/specification/DESIGN.md) already provides typed capability imports, durable `send`, associated delivery references, verified events, final completions and receiving-app finalization of provider files. Those mechanisms can represent final LLM replies, classifier answers, image submission and completion. Provider-defined events can also carry progress. Therefore these are not all expressiveness failures.

The demonstrated missing **shared contracts** are narrower:

| Pressure from new apps | Current mechanism | Work to expose in drafts |
| --- | --- | --- |
| Typed fetch / external API calls | Bound capability plus adapter mapping | Source-owned endpoint operation/configuration contract; typed status/result mapping, bounded pagination and unknown outcomes without hand-authored fetch plumbing. |
| LLM output and structured extraction | Typed service result | Standard message/content and constrained-result contracts; explicit supported model features; preserve malformed/partial outputs as failures or evidence rather than valid business facts. |
| Chat progress, stop and reconnect | Events plus ordinary models/queries | One reusable observable-run contract and authorized UI updates; distinguish partial text, completed answer, requested stop and confirmed cancellation. |
| JEV question batches | Custom typed capability | Declare question types and criteria once; derive result shape rather than repeat option enums, probability fields and UI labels. Preserve distributions and ordered rubrics. |
| ComfyUI workflow inputs | Adapter configuration outside source | One typed mapping to a pinned API graph, either fixed by the app author or published as a user-configured template revision; no graph JSON copied into each business operation. |
| Search / multi-stage work | Sends, handlers, schedules and bounded loops | A realistic source should reveal whether this becomes repetitive callback orchestration; compare existing handlers with a resumable sequence form only if it helps. |
| Retrieval over private documents | Ordinary reads and provider calls | Scope retrieval to authorized sources, preserve document revision/citations, recheck access; vector search is not the authority for access. |
| Generated media UI | Finalized files and generic components | Shared conversation, generation-progress and gallery components with ordinary page/operation grants. |

Some missing pieces belong in the standard library, some in declaration/type rules, and some may justify a new primitive. That allocation is an investigation result, not a reason to invent eight new keywords now.

## Fetch, workerd and JavaScript reuse

Use workerd's existing `fetch`, encoding, streams, URLs, cryptography and JavaScript built-ins. Do not rewrite UTF-8, a JSON parser or HTTP in Can. Workerd is the runtime; managed D1/R2/inference services are separate capabilities supplied by the hosted platform. [workerd](https://github.com/cloudflare/workerd), [Workers runtime APIs](https://developers.cloudflare.com/workers/runtime-apis/).

A business app should be able to declare the external operation it needs in its owning source, reuse it and call it through the canonical invocation path. Standard integrations should already supply their typed contract. A new company-specific HTTP API needs a compact typed mapping once: binding, method/path, inputs, output schema, status/error interpretation and any provider identity/reconciliation support. Credentials belong to deployment bindings; ordinary app input can select allowed resource paths, not silently replace the credential's destination. This is a candidate declaration contract, not a requirement for a second `fetch` effect beside `send`.

For a small pure conversion, a typed library function may be sufficient. For network/database/model work, it is an effect with an observable outcome. Exposing arbitrary JS callbacks inside `derive` would erase this distinction. A selected JS library also needs to respect Can's exact integer/decimal, time, nullability and file semantics; passing everything through JavaScript `Number` or raw URLs is not a faithful bridge.

Useful reuse candidates:

| Need | Existing foundation | Remaining Can responsibility |
| --- | --- | --- |
| Text/structured generation, embeddings, tools, image calls | [AI SDK Core](https://ai-sdk.dev/docs/reference/ai-sdk-core) or a focused provider client | One typed contract, feature validation, authorized inputs and output acceptance. Evaluate dependency cost against a small direct adapter; do not install two overlapping stacks by default. |
| Ollama transport | [Official Ollama JS client](https://github.com/ollama/ollama-js) or native fetch/streams | Retained conversation/run identity and independent cancellation. A local server must be reachable through its configured binding; a remote Worker cannot use the user's `localhost`. |
| MIME email parsing | [postal-mime](https://github.com/postalsys/postal-mime), which explicitly supports Cloudflare Workers | Mailbox ownership, thread identity, attachment finalization, routing and response policy. |
| Incremental server-rendered UI | [HTMX SSE extension](https://htmx.org/extensions/sse/) | Shared authorized components, snapshot/reconnect behavior, escaping and preserving unsaved form input. No separate browser business-state model is required. |
| Crawling/rendering pages | [Cloudflare Browser Run crawl](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/) | Source selection, extraction meaning, coverage status, deduplication and reviewed business promotion. The service provides asynchronous jobs, depth/page bounds and result retrieval. |

Libraries make mechanisms cheaper to obtain; they do not define company policy or make external calls free. Workers supports only a documented subset of Node behavior, including some importable stubs, so package/version compatibility must be checked for the functions actually used. Native GPU inference stays with Ollama/ComfyUI or a hosted inference service. [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

## Draft portfolio

These are working names and bounded company outcomes, not a new required folder/package architecture. New apps should be useful alone where sensible and compose through canonical owners. Enrich an existing app when it already owns the workflow.

| Draft exercise | Complete company journey | New design pressure |
| --- | --- | --- |
| **CanChat** | Private assistant conversations: prompt, stream reply, stop, return later, regenerate an explicit branch, attach permitted files. Optional business tools use the caller's current authority. | Ordered history, typed content, partial/final distinction, cancellation, token/spend limits and conversation UI. Start with ordinary LLM chat, not a Slack replacement. |
| **CanCreative + CanGallery** | A marketing employee discusses a brief, approves or directly requests a generation under company policy, produces ComfyUI variants, reviews the originals and shares an approved collection. | One workflow-node mapping, typed image tool, async progress, partial batches, stable provenance, thumbnails and gallery permissions. |
| **CanInbox** | Classify purchasing/support/sales messages, assign the permitted queue, let staff correct a judgment, attach evidence and send or draft replies according to policy. | NOUL/choice/score batches, ambiguity, provider mailbox events, shared/private visibility and distinct send/delivery outcomes. Existing CanMail is physical mail; compose with CanDesk for support. |
| **CanDiscover** | Repeatedly search declared sources for tenders/leads/grants, retain evidence, extract deadlines, dedupe changes, rank against company criteria and promote reviewed records to CRM. | Bounded durable runs, pagination, source coverage, citations, uncertain extraction and cost controls. A failed source must not become “no opportunities.” |
| **CanKnowledge** | Publish approved procedures, index their versions, answer employee questions with current authorized citations and route unresolved questions to an owner. | Retrieval authority, stale indexes, superseded documents, unsupported claims and citation UI. |
| **CanSync** | Synchronize approved customer changes into one billing/CRM provider, show differences, resume after rate limits and resolve conflicting authoritative fields. | General HTTP integration, cursors, webhook identity, conditional writes and reconciliation after a lost response. |
| **Document-to-purchase pack** | Extract supplier invoice claims, compare them with approved purchase orders and receipts, correct discrepancies and accept the reviewed version. | OCR/structured extraction, page evidence, exact money, duplicate documents and version-bound review. Extend CanPurchase/CanExpense rather than clone them. |
| **CanEnrich** | Fill missing CRM facts through a provider waterfall, preserve provenance, compare conflicting results and apply accepted changes. | Reuse paid successes, bounded fallbacks, per-field provenance and explicit provider data ownership. |
| **CanWorkbench** | Carry out a bounded named business task using permitted read tools; propose mutations; obtain approval where policy requires it; invoke the canonical operation. | Tool schemas derived from existing operations, precise approval arguments, changed-record checks and bounded multi-step work. |

The wider portfolio adds supplier onboarding, reviewed outreach, support SLAs, client document packets, research digests and meeting-to-actions. Vendor references establish feature slices, not a popularity ranking or complete parity: Front/Zendesk/Intercom for intake, Feedly/AlphaSense for monitoring, Clay/Apollo for sales workflows, Dify/Open WebUI for model workflows, Zapier/Make for integration recovery, Airtable/Zip for intake and procurement, and Cloudinary for assets. Exact primary links and failure journeys are in the [candidate report](research-demanding-apps-20261004.md).

## First-class models without repeated contracts

My starting recommendation is first-class **typed capabilities for generation and judgment**, supplied by the standard library and usable through the existing import/call structure. Their schemas must be available to checking and tooling. This does not require Rust to know Ollama endpoints or every ComfyUI node. A provider should declare unsupported features instead of accepting parameters it ignores.

Generation and SystemONE classification should not collapse into one chat-shaped API. NOUL yields a probability, choice yields a selected alternative and distribution, and score uses an ordered rubric. Their downstream thresholds, review rules and routing remain authored business policy. JEV is not a research model. [TypeSafe NOUL](https://docs.typesafe.ai/primitives/noul), [choice](https://docs.typesafe.ai/primitives/choice), [score](https://docs.typesafe.ai/primitives/score).

The AI research note demonstrates that a fixed typed judgment contract is possible, but it repeats option names in the question specification and output probability schema. Treat that sketch as a baseline to improve, not the ideal draft. A promising new Given declaration would author each question and rubric once and derive its result type, input UI and review display. Question names, option IDs, descriptions and rubric ordering remain explicit; result DTO duplication should disappear. Keep ordinary `#` descriptions distinct from instructions that are actually sent to a model.

For discussion only, a compact question declaration could resemble:

```can
decision Triage
 reply noul "Does this message require a staff reply?"
 route choice "Which queue owns the request?" {billing="Invoices and payments",support="Product support",other="Neither queue"}
 urgency score "How quickly does this need attention?" ["Routine follow-up","Same-day attention","Immediate operational disruption"]
```

`decision` and these forms are **new, unadopted syntax**, not accepted Can. Invocation would still use the canonical typed service mechanism, binding one question specification to the request. The point is deriving the exact answer schema from the authored specification; a standard typed value constructor may achieve the same result with less core grammar. Compare those alternatives in CanInbox before selecting one. No automatic confidence threshold or universal human approval rule is proposed.

Current Ollama documentation also describes a local System One endpoint with compatible decision models. That makes provider-independent classification worth investigating, but it does not make the local models identical to JEV: the documented option limits differ. None of this establishes the user's installed version or model availability. [Ollama System One](https://docs.ollama.com/api/systemone), [decision model contracts](https://docs.ollama.com/capabilities/decision).

## ComfyUI mapping and chat/gallery composition

The desired authoring experience is one selected workflow artifact and one map from business inputs to node inputs. App operations then say “generate these variants” using prompt/negative/dimensions, without repeating graph topology, polling or file downloads. A declaration might extend the existing import as follows:

```can
use std {ImagesV1 as Images} from=deployment.images with={workflow="campaign-v1",inputs={prompt="6.inputs.text",negative="7.inputs.text",width="5.inputs.width",height="5.inputs.height"},outputs=["9"]}
```

This is a **proposed compact spelling**, not current syntax, and `ImagesV1` is an unimplemented contract. Node IDs are illustrative, not taken from a user workflow. Compare this string-path spelling with the AI report's explicit `{node,key}` map; adopt one canonical representation after checking type/path ambiguity. The mapping has to match an actual pinned API-format graph, its input classes and selected output nodes. For this fixed-workflow alternative, selection belongs in the source; the user-configured alternative below stores published revisions in app records. Server address/credentials belong in the deployment binding; the large reusable graph remains an artifact rather than hand-copied Can.

The critical failure case is a workflow edit changing what node `6` means: existing queued jobs retain their original graph and mapping, and new invalid bindings fail visibly. A provider job ID, preview or image URL is not an authorized Can attachment. Final outputs enter the existing immutable-file flow before appearing in the owned gallery. ComfyUI submission, node progress and whole-job completion are different events. [ComfyUI routes](https://docs.comfy.org/development/comfyui-server/comms_routes), [messages](https://docs.comfy.org/development/comfyui-server/comms_messages).

The chat model may propose a typed `generate_image` business operation. That operation owns allowed dimensions, reference-file access and spend limits; its signature also supplies the model-tool schema and normal UI/MCP action. This avoids three independent definitions of the same action. The company decides whether invocation is automatic within a budget or requires a preview/approval.

The user's example also needs a **user-configurable workflow-template journey**. A static source map alone is insufficient when an authorized employee should upload a different graph and select its prompt, negative prompt, width and height node inputs inside the app. Treat that selection as versioned business configuration: ordinary template/revision records, edit/publish operations, grants and UI. A proposed shared adapter inspects the immutable API-format graph and returns typed selectable node inputs; publishing validates the mapping and generation freezes that published revision. Existing jobs retain their old graph and mapping when someone edits the next revision. Credentials and server routing remain bound integration configuration; selecting a template does not replace them.

ComfyUI supplies node-type inspection and queued prompt validation, which can support this adapter, but its documented `/prompt` validation is part of submission, not an asserted side-effect-free publish validator. A Can adapter's earlier graph/mapping checks remain a proposed library contract. Missing custom nodes or changed installed models must still fail visibly at execution. [ComfyUI routes](https://docs.comfy.org/development/comfyui-server/comms_routes).

The static `with` sketch above is an alternative for an app whose author fixes one workflow, not a rule forcing every company workflow edit through source deployment. The first chat/image/gallery draft should exercise the employee-configurable case. Inspect whether ordinary models plus one reusable typed adapter configuration can cover it before adding a mapping keyword. Both approaches should invoke the same generation capability; no second business operation, copied graph per chat message or vendor-specific control-flow language follows from runtime configurability.

## Cloudflare coverage without forced dependencies

Use a **composed company suite as the coverage example**, with focused apps also deployable using only their selected capabilities. Forcing every Cloudflare product into every app would distort adoption and costs. Service support and mandatory use are different questions.

| Platform capability | Realistic draft consumer |
| --- | --- |
| D1, R2 | Business records, evidence, conversation attachments and media originals. |
| Durable Objects, Queues | Per-owner coordination, ingestion and job dispatch. |
| Workflows | Research/extraction sequences with persisted steps and waits; compare its guarantees with Can's required workflow semantics. |
| Workers AI, AI Gateway | A model provider and optional model-routing/usage infrastructure, alongside Ollama. |
| Vectorize or AI Search | Knowledge retrieval. Choose a managed or custom retrieval contract for the actual need; do not require both. |
| Browser Run | Research/crawl, extraction and webpage-to-PDF work. |
| Images; Stream/media transformations where required | Gallery derivatives; media review or meeting evidence without a video editor. |
| Email Service/Routing | Mail intake and notifications; an existing Gmail/Microsoft mailbox still needs its own integration. |
| Hyperdrive | A company-owned external database integration where the app actually needs it. |
| Service bindings | Calls between deployed application providers. |
| KV/cache, Analytics Engine, rate limits, secrets, assets | Shared supporting mechanisms; not competing business-record stores or app-authored boilerplate. |

This is a broad developer-platform coverage map, not every Cloudflare account product. DNS/WAF/Access and related deployment features should not acquire new business-language keywords without a demonstrated business use. Cloudflare's binding catalogue provides direct service capabilities; Can does not need the entire management SDK to query D1 or store a file. [Binding catalogue](https://developers.cloudflare.com/workers/runtime-apis/bindings/). Workflows already supplies durable steps and waits; adopting it still requires mapping replay/effects correctly. [Workflow guide](https://developers.cloudflare.com/workflows/get-started/guide/). [Email Service](https://developers.cloudflare.com/email-service/) distinguishes sending from routing.

## JEV comparison and next experiments

Three fully reworded consultations compared provider-shaped typed interfaces, standard domain contracts and dedicated core syntax. Choices were **shared, generic, shared**. Returned probabilities and confidence, all requests/responses, the framing correction and disagreement analysis are in [the consultation record](jev/business-ai-boundary-20261004/review.md). No majority vote settled the grammar.

The useful next draft round is three independent lanes:

1. **Chat → images → gallery**, with one real workflow map and a failed/cancelled/reconnected generation. This tests model contracts, observable work, file provenance and UI together.
2. **Email triage**, with a mixed NOUL/choice/score batch and a staff correction. Compare schema-derived questions against the verbose ordinary typed baseline.
3. **Opportunity discovery**, with two sources, bounded pagination, one failed source, dedupe, cited extraction and reviewed CRM promotion. Compare existing handlers with a compact durable continuation only if the complete source proves the need.

Then use the shared results for Knowledge, Sync, document extraction and Enrich. Each lane should produce requirements, complete Can and corresponding desired JS for its chosen journey; no adapter/runtime implementation is necessary for this draft evidence. Sol High suits the provider/app investigations; a bounded Astra Medium review is appropriate for a consequential shared semantic choice, not every leaf task.

Compare complete outcomes and correction effort, not just source line counts: authored tokens including configuration/rubrics; repeated schema and lifecycle declarations; number of changes for adding a provider/rubric option; visible handling of failure/partial results; consistent JS import/call patterns; and whether a departmental user can inspect and repair the result. Inline BDD should use deterministic provider fixtures, covering normal and ambiguous outcomes. Actual quality, latency, recovery and savings remain measured later against the company's workload; these draft-stage checks must not be mislabeled as executed behavior.

Companies may replace a paid suite with several composed Can apps. Evaluate that complete required outcome, including continuing provider/data/model costs and maintenance, against an equivalent configured subscription or self-hosted alternative. These harder drafts should make that comparison more realistic while keeping realtime canvases, model training and arbitrary autonomous execution outside the proposed boundary.
