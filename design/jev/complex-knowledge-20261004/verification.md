# CanKnowledge bounded draft verification

2026-10-04. Complete requirements, actual Can source and handwritten desired JavaScript are released for independent review. This is a design/prototype round, not a deployed compiler or provider implementation.

Run from the repository root:

```sh
python3 design/jev/complex-knowledge-20261004/check-draft.py
```

Results and SHA-256 hashes are in [static-verification.json](static-verification.json). `node --check draft/CanKnowledge.mjs` passes. The full prototype parser stops at line 18's typed delivery association with `type permits one array suffix followed by one nullable suffix`. The explicit syntax-only projection passes after replacing delivery associations with text and omitting the corpus declaration/attached description, four shared-state example sequences and page polling. Exact excluded source lines are recorded; the projection proves only the remaining ordinary syntax.

Bounded structural checks match eight models, fifteen scenario handlers/metadata entries, eighteen fixture recipes, fourteen example blocks (thirty table cases and four sequences), four page functions, the trusted `{event}` handler envelope, `{fixtures,examples}` return wrapper and field-style result descriptors. The exact golden quote contains twenty Unicode scalars. These checks do not execute model/read policies or BDD semantics.

The final independent pass additionally runs [descriptor inspection](final-descriptor-review.cjs): all fifty-seven handler, read, invariant, lock and derived-field references resolve, result descriptors have the field-style shape, and fixture dependencies contain no alternate `seed` slot. Native `.trim()` calls were replaced with the canonical pinned Unicode helper. The resolution UI now filters through ordinary Revision read grants before reading withdrawn or superseded guidance. The source expert-disclosure predicate remains `count(row.Escalation)>0` and the target compares an exact count with `0n`.

Focused manual tracing covered independent revision approval, immutable publication evidence, source and selected-field grants, current whole-used-context revocation, historical/as-of preservation after an unrelated publication, budget/unfinished bounds, original-identity cancellation/reconciliation, explicit expert sharing and guarded source-backed resolution notes. The sequences begin with real eligible readable source fixtures and then call ordinary mutations; they do not forge an opaque constructor or retrofit an invalid initial proof. The one-source golden fixture checks source/quote correspondence; uncited-context and selected-file revocation still require shared-runtime tests rather than being claimed as executed by these examples.

Not run: semantic checker/BDD executor, model or index calls, real file extraction, permission race/interleaving tests, receipt/progress reconnect ordering, MCP serialization, browser rendering or historical banners. Those depend on the shared corpus and observable-run implementations. The source's new declarations and desired imports are accepted draft contracts, not claims of available production packages. JEV's material disagreement is retained in the design and its three saved distributions.
