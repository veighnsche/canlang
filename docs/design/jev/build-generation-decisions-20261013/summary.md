# JEV consultation: open build-generation decisions

Status: consultation complete, 13 October 2026. Advice only; no grammar, configuration, interface or persistence choice is automatically adopted. The [feature requirements](../../../specification/BUILD_GENERATION_REQUIREMENTS.md) remain the outcome owner.

All six open groups D1–D6 were consulted: **18 requests, 25 subchoices and 75 judgments**. Each group received three independently worded requests. Returned model: `jev-1.13.0`; usage: 36,554 input + 3,362 output = 39,916 tokens.

## Findings

| Group | Advice and remaining uncertainty |
| --- | --- |
| D1 Language carriers | Prompt-only style additions are consistently favored; declaration/application/body spelling and initial component scope remain open. |
| D2 Generator configuration | No concrete configuration alternative is consistently selected; the Given/When default role is unanimously left open. |
| D3 Unit association | Tracked association records and unit-centered directories are consistently favored. |
| D4 JavaScript integration | Compiler-visible contributions and truthful JS maps/Can owner links are consistently favored; effects and trust remain unresolved. |
| D5 Style isolation | No consistent hook, nested cascade or affected-use implementation choice. |
| D6 Agent protocol and promotion | JSON dispatch, an acceptance option and file journaling have only request-3 preferences. Promotion remains unresolved. |

Five concrete recommendations are selected in all three requests: prompt-only new style authoring initially; tracked minimal unit association records; unit-centered implementation directories; source-owned compiler-visible generated contributions; and maps to current saved JavaScript with a separate Can owner link. Given application syntax and the Given/When default role are left open in all three requests. The other 18 subchoices have differing selections.

These are recommendations, including moderately confident ones, rather than accepted decisions. Existing user requirements—inline and named styles, implicit frontend, workerd server code, selected-unit operations, editable saved files and zero-AI ordinary builds—were held fixed in every request.

## Method and disagreement

