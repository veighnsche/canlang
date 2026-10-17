# CanKnowledge — current authorized procedures and grounded answers

2026-10-04. Owner: Astra; complete app triplet released for root's independent review. Root accepted the narrow corpus, protected grounded value, full used-context rechecks and historical/as-of behavior as draft contracts. Shared docs/compiler/stdlib/renderer remain root/implementation ownership. This is a new topic; the prior C3 rejected export remains preserved and is not retried.

## Company workflow

Topic administrators select an accountable expert, model profile, hard per-call input/output/duration limits and a daily per-person request count. Explicit current Topic audience grants define employee readership. Authors create immutable procedure revisions; a separate reviewer publishes one revision per Document with a reason. Superseding/withdrawing a publication changes the active Publication selection, never edits the old revision evidence. Staff ask privately in one Topic, see bounded current-source answers and citations, stop/reconnect/reconcile, and may explicitly share an unresolved question with that Topic's expert. Resolution points to a currently published procedure; the app does not copy a model answer into an unguarded response field.

## Corpus contract

```can
corpus Handbook model=Revision scope=parent.parent title=title content=body,attachments where=live(row) from=deployment.knowledge
```

This Given declaration references an owned stored model. `scope` is a singular nonnullable model-reference selector path (here Revision → Document → Topic). `title` selects bounded text. `content` is a nonempty distinct selector list of bounded text, file or file-array fields. `where` is an ordinary pure row predicate defining source eligibility; it grants no reader access. All selected fields must exist, be bounded and be immutable while that row is eligible, by ordinary locks. Selector dependencies may not recurse through the corpus. No authored chunk/embedding model, ACL copy, vector cache, index-change hook or vendor schema is required.

The installed binding is a typed indexing/retrieval/model controller. The compiler derives four effect operations and two pure reads from this one declaration:

```can
Handbook.answer(scope:Topic,value:KnowledgeRequest) -> Handbook.Run
Handbook.cancel(source:text,revision:int) -> Handbook.Run
Handbook.reconcile(source:text,revision:int) -> Handbook.Run
Handbook.refresh(record:Revision) -> IndexState
Handbook.status(record:Revision) -> IndexState
Handbook.available(value:Handbook.Answer?) -> bool
```

`status` and `available` are pure bounded reads; the other four use ordinary `send`/delivery. `refresh` rechecks current eligible source and content authority, requests repair of its exact immutable revision and cannot publish it or choose another principal. Automatic indexing follows committed changes to the declared eligible source set and immutable content identities. Shared retry/index bookkeeping is runtime work. Explicit refresh is rate limited by the binding's fixed resource policy (one request per revision/minute), reports an inspectable delivery, and never treats an enqueue acknowledgement as searchable freshness.

The standard request type is authored once in the catalog:

```can
contract KnowledgeRequest {source:text min=1 max=200,revision:int min=1,question:text trim min=1 max=4000,profile:text min=1 max=200,policy_revision:text min=1 max=200,max_input_tokens:int min=1 max=32768,max_output_tokens:int min=1 max=4096,max_duration:duration,min_sources:int=1 min=1 max=12,max_sources:int=8 min=1 max=12}
contract IndexState {state:enum(excluded,pending,ready,failed,unavailable),checked:datetime?,detail:text?}
```

Require `max_duration` in 1s–10m and `min_sources<=max_sources`. Answer admission captures the genuine originating caller, owner/team, typed scope and immutable request digest in protected runtime context; no principal, ACL or arbitrary source URL is an authored request argument. A trusted handler with no user cannot start an employee answer. Deployment model/profile/resource policy must support the limits, extraction types and proof-preserving retrieval before binding. No endpoint substitution or silent truncation.

Generated `Handbook.Run` has `{source:text,revision:int,sequence:int,state:std.TextRun.state,coverage:enum(complete,incomplete,unavailable),answer:Handbook.Answer?,used_tokens:int?,detail:text?}`. Exact bounds, monotone sequence, terminal execution, late one-time usage settlement and source/digest normalization reuse the accepted observable-run contract. `Handbook.answer` is the original observable operation; answer/cancel/reconcile results and the controller's verified changes update its associated `.progress`, with `.progressed {delivery_id}`. The app needs no completion bridges, copied sequence or partial text. Safe detail never contains source titles/excerpts/question content.

