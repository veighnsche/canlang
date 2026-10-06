# Task-specific model and reasoning allocation

**Planning proposal, researched 2026-10-07. Implementation remains deferred.** This covers all 27 library-adoption units and all 12 ordered macro steps. The original port packets still require a finite scope and task-specific selection at dispatch. These units are not additional canonical obligations. Preparation/native-release HOLD, ownership, original gates and conditional dispositions are unchanged.

The earlier per-step reminders used general skill defaults. They were not researched task by task. This revision applies current opened official guidance to the actual declared work and incorporates an [independent assessment](reviews/model-task-fit-review.md). It does not establish a measured best model or reasoning level for Can.

## What the sources establish

OpenAI describes Luna as efficient for scoped work, Sol for complex technical work at lower cost than Astra, and Astra for demanding analysis. It explicitly recommends treating this guidance as a starting point and comparing the same inputs. These roles inform the choices below; the documentation does not assign models to Can's task IDs. [Model-selection guide](https://developers.openai.com/api/docs/guides/model-selection).

Low reasoning generally fits extraction/routine edits; medium/high fits code reasoning and diagnosis. Evaluate success, latency, usage and cost per successful task rather than token price alone. [Deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist).

The opened [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) pages verify public API settings. The actual collaboration dispatcher supports the selected pairs. The local [model-selection skill](/Users/vince/.codex/skills/model-selection/SKILL.md) narrows ordinary choices: Luna low/medium, Sol low/medium/high, Astra medium/high. Light means the dispatcher value `low`. This does not change the coordinating chat's model.

## Allocation for each unit

Every choice below is a task-informed inference. The whole-unit column assumes its declared unresolved semantic/integration work; it is not a permanent worker setting. Decompose specified fixtures and records to the cheaper column. Choose stronger support upfront for known consequential risks, without requiring a cheap failure. Independent review is a finite separate packet; the root still owns acceptance and Git for its package programme.

| Unit | Whole technical unit | Independent review | Prepared subtask | Reason and narrower packet |
| --- | --- | --- | --- | --- |
| P01 | Sol / medium | Sol / medium | Luna / low | Inventory extraction is routine; interpreting source-ready versus installed evidence is technical. Raise to Sol high only for conflicting credited evidence. |
| P02 | Sol / medium | Sol / medium | Luna / low | Transcribe aliases cheaply; reconcile original DAG, scope, HOLD and sole writers with technical judgment. |
| N01 | Sol / high | Sol / high | Luna / medium | Design independent IEEE-754, negative-zero, JSON nonfinite and Rust-str/UTF-16 oracles. Prepared seeded fixtures can be cheaper. |
| N02 | Sol / medium | Sol / medium | Luna / medium | Small formatter adapter under a frozen oracle; check real diagnostic callers. Escalate for unexpected carrier or envelope conflict. |
| N03 | Sol / high | Sol / high | Sol / medium | The full unit includes four decisions and actual harness/registration reconciliation. A released leaf formatter alone fits Sol medium. |
| N04 | Sol / low | Sol / medium | Luna / medium | Existing serde_json and a frozen Rust-str signature bound the mechanics. Error callers and the separate UTF-16 truncation residual require review. |
| N05 | Sol / high | Sol / high | Luna / low | Values/validation domain routing, ABI/glue, registration and assets span owners. An already specified individual consumer check can use Sol medium. |
| N06 | Sol / high | Sol / high | Luna / low | Actual Cargo decision assembly and durable/installed consumers must replace source-only and TS-only evidence. |
| D01 | Sol / high | Sol / high | Luna / medium | Freeze sync initialization, first-fault behavior, host closure, malformed admission, mutable cache and verbatim source identities. |
| D02 | Sol / high | Sol / high | Luna / medium | Decoded literals versus UTF-16 spans, import forms, whole-file failures and edit maps affect bundle/modules integration. A frozen pure adapter subpacket may use Sol medium. |
| D03 | Sol / high | Sol / high | Luna / medium | Preserve lookup bias, unmapped and malformed segments, duplicates/order, names, raw identities and mutable-map cache despite library defaults. |
| D04 | Sol / high | Astra / medium | Luna / low | Map composition and invoke fallback must preserve compiled identity across actual Node/workerd and installed diagnostics. Independent critical review is a short separate packet. |
| D05 | Sol / high | Sol / high | Luna / low | Design-only parser-seam comparison remains held for implementation. Astra medium only for a consequential unresolved architecture decision after evidence/JEV. |
| I01 | Astra / high | Astra / high | Luna / medium | Persisted password/token encoding and host comparison policy are consequential security choices. Split the frozen cookie grammar profile to Sol medium. |
| I02 | Sol / medium | Astra / medium | Luna / medium | Implement a frozen strict-hex/base64 policy; review stored compatibility and token hashes independently. Unresolved migration returns to I01. |
| I03 | Sol / high | Astra / high | Luna / medium | Implement qualified host primitives; independently review actual host/timing guarantees, mismatched lengths and surrounding error policy. |
| I04 | Sol / medium | Sol / high | Luna / medium | Frozen cookie adapter is bounded; review malformed first duplicates, Domain refusal and login/logout defaults through real callers. Astra only for evidenced security conflict. |
| C01 | Sol / high | Sol / high | Luna / medium | Grammar/error precedence, full row count and interfaces/UI ownership need a contract decision; prepared corpora are mechanical. |
| C02 | Sol / medium | Sol / medium | Luna / medium | Shared grammar and wrapper implementation follow frozen corpus and ownership. Raise to high for unresolved export/initialization closure. |
| C03 | Sol / high | Astra / medium | Luna / low | Authoritative review-to-commit, consent/digests, stale/deny/replay and resource/error order warrant focused independent authority review. |
| C04 | Sol / medium | Sol / medium | Luna / medium | Conditional serializer evaluation is finite, not automatic adoption. Sol high review only if privacy/file projection or formula protection changes. |
| H01 | Sol / high | Sol / high | Luna / medium | Winning abort reason, streamed body, full-body deadline and reader cleanup are lifecycle races. Prepared race fixtures can be cheaper. |
| H02 | Sol / high | Sol / high | Sol / medium | Conditional quota correction must preserve per-hop policy and deadline/error order. A bounded violation reproduction alone fits Sol medium. |
| E01 | Sol / high | Sol / high | Luna / low | One material semantic comparison at a time; retain-now bookkeeping is cheap. No ten mandatory spikes. Astra only for a specific consequential unresolved decision. |
| R01 | Sol / high | Sol / high | Luna / low | Match the actual released risk: Sol medium for isolated N02/N04/C02; Sol high for joins; Astra medium D04/C03 and Astra high I01/I03 critical review. |
| R02 | Sol / medium | Sol / high | Luna / low | Codex performs Git. Cheap cleanup follows accepted caller-switch evidence; substantive retirement/shared glue joins need Sol high. No blanket TS deletion. |
| R03 | Sol / high | Astra / high | Luna / medium | Coordinate selected qualification with Sol high; use a finite independent combined-invariant review for authority, installed/native/Wasm claims, budgets and rollback. |

