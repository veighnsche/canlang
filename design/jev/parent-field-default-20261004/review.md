# Parent-derived creation defaults

CanOnboard requires a manually added step to default to its checklist employee, while permitting explicit assignment. The existing field `=expr` syntax could parse that expression, but its parent scope was unspecified. A browser-only prefill would leave MCP and internal creation inconsistent; another creation scenario would duplicate canonical CRUD.

Three semantically equivalent requests restated all context, instructions and alternatives. They compared a resolved-parent creation binding, a prospective-row dependency graph, and separate CRUD argument defaults. All preserve explicit inputs, existing authority/validation and transactional read protection. Wider defaults have genuine additional expressiveness; operation-level defaults make admission policy explicit. The demonstrated app needs neither a sibling dependency graph nor a second declaration surface.

| Request | Choice | Confidence | P(parent) | P(candidate) | P(crud) |
| --- | --- | --- | --- | --- | --- |
| 1 | parent | 0.98 | 0.99 | 0.00 | 0.01 |
| 2 | parent | 0.85 | 0.90 | 0.01 | 0.09 |
| 3 | parent | 0.98 | 0.98 | 0.01 | 0.01 |

Complete requests/responses are retained beside this file. No answer disagreement occurred; confidence/probabilities vary, and agreement is advice rather than proof. Selection rests on reuse of existing default/containment semantics and the concrete missing assignment behavior, not an automatic threshold.

Adopt the resolved immutable `parent` binding for contained-model creation defaults/server initialization. Existing declaration order supplies deterministic evaluation; there is no field-dependency solver, partial row, sibling input scope or new syntax. All creation paths share the rule. Explicit arguments override ordinary defaults; nullability, access, current guards, storage-owner fences and replay remain unchanged. A later parent edit or an update with omitted assignee does not rerun creation.

Source witness: `Step in Checklist {assignee:user=parent.parent.user}`. Desired JS witness: `assignee:{type:"user",default:(c,{parent})=>parent.parent.user}`. The Onboard source/target includes omission/override examples and a causal recovery sequence. Explicit null fails the nonnullable schema, outside correctly typed inline rows. The compiler/runtime default evaluator and example execution remain unimplemented.