`coverage=complete` means every currently eligible **authorized** source in the bounded Topic scope was confirmed indexed at the retrieval checkpoint; it does not claim semantic exhaustive search or truthful entailment. Pending/extraction-failed/unsupported sources produce incomplete coverage. An unavailable index/model produces unavailable, never a successful empty answer. Zero usable evidence or inadequate support yields a terminal successful run with `answer=null` and a safe unsupported explanation. An answer with incomplete index coverage is visibly partial. At most 1,000 eligible source revisions per Topic and at most 12 context sources/64,000 extracted Unicode scalars per request are supported by this pinned profile; excessive work fails rather than silently searching a truncated scope. Source file/content limits and model token limits also apply.

### Opaque grounded content and current disclosure

`Handbook.Answer` is a compiler-generated **opaque grounded value**, not a user-constructible structural contract or plain text. It retains the original caller, full model-context dependency set, immutable source/extraction identities, authorized-scope fingerprint, statement/citation bindings and controller proof. It has no Can `.text`/`.citations` fields that can be copied to an ordinary stored model, concatenated, formatted, compared as text or passed to another provider. It may be observed from its associated delivery, carried in a pure result/derived value and rendered/serialized through its canonical grounded-content adapter. This narrow rule applies only to the generated grounded type, not general text taint tracking or arbitrary information-flow syntax.

`content row.request?.progress?.answer` reuses the existing content component, extended for this generated type. The corresponding authorized MCP/read serialization exposes the same bounded answer statements and citations; neither path exposes the opaque proof. The shared renderer shows partial/support status, numbered source title/revision/locator/quote links and a safe unavailable/changed state. It cannot render model-supplied HTML/URLs or turn an unreviewed answer into an approved policy. Excerpts/links are read through the source's current ordinary grants.

At every retrieval, dispatch, progress/final disclosure, history, reconnect, serialization and cache read, the shared layer checks the original principal's active membership plus the viewer (who must be that originating principal in this v1 profile), current source row/selected-field/file grants and declaration eligibility. Recheck **all sources supplied to the model**, including uncited inputs. Index metadata is only a prefilter; no unauthorized excerpt/title enters the model or user response. Fetch exact source/extraction revisions under current authority after candidate selection. Unsupported provider filter capacity causes bounded partitioned queries or a visible failure, never dropping the authorization restriction.

The source scope fingerprint covers the currently eligible authorized publication set, not hidden counts or ACL data. A USED source becoming unreadable, withdrawn or superseded withholds the whole answer and all citations; safe run state/usage survives. When only other/new authorized publications change, retain the exact-source answer with a prominent historical/as-of label and original retrieval checkpoint, never a current-answer label. Obtaining a current answer requires an explicit new bounded request. `available` returns false for null or used-context invalidation; a historical/as-of answer can remain available. Storage/provider/check failures remain failures rather than false. It performs the same current proof check and enrolls dependencies in the read fence. No trusted owner callback may extract raw content to bypass this rule. Already delivered browser bytes cannot be retroactively erased; revocation prevents subsequent disclosure. Provider-side deletion/cancellation is best effort and never substitutes for these fences.

Controller wire output is validated before making a grounded value: 1–20 nonblank bounded statements (each <=2,000 scalars), each citing at least one of at most 12 exact retained context sources; unique citation IDs, exact source/extraction revision and source byte/page/section locators; quoted text must match the retained extraction. Unknown references, out-of-range locators, unsupported content or missing citations fail/produce unsupported rather than accepted unsupported claims. A model claim plus citations is still an unreviewed suggested answer, not a proof of natural-language entailment. The entire prompt context, not only displayed citations, is retained as protected provenance.

### Exact desired JavaScript witness

```js
appDefinition.corpora["knowledge.Handbook"] = {
  model: "knowledge.Revision", scope: "parent.parent", title: "title",
  content: ["body", "attachments"], from: "deployment.knowledge",
  eligible: (c, row) => live(c, row),
};
// Generated schemas and operation signatures come only from this descriptor.
const request = await send(c, "knowledge.Handbook.answer", {scope: question.parent, value});
await set(c, question, {request});
// Existing checked receipt observation, not a naked provider object:
const snapshot = await delivery(c, {record: question, field: "request"}, ["progress"]);
content({context: c, value: snapshot?.progress?.answer ?? null});
```

