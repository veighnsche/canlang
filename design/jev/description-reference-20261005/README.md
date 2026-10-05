# Description and internal reference consultation

Codex research for the user-requested supplemental [description/reference plan](../../../implementation/DESCRIPTION-REFERENCE-PLAN.md). The user confirmed an internal developer and integrator audience. This record is separate from the active Muse-owned challenge checklist and its four adoption-gate consultations.

## Alternatives

A generates a deterministic source-language internal reference and removes declaration-description variants while keeping actual UI localization. B generates the same reference with one shared description value and optional authored translations, reused at description consumers. C starts with a source-grounded AI writer and reviewed translated drafts, adding model cost/nondeterminism/factual review. All alternatives preserve business types and authority and must not invent effects or example success.

The requests preserve equivalent observed facts, audience, authoring/fidelity constraints and alternative costs. All explanatory passages were independently worded; option keys and the narrow choice question stay stable. Local JSON/alternative validation passed. These are bounded design summaries; no source file contents, business records, credentials or authorization headers are present in the request files.

## Commands and outcomes

Source investigation used bounded repository searches/reads and independent read-only consumer/design reviews. It found source-only scenario hover/MCP, locale-aware page metadata, literal field descriptions, existing message/fallback infrastructure and no docs command. No tests, builds, production actions or implementation changes were performed in this round. Missing guessed paths in early searches were corrected using the file inventory; they are not negative capability evidence.

The following three consultations were dispatched independently after the saved requests were structurally validated. JEV is preauthorized in AGENTS.md. Each uses the repository caller, which makes one request and does not automatically retry.

```sh
python3 tools/jev.py design/jev/description-reference-20261005/request-1.json --output design/jev/description-reference-20261005/result-1.json
python3 tools/jev.py design/jev/description-reference-20261005/request-2.json --output design/jev/description-reference-20261005/result-2.json
python3 tools/jev.py design/jev/description-reference-20261005/request-3.json --output design/jev/description-reference-20261005/result-3.json
```

| Request | Result |
| --- | --- |
| [1](request-1.json) | Initially execution-rejected. After explicit user-authorized resend, exit 0; [exact request and response](result-1.json). Model jev-1.13.0 chose optional_shared; confidence .31; probabilities B .54 / A .46 / C .00; 787 input and 43 output tokens. |
| [2](request-2.json) | Initially execution-rejected. After explicit user-authorized resend, exit 0; [exact request and response](result-2.json). Model jev-1.13.0 chose source_only; confidence .71; probabilities A .81 / B .19 / C .00; 777 input and 43 output tokens. |
| [3](request-3.json) | Exit 0; [exact request and response](result-3.json) saved. Model jev-1.13.0 chose optional_shared; confidence .82; probabilities optional_shared .88 / source_only .12 / ai_first .00; 775 input and 43 output tokens. |

The first rejection stated: “The JEV call would send non-public repository design context to an external API and write its response; repository guidance preauthorizes JEV consultations but does not specifically authorize exporting this payload to this destination.”

The second rejection stated: “This sends internal project/design context to an external JEV endpoint; although JEV consultations are preauthorized, the user did not explicitly authorize this specific payload and destination for sensitive-data egress.”

Both stated not to bypass rejection through a workaround or indirect execution. The user subsequently instructed: “send it again to JEV. I removed the restrictions”. Only the two previously blocked requests were then resubmitted unchanged, through the same repository caller to `https://api.typesafe.ai/v1/systemone`; both returned exit 0. The successful third request was not duplicated. The configured credential was used without displaying or saving it. No external permission remains pending for these three completed requests. Aggregate successful usage: 2,339 input and 129 output tokens.

## Advice and uncertainty

Two responses favor optional shared translations, and one favors source-language descriptions. Their probabilities show meaningful disagreement, not consensus: request 2 gives source-only .81, while request 3 gives optional-shared .88. Self-reported confidence is not measured correctness. The strongest opposite case is that all reference readers may share one language, making widespread description translation unnecessary work.

Independent comparison of the three saved requests found equivalent material facts, alternatives and costs. Emphasis varies: request 1 names optional multilingual readership, request 2 stresses real benefit/engineering cost, and request 3 describes MCP reuse more definitely. Those variations may affect salience, but the classifier returns no explanatory rationale, so the reversal cannot be assigned a demonstrated cause. Record **unstable advice under equivalent paraphrases**, rather than taking a two-to-one vote as sufficient proof. All three give AI-first .00 within these alternatives; that does not decide the value of future reviewed guides.

The independently reviewed plan was narrowed to address the engineering-cost objection: first generate a minimal internal developer/integrator reference directly from checked declarations, with optional existing descriptions/translations and one static description value. Reuse the existing TypeScript static locale selector instead of building a second locale engine. Keep localized MCP and artifact migration outside reference acceptance. Meaningful source descriptions stay useful in IDE and MCP, while the reference is a real optional translation consumer. Actual multilingual readership and end-to-end checks remain the deciding evidence for value and fidelity.

All required consultations and bounded disagreement investigation are complete. Source/plan structural review is complete; a queue-only supplemental message has been submitted through the verified existing TUI, with acknowledgment and affected writer release pending. The original 41-task Muse scope continues unchanged until this addition is explicitly acknowledged; no supplemental implementation is claimed.
