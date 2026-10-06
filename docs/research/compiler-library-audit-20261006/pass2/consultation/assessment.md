# Verified-context JEV consultation — C02

Three independently worded equivalent **choice** requests were sent through `tools/jev.py` under AGENTS.md authorization. The state pins the official LSP/JSON-RPC rules, owning parser/server behavior, supported production and test callers, compatibility constraints and limited scope. Each request asks seven separate boundary questions; it selects no individual dependency API. Results are advice rather than executable evidence.

| Boundary | Request 1 choice / confidence | Request 2 | Request 3 | Accepted choice |
| --- | --- | --- | --- | --- |
| numeric_ids | integer_values / 0.6 | integer_values / 0.29 | integer_lexemes / 0.4 | integer_values |
| duplicates | reject_reserved / 0.81 | reject_reserved / 0.78 | reject_reserved / 0.75 | reject_reserved |
| invalid_correlation | legal_detected_id / 0.88 | legal_detected_id / 0.92 | legal_detected_id / 0.83 | legal_detected_id |
| primitive_params | envelope_error / 0.26 | envelope_error / 0.61 | method_error / 0.48 | envelope_error |
| no_param_methods | compatibility / 0.99 | compatibility / 1.0 | compatibility / 0.96 | compatibility |
| method_shapes | required_projection / 0.97 | required_projection / 0.99 | required_projection / 0.98 | required_projection |
| precedence | lifecycle_first / 1.0 | lifecycle_first / 1.0 | lifecycle_first / 1.0 | lifecycle_first |

## Disagreement investigation

Numeric advice split 2–1 with confidence 0.29–0.60. LSP defines integer by numeric value/range, and JSON has one number grammar. No source imposes an integer-only lexical form. We select exact integral values to retain intended legal-value compatibility and raw spelling. A lexical-only profile is simpler, but would reject integral exponent/fraction spellings previously accepted. The implementation must avoid float rounding/underflow, exponent overflow, huge powers, and premature rejection of all-zero coefficients. Sol high independently supplied the zero/underflow/range witnesses and assessed the value interpretation as defensible.

Primitive-params advice split 2–1 with confidence 0.26–0.61. Structured params are a base-message rule, supporting structural invalid-request treatment. The contrary interpretation treats recognizable calls as method-invalid notifications with no reply. The JSON-RPC malformed-message example combines invalid method and params, so it does not uniquely prove the params-only case. We explicitly choose envelope error `-32600`; admitted notifications with malformed method fields remain silent. Current callers are unaffected by this split once the method-local shutdown/exit null exception is retained.

The other five gates are unanimous. Reject reserved duplicates only at the LSP boundary; preserve usable legal-ID correlation; admit omitted/null/empty-object shutdown parameters for actual callers; validate mandatory method fields with compiler fixture corrections; retain lifecycle precedence. Required document-version admission removes malformed fallback/clamping, while admitted version ordering and sync behavior remain unchanged. This correction was made explicit after the independent investigation.

Question framing was independently reworded but shares verified state and alternatives; these are not independent repositories or new empirical implementations. Saved results provide probability/confidence only, not rationales. No measured model-cost reduction is claimed.

## Saved requests and responses

- [Request 1](request-1.json), [response 1](response-1.json).
- [Request 2](request-2.json), [response 2](response-2.json).
- [Request 3](request-3.json), [response 3](response-3.json).
