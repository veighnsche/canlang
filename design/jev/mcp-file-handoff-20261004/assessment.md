# Shared attachment handoff

The missing contract is how a supporting chatbot host supplies new content before invoking a canonical file-valued operation. Existing finalized references, fixture samples and business validation did not specify that transfer. The draft adopts one host bridge to the existing browser upload/finalization flow, with a browser fallback when unsupported; it adds no authored `.can` setup or upload scenario.

| Request | Selected | P(shared host flow) | P(runtime tools) | P(browser only) | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | shared_host_flow | 0.80 | 0.02 | 0.17 | 0.70 |
| 2 | shared_host_flow | 0.81 | 0.03 | 0.16 | 0.72 |
| 3 | shared_host_flow | 0.64 | 0.03 | 0.33 | 0.46 |

All responses identify jev-1.13.0; usage totals 2,809 input and 135 output tokens. Returned probabilities are preserved without normalization; request 1's rounded values total 0.99. Full saved responses retain model/usage. All three authorized calls succeeded without retries.

Selections agree, but the third rewrite gives browser-only a material 0.33 and lower confidence. Rechecked its genuine benefit: browser-only needs no custom host adapter and is sufficient for reference-based calls, at the cost of an extra handoff even on file-capable hosts. The shared bridge is chosen because it reuses current validation and permits a supported complete chat task without sending binary content through model calls. That still requires an implemented host extension; generic MCP compatibility is insufficient. Runtime upload tools could reuse tool transport but do not solve host file access automatically, and large encoded calls add context/chunking burdens. No speed, cost saving or adoption measurement was established.

The [wording check](wording-check.md) preserves factual equivalence and rewords every explanatory field. More detail for the developed proposal remains a framing limitation, not removed by agreement. JEV supplies classification probabilities, not reasoning, authorization or proof. The final concrete bridge schema is the coordinator's contract elaboration after consultation, not a wire design individually validated by the classifier.

DESIGN §8 now pins initialization metadata, opaque file schema annotation, typed intent/context, same-origin destinations, real content upload, immutable completion/retry, current authorization, final business admission, abandonment cleanup and honest fallback. An intent is not approval of incomplete business inputs. The Expense.create witness retains its actual receipt:file input and Employee parent; no fake object or path is treated as a file. REQUIREMENTS and GRAMMAR state that the existing primitive generates this interface with no additional source syntax. Handwritten targets keep their existing file type metadata; bridge advertisement is runtime-derived, not copied into each target.

Checked the pinned official [MCP metadata mechanism](https://modelcontextprotocol.io/specification/2025-11-25/basic/index#meta) and [resources/read](https://modelcontextprotocol.io/specification/2025-11-25/server/resources): custom metadata can identify this Can-specific bridge; resource retrieval does not upload local content. The specification does not establish support in arbitrary hosts. Valid, partial, malformed, oversized, wrong-team, revoked and unsupported-host cases are contract traces, not executed tests. Upload, bridge authentication, adapters, cleanup and end-to-end attachment execution remain future validation.