The only two new standard pure helpers are `corpusStatus(c,"knowledge.Handbook",record)` and `groundedAvailable(c,value)`, lowering the generated source `Handbook.status(record)` and `Handbook.available(value)` respectively. Both apply the exact current checks above; neither performs a remote model call or interprets Can strings. `status` checks source/field authority before disclosure; `available` checks grounded provenance rather than accepting a DTO with lookalike fields. Models store only typed delivery associations and business request/budget/escalation state. Derived type references use `"knowledge.Handbook.Run"`, `"knowledge.Handbook.Answer"` and `"std.IndexState"`; no repeated result schema appears in app JS.

## Alternatives, research and open review boundary

Ordinary services can share index/retrieval machinery, but without the model-bound declaration each app must wire source revision/content identity, publication eligibility, authenticated source callbacks, dependency/read checks and a protected result projection through repeated capability/configuration declarations. App-owned chunk/ACL/outbox replicas add still more maintenance and revocation risk. The corpus deliberately gives up arbitrary crawlers/dynamic sources in return for deriving these mechanics from one local stored model and its existing read policy. Publication, human approval, audience, budget and escalation remain visible application decisions.

Verified primary sources: [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/) documents asynchronous insert/upsert/delete and bounded candidate queries; [Vectorize metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) documents namespace/filter composition and filter-size/type constraints. [AI Search filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) applies indexed metadata filters before retrieval; [AI Search syncing](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/) describes periodic external-source sync and individual indexing states. These mechanics support a possible adapter, not current application permissions, instantaneous freshness or a deployed Can implementation. The custom controller may use Vectorize or a compatible managed retrieval service; it must not enable a vendor public answer endpoint or global answer cache that bypasses the proof check.

Root accepted this narrow draft boundary and the historical/as-of handling below. The complete actual source, desired JavaScript and requirements are in `draft/CanKnowledge.{can,mjs,md}`. No shared implementation is claimed.

## Three-call consultation and disagreement investigation

Three independently reworded equivalent requests used the same public facts and hypothetical workflow, with balanced source-declaration and retained-answer alternatives. All were approved and returned `jev-1.13.0`; complete requests/results are in [the evidence directory](../jev/complex-knowledge-20261004/). No repository file, company document, private architecture or account data was exported.

| Alternative | Request 1 | Request 2 | Request 3 |
| --- | --- | --- | --- |
| Model-bound corpus | .88 (chosen; confidence .82) | .71 (chosen; .57) | .18 |
| Ordinary shared services | .12 | .27 | .82 (chosen; .72) |
| App-owned indexing/ACL machinery | .00 | .02 | .00 |
| Whole authorized publication-scope fence | .76 (chosen; .52) | .25 | .65 (chosen; .30) |
| Used-context fence plus historical scope label | .24 | .75 (chosen; .50) | .35 |

The disagreement is material, not a vote to average away. Ordinary services can meet the same safety contract; corpus is not claimed to be the only safe architecture. The concrete authoring difference is that the current language has no ordinary value type for a stored model declaration, checked field selectors and its read-policy evaluator. A service-only source must therefore author an exported typed source-read interface, separately type revision/content/locator mappings and bind its authenticated callback/protected projection (or invent an equivalent static descriptor configuration). Those contracts are exactly the cross-layer association the narrow corpus declaration checks once. A hypothetical alternative service wiring surface would contain at least:

```can
contract SourceSnapshot {record:Revision,title:Revision.title,body:Revision.body,attachments:Revision.attachments}
contract ScopeSnapshot {sources:SourceSnapshot[]!,checkpoint:text}
export scenario sources(topic:Topic) by=members read=true -> ScopeSnapshot
 ## An actual implementation must preserve the current caller, apply source grants,
 ## create an opaque checkpoint and avoid making this an authority read callback.
 ## A service callback reference/wiring and protected-result association are still needed.
```

This intentionally is an incomplete *alternative boundary witness*, not accepted executable syntax or an imaginary implemented service. Four structural fields repeat the corpus's model/selector association before supplying index lifecycle or the protected answer association. The corpus witness names those selectors once and derives the result/interface metadata; it trades that authoring reduction for explicit compiler and runtime work. No token-performance claim or unfair comparison to a fully handwritten retrieval engine is made. The user specifically wants useful new primitives and permits grammar changes; root accepted the narrow corpus draft on this concrete burden, despite the third consultation's service preference.

