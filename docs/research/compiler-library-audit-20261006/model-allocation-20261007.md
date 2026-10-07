# Compiler task model allocation

This is the historical C-series allocation. Use the [current remaining-reference settings](resumption/model-allocation.md) for work phases, independent review and owner lanes after the resumed audit. Historical source pins and receipts retain their original scope.

**PROPOSED starting settings, researched 2026-10-07 (Europe/Brussels).** These allocations apply to delegated compiler packets. They do not change the coordinating chat's model, release an implementation gate or claim a measured optimum. The previous ten reminders repeated a general policy; they were not ten independently researched task selections.

The inspected sequence is at `b2d54b5029d1426b85994c95dc84ae01a95c88d6`. [Pass 0](pass0/README.md) supplies the contracts and [16 packet boundaries](pass0/packets.json). The current collaboration dispatcher offers the selected model/effort combinations. Check it again at dispatch; public model documentation does not prove account or client availability.

## Online evidence and its limits

The following official pages were searched and opened on 2026-10-07. No source publishes a benchmark or a best setting for these Can compiler packets.

- [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection) distinguishes scoped Luna work from complex Sol work and recommends comparing settings on representative inputs. Its examples are guidance, not a compiler-specific routing result.
- [Codex models](https://learn.chatgpt.com/docs/models) recommends GPT-6.1 Sol for complex coding and Luna for repeatable work. It advises starting with available defaults; its general Luna starting suggestion is High, while quick scoped tasks can use Light/low. The low/medium Luna assignments below are deliberate workload-specific starting hypotheses under the local selection policy, rather than a claim that Codex universally recommends them.
- The [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) pages establish supported API efforts and model roles. Luna and Sol default to medium in the API; Sol has no none/minimal setting. API controls and Codex product modes have different scopes.
- [Reasoning guidance in the deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist) places routine extraction/rewrites at low, code diagnosis and tradeoffs at medium/high, and reserves xhigh/max for demonstrated benefit. That supports differentiating mechanical adapters from unresolved compatibility work.

For clarity, **Luna = `gpt-6-luna`**, **Sol = `gpt-6.1-sol`**, **Astra = `gpt-6-astra`**. Efforts below use dispatcher names `low`, `medium`, `high` (Light corresponds to low in Codex UI). The local model-selection skill permits ordinary Luna low/medium, Sol low/medium/high and Astra medium/high. Supported higher settings are not automatic assignments.

## Cost evidence

[Codex pricing](https://learn.chatgpt.com/docs/pricing) lists these **Standard-speed credit rates per million tokens**, separate from included subscription limits:

| Model | Input credits | Cached input credits | Output credits |
| --- | ---: | ---: | ---: |
| Luna | 2.5 | 0.25 | 12.5 |
| Sol | 50 | 2.5 | 250 |
| Astra | 250 | 25 | 1,250 |

For equal uncached input/output token counts, Sol's listed rate is 20 times Luna's and Astra's is 5 times Sol's. Those ratios do not establish cost per accepted packet: context, reasoning, retries and review affect the run. Included subscription usage cannot be calculated from this credit table. Codex credit billing has no separate cache-write charge; speed modes can change applicable usage/billing.

The separately fetched [API Standard pricing](https://developers.openai.com/api/docs/pricing) lists short-context input/cached/output dollars per million tokens of Luna `0.10 / 0.01 / 0.50`, Sol `2.00 / 0.10 / 10.00`, Astra `10.00 / 1.00 / 50.00`. API-key billing is a separate comparison; do not substitute it for Codex subscription usage. No programme savings or per-task token total has been measured.

## Pass 1

| Task | Start | Why / escalation |
| --- | --- | --- |
| C01IR decoded lowering | Sol low | Existing payload and independent expected values make this a narrow adapter. Raise to medium if literal/metadata routes need different handling or emitted execution disagrees. |
| C01A analysis consolidation | Sol medium | Eight callers carry identity and diagnostic obligations. Raise to high for conflicting schedule/message identity, missing payload recovery or span requirements. |

## Pass 2

| Task | Start | Why / escalation |
| --- | --- | --- |
| C02 LSP byte/envelope admission | Sol medium | Real protocol/lifecycle behavior needs technical judgment even with few defining files. Use high for the separately gated ID correlation, error precedence, numeric spelling or framing decisions. |

## Pass 3

| Task | Start | Why / escalation |
| --- | --- | --- |
| C03U URL adapter qualification | Sol medium | Compare actual owner admission and source diagnostics; preserve authored values. Raise to high when parity differences require policy rather than a narrow adapter. |
| C03L locale qualification | Sol medium | Begin bounded owner-vector/candidate investigation; implementation waits for its gates. Use high for alias/canonical identity disagreement across scalar/context/variant callers. |

## Pass 4

| Task | Start | Why / escalation |
| --- | --- | --- |
| C04H SHA-256 adapter | Sol low | Standard algorithm, known byte contract and independent answers. Raise to medium for feature/footprint or stale-fix/migration consumer differences. |
| C04F file replacement | Sol medium | Mode, no-op and error/order behavior are released; other link/metadata/host scope remains gated. Use high for conflicting host, race or destination ownership choices. |

## Pass 5

| Task | Start | Why / escalation |
| --- | --- | --- |
| C05D diagnostic serializer | Sol low after escape/layout release | Fixed contract supports a narrow conversion. Raise to medium for ordering, omission, escaping or CLI newline disagreement. |
| C05A artifact serializer | Sol medium after family release | Real loaders, versioning and raw content require judgment. Use high for unresolved optional/null, content or consumer closure conflicts. |
| C05M JS descriptors / BDD JSON | Sol medium after family release | Exact scalar strings, authored scale and fragment/emission separation matter. Use high if preservation crosses evaluation or representation ownership. |
| C05R docs/reference serializer | Sol low after frozen schema/layout release | Mechanical typed conversion is suitable once expected output is explicit. Raise to medium for renderer, source-order or revision identity differences. |
| C05P policy/explain/fix serializers | Sol medium, one family per release | Source facts, layout, fix identities and stale-source rejection span consumers. Use high for conflicting shared representation requirements. |

Luna medium may perform repeated conversions only after a writer releases an explicit schema, shared seam and independent expected outcomes; the packet name alone does not establish that condition. Independent substantive acceptance stays with a Sol reviewer.

## Pass 6

| Task | Start | Why / escalation |
| --- | --- | --- |
| C06 JSON input engine | Sol high | Raw numeric lexemes, lexical accessors, ordered/duplicate views, parse-time limits and catalog/LSP callers already interact. This is an upfront recorded reason for high. Split fixed helpers out afterward. Consider Astra medium for a bounded remaining conflict or adapter-complexity decision that Sol cannot resolve reliably. |

## Pass 7

| Task | Start | Why / escalation |
| --- | --- | --- |
| C07DTO typed LSP output | Sol medium | Version/null rules, positions and stale lifecycle need real editor acceptance. Use high if protocol shapes conflict with source/editor ownership. |
| C07URI document URI adapter | Sol medium after contract release | File authority, percent encoding, display conversion and non-file identity require qualification. Use high if one adapter cannot preserve these without a policy change. |

## Pass 8

| Task | Start | Why / escalation |
| --- | --- | --- |
| C08 map codec preserving released byte profile | Sol medium | Source/name ID translation and independent consumer checks are substantive. Use high for a consumer mismatch or proposed coordinate-policy change; browser/editor scope remains gated. |

## Pass 9

These are deferred comparisons, outside the 16 implementation packets. Release a separate exact-file packet before dispatch.

| Comparison | Start | Why / escalation |
| --- | --- | --- |
| CLI / completion consolidation | Sol medium | Passthrough, precedence and exit behavior require comparison. Use high for contract conflicts. |
| ICU syntax / owner parity | Sol high | Exact selectors, quoting, parameter disclosure and parse-time depth interact across compiler and owner. Consider Astra medium for persistent conflicting evidence. |
| Temporal conformance / reuse | Sol medium | Begin finite owner vectors. Use high for offset/range/spelling disagreement or proposed private-core boundary changes. |
| Graph routine / SCC library | Sol medium | Preserve per-origin diagnostic order and witnesses, then compare workloads. Use high if those requirements change the algorithm. |
| Position / path adapter | Sol low after policy release | Existing owner and frozen units support a narrow adapter. Raise to medium for Unicode/CRLF/clamping or root/path identity differences. |

Rowan, Salsa and JS AST architecture remain separately scoped projects; this allocation starts no architectural migration.

## Pass 10

| Task | Start | Why / escalation |
| --- | --- | --- |
| Execute specified checks and capture raw results | Luna low | Follow the exact released command checklist. Hand failures to a technical diagnostician; do not infer acceptance from command exit alone. |
| Reconcile pins, links, coverage and helper inventory | Luna medium | Several known checklist steps; no authority to waive a consumer or choose changed semantics. |
| Independent substantive final review | Sol medium | Assess caller closure, regression independence and real consumer scope. Use high for integration failures or conflicting receipts. |

The same split applies within every pass: Luna low for factual inventory, Luna medium for already defined vectors/receipts, Sol medium for substantive review. Writing a new expected outcome or settling policy is not routine fixture transcription. Hashing/commands can remain ordinary tooling; do not create a worker merely to run one cheap command.

## Calibration and escalation

These are our inferences from official workload guidance plus the verified packet contracts. To establish the most economical successful setting, record each actual packet's model/effort, supplied context, attempts, elapsed time, available token/usage data, review findings and independent acceptance. Keep a lower setting when it meets the same bar; compare a neighboring setting on the same frozen inputs only when a failure or uncertainty justifies the extra work. Include review and correction effort in the comparison.

Escalate the affected task with its concrete reason and evidence. Astra medium is an option for a bounded difficult conflict; high for an already established high-risk/open architectural scope. No selected utility task currently requires Astra, xhigh, max or ultra by default. Coordinated work does not make every child use ultra, and the API model effort list is not a Codex ultra-mode contract. Existing JEV gates, exclusive writers and early checked commits remain in force. No product tests or comparative implementation trials were run for this allocation.