Use JEV [Choice](https://docs.typesafe.ai/primitives/choice) through the [System One API](https://docs.typesafe.ai/api). Each triplet keeps the same verified context, required outcome and balanced candidate descriptions, including an explicit `open` option. The question wording is independently varied and candidate order rotated. The [machine summary](summary.json) retains every probability, confidence, candidate definition and raw-record path.

The first variant asks which draft resolves the outcome with concrete prerequisites; the second asks for the smallest complete choice; the third asks for the best balance at the declared draft stage. The third more often selects a concrete draft. This shows sensitivity to the consultation framing; because both wording and ordering changed, the results do not isolate their respective effects. No reasoning text was returned, so the interpretation here is the root agent’s analysis, not an explanation attributed to JEV.

Reported probabilities and confidence are model judgments, not measured correctness or independent votes. Do not average them into an adoption threshold. `open` means the precise choice remains unsettled, rather than rejection of the feature. Earlier consultations compared narrower candidate sets; their raw records remain historical evidence and do not settle the expanded choices here.

The disagreement was investigated against the actual mechanisms and candidate descriptions:

- **Identity:** [NodeKey](../../../../compiler/src/analysis/mod.rs) is process-local and explicitly never persisted. An association record still needs unique matching plus explicit reconciliation for ambiguous moves, copies or renames; names and fingerprints must not become identity.
- **JS effects and authority:** [HandlerContext and CanonicalEffectsScope](../../../../packages/cloudflare/src/runtime/context.ts) separate raw storage access from projected reads and staged writes. Both proposed effect interfaces must preserve interleaving and canonical commit. Full context cannot simply be passed through. Import admission does not contain ambient JavaScript capabilities; accepting trusted application code is a different contract from an adversarial sandbox.
- **Promotion:** [write_file_atomic](../../../../compiler/src/cli.rs) explicitly states its final comparison is not a compare-and-swap. File journals and directory staging both still need selected-unit writer coordination and a build-read gate. Neither mechanism alone proves protection against arbitrary concurrent writers or prevents mixed group consumption.
- **CSS:** scoped selectors do not stop inherited fonts/colors/tokens, shared styles or parent geometry. The nested boundary must explicitly define inherited inputs and parent access to the child root. Independent files do not promise identical pixels after an ancestor changes.
- **Components:** the verified parser/analysis/IR pilot supplies same-module row-bound `view`/`show`, not arbitrary inputs, slots or exports. Selecting the initial finite input scope is a real choice, rather than a prerequisite to implement an unlimited component system.

## Every subchoice

Each result cell is `choice (probability of that choice; reported confidence)`, in request order 1–3. Candidate IDs are defined fully in [summary.json](summary.json) and the original question files. A displayed probability tie can still have a selected choice: D2 profile schema request 3 returns `.36` for both complete recipes and overlays, with confidence `.04`.

| Decision | Request 1 | Request 2 | Request 3 | Status |
| --- | --- | --- | --- | --- |
| D1 Given keyword | `open` (0.54; 0.39) | `open` (0.63; 0.51) | `modifier` (0.39; 0.19) | Split |
| D1 Given application | `open` (0.72; 0.58) | `open` (0.77; 0.66) | `open` (0.47; 0.20) | All leave open |
| D1 When prompt body | `open` (0.49; 0.32) | `open` (0.52; 0.36) | `quoted_do` (0.43; 0.24) | Split |
| D1 Component prompt carrier | `open` (0.50; 0.25) | `open` (0.48; 0.22) | `header_prompt` (0.72; 0.58) | Split |
| D1 Component input/reuse scope | `bounded_inputs` (0.45; 0.18) | `row_pilot` (0.64; 0.46) | `row_pilot` (0.59; 0.38) | Split |
| D1 New typed style overrides | `prompt_only` (0.60; 0.40) | `prompt_only` (0.61; 0.41) | `prompt_only` (0.83; 0.74) | Consistent recommendation |
| D2 Root config filename | `open` (0.49; 0.32) | `open` (0.43; 0.24) | `can_gen_toml` (0.43; 0.24) | Split |
| D2 Profile schema | `open` (0.42; 0.13) | `open` (0.51; 0.27) | `complete_recipes` (0.36; 0.04) | Split |
| D2 Given/When default role | `open` (0.68; 0.52) | `open` (0.73; 0.59) | `open` (0.59; 0.38) | All leave open |
| D2 Config precedence | `open` (0.66; 0.49) | `open` (0.70; 0.55) | `project_local` (0.50; 0.25) | Split |
| D2 Runner-specific controls | `open` (0.35; 0.02) | `open` (0.46; 0.19) | `normalized_controls` (0.51; 0.27) | Split |
| D3 Stable identity carrier | `association_record` (0.77; 0.69) | `association_record` (0.65; 0.53) | `association_record` (0.80; 0.73) | Consistent recommendation |
| D3 Current/candidate file layout | `unit_directories` (0.70; 0.55) | `unit_directories` (0.64; 0.46) | `unit_directories` (0.79; 0.69) | Consistent recommendation |
| D4 Generated schema/interface ownership | `generated_contributions` (0.75; 0.67) | `generated_contributions` (0.69; 0.59) | `generated_contributions` (0.79; 0.72) | Consistent recommendation |
| D4 JavaScript effects interface | `resumable_effects` (0.43; 0.14) | `open` (0.57; 0.35) | `narrow_facade` (0.54; 0.31) | Split |
| D4 JavaScript execution trust | `trusted_application` (0.48; 0.22) | `open` (0.57; 0.35) | `trusted_application` (0.65; 0.48) | Split |
| D4 Canonical runtime join | `compiler_wrappers` (0.58; 0.37) | `open` (0.56; 0.34) | `compiler_wrappers` (0.72; 0.58) | Split |
| D4 Generated-JS source attribution | `js_maps_owner_link` (0.68; 0.52) | `js_maps_owner_link` (0.57; 0.35) | `js_maps_owner_link` (0.88; 0.82) | Consistent recommendation |
| D4 Finite target validation | `target_by_unit_kind` (0.74; 0.65) | `unit_harness` (0.45; 0.27) | `target_by_unit_kind` (0.55; 0.40) | Split |
| D5 CSS root/part hooks | `open` (0.36; 0.04) | `open` (0.64; 0.46) | `element_attributes` (0.45; 0.18) | Split |
| D5 Nested CSS boundary | `explicit_inheritance_boundary` (0.40; 0.10) | `open` (0.51; 0.27) | `shared_inheritance` (0.45; 0.18) | Split |
| D5 Shared-component use discovery | `derived_index` (0.42; 0.13) | `inspect_graph_walk` (0.45; 0.18) | `derived_index` (0.48; 0.22) | Split |
| D6 Agent request/result protocol | `open` (0.54; 0.31) | `open` (0.70; 0.55) | `json_dispatch` (0.58; 0.37) | Split |
| D6 Composed generation/acceptance | `open` (0.82; 0.73) | `open` (0.78; 0.67) | `accept_option` (0.49; 0.23) | Split |
| D6 Promotion and interruption recovery | `open` (0.42; 0.23) | `open` (0.42; 0.23) | `file_journal` (0.53; 0.37) | Split |

## Finite choices remaining

| Group | Next decision |
| --- | --- |
| D1 | Define local contribution ordering and prompt/body variants; select the smallest component inputs needed by the initial scope. |
| D2 | Specify effective recipe pairing, field origins and enforceable native control mappings, then choose a narrow root schema. |
| D3 | Define unique matching and explicit reconciliation for ambiguous move/copy/rename cases; allocate IDs independently of names/freshness. |
| D4 | Choose the interleaved effects ABI and declared execution trust boundary, then define export/codecs/registry joins and finite target checks. |
| D5 | Define what a nested scope inherits and what the parent may style, including shared-theme and geometry dependencies. |
| D6 | Define versioned lifecycle envelopes and phase results plus selected-unit writer coordination/build-read gating before claiming consistent promotion. |

## Saved requests and responses

| Group | Questions | Responses |
| --- | --- | --- |
| D1 | [1](D1/1.questions.json) · [2](D1/2.questions.json) · [3](D1/3.questions.json) | [1](D1/1.result.json) · [2](D1/2.result.json) · [3](D1/3.result.json) |
| D2 | [1](D2/1.questions.json) · [2](D2/2.questions.json) · [3](D2/3.questions.json) | [1](D2/1.result.json) · [2](D2/2.result.json) · [3](D2/3.result.json) |
| D3 | [1](D3/1.questions.json) · [2](D3/2.questions.json) · [3](D3/3.questions.json) | [1](D3/1.result.json) · [2](D3/2.result.json) · [3](D3/3.result.json) |
| D4 | [1](D4/1.questions.json) · [2](D4/2.questions.json) · [3](D4/3.questions.json) | [1](D4/1.result.json) · [2](D4/2.result.json) · [3](D4/3.result.json) |
| D5 | [1](D5/1.questions.json) · [2](D5/2.questions.json) · [3](D5/3.questions.json) | [1](D5/1.result.json) · [2](D5/2.result.json) · [3](D5/3.result.json) |
| D6 | [1](D6/1.questions.json) · [2](D6/2.questions.json) · [3](D6/3.questions.json) | [1](D6/1.result.json) · [2](D6/2.result.json) · [3](D6/3.result.json) |

Record checks confirm all 18 requests have matching saved inputs, all 75 requested answers are present, and each triplet preserves context/outcomes/candidate descriptions. No generator, grammar or runtime behavior was implemented or qualified by this consultation.