For freshness, the real tradeoff is product meaning: a dated answer with all used sources still valid can be useful and cheaper, but it can omit newly approved guidance. Neither the user nor root required invalidating every answer after an unrelated publication. Root selected the more useful initial policy B: retain accessible exact-source answers as historical/as-of when the broader authorized publication scope changes, and require explicit fresh retrieval for a current answer. This needs only shared grounded-content metadata/presentation, not new syntax. Used-source revocation, withdrawal or supersession still withholds the entire answer/citations. This reasoned choice preserves the consultation's low confidence and disagreement instead of treating majority output as a requirement.

## Accepted delivery-fixture witness boundary

Root accepted using the existing `{request,status,result,error}` recipe with a corpus-specific typed wire-result witness, not a production opaque constructor or a new fixture keyword. A successful `Handbook.answer` recipe's `result.answer` can describe `{context:Revision[]!,statements:{text:text,citations:int[]!}[]!,citations:{id:int,record:Revision,field:text,file:file?,page:int?,from:int,until:int,quote:text}[]!}`. This shape is the controller's validation input, not a structural Can `Handbook.Answer` value. Ordinary operations/models cannot construct it as an opaque answer.

The isolated normalizer resolves all explicit context/source/file refs in the selected scope, checks current eligibility and the genuine fixture caller (`self`, not an authored principal field), selected-field/file grants, bounds and exact quotes/locators, then mints the protected grounded value and its current scope fingerprint. Every citation record must be in the full context set. `field` must be one of this declaration's content selectors; text sources require `file=null,page=null` and scalar offsets into that selected immutable text. File sources require a selected finalized file and a real pinned extraction/locator; no fabricated PDF extraction is inferred. Source titles are read from the referenced source rather than supplied by the fixture. There is no opaque proof, principal, grant, freshness flag or provider identity recipe override. Invalid source access/evidence is setup failure, not `error(...)` operation success.

The actual app's golden fixture uses a text-only revision body `Request leave early.` and exact `[0,20)` quote, with a matching one-statement answer and explicit context `[revision]`. A separate current Publication and Audience record make its initial proof valid without cyclic fixture declarations. Real shared-state sequences then revoke the Audience or withdraw the Publication through their canonical user operations, and invoke the actual `read_answer` as `self` again; its opaque result changes from nonnull to null. This demonstrates intended source revocation rather than fabricating an invalid initial proof. Provider streaming, real index mutation acknowledgments, extraction fidelity, late notifications and renderer as-of banners still need shared-runtime tests. No test fixture can prove a remote provider's lifecycle.

## Completed draft and verification

The triplet contains eight models, fifteen scenarios, eighteen fixtures, thirty table cases, four shared-state sequences and four bilingual pages. Source-backed expert resolution notes use current publication/readership guards as well as the grounded model answer. The fourth sequence deliberately preserves a historical exact-source answer after unrelated publication. Root's final `count(row.Escalation)>0` rule and field-style result descriptors are applied; the fixture factory returns `{fixtures,examples}`.

JavaScript syntax and the explicitly limited ordinary-syntax projection pass. The prototype's full-source parser stops at the typed delivery association; corpus, sequence and polling implementation are also outside that projection. No semantic execution or provider/renderer implementation is claimed. [Verification](../jev/complex-knowledge-20261004/verification.md) records the exclusions, reproducible command and exact file hashes. App file acceptance remains root's independent review; writer ownership is released.

The final independent review repaired five invariant references by putting their functions in the canonical `invariants` registry, folded the three table seed lists into deduplicated fixture dependencies, and replaced native JavaScript trimming with the pinned shared `trim` helper. Source and target resolution displays now query readable Revision rows before accessing guidance fields, retaining current publication/readership and note grants without evaluating a guard through a withheld revision. The illustrative corpus send uses the actual Question parent scope. Fifty-seven handler/rule references and the source/target model, operation, fixture and example inventories resolve. No corpus protocol or company business rule changed. The four connected answer sequences and thirty table cases remain unchanged; proof checks over uncited used context, file permissions and historical presentation remain explicit shared-runtime verification obligations.