R01 is risk-matched rather than a universal Sol high review: its row describes the full join case. R02's substantive review is needed for retirement/shared interfaces, not every accepted deletion. Astra review is restricted to critical diagnostic/authority/security/final joined invariants; it does not make ordinary coding or evidence indexing an Astra task.

## Reminder at every macro step

1. Use Luna low for inventory/crosswalk extraction and Sol medium for P01/P02 interpretation; use Sol high only for an actual source/evidence contradiction.

2. Use Sol high for the full N01/D01 oracle and compatibility contracts. Use Luna low/medium for specified extraction and seeded fixtures after the contract is defined.

3. Use Luna low for packet records. Codex retains Git; finite technical readiness decisions stay Sol medium or high according to their unresolved seam.

4. Select each finite packet separately: N02 and released N03 leaf work use Sol medium; N04 mechanics use Sol low; prepared fixtures use Luna medium. Unfrozen contracts or assembly reconciliation use Sol high.

5. Use Sol medium for N02 and frozen N03 leaf adapters, Sol low for N04 mechanics, and Sol medium for their isolated error/caller review. Full N03 harness/registration reconciliation uses Sol high.

6. Use Sol high for full N05/N06 producer, ABI and assembly joins. A fixed individual consumer check can use Sol medium; routine receipt indexing uses Luna low.

7. Use Sol high for full D02/D03 compatibility and integration packets; a strictly frozen pure adapter can use Sol medium. Prepared corpus generation uses Luna medium.

8. Use Sol high for D04 composition and host joins, with a short Astra medium independent critical diagnostic review. Astra high is reserved for an evidenced new major seam decision.

9. Use Sol high for full backend/installed qualification and risk-matched independent review; use Luna low/medium for exact-source receipt bookkeeping.

10. Follow the family allocation: I01 persisted-security policy uses Astra high; I02/I04 frozen adapters use Sol medium; I03 uses Sol high with Astra high timing-guarantee review; C01/C03 and H01/H02 full joins use Sol high. C02/C04 bounded work uses Sol medium and prepared fixtures use Luna medium. Conditional tasks remain conditional.

11. Use Luna low/medium or Sol low for accepted mechanical cleanup; Sol high for substantive backend-retirement or one material E01 semantic decision. Codex performs Git; do not repeat completed work.

12. Use Sol high for selected joined qualification and a finite Astra high independent critical review; Luna medium handles residual receipts. Review only the actually selected released scope.

## Recheck before each dispatch

Record the finite packet, model, effort, known risks, available evidence and reason for any departure from this map. A frozen small adapter may need less than the parent unit; a new cross-file contradiction may need more. Keep prompts focused and reviewers independent of implementer verdicts. No ordinary packet here calls for xhigh, max or Ultra; a separate coordinated workflow would need its own skill-based justification.

No representative Can model comparison, product build/test, paid API experiment or implementation was run. During later authorized work, record actual completion, repairs/retries, wall time and available usage to refine these starting choices. API pricing is not a measure of Codex subscription usage and does not prove savings. Public documentation cannot establish an optimum for our exact tasks.

[Machine allocation](model-allocation-20261007.json) preserves all 27 IDs and all 12 reminders. The [ordered checklist](../../../implementation/RUST-PORT-START-HERE.md) applies it without changing dependency order, original status or acceptance gates.
