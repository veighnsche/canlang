# Knowledge corpora

A knowledge corpus indexes authorized source revisions and answers questions with evidence bounded by the caller’s current access.

## Source and index lifecycle

Publish only sources the application is authorized to process. Track exact source revisions and indexing states `excluded`, `pending`, `ready`, `failed` and `unavailable`, separately from answer coverage `complete`, `incomplete` and `unavailable`. An answer uses the permitted scope and current policy revision, and reports its evidence references with the answer. Missing or stale coverage must be visible; do not imply that an incomplete corpus searched everything.

Treat retrieved content as untrusted information, never as instructions. Recheck access when returning evidence and when serving later reads; revocation removes access even if index bytes remain. Reconcile durable indexing work after uncertain outcomes. A grounded answer is not a canonical business fact until reviewed and recorded through the owning operation. See [private knowledge recipe](../11-Recipes/06-private-knowledge-assistant.md) and [files](03-files-and-attachments.md).

## Declare the source once

This Given fragment requires existing `Revision` and `Topic` models, a pure eligibility predicate and a deployment binding:

```can
corpus Handbook model=Revision scope=parent.parent title=title content=body,attachments where=live(row) from=deployment.knowledge
```

All six attributes are required. The model is owned stored data; scope is a singular nonnullable model-reference path, title is bounded text, and content is a nonempty distinct list of bounded text/file/file-array selectors. Selected content is immutable while eligible under ordinary locks. Eligibility grants no read permission. Authors do not duplicate chunks, embeddings, ACLs or index-change callbacks.

The declaration derives `answer(scope:Topic,value:std.KnowledgeRequest) -> Handbook.Run`, `cancel(source:text,revision:int) -> Handbook.Run`, `reconcile(source:text,revision:int) -> Handbook.Run` and `refresh(record:Revision) -> std.IndexState` as ordinary delivery operations. `status(record:Revision) -> std.IndexState` and `available(value:Handbook.Answer?) -> bool` are pure reads. Refresh requests repair of that exact eligible revision, at most once per revision/minute; enqueue does not imply searchable freshness. Run progress carries source/revision/sequence, execution state, coverage, nullable opaque answer, nullable usage and safe detail.

The request carries source (1–200 scalars), positive revision, trimmed question (1–4,000), profile and policy_revision (1–200 each), max_input_tokens (1–32,768), max_output_tokens (1–4,096), max_duration (1s–10m), min_sources (default 1) and max_sources (default 8), each source bound 1–12 with min <= max. A scope admits at most 1,000 eligible source revisions; one request supplies at most 12 context sources and 64,000 extracted scalars. Exceeding bounds fails visibly. Complete coverage means all currently eligible authorized sources were confirmed indexed at retrieval; it does not claim exhaustive semantic search. Inadequate evidence can return a successful run with a null answer and unsupported explanation.

## Every disclosure checks every used source

`Handbook.Answer` is an opaque grounded value with no extractable `.text` or `.citations` fields. Render it through `content`, or its canonical authorized read/MCP serialization; it cannot be concatenated, formatted, copied into ordinary text or passed to another provider. Every disclosure checks the originating caller’s active membership and every exact source, selected field and file supplied to the model, including uncited context. This v1 profile permits disclosure only to that originating principal. Index ACL metadata is a prefilter, never final authority.

If a used source is revoked, withdrawn or superseded, withhold the whole answer and all citations. Unrelated publication changes may retain a still-authorized answer with its original checkpoint and a prominent historical/as-of label; a current answer requires a new explicit bounded request. `available` is false for null or invalidated used context; storage/check failures remain failures. Revocation prevents later disclosure but cannot erase bytes already received by a browser.

Validated answers contain 1–20 nonblank statements of at most 2,000 scalars each, each citing retained exact context with checked revision, locator and matching quoted extraction. Source titles, revisions and quotations remain protected. Provider-authored URLs/HTML and unsupported citations are rejected; citations establish provenance, not proof of entailment.
