# JEV consultation record

On October 3, 2026, the initial design pass used the reusable [caller](../../tools/jev.py) for three successful consultations and 17 question judgments. The later inline-testing addition used one consultation with two judgments; the fragment discussion used one with three judgments. All five successful responses identify model `jev-1.13.0` through the `jev-latest` alias. One initial attempt was blocked by sandbox networking before a response; rerunning with authorized network access succeeded. The caller itself never automatically retries.

JEV returns structured judgments, not explanatory prose. The alternatives and evidence were authored here. Its confidence is the model's self-reported judgment, not measured correctness. These results informed the chosen design; they are not tests of a compiler, runtime, security implementation, or application.

## Foundation choices

[Questions](01-foundations.questions.json) · [Exact request and response](01-foundations.result.json)

| Question | JEV choice | Confidence |
| --- | --- | --- |
| Operation types | Explicit parameter types with reusable field types | 1.00 |
| Record scope | Defined lexical record scopes | 0.94 |
| Trusted sources | Separate `on` sources from `by` user authorization | 0.80 |
| Statement boundary | Newline/semicolon separators and indented compound blocks | 0.99 |
| Default storage | Proposed D1 optimistic revision fence | 0.95 |

## Boundary choices

[Questions](02-boundaries.questions.json) · [Exact request and response](02-boundaries.result.json)

| Question | JEV choice | Confidence |
| --- | --- | --- |
| Permissions | Read policies plus operation write authorization | 0.72 |
| Authority | Model-level owner inherited by children | 0.84 |
| Presentation | Bounded components plus composed business views | 0.86 |
| MCP team | One selected team per authorized connection | 0.64 |
| Preservation | Explicit typed copies plus one declarative lock | 1.00 |
| Query privilege | Viewer reads, explicit authorized reports, private mutation checks | 0.99 |
| Existing drafts | Normative spec and reference examples; honestly mark migration work | 1.00 |

The two less decisive choices remain visible. Read policies plus operation authorization were selected to avoid duplicating write ceilings while supporting workflow-controlled fields. Team-bound MCP connections were selected to remove repeated team arguments and limit accidental cross-team calls. These are our design rationales, not prose returned by JEV.

## Final consistency consultation

[Questions](03-consistency.questions.json) · [Exact source snapshot and response](03-consistency.result.json)

The caller attached DESIGN.md and both reference sources. JEV judged all five narrow properties coherent: replay ordering/routing (0.94), schedule replacement/cancellation (0.98), user/trusted-source separation (1.00), the examples' core types/scopes (0.90), and the limited D1 transaction/performance claim (1.00). Subsequent edits clarified default-expression context, the membership admission boundary, team ownership safeguards, and the standard adapter/instrumentation contracts. Those later details were not separately assessed by JEV; the saved request remains the exact reviewed snapshot.

Initial-pass usage: 15,463 input tokens and 813 output tokens. No API keys or authorization headers are saved in these records.

## Inline behavior tests

[Questions](04-inline-tests.questions.json) · [Exact request and response](04-inline-tests.result.json)

The user subsequently required tests mixed into business logic while staying token-efficient. JEV chose attached example tables with shared explicit fixtures over repeated test triples or expectations generated from implementation (confidence 1.00), and judged the proposed separation between production effects and authored expectations coherent (0.97).

This assessed the testing approach described in the request, not a parser or the full subsequent grammar. DESIGN §5.1 specifies its scopes, isolated fixture state, stale-version envelope inputs, seeded report data, and assertions. The two reference sources now include inline examples, which remain unexecuted until a compiler/test runner exists.

This call reported 823 input tokens and 95 output tokens.

## Named fragments versus automatic partial responses

[Questions](05-fragments.questions.json) · [Exact request and response](05-fragments.result.json)

The user asked whether explicit `fragment`/`render` would help AI coding agents. The request compared automatic regions, extracted named fragments, and named inline components, considering one-use content separately from genuinely repeated content. No agent benchmark was supplied or performed.

| Situation | JEV choice | Confidence |
| --- | --- | --- |
| One task-list region rendered once | Keep it inline; automatic runtime fragments | 0.98 |
| Substantial identical subtree on three pages, edited together | One shared fragment with explicit typed bindings | 1.00 |
| Current v1 reference apps, with no demonstrated repeated subtree | Keep automatic regions; defer reusable-fragment syntax | 0.88 |

The recommendation is to retain the current automatic-fragment default. Named fragment reuse becomes justified when an app actually repeats content; making every partial a separately declared fragment would add unnecessary source names/references in the simple case. This is a design inference from the supplied alternatives, not measured agent performance. `fragment`/`render` and inline `id` remain proposals rather than implemented or adopted source syntax.

This call reported 1,372 input tokens and 170 output tokens. Combined usage across successful calls is 17,658 input tokens and 1,078 output tokens, covering 22 question judgments.

## Material decisions from the combined review

The review also replaced ambiguous behavior with concrete rules: schedule keys cross operation boundaries within a package; completed receipt replay precedes stale-version/default checks; DO root creation has stable replay routing; provider results differ from enqueue receipts; cancellation suppresses undispatched notifications; file attachment and historical values obey authorization. No additional verification framework or compiler was introduced.

The D1 fence still needs a real runtime prototype and representative concurrency measurements. The 39 app sources have now been rewritten; [migration coverage](../../draft/MIGRATION.md) records remaining requirements and validation limits. They have not been compiled or executed. JEV agreement does not establish runtime correctness.

## Migration boundaries

[Questions](06-migration-boundaries.questions.json) · [Exact request and response](06-migration-boundaries.result.json)

| Question | JEV choice | Confidence |
| --- | --- | --- |
| Focused/composed source layout | Package-only business sources, thin app entries and explicit build source sets | 1.00 |
| Common CSV requirement | One authorized collection-export runtime contract | 0.73 |
| Verified own-account email | Read-only caller email/verification facts from canonical auth | 0.98 |

The CSV choice was less decisive: the reported alternatives included probability 0.20 for recording a gap instead. The chosen contract belongs to the shared runtime and is still unimplemented. Source layout preserves one declaration per business owner; profiles are alternative assemblies, not independent deployments that can duplicate mutable canonical identities.

This call reported 1,137 input tokens and 154 output tokens.

## Source ownership and explicit gaps

[Questions](07-source-ownership.questions.json) · [Exact request and response](07-source-ownership.result.json)

| Question | JEV choice | Confidence |
| --- | --- | --- |
| Guards reading mutable canonical D1 records | Co-deploy related mutations at D1; record DO placement discrepancies | 1.00 |
| Anchored calendar recurrence beyond the current builtins | Use explicit dates and record the missing calendar contract | 0.99 |
| Retention with forbidden user technical CRUD | Record the trusted-cleanup design gap | 1.00 |

These choices avoid asserting atomic remote policy reads, inventing calendar helpers or exposing forbidden technical deletion tools. They do not declare the affected application requirements fulfilled. Typed adapters also require actual implementations and explicit ingress/egress mapping.

This call reported 942 input tokens and 145 output tokens. Combined usage across all seven successful calls is 19,737 input tokens and 1,377 output tokens, covering 28 question judgments. The two migration responses identify `jev-1.13.0` through `jev-latest`. Later source edits were not individually assessed by JEV, and neither consultation reviewed the complete migrated source catalogue.

## App composition reconsidered after rejected scaffolding

The user rejected `draft/apps/` wrappers and the authored `draft/builds.json` manifest. Consultation 06 had accepted the assistant's one-app-per-loaded-source-set restriction as part of its framing; its advice therefore did not establish that the resulting scaffolding served the requirements. This review reopens that boundary instead of preserving the earlier answer.

Three fresh consultations supplied equivalent facts, constraints and alternatives with rewritten context, instructions and every option description. Relevant requirements and recorded violations were restated in each context rather than attached as identical prose. Before sending, the requests were compared for semantic equivalence, matching question/alternative identities, and different explanatory wording throughout. Exact code and technical names were retained where relevant. This is a comparison of wording sensitivity, not proof that framing bias has been removed.

- Review A: [questions](08-app-composition.questions.json) · [request and response](08-app-composition.result.json)
- Review B: [questions](08-app-composition-b.questions.json) · [request and response](08-app-composition-b.result.json)
- Review C: [questions](08-app-composition-c.questions.json) · [request and response](08-app-composition-c.result.json)

All responses identify `jev-1.13.0`. The table reports choices and their self-reported confidence separately; confidence is not measured accuracy or a probability of adoption.

| Decision | A | B | C |
| --- | --- | --- | --- |
| Deployment boundary | One selected app, multiple declarations permitted (0.99) | Same (0.99) | Same (1.00) |
| Composition notation | App `uses=[...]` attribute (0.27) | Same (0.67) | Same (0.42) |
| Single named-package membership | Same-name default (0.57) | Same-name default (0.55) | Unresolved (0.50) |
| Source resolution | Compiler-derived index under explicit project root (1.00) | Same (1.00) | Same (1.00) |
| Local dependency inclusion | Whole owning package internally; selected product controls default UI/MCP mounting (0.91) | Same (1.00) | Same (0.97) |
| Context baseline | Version-pinned standard team/auth/runtime/presentation defaults (0.99) | Same (0.97) | Same (0.99) |
| File policy | Infer R2, explicitly declare business type/size policy (0.76) | Explicit existing `files R2 types=... max=...` declaration (0.59) | Explicit existing declaration (0.67) |
| Shared owners and conflicts | Deduplicate local packages; retain external schema-only imports; diagnose conflicting context requirements (0.99) | Same (0.99) | Same (1.00) |

The common architectural recommendation is to declare app identity and composition in actual business source, select one app for deployment, and derive discovery/inclusion without an authored source inventory. Finding a declaration does not execute it. App membership and imports remain different: importing a helper/model does not mount the dependency's entire browser/MCP product. Whole-package internal inclusion preserves owning policies, CRUD, hooks and trusted handlers but may include unrelated resources; declaration-level pruning was not assumed. Deployment bindings remain explicit external integration boundaries, never implicit local provider execution. Compatible shared package identities appear once; incompatible settings require a supported explicit resolution.

The disagreements were examined against the source facts and the exact alternatives:

- Automatic membership by matching app/package names is not established. Current names already differ (`CanDo`/`todo`, for example); the proposed convention adds coupling between names or demands renaming. All three assign some probability to an unresolved answer (0.23, 0.27, 0.60). Recommendation for the next design pass: retain the implicit small-app package, and explicitly select named packages until a compact file-independent rule is justified. This recommendation is our reasoning, not an explanatory answer from JEV.
- Both file alternatives separate business type/size policy from shared technical guarantees. The disagreement concerns inferring R2 versus retaining the existing combined storage/policy declaration. No actual token/performance evidence distinguishes them. Recommendation: omit file setup for apps without files, retain the existing explicit policy for apps that use them, and do not invent a universal MIME list or a second file-policy syntax just to infer storage.
- The app attribute won all three syntax choices, but A and C assign substantial probability to unresolved (0.39 and 0.35). App/package name disambiguation and the exact rules for explicitly exposing imported operations remain to be specified. `uses=[...]` is a candidate, not adopted syntax or a verified implementation.

This consultation changed no `.can` source, removed no wrappers/manifest, and did not update the normative grammar. Shared-folder reorganization remains deferred. Runtime behavior, operation exposure, resource reconciliation and compilation still require concrete design/implementation. Agreement is advisory evidence, not a replacement for the user's requirements.

These three calls used 9,782 input tokens and 1,369 output tokens. Across ten successful consultations, the recorded totals are 29,519 input tokens and 2,746 output tokens, covering 52 judgments. The earlier sandbox-blocked attempt received no JEV response. After the user provided standing authorization for JEV calls with relevant design context, these consultations completed without another permission request; that authorization is recorded in [AGENTS.md](../../AGENTS.md).

### Subsequent source migration

The user subsequently requested all app sources be updated and the wrappers/manifest removed. The sources and DESIGN §1 now use `app Name uses=[...]`, explicit named-package membership, compiler-derived discovery, standard context defaults, and explicit existing file/resource policies. The seven portfolio compositions live alongside related business app declarations. Local dependency mounting, app/package name disambiguation and context reconciliation were specified as part of that migration; those exact later grammar details were not a separate JEV request. [Migration coverage](../../draft/MIGRATION.md) records structural checks and outstanding requirements. The saved consultation inputs/responses above remain unchanged evidence of what was actually assessed.

## Repetition audit

The user identified the retained 38 identical file declarations as a repetition violation and required their common policy to become a default. Consultation 08's earlier file-policy alternatives do not override that instruction. A measured audit of all 44 `.can` files supplied counts and current semantics to three freshly worded consultations. Context, questions/instructions and option descriptions were rewritten while retaining the same facts, technical identifiers and alternatives. Their equivalence and wording differences were checked before sending. No identical attached prose or extra permission request was used.

- A: [questions](09-repetition.questions.json) · [request and response](09-repetition.result.json)
- B: [questions](09-repetition-b.questions.json) · [request and response](09-repetition-b.result.json)
- C: [questions](09-repetition-c.questions.json) · [request and response](09-repetition-c.result.json)

All three responses identify `jev-1.13.0` and select the same alternatives:

| Question | Selected alternative | Confidence A / B / C |
| --- | --- | --- |
| R2 default preserving former policy | Coherent as described | 0.28 / 0.12 / 0.88 |
| Equal/default-equivalent attributes | Remove duplicate/default values; omitted lock condition means true | 0.96 / 0.89 / 0.95 |
| Required scalar syntax | Bare scalar required; retain nullable/default/server semantics and required array exception | 0.80 / 0.33 / 0.20 |
| Model/role scope | Team baseline; preserve explicit parent/app alternatives and policies | 0.77 / 0.70 / 0.70 |
| Operation markers | Remove `scenario` and lowercase `then` under When, retaining typed by/on and ordered body | 0.95 / 1.00 / 0.92 |
| Imports | Explicit grouping by package, preserving symbols/aliases/bindings | 0.99 / 0.99 / 1.00 |
| Access/guards | Keep explicit authority and business checks; factor only demonstrated equivalent pure predicates | 1.00 / 1.00 / 1.00 |
| UI/attribution | Preserve selected controls and distinct business evidence; reuse existing defaults/metadata only when equivalent | 1.00 / 1.00 / 1.00 |

Agreement does not mean equal strength. R2 coherence probability varies from 0.41 to 0.92, with unresolved probability as high as 0.35; required-default probability varies from 0.47 to 0.87, with explicit-marker alternatives at 0.39/0.41 in B/C. No explanatory prose was returned. The concrete R2 design therefore specifies resource derivation from runtime-included file types, excludes schema-only provider storage, applies defaults after merging explicit deviations, and keeps content/authorization checks. This makes the implementation contract explicit while honoring the user directive; it is not proven correct by JEV. Scalar requiredness remains a proposal rather than being silently adopted despite variable confidence.

There are no different winning choices to resolve, but the confidence/probability changes show material wording sensitivity. The detailed [audit](../../docs/specification/DECISIONS.md#token-repetition-audit) separates implemented source/default normalizations from proposed grammar changes and measurements from actual token/runtime benchmarks. Only uniform R2/setup and default-equivalent CRUD/lock attributes were applied in this round. Capability-version, loop-budget and implicit-app identity candidates were found by the audit but not separate questions in this consultation.

The three requests used 7,078 input tokens and 1,182 output tokens. Recorded totals across thirteen successful consultations are 36,597 input tokens and 3,928 output tokens, covering 76 judgments. Saved requests/responses are evidence of the supplied alternatives, not a parser, compiler, execution test or guaranteed removal of bias.

## NOUL review of open repetition proposals

The user subsequently requested using NOUL questions for JEV, and this review used them. The assistant incorrectly generalized that request into a future default; the user corrected that interpretation. AGENTS.md and the caller documentation now retain NOUL, choice and score, selected by the actual question. The existing caller already accepts NOUL and preserves its numeric answer, so no caller code or validation framework was added. The [official API reference](https://docs.typesafe.ai/api#noul) defines NOUL as a yes/no probability and returns `{"type":"noul","noul":...}`; it supplies no separate confidence field. Historical requests/responses above remain unchanged.

Six open properties were independently assessed in three semantically equivalent, fully reworded requests. Scope and operation-marker questions were split so model/role defaults and declaration/body compression could receive separate answers. No candidate menu or binary criteria text was supplied; each question used `type: "noul"` and its own instructions. Evidence, constraint meanings and technical identifiers were retained across phrasings; explanatory wording was compared before calls.

- A: [questions](10-noul-repetition.questions.json) · [request and response](10-noul-repetition.result.json)
- B: [questions](10-noul-repetition-b.questions.json) · [request and response](10-noul-repetition-b.result.json)
- C: [questions](10-noul-repetition-c.questions.json) · [request and response](10-noul-repetition-c.result.json)

All responses identify `jev-1.13.0`. Values below are the returned yes probabilities, not confidence or approval scores:

| Property | A | B | C |
| --- | ---: | ---: | ---: |
| Required scalar default preserving field distinctions | 0.65 | 0.84 | 0.27 |
| Team model default with explicit alternatives | 0.64 | 0.49 | 0.68 |
| Implicit existing team role scope | 0.48 | 0.76 | 0.75 |
| Signature/When identifying operations without `scenario` | 0.61 | 0.38 | 0.43 |
| Direct ordered body without lowercase `then` | 0.59 | 0.24 | 0.58 |
| Explicit import grouping preserving dependency boundaries | 0.78 | 0.74 | 0.78 |

The disagreement was investigated by comparing the questions against their shared evidence. They retain the same null/default/array exceptions, non-team ownership choices, mandatory by/on, atomic rollback, example attachment and explicit binding boundaries. No fact reversal was found. Nevertheless, scalar requiredness, roles and operation markers vary materially with wording. Complete parser/diagnostic rules and actual generation measurements are absent; JEV returned no explanation, so the cause of individual scores cannot be asserted. The earlier forced-choice confidence and these independent property probabilities are different outputs and must not be directly compared as a single correctness scale.

Grouped imports have a narrow observed range here, which makes them a more consistent advisory candidate in this review, not an automatically approved or verified grammar. The remaining proposals are unsettled. No fixed cutoff, averaging, majority vote or repeated calls until a preferred answer was obtained were used. No larger grammar proposal was adopted or `.can` source changed in this NOUL round. [The audit](../../docs/specification/DECISIONS.md#token-repetition-audit) now records this additional uncertainty.

These three calls used 3,789 input tokens and 348 output tokens. Across sixteen successful consultations, totals are 40,386 input tokens and 4,276 output tokens, covering 94 judgments. This NOUL review establishes neither an exclusive question type nor a default for subsequent consultations.

## Wide source and necessary newlines

The user requested NOUL advice on preferring wide source with the fewest necessary lines. Three independently rewritten requests supplied the same current one-space indentation, newline/semicolon grammar, scope boundaries, description/comment attachment, authored BDD rows and absence of tokenizer/generation benchmarks. The candidate preserves these boundaries and permits related simple statements in the same block to share a semicolon-delimited line. It does not remove operation markers or introduce a new block syntax.

[Review A](11-wide-layout.result.json) · [Review B](11-wide-layout-b.result.json) · [Review C](11-wide-layout-c.result.json). Each evidence file includes its exact request. Initial sandbox-network attempts failed before a response; the authorized network calls succeeded.

| Yes/no property | A | B | C |
| --- | --- | --- | --- |
| Wide layout is a defensible default for the stated goals | 0.76 | 0.82 | 0.67 |
| Compaction with the specified boundaries retained can preserve semantics | 0.87 | 0.78 | 0.90 |
| Line count alone establishes token savings or generation reliability | 0.06 | 0.10 | 0.21 |

These are returned yes probabilities, not approval thresholds. Wording variation changes strength but not the direction of these results: the wide-layout property ranges from 0.67 to 0.82 and the unsupported performance inference from 0.06 to 0.21. All variants keep the same candidate and qualifications; no supplied evidence explains the remaining probability variation. JEV supplies structured judgments rather than an explanatory rationale. Our interpretation favors compact layout while retaining syntax-required line boundaries; measured model-token or generation gains remain unestablished. No source or normative formatting-policy migration was made by this consultation.

This round used 2326 input tokens and 180 output tokens across three successful calls and nine judgments, all returned by `jev-1.13.0`.

## Reassessment of wide layout

The user challenged the previous inputs' framing and requested a redo. The earlier round characterized optional breaks negatively, stipulated preservation before asking about it, and framed the performance question around missing measurements. Its three paraphrases retained those assumptions. Its results should not be presented as independent validation of a minimum-line default.

The new round compares minimum-line formatting with wide declarations plus separate simple-statement lines. Each variant supplies concrete potential benefits and costs for both: whitespace and separator overhead, local content density, scope/action visibility, delimiter/guard/alias mistakes, patch granularity and diagnostic locations. These effects are hypotheses, not measurements. Identical code illustrates a same-block semicolon join; no compiled equivalence is asserted. Current descriptions/comments, BDD rows, nested structures and incompletely specified simple-statement boundaries remain in scope. No previous JEV probabilities were supplied. All explanatory prose and questions are freshly worded while the facts, alternatives and exact code are preserved; their wording differences were checked before submission.

[Review A: exact input and output](12-wide-layout-balanced.result.json) · [Review B](12-wide-layout-balanced-b.result.json) · [Review C](12-wide-layout-balanced-c.result.json)

| Yes/no property | A | B | C |
| --- | --- | --- | --- |
| Recommend minimum-line formatting as the canonical default over separate workflow statement lines | 0.36 | 0.32 | 0.42 |
| Current written grammar sufficiently defines compaction boundaries without additional clarification | 0.20 | 0.12 | 0.16 |
| Supplied evidence supports a token-cost or correct-generation/revision advantage | 0.09 | 0.08 | 0.19 |

The new default-policy results lean against adopting strict line minimization. This is not a judgment against wide field/argument declarations, which both alternatives share. The result differs from the previous round, but the preservation/performance questions were revised to remove assumed conclusions; the rounds are not a controlled measurement of how much framing changed the answers. Within this round, variation is 0.32–0.42 for the default, 0.12–0.20 for grammar sufficiency and 0.08–0.19 for performance support. None reverses direction, and the supplied facts provide no causal explanation for the remaining variation. JEV returns probabilities, not a prose rationale or proof. The author's attempt to supply balanced tradeoffs does not guarantee neutral framing.

All three successful calls returned `jev-1.13.0`, using 3422 input tokens and 174 output tokens for nine judgments. This consultation changes no normative grammar or `.can` source.

## Lowercase then and direct scenario bodies

The user questioned whether lowercase `then` always follows the last `require` and suggested removing it. A source inventory found 254 markers (154 standalone, 100 inline) and 34 `require` statements within marker-owned bodies. Existing atomic rollback applies to those checks as well as leading checks; `then` is not a universal validation/effect phase boundary.

Three independently rewritten NOUL consultations compared retaining the container with removing only its marker and flattening its block subtree by one level. The proposal keeps `scenario`, uppercase Given/When/Then, one-space indentation, ordered guards/effects, relative branch/loop scope and attached test-only examples. Inputs give both container benefits and direct-body benefits, along with migration/parser/test-boundary risks. These risks and benefits are supplied possibilities, not measured generation outcomes. A schematic nested example illustrates the exact rewrite; no preservation guarantee or benchmark is supplied. Full wording differences and equivalent facts/alternatives were checked before calling.

[Review A](13-direct-scenario-body.result.json) · [Review B](13-direct-scenario-body-b.result.json) · [Review C](13-direct-scenario-body-c.result.json)

The probability of recommending removal was **0.44 / 0.36 / 0.49**. These uncertain answers provide no strong endorsement. All remain below an even probability, with wording variation of 0.13; the evidence does not explain that variation. There is no automatic acceptance/rejection threshold, and JEV supplied no prose rationale. The result does not establish that the wrapper is semantically required or settle the user's design preference. This discussion has not migrated sources or normative grammar.

Three successful `jev-1.13.0` calls used 3271 input tokens and 63 output tokens for three judgments.

## Rename scenario-body introducer to do

The user explicitly requested replacing lowercase `then` with `do` and predicted unanimous agreement. Three fresh consultations compared retaining `then`, renaming it to `do`, using direct statements, or leaving preference unresolved. This comparative question uses `choice`; NOUL remains available for yes/no properties and is not the exclusive/default question type. The evidence supplies the same grammar, corpus counts, examples and plausible costs/benefits across all variants. Every explanatory paragraph, question and option description was rewritten, while exact technical names/code were retained. Option order also varied. The user's prediction and earlier classifier probabilities were not supplied as evidence.

[Exact review A](14-do-body.result.json) · [Review B](14-do-body-b.result.json) · [Review C](14-do-body-c.result.json)

| Review | Returned choice | Returned confidence | P(then) | P(do) | P(direct) | P(unresolved) |
| --- | --- | --- | --- | --- | --- | --- |
| A | unresolved | 0.15 | 0.35 | 0.26 | 0.02 | 0.37 |
| B | do | 0.38 | 0.16 | 0.53 | 0.02 | 0.28 |
| C | unresolved | 0.57 | 0.30 | 0.00 | 0.02 | 0.68 |

There is no unanimous endorsement: the `do` probability ranges from 0.00 to 0.53. Rechecking the inputs confirms the same alternatives, counts, atomicity, intermediate checks, read purity, test boundaries and rename-only semantics. Changes in wording and presentation order remain possible confounders; these calls do not isolate either effect or explain the disagreement. Do not average this variation into a stable ranking or interpret the reported zero as impossibility. The model provided no rationale. The rename follows the user's explicit decision, not a classifier acceptance threshold.

All 254 body markers were renamed across 41 of the 44 `.can` sources. A reverse-substitution comparison verified that no other source text, statement ordering or indentation changed. Both inline and block forms keep their old semantics, and uppercase package `Then` remains presentation. The source rename saves 508 UTF-8 bytes and no lines; model-token savings are unmeasured. Root REQUIREMENTS, DESIGN and migration/current-status documentation now specify `do`; historical evidence is preserved. No executable compiler/runtime validation is claimed.

This round used 3128 input tokens and 159 output tokens across three successful `jev-1.13.0` calls and three choice judgments.

## Syntax borrowings to investigate

The user asked what other languages' syntax could improve canlang. Official documentation was checked for Kotlin non-null/nullable types and safe navigation, ECMAScript nullish fallback, Python augmented assignment, Rust exhaustive matching, CUE reusable constraints and SQL queries. Field shorthand and declarative query clauses already exist in canlang, as do field-type constraint references and pure derivations; they are not new language proposals.

Three freshly reworded choice reviews ranked only which of five ideas deserves a focused design review next: required bare scalar fields, nullable expression operators, compound arithmetic fields inside `set`, exhaustive closed-enum branches, or reusable constrained scalar aliases. Deferral was also available. Context, instructions and candidate descriptions were independently rewritten with equivalent facts and tradeoffs; option/presentation order varied. Official references were recorded, but JEV was supplied the relevant construct descriptions rather than asked to research. The required-marker counts (798 scalar, 18 required-array) are from the earlier repetition audit; a narrower current scan found seven simple same-variable addition/subtraction updates, excluding nested targets. These are occurrence evidence, not tokenizer measurements.

[Exact review A](15-syntax-borrowings.result.json) · [Review B](15-syntax-borrowings-b.result.json) · [Review C](15-syntax-borrowings-c.result.json)

| Review | Returned choice | Returned confidence | P(required scalars) | P(null operators) | P(compound updates) | P(enum match) | P(refinements) | P(defer) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | required_scalars | 0.81 | 0.84 | 0.08 | 0.06 | 0.01 | 0.00 | 0.01 |
| B | required_scalars | 0.73 | 0.78 | 0.16 | 0.03 | 0.00 | 0.02 | 0.01 |
| C | required_scalars | 0.58 | 0.66 | 0.22 | 0.07 | 0.01 | 0.00 | 0.04 |

All three rank required scalar defaults first for investigation. The distribution still varies: its probability spans 0.66–0.84 and null operators 0.08–0.22. No facts/options changed to explain that strength variation, and wording/order effects are not isolated. This is agreement about a bounded review priority, not approval of migration, proof of preservation or measured AI-token savings. Real counted repetition makes the required-scalar option better evidenced than some alternatives; those unequal evidence bases should not be mistaken for a neutral performance comparison. Arrays, defaults, server initialization and nullable behavior must remain explicit in any future proposal.

The other candidates retain identified costs: new precedence/evaluation rules for null operators; checked arithmetic/field evaluation for compound updates; an additional branch form for match; and possible redundancy with existing field references for constrained aliases. No normative grammar or application sources were changed. The proposed sketches remain unadopted.

All three responses identify `jev-1.13.0`. This round used 3507 input tokens and 216 output tokens for three choice judgments.

## Required scalar defaults and nullable expressions adopted

The user authorized the two prioritized borrowings: required scalar defaults and nullable expression operators. Three fresh NOUL consultations reviewed concrete field modes and operator typing/evaluation rather than ranking more features. Each supplied identical cases, migration limits and proposed rules with fully rewritten explanatory prose and questions. Exact snippets were retained. The specification review is not a compiler test or an approval threshold.

[Exact review A](16-required-null-grammar.result.json) · [Review B](16-required-null-grammar-b.result.json) · [Review C](16-required-null-grammar-c.result.json)

| Property | A | B | C |
| --- | --- | --- | --- |
| Field-mode coherence | 0.73 | 0.83 | 0.52 |
| Null-expression typing/evaluation/narrowing sufficiency | 0.67 | 0.72 | 0.74 |

Field-mode judgments vary substantially (0.52–0.83); the rewritten inputs retain the same scalar/array/default/server/update facts. That check supplies no explanation of the difference, and the remaining wording effects are not isolated. Null-rule results span 0.67–0.74. Neither distribution proves correctness or justifies ignoring a concrete defect. The final normative grammar explicitly describes field presence, arrays, lazy fallback, grouping, type-compatible operands, nullable-hop access, non-null equality narrowing and ordinary authorization/error behavior.

All 44 `.can` sources remove 798 required-scalar suffixes. All 18 required-array markers remain, with unchanged nullable/default/server declarations. A mask of strings and metadata preserves those texts and comparison operators. Four `coalesce` calls become `??`, with arithmetic/query grouping retained. Their fallback values are `now` or `money(0,validated_currency)`; they are total pure expressions for the reviewed inputs. Generic `coalesce` evaluation was previously underspecified; `??` now explicitly evaluates its fallback only on null, so arbitrary unreviewed old calls are not claimed equivalent.

Three result guards use `event.result?.source==record.id` instead of an explicit result-presence check followed by equality. The record IDs are non-null. A small truth-case inspection checks null result and null/equal/unequal source outcomes; it is not executable canlang validation. True equality establishes the receiver for subsequent result reads under the specified narrowing rule. Other null predicates and permission decisions remain explicit. Prepared-transform comparison, array-marker inventory and line/depth inspection constrain edits to those changes; authored examples and action ordering are unchanged. The source migration saves 886 UTF-8 bytes, not a measured model-token result.

DESIGN, REQUIREMENTS and draft/current-status guidance are updated. `??` replaces the `coalesce` builtin rather than adding a second fallback form. No compound updates, match construct, scalar aliases, scope defaults or scenario removal are adopted. The compiler/runtime remains unimplemented.

Three successful `jev-1.13.0` calls used 3339 input tokens and 114 output tokens for six judgments.

## Remaining syntax priorities

The user asked what language syntax design still needs work. Three fresh choice consultations compared next focus: team-scope defaults, composable implicit-package identity, documented missing contracts, completing the existing grammar with an initial parser, or deferral. They supplied equivalent product constraints, current constructs, corpus/implementation status and concrete benefits/costs. All explanatory prose and option descriptions were rewritten; option order varied. Review of the requests found the same alternatives and factual claims. The current corpus contains 44 sources, 46 explicit team-model scopes and 67 team-role scopes; the numeric counts were measured separately and were not supplied to the classifier.

[Review A](17-remaining-syntax.result.json) · [Review B](17-remaining-syntax-b.result.json) · [Review C](17-remaining-syntax-c.result.json)

| Review | Choice | Confidence | P(parser/grammar) | P(coverage contracts) | P(composition) | P(scope) | P(defer) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | parser | 0.82 | 0.86 | 0.11 | 0.02 | 0.01 | 0.00 |
| B | parser | 0.53 | 0.63 | 0.30 | 0.00 | 0.00 | 0.07 |
| C | parser | 0.89 | 0.91 | 0.06 | 0.00 | 0.00 | 0.03 |

All select completing the current grammar and initial parsing first, but its probability ranges from 0.63 to 0.91 and coverage from 0.06 to 0.30. Equivalent facts do not explain that variation; wording and presentation order remain possible influences and were not isolated. The classifier supplies no rationale. This is a sequencing recommendation among these supplied alternatives, not proof that the grammar is adequate, a rejection of other necessary work, an agent benchmark, or authorization to implement a compiler now. In particular, grammar completion and parser implementation were bundled as one candidate, so the results cannot distinguish those activities' individual priorities. No normative syntax or application source was changed.

Three successful jev-1.13.0 calls used 2616 input tokens and 162 output tokens for three judgments.

## Team ownership and role defaults adopted

The user requested research, validation with a stop on invalidity, brainstorming, consolidation, planning and implementation of the repeated team qualifiers. A subsequent clarification reiterated one way to express each primitive where possible. The adopted grammar therefore provides one spelling for team ownership/roles rather than retaining the old qualifiers as optional alternatives. No per-package or per-context scope switch was added.

Research consulted [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), which calls for denial without a grant and permission validation on every request, and [PostgreSQL row-security documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), which distinguishes access enforcement through policies from table structure and describes denial without applicable policies after row security is enabled. These principles support keeping access enforcement separate from declaration shorthand; they do not demonstrate canlang runtime behavior or imply that D1 implements PostgreSQL RLS. An independent read-only scope review found no concrete contradiction beyond the intentional replacement of DESIGN's old prohibition on omitted ownership. It identified stored-declaration boundaries, explicit parent/app exceptions, storage placement, record-derived public team resolution, verified trusted context, role identity and default denial as preservation obligations.

Three fresh consultations supplied the same 44-source inventory (46 team models, 67 team-only roles, 116 parent models, no already bare/app-scoped models), exact code cases, current execution limits and proposed semantics. All context, questions and option descriptions were rewritten; the technical examples/URLs/option identities remain the same. Inspection before sending checked equivalent facts, exceptions, costs and alternatives with distinct full-request prose. Choice compared both defaults, role-only omission, unchanged explicit scopes and deferral. NOUL assessed the precise preservation contract rather than serving as an approval gate.

[Exact review A](18-team-defaults.result.json) · [Review B](18-team-defaults-b.result.json) · [Review C](18-team-defaults-c.result.json)

| Review | Choice | Confidence | P(both defaults) | P(roles only) | P(explicit) | P(defer) | Preservation NOUL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | both_defaults | 0.92 | 0.94 | 0.05 | 0.01 | 0.00 | 0.80 |
| B | both_defaults | 0.94 | 0.95 | 0.03 | 0.01 | 0.01 | 0.85 |
| C | both_defaults | 0.27 | 0.45 | 0.29 | 0.10 | 0.16 | 0.62 |

All select both defaults, but review C is substantially less decisive. Re-examining the requests found the same inventory, scope/permission distinctions, migration constraints, examples, alternatives and concrete omission risks. It found no factual difference explaining the result variation. Wording/order effects remain possible and are not isolated; the classifier provides no rationale. Do not average these probabilities into certainty, interpret zeros as impossibility, or treat the decisions as runtime proof. No concrete preservation blocker was identified through specification and source review; this conclusion rests on those explicit rules and comparisons rather than a probability threshold.

Canonical stored Given declarations use `Model {...}` for team scope, including `export` and optional `at=Binding`; parent containment and app scope retain explicit `in Parent` and `in app`. The default is pinned by language version and cannot vary with imports, composition, file location, neighboring declarations or package configuration. Structural declarations and constructors retain their existing meanings. Role declarations use `role Name`, preserving owner assignment, package identity and team resolution. Redundant `in team` and role `in=team` are invalid and diagnostics direct their removal; nonteam roles remain unsupported. Permission grants are not inferred, and no ownership default creates missing team context.

Implementation updated REQUIREMENTS, DESIGN and draft guidance before migrating the corpus. All 44 sources remove only 46 model and 67 role qualifiers, saving 904 UTF-8 bytes. Exact-transform comparison preserves all remaining source characters and authored examples; declaration inspection finds the same effective ownership for 162 models, including all 116 parent scopes, and all 67 role identities/scopes. Lines and indentation are unchanged. DECISIONS and migration coverage now mark the change adopted while retaining historical decisions and prior evidence. No parser/runtime exists, and no executed application or model-token claim is made.

Three successful jev-1.13.0 calls used 3971 input tokens and 207 output tokens for six judgments.

## Implicit app identity and composition adopted

The user requested research, validation with stopping on invalidity, brainstorming, consolidation, planning and implementation of small-app composition without forced package wrappers. The previous assistant rule named every implicit package main and rejected two of them in one selection. The source inventory before this round was 44 files, 48 apps, 49 named packages, one implicit app TeamTasks and no app/package name overlaps. No source referenced synthetic main; an unrelated CanAffiliate fixture string is business data. Parser/runtime and agent/tokenizer benchmarks do not exist.

Research used [Go's import specification](https://go.dev/ref/spec#Import_declarations), which distinguishes the imported dependency from its local access name and requires imported/exported access, and [MCP's tool-name guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names), which recommends case-sensitive unique names within a server and permits dots among a limited ASCII character set. These are naming/visibility principles, not validation of canlang or a reason to import Go's filesystem conventions. An independent read-only review compared direct app identity, App.main, assembly aliases and the rejected wrapper approach. It favored direct identity while identifying app-rename and implicit-to-explicit extraction costs, app-versus-owner lookup distinctions, source boundaries, deduplication, route conflicts, and separate deployment authority as obligations.

Three fresh requests supplied equivalent facts, code examples, alternatives and tradeoffs with every explanatory paragraph, question and option description rewritten. Option order varied; exact technical code/identifiers/URLs remained. Before dispatch, wording comparisons and manual inspection checked unchanged cases, alternatives, rename/extraction liabilities and permission/context boundaries. Choice compared direct_app, app_main, composer_alias and unresolved; NOUL assessed the concrete direct-owner contract. Mandatory wrappers were excluded because the user already rejected that solution.

[Exact review A](19-implicit-app-identity.result.json) · [Review B](19-implicit-app-identity-b.result.json) · [Review C](19-implicit-app-identity-c.result.json)

| Review | Choice | Confidence | P(direct app) | P(App.main) | P(composer alias) | P(unresolved) | Direct coherence NOUL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | direct_app | 0.99 | 1.00 | 0.00 | 0.00 | 0.00 | 0.71 |
| B | direct_app | 0.99 | 1.00 | 0.00 | 0.00 | 0.00 | 0.75 |
| C | direct_app | 0.99 | 1.00 | 0.00 | 0.00 | 0.00 | 0.71 |

Choice is consistent, while the separate coherence estimates remain 0.71–0.75. Reinspection found the same direct-owner contract, examples, inventory, alternatives and costs; no factual change explains the small coherence variation. Wording/order effects remain possible and unisolated, with no classifier rationale. Returned 1.00/0.00 values are not certainty or impossibility. Direct ownership received a detailed rule set for the NOUL assessment while competing mechanisms were sketches with their concrete costs; ranking under that supplied evidence does not prove their universal inferiority, adoption, agent performance or runtime correctness. No probability threshold supplied authorization. The actual decision rests on the explicit identity model and preservation review.

The adopted rule reuses the authored app name as the canonical implicit package identity, without main or a composer prefix. One declaration supplies both app selection and its own owning body, so it is not a second duplicate name. Separate authored app/package duplicates remain errors. Existing `uses=[Tasks]` selects app/context; existing `use Tasks {Todo}` imports exported owner symbols with unchanged local-versus-bound semantics. An assembled app has no aggregate package to import. Several implicit apps can occupy one file, each with optional immediate context, imports before a complete ordered Given/When/Then, and a boundary at the next top-level app/package or EOF. uses and an implicit body cannot coexist. Owners deduplicate across product/import/diamond paths; model, role, event, handler, schedule and operation names remain stable across standalone/composed selection and source moves. Existing permissions, storage binding, parent/team inheritance and separate-deployment authority remain. Routes and named resources are not automatically rewritten.

App-derived ownership has real coupling costs: app renames change API/storage declaration identities, and extraction to a same-named explicit package conflicts with an unchanged app under the shared namespace. Deliberate migration is needed for identity changes; no automatic aliases or data transfers were added. App.main adds a synthetic segment/provider grammar and retains rename costs. Composer-only prefixes leave canonical owner collisions unless internal IDs change, which conflicts with stable standalone/composed identity and complicates deduplication. These costs informed the decision but are not an experimental token/agent result.

Implementation updated REQUIREMENTS, DESIGN, current DECISIONS, draft guidance and the recorded violation. The existing TeamTasks reference now also declares TeamNotes and their TeamOffice selection with unique `/` and `/notes` routes. No wrapper, build manifest, source file or alternate import form was added. The other 43 sources, all 49 named-package bodies and the original task text are identical to the baseline. The corpus now has 50 apps and two implicit owners. Bounded source/selection inspection covered duplicate IDs, app cycles, deduplication diamonds, file-move identity, same-named owner models, incomplete bodies and uses/body conflicts. This inspection is not executable canlang parsing, authorization, generated tool validation or application acceptance. No concrete preservation blocker was found; runtime implementation remains open.

Three successful jev-1.13.0 calls used 4815 input tokens and 219 output tokens for six judgments.


## Demonstrated primitive contracts

The user requested research, validation with a halt for concrete invalidity, brainstorming, consultation, consolidation, planning and implementation of calendar recurrence, trusted retention and typed delegated forms. Inspection started from the existing primitives, not an assumption that three new subsystems were needed. The closed date vocabulary lacks calendar month/year/weekday/range calculations; trusted delete alone conflicts with removal locks and retains data when archived; static operation forms already type inputs, but CanDo's string/JSON router cannot select a heterogeneous owner schema safely. No compiler, parser, runtime, renderer, BDD runner or tokenizer/agent benchmark exists.

Research used primary references: [Temporal date overflow](https://tc39.es/proposal-temporal/docs/plaindate.html) distinguishes calendar addition and clamp/reject policies; [RFC 5545 recurrence](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10) skips invalid dates/times, so adopting RRULE would not automatically implement anchored billing. [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) uses declared input/output schemas and validates operations; [MCP audience restrictions](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#access-token-privilege-restriction) support separate downstream credentials rather than bearer passthrough. [HTML forms](https://html.spec.whatwg.org/multipage/forms.html) supply named typed controls, while [HTMX response handling](https://htmx.org/docs/#configuring-response-handling) requires configured error swapping. These sources describe external standards, not executable canlang support.

Alternatives compared pure calendar helpers versus authoritative expanded dates, RRULE or deferral; declared owner expiry versus separate model deletion policy/private handlers, coordinated external TTL or deferral; finite action references versus generated owner-input unions/router, static typed source forms or deferral. Benefits and costs were supplied for each: producer authority versus grammar scope; cleanup control versus declarative dependency/lifecycle work; static syntax versus repeated layouts and dynamic type/storage/sealing rules. Candidate contracts received more detail than the alternatives' sketches. Rankings therefore reflect that supplied framing and do not establish universal superiority or bias removal.

Three initial requests independently rewrote all explanatory state, instructions, questions and criteria, preserving exact technical examples and alternative identities. A source review then found an input mistake: the inspection example said by=members, while the actual owner uses by=technician. The source guard was never weakened. Original requests/results remain intact with that limitation. Three further fresh requests corrected the role and actual source bindings and incorporated the resolved findings. Every paragraph, question and criterion was rewritten again; pre-dispatch inspection checked the same facts, cases, bounds and alternatives across each triplicate. Shared exact code/identifiers/URLs were retained. The second set limits action values to demonstrated user mutations, states static all-target argument checks, supplies authorized checklist context, and adds physical uniqueness blocks, final-state lifetime validation, monotonic activity and the replay-age/tombstone boundary.

[Initial A](20-primitive-contracts.result.json) · [Initial B](20-primitive-contracts-b.result.json) · [Initial C](20-primitive-contracts-c.result.json) · [Corrected D](20-primitive-contracts-d.result.json) · [Corrected E](20-primitive-contracts-e.result.json) · [Corrected F](20-primitive-contracts-f.result.json). Each result preserves its exact request and response; corresponding questions.json files preserve authored inputs.

Tables round display to two decimals; the linked files retain returned values exactly, including floating-point representation. Confidence is distinct from selected-option probability. No approval threshold or averaged certainty was used.

| Review | Mechanism selected | Confidence | P(selected) | P(alternative 1) | P(alternative 2) | P(unresolved) |
| --- | --- | --- | --- | --- | --- | --- |
| A | pure_helpers | 1.00 | 1.00 | 0.00 (expanded_dates) | 0.00 (rrule) | 0.00 |
| A | declared_expiry | 1.00 | 1.00 | 0.00 (trusted_delete) | 0.00 (external_ttl) | 0.00 |
| A | bounded_action | 0.89 | 0.92 | 0.05 (input_union) | 0.03 (static_forms) | 0.00 |
| B | pure_helpers | 0.95 | 0.96 | 0.01 (expanded_dates) | 0.00 (rrule) | 0.03 |
| B | declared_expiry | 0.99 | 1.00 | 0.00 (trusted_delete) | 0.00 (external_ttl) | 0.00 |
| B | bounded_action | 0.84 | 0.87 | 0.01 (input_union) | 0.11 (static_forms) | 0.01 |
| C | pure_helpers | 0.96 | 0.97 | 0.02 (expanded_dates) | 0.00 (rrule) | 0.01 |
| C | declared_expiry | 1.00 | 1.00 | 0.00 (trusted_delete) | 0.00 (external_ttl) | 0.00 |
| C | bounded_action | 0.75 | 0.81 | 0.02 (input_union) | 0.16 (static_forms) | 0.01 |
| D | pure_helpers | 0.81 | 0.86 | 0.14 (expanded_dates) | 0.00 (rrule) | 0.00 |
| D | declared_expiry | 1.00 | 1.00 | 0.00 (trusted_delete) | 0.00 (external_ttl) | 0.00 |
| D | bounded_action | 0.91 | 0.94 | 0.03 (input_union) | 0.03 (static_forms) | 0.00 |
| E | pure_helpers | 1.00 | 1.00 | 0.00 (expanded_dates) | 0.00 (rrule) | 0.00 |
| E | declared_expiry | 0.98 | 0.98 | 0.02 (trusted_delete) | 0.00 (external_ttl) | 0.00 |
| E | bounded_action | 0.52 | 0.64 | 0.13 (input_union) | 0.20 (static_forms) | 0.03 |
| F | pure_helpers | 0.99 | 1.00 | 0.00 (expanded_dates) | 0.00 (rrule) | 0.00 |
| F | declared_expiry | 0.96 | 0.97 | 0.02 (trusted_delete) | 0.00 (external_ttl) | 0.01 |
| F | bounded_action | 0.78 | 0.83 | 0.01 (input_union) | 0.15 (static_forms) | 0.01 |

| Review | Calendar contract NOUL | Retention contract NOUL | Delegation contract NOUL |
| --- | --- | --- | --- |
| A | 0.86 | 0.85 | 0.90 |
| B | 0.79 | 0.81 | 0.81 |
| C | 0.68 | 0.86 | 0.82 |
| D | 0.87 | 0.77 | 0.86 |
| E | 0.81 | 0.44 | 0.84 |
| F | 0.82 | 0.76 | 0.69 |

All six choose the same directions, but the corrected action ranking spans 0.64–0.94, and corrected retention coherence spans 0.44–0.77. E is a materially less favorable retention property judgment despite selecting expiry. Re-reading D/E/F found the same limits and facts; no factual change explains the spread. Wording effects remain possible and unisolated, and the classifier supplies no rationale. A-C cannot validate real inspection authority because of the supplied role error. Reported zeros/ones are not impossibility/certainty; choice does not prove the separate property.

Investigation of the low retention property result reviewed final-state child deadlines, configuration resurrection, locked removal exceptions, stored references/unique keys, expired cycles, copied sensitive content and replay identity. A separate review identified the older-admission activity regression and the raw<=issue boundary; source now advances last_activity monotonically. Physical keys stay occupied until bounded eligible disposal or an observable retryable block. Expired history cannot preserve sensitive result copies merely to replay: the specified mutation envelope permits a null result with safe committed status, rather than a malformed partial result or re-execution. Source mapping establishes site/origin and stable dedup identity without declaring public browser content truthful. No concrete remaining contradiction was found for the targeted sources under these explicit contracts. Implementation feasibility/performance and complete application acceptance are not proven by that review.

Adoption keeps the scheduler, existing forms, operation registry and owner transactions. Four pure helpers close the calendar expression gap, retain is one canonical lifetime declaration, and action is a finite reference to existing mutations rather than a new perform API. Implementation updated REQUIREMENTS, DESIGN, DECISIONS and draft guidance; 11 existing sources adopt the contracts, with no new .can file, wrapper, manifest, cleanup handler or verification framework. Seven inline tables add 18 independent cases. The other 33 sources are byte-identical; four owner sources change only their existing model/operation export modifiers. CanMaintain also displays the frozen checklist. Source/specification checks and independent Python date/zone observations cover month-end/leap restoration, cross-year coverage, bounded-range rejection and Brussels gap/fold behavior. An initial text scan falsely matched perform in a description and was corrected to check declarations. These are inspections/reference observations, not executed DSL tests.

Migration requires frozen membership-calendar backfills and term input changes, stored Day.year removal, raw-file ownership transfer, changed WorkSources reply shape and matching source/delegation mappings. Leave's 3660-date bound is an explicit request processing budget; it does not become a language-wide entitlement limit. Automatic renewal/cancellation/catch-up, weekly/holiday availability, atomic rental day segments/pricing, actual authorized work-list producers and source-change/poll refresh remain application work. Retention/sealing/dispatch/rendering/MCP generation await the compiler/runtime. Positive finalized-file fixtures remain unresolved. No claim of all-app completion is made.

Six successful jev-1.13.0 calls used 18349 input tokens and 1308 output tokens for 36 judgments.


## Finalized-file fixtures

The user requested research, validation with a stop for concrete invalidity, brainstorming, JEV consultation, consolidation, planning and implementation of finalized-file fixtures for inline BDD. The source gap is demonstrated: Given accepts model fixtures, but the opaque completed `file` type has no production constructor. Required attachment fields cannot receive a concrete valid fixture; null checks absence only. CanExpense and CanContract had no inline tables, and their migration entries explicitly identified this gap. The preceding round's unresolved-file statement is historical; this round closes the notation contract, not runtime execution.

Primary research distinguishes bytes, metadata and application finalization. [Cloudflare R2 writes actual bytes/streams and returns object metadata](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/); a supplied contentType or that return value alone is not an authorized finalized canlang attachment. Multipart completion differs from an incomplete upload. [W3C File construction](https://w3c.github.io/FileAPI/#file-constructor) supplies immutable bytes and name/type metadata without an app attachment grant. [Current Cloudflare test storage isolation](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/) is per test file, so the canlang runner must provide its own per-row isolation. These references describe underlying facilities, not an implemented canlang finalizer.

Alternatives were version-pinned valid samples, real authored relative-path assets, embedded UTF-8/base64 bytes, or deferral. Samples minimize payload repetition but require correct versioned bytes, validators and test-finalizer integration, without arbitrary content fidelity. Assets provide arbitrary inspectable documents with path/bundling/relocation obligations; legitimate test assets were not labeled prohibited scaffolding. Embedded bytes are self-contained and arbitrary, with encoding/bounds and binary-source size/readability costs. One provenance was chosen, without accumulating alternate fixture APIs. Within sample selection, fixed default PDF saves common MIME attributes and stays stable under policy edits; explicit MIME keeps each choice visible but repeats it; allowlist inference adapts compactly but changes sample bytes with policy. A policy excluding PDF must use a different supported type explicitly, not silently change the default.

Three fresh requests rewrite every explanatory state field, instruction, question and option criterion while preserving facts, constraints, technical identifiers, exact code and alternatives. An independent review and pre-dispatch field comparison checked semantic equivalence and full-request wording differences. Before sending, all three clarified that upload-intent checks use the selected fixture owner's identity, with outsider in its own other team; seeded record attachments still use self. The real review/renewal by permissions and guards were supplied. Candidate samples receive a fuller contract than alternate sketches; rankings therefore remain contingent on the alternatives and framing supplied, not proof of universal superiority or guaranteed bias removal.

[Request A](21-file-fixtures.questions.json) · [Request B](21-file-fixtures-b.questions.json) · [Request C](21-file-fixtures-c.questions.json). [Result A](21-file-fixtures.result.json) · [Result B](21-file-fixtures-b.result.json) · [Result C](21-file-fixtures-c.result.json). Each result includes the full exact submitted request and returned response.

| Review | Provenance selected | Confidence | P(pinned sample) | P(authored asset) | P(embedded bytes) | P(unresolved) |
| --- | --- | --- | --- | --- | --- | --- |
| A | pinned_sample | 0.98 | 0.99 | 0.01 | 0.00 | 0.00 |
| B | pinned_sample | 0.97 | 0.98 | 0.02 | 0.00 | 0.00 |
| C | pinned_sample | 0.99 | 1.00 | 0.00 | 0.00 | 0.00 |

| Review | Sample selector selected | Confidence | P(fixed PDF) | P(explicit MIME) | P(infer policy) | P(unresolved) | Coherence NOUL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | fixed_pdf | 0.99 | 0.99 | 0.01 | 0.00 | 0.00 | 0.82 |
| B | fixed_pdf | 0.46 | 0.60 | 0.36 | 0.04 | 0.00 | 0.82 |
| C | fixed_pdf | 0.98 | 0.99 | 0.01 | 0.00 | 0.00 | 0.51 |

All select the same alternatives, but B materially favors explicit MIME more than A/C, and C's coherence is near-even. Re-reading all requests found no changed fact, reversed cost or omitted constraint explaining this variation. Question emphasis differs: A highlights setup/invocation separation, B rejection baselines, C upload authority/setup failures; all these obligations occur in each supplied contract. The classifier provides no rationale, so those wording differences cannot establish a cause. No automatic approval threshold, averaging or certainty claim was applied.

The concrete review rechecked opaque-value construction, content validation versus MIME labels, effective upload policy, authorization under the chosen owner, seeded attachment authorization as self, foreign input versus invalid initial state, identity despite equal bytes, retry stability, rejection baselines and per-row storage/production erasure. No concrete contradiction requiring abandonment was found under these explicit obligations. Their implementation feasibility and correct execution are unproven; high choice probability cannot establish valid sample bytes, finalizer correctness or isolation. The low coherence result remains recorded.

Consolidation keeps `fixture` and `examples`, the owning business operations, existing fixture dependencies and the shared file lifecycle. The adopted recipe is `fixture receipt=file {}`: default pinned valid PDF, selected app, self and its row team. Only differing type/owner attributes are needed. Another declaration yields another immutable upload reference even for equal bytes. The test runtime must provision real checked bytes with normal finalization and attachment rules, capture a baseline after setup and reject invalid setup independently of business errors. A production file literal, byte/asset API, invented opaque ID, upload-state selector or permission bypass is not introduced. Arbitrary authored-content fidelity and upload machinery remain shared-runtime test responsibilities; no new framework or source scaffold is added.


The implementation plan was to specify the file recipe in REQUIREMENTS/DESIGN, record the decision/limits, add focused attachment examples in the two demonstrated apps, and compare source preservation plus table structure. Adoption changes those documents and draft guidance, with five tables/16 independently authored cases in CanExpense and CanContract. Expense uses one claim fixture and existing initial-field overrides instead of copying its required data into three fixtures; agreement tests use separate signed_file/renewal_file fixtures. Existing production signatures, guards, bodies, policies, locks, pages and descriptions are byte-preserved. The other 42 `.can` sources and the 44-file source inventory are unchanged. No new business primitive, fixture keyword, source asset, wrapper or validation framework was added.

Bounded text comparison reconstructs each edited app's original business source; source inspection checks table arity, balanced delimiters and no tabs. The result artifacts were compared to their submitted question files, including answer types. These checks do not parse/type-check canlang, produce finalized objects, execute examples or prove application coverage. The final review also made fixture-only imports explicitly test-only before production dependency/resource inference, consistent with fixture erasure; mixed groups retain their production dependency. The sample catalog/finalizer and per-row storage lifecycle await implementation. All known migration limits remain visible, including the unrelated missing required category in CanOnboard's existing test_step fixture.

Three successful jev-1.13.0 calls used 7541 input tokens and 384 output tokens for nine judgments.

## Schema evolution

The user requested concrete migration notation and a declaration boundary. Research found no compiler/runtime, installed predecessor snapshots or complete historical schema inventory in this checkout. Existing §11 required explicit destructive migrations but left their source form open and overstated automatic compatibility for optional/defaulted fields and indexes. That unconditional claim was rejected: new invariants, uniqueness, historical defaults, locks, retained references and work contracts can make such changes incompatible. The proposal does not invent deployed history for the current drafts.

Primary research informed the implementation boundary. [D1 migration records](https://developers.cloudflare.com/d1/reference/migrations/) track applied SQL changes; our inference is that canlang can generate these artifacts without requiring an authored SQL language or manifest. [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) do not establish atomicity for an entire multi-batch rollout. [SQLite alteration rules](https://www.sqlite.org/lang_altertable.html) constrain schema generation, with actual Cloudflare support still to be pinned. [Durable Object class lifecycle configuration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) is distinct from evolving arbitrary row data; it supplies no proof of cross-authority migration atomicity. JEV received this evidence rather than being asked to research.

Boundary alternatives were top-level owner transitions, maintenance in owning When sections, externally authored intent/mapping through a generated deployment plan, or deferral. When preserves workflow locality but needs a separate full-owner removal boundary or an empty retained shell. Top-level declarations handle removal without a shell but add discovery/scoping rules. Generated plans reduce business source while needing an external mapping channel; reviewing generated output itself is not prohibited scaffolding. Value-transformation alternatives were a typed row mapper reusing pure statements, field expressions with new conditional-expression grammar, maintenance scenarios with complete bounded execution and old/desired typing, or deferral. The row mapper costs partial-state typing and staging; ordinary `for ... limit` supplies neither complete traversal nor resumability. The supplied candidate is more detailed than the competing sketches, which limits conclusions about their relative merit.

Three fresh requests rewrote all explanatory context, instructions, questions and criteria while preserving facts, constraints, alternatives and exact technical code. Independent review and pre-dispatch field comparison checked semantic equivalence and full-request wording differences. All three were amended before dispatch to state that stored null/default initialization advances affected row versions and that owner renames carry only valid surviving role grants. This process does not establish bias removal.

[Request A](22-schema-evolution.questions.json) · [Request B](22-schema-evolution-b.questions.json) · [Request C](22-schema-evolution-c.questions.json). [Result A](22-schema-evolution.result.json) · [Result B](22-schema-evolution-b.result.json) · [Result C](22-schema-evolution-c.result.json). Each result preserves the exact submitted request and returned response.

| Review | Boundary selected | Confidence | P(top-level owner) | P(package When) | P(deployment plan) | P(unresolved) |
| --- | --- | --- | --- | --- | --- | --- |
| A | top_level_owner | 0.85 | 0.89 | 0.11 | 0.00 | 0.00 |
| B | top_level_owner | 0.96 | 0.98 | 0.00 | 0.00 | 0.02 |
| C | top_level_owner | 0.96 | 0.98 | 0.02 | 0.00 | 0.00 |

| Review | Mapping selected | Confidence | P(row mapper) | P(field expression) | P(maintenance scenario) | P(unresolved) | Coherence NOUL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | row_mapper | 0.87 | 0.90 | 0.09 | 0.01 | 0.00 | 0.86 |
| B | row_mapper | 0.73 | 0.80 | 0.04 | 0.13 | 0.02 | 0.67 |
| C | row_mapper | 0.69 | 0.77 | 0.21 | 0.02 | 0.00 | 0.82 |

These preserve returned confidence separately from selected probability, including B's rounded mapping probabilities summing to 0.99. All select the same alternatives; confidence and competing mappings vary materially. Coherence is less decisive in B. Re-reading the requests found no changed fact or reversed alternative explaining the variation. The classifier emitted no rationale, so wording emphasis cannot establish its cause. No averaging, approval threshold or agreement-as-proof was applied.

Consolidation adopts top-level `migration Owner from="snapshot-id"` in real business source, with an exact generated predecessor and current declarations as target. One-to-one owner/model/field rename/drop intent is explicit; `backfill Model` reuses pure `require`/`do`/`if`/`set` with immutable old state and a typed partial target. Applied artifacts remain immutable and separate from current upgrade alternatives. Conditional automatic changes, old locks, full stored-state validation, attachment identity, retention and actual pending release contracts remain binding. Work invalidation is limited to undispatched occurrences of a pinned predecessor handler. Record splits/merges, new-model population from old rows, team/containment/physical-authority transfers and generic payload rewrites are outside this subset. Unknown history or insufficient authoritative DO inventory blocks installation.

Post-consultation review clarified removed-owner resolution, identity mapping before value initialization, renamed-field transformation, incompatible/invalid target values, immutable applied-target history, preservation of old lock predicates/coverage and handler-contract matching across retained releases. These are our findings and final clarifications; they were not separately scored or explanations for JEV's uncertainty. In particular, retaining values while removing their old evidence lock must not create an indirect editing bypass. The deliberately limited contract has no identified contradiction after these repairs; runtime feasibility remains unproven.

The implementation plan was to update REQUIREMENTS/DESIGN, record the choice and limits in DECISIONS and draft guidance, retain the hypothetical before/desired snippet in DESIGN, and check source/artifact preservation. No real app migrations were authored without installed snapshots. Member's historical calendar backfill remains dependent on defensible old values, Leave's year-field removal on its actual predecessor, and Catch's record split on an extension beyond this subset. No new `.can` file, schema copy, wrapper, authored manifest, SQL escape or verification framework was added. Snapshot production, diff/type checking, staging, inventory and the migrator remain implementation work.

Bounded comparison found all 44 `.can` sources and their inventory unchanged. The saved submitted requests match their authored payloads plus the caller's `jev-latest` model field; response types/options, unchanged technical code, distinct explanatory wording and usage totals were checked. The illustration was inspected for its top-level boundary, one-space nesting, explicit rename/drop and both required-priority paths. Local documentation targets exist and code fences are balanced. These text/artifact checks do not parse/type-check canlang, validate a historical schema, execute BDD or apply a migration.

Three successful jev-1.13.0 calls used 8106 input tokens and 372 output tokens for nine judgments.

## Exact grammar and initial parser

The user requested research, rejection of invalid proposals, consolidation and implementation of exact statement boundaries, contextual keywords, field-type reuse, queries and inline/block forms, followed by an initial parser exercised against existing source. The audit covered 44 `.can` files and 4418 physical lines before the source correction. There was no parser, checker or runtime at consultation time. The corpus demonstrated nested query domains, aggregate argument boundaries, named arguments, reused field types and UI selector lists; it contained no semicolons, unions or migrations, so corpus acceptance alone could not exercise the designed grammar.

Technique research used [Python's official lexical reference](https://docs.python.org/3/reference/lexical_analysis.html) for logical lines, delimiter joining and contextual words, and the [original author's parsing chapter](https://github.com/munificent/craftinginterpreters/blob/master/book/parsing-expressions.md) for recursive-descent syntax trees and expression precedence. These inform parser machinery; Python whitespace and keyword rules are not canlang rules. The concrete invalid source was CanStock's executable `let` before `do`; accepting it would contradict the established leading-guard/body boundary. The correction moves that binding, its subsequent guards and the create into block `do`, retaining their order and actual `by=stock_staff` authorization.

The alternatives were to retain contextual low-binding query tails or replace them with mandatory `query(...)`, and to bound type suffixes or define recursive grouped types immediately. Both questions also offered an unresolved outcome. Wrapper queries make extent explicit at a per-use token/migration cost; recursive types express richer values but need additional nesting/nullability contracts. Contextual tails preserve the demonstrated compact queries but require exact delimiters. The flat subset limits expressiveness while avoiding uncontracted suffix combinations. Separate NOUL questions assessed field-value reuse and the supplied grammar's determinism; no approval threshold was used.

Three complete fresh requests retained the same facts, alternatives and exact technical code while rewriting context, instructions, questions and option/criterion descriptions. Full-request text comparison and independent semantic review found no changed fact or reversed alternative before submission. Every explanatory string differs across the three requests; code/technical identifiers remain stable.

- A: [Questions](23-exact-grammar.questions.json) · [Exact request and response](23-exact-grammar.result.json)
- B: [Questions](23-exact-grammar-b.questions.json) · [Exact request and response](23-exact-grammar-b.result.json)
- C: [Questions](23-exact-grammar-c.questions.json) · [Exact request and response](23-exact-grammar-c.result.json)

| Question/type | A | B | C |
| --- | --- | --- | --- |
| Query spelling, choice | contextual_tail; confidence .99; probabilities contextual_tail 1, explicit_wrapper 0, unresolved 0 | contextual_tail; confidence 1; probabilities contextual_tail 1, explicit_wrapper 0, unresolved 0 | contextual_tail; confidence .99; probabilities contextual_tail 1, explicit_wrapper 0, unresolved 0 |
| Type suffixes, choice | flat_bounded; confidence 1; probabilities flat_bounded 1, recursive_grouped 0, unresolved 0 | flat_bounded; confidence 1; probabilities flat_bounded 1, recursive_grouped 0, unresolved 0 | flat_bounded; confidence 1; probabilities flat_bounded 1, recursive_grouped 0, unresolved 0 |
| Field-value reuse, NOUL | .83 | .87 | .88 |
| Grammar coherence, NOUL | .62 | .71 | .66 |

There is no categorical choice disagreement, but overall coherence is materially uncertain. Re-reading the requests found no factual reversal explaining the variation. JEV returned no rationale, so its probabilities cannot diagnose a particular parser defect or establish the cause of wording sensitivity. Agreement is advice, not proof or guaranteed removal of bias. Confidence and probability are preserved separately; no average or rounded yes/no verdict replaces them.

Consolidation retains ordered contextual query tails, uniform type paths with later resolution, bounded named unions/array/nullability, one-space suites, joined delimiters and inline leaf sequences. GRAMMAR specifies closed attributes, contextual roles, exact routes, initializer placement and distinct schema/value/example productions. A compact standard-library parser now parses declarations, expressions, types, queries, effects and example tables into located syntax trees rather than preserving unchecked token tails. The implementation plan was one parser, focused tests for absent/boundary syntax, corpus parsing and a source-preservation comparison; no framework, authored manifest or app wrapper was added.

Post-consultation implementation review clarified required UI suites versus optional page bodies, enum names versus action paths, handler paths versus `every(DURATION)`, mutation paths, contextual model names in semicolon sequences, and exact numeric tokens without floating-point conversion. These are our repairs, not further JEV classifications. The requests proposed spans; the initial AST retains physical start positions, with complete end spans left unimplemented. File recipes, reused-type suffix suitability, modes, resource/operation references and other value/authority obligations still need semantic checks. Authored refresh/poll syntax remains unspecified; it was not invented to fill a gap.

All 44 existing sources parse, and 25 focused parser tests pass. A bounded comparison confirms the other 43 files are byte-identical and the only source change is the ordered CanStock body correction, increasing the corpus by one physical line. Saved requests match authored JSON plus the caller's model alias. This establishes source syntax and artifact preservation only: imports/names/types/permissions, executable migrations, finalized-file provisioning and inline BDD remain unimplemented. CanOnboard's missing required fixture category and the previously recorded app/runtime gaps are not repaired by syntax acceptance.

Three successful jev-1.13.0 calls used 7996 input tokens and 390 output tokens for 12 judgments. No credentials or authorization headers were saved.

## Built-in internationalization

The user requested a language primitive with translations beside business source and shared wording without repetition. The audit found 87 literal page titles and page descriptions, 189 scenario descriptions, 50 app descriptions, 47 package descriptions, 24 literal email subjects, three literal email bodies and three literal alert messages. Many other outbound bodies are business data. Across the 44 sources, 1263 string literals have 414 distinct values. `Reception` occurs as both stored fixture data and a page title: scanning strings or using English text as global keys cannot determine meaning. Generated CRUD/auth/team controls and field/value labels also need localization. At consultation time the syntax parser had 25 tests; there was no checker, compiler, renderer, message engine or BDD runner.

Primary research used [ICU's message guide](https://unicode-org.github.io/icu/userguide/format_parse/messages/) and [FormatJS syntax](https://formatjs.github.io/docs/core-concepts/icu-syntax/) for whole-message plural/select patterns, [Unicode MF2](https://unicode.org/reports/tr35/tr35-messageFormat.html) for annotated selectors and formatter status, [Fluent terms](https://projectfluent.org/fluent/guide/terms.html) for reuse and grammatical-case risks, [RFC 4647](https://www.rfc-editor.org/rfc/rfc4647) for lookup/defaults, [W3C direction guidance](https://www.w3.org/International/questions/qa-html-dir) for bidi markup and [Cloudflare web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) for `Intl`. In the examined UTS35 48.2 text, MF2 date/time functions are Draft; treating every formatter as upstream stable was rejected. Workerd's `Intl` support does not install an ICU message engine.

The layout alternatives were one owned table declaring locale columns once, individually locale-keyed messages, or deferral. Tables save repeated tags but require coordinated positional column edits; keyed messages support sparse independent changes at a repeated-tag cost. The pattern alternatives were a bounded ICU MessageFormat profile, MF2 with its declarations/annotations and a pinned decision on Draft formatters, or deferral. Both require compiler checks and a pinned runtime adapter. Separate NOUL questions examined sharing and presentation semantics. Existing whole-package imports would overreach for shared words; message-only asset closure and composed-app metadata import scope were included explicitly, with mixed business groups retaining their original inclusion rules.

Three fresh requests rewrote every explanatory context string, instruction, question and option description while preserving the facts, constraints, alternatives and exact technical code. Field comparison and independent review checked semantic equivalence and distinct full-request prose before dispatch. This process does not prove bias removal.

- A: [Questions](24-i18n.questions.json) · [Exact request and response](24-i18n.result.json)
- B: [Questions](24-i18n-b.questions.json) · [Exact request and response](24-i18n-b.result.json)
- C: [Questions](24-i18n-c.questions.json) · [Exact request and response](24-i18n-c.result.json)

| Review | Layout selected | Confidence | P(table) | P(keyed) | P(unresolved) |
| --- | --- | --- | --- | --- | --- |
| A | keyed | .49 | .34 | .66 | 0 |
| B | table | .25 | .50 | .49 | .01 |
| C | table | .79 | .86 | .14 | 0 |

| Review | Pattern selected | Confidence | P(ICU) | P(MF2) | P(unresolved) | Sharing NOUL | Semantics NOUL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | icu | .87 | .92 | .02 | .06 | .86 | .87 |
| B | icu | .96 | .98 | 0 | .02 | .81 | .90 |
| C | icu | .92 | .94 | .03 | .03 | .81 | .87 |

Layout judgments disagree materially, and B is nearly even. Re-reading the requests found no changed fact or reversed tradeoff explaining that disagreement: each supplies positional maintenance versus independent additions, and token savings versus repeated tags. The classifier returned no rationale, so the cause remains unknown. No averaging, majority rule, automatic approval threshold or agreement-as-proof was applied. The author chooses the table because the user's explicit repetition priority outweighs independent sparse row edits here, while recording its maintenance limitation. No model-token benchmark is claimed.

Consolidation adopts one Given-owned `messages` table, named typed messages, `for path` label bindings, `#= message_path` descriptions and existing export/grouped imports. Ordinary strings/data remain literal. Runtime catalogs supply standard controls once. Whole-message lookup uses the selected variant's locale; localized descriptions reuse browser/MCP metadata while machine names remain fixed. Outbound rendering uses the typed `format(message,locale=...)` overload and freezes locale/content/release before retries. There is no translation folder, wrapper, new business operation, copied interface or automatic translation. A source-text-key overlay and unrestricted localization of machine/business strings were rejected before implementation.

Post-consultation review pins the bounded ICU format/quoting forms, selector type rules, exact numeric preservation, civil-date handling, money scale/currency, and presentation provenance. Locale lookup tie-breaking and the contextual `null` message path are explicit. These clarifications are our findings, not JEV rationales or additional scored claims. They depend on an actual message engine and semantic checker, neither implemented here.

The implementation plan was to update requirements/design/grammar, extend the existing syntax parser and focused tests, and demonstrate shared/generated/parameterized wording in the existing task/notes reference. The parser constructs message and description-reference nodes, checks table widths/duplicate raw tags, accepts text expressions and captures composed-app imports. It does not validate ICU patterns, canonical BCP 47 aliases, symbol categories, argument types or runtime behavior. The reference preserves stored task/note content and business declarations, adds labels/localized captions and one plural observation to its existing inline example. Source inventory remains 44 files; the other 43 are byte-identical. There is no bulk translation claim.

All 30 parser tests pass and all 44 sources parse. A bounded text reconstruction preserves the reference's original model, policy, CRUD, fixture, query/action ordering and original example cases after reversing only the recorded presentation/example additions. Saved requests match their authored payloads plus the caller's model alias; technical code, rewording and usage totals were checked. These are syntax/source/artifact checks, not compilation or BDD execution. Locale preference, catalogs, ICU validation/rendering, exact adapters, provenance checks, HTMX/MCP localization and outbound freezing remain runtime/compiler work. Existing unrelated app gaps remain open.

Three successful jev-1.13.0 calls used 7618 input tokens and 349 output tokens for 12 judgments. No credentials or authorization headers were saved.

## Frontend requirements target

The previous requirements-only pass saved [A](26-frontend-requirements.result.json), [B](26-frontend-requirements-b.result.json) and [C](26-frontend-requirements-c.result.json). All selected eligible-page navigation and a runtime personal-configuration primitive. Overall coherence NOUL estimates were .84/.90/.82; navigation alternatives retained .06 for all-pages-with-exclusions in B and .01 in C. The staged CanDo shell target is now consolidated into root REQUIREMENTS/DESIGN. Raw choice/confidence/probabilities and submitted wording remain in the original artifacts. No rationale was returned.

## Frontend source and seamless draft localization

Research used primary [daisyUI Drawer](https://daisyui.com/components/drawer/), [Modal](https://daisyui.com/components/modal/) and [Tab](https://daisyui.com/components/tab/), [WAI-ARIA tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) and [dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [HTMX response handling](https://htmx.org/docs/#response-handling), and [Rails schema-label localization](https://guides.rubyonrails.org/i18n.html). These support component and interaction/label-reuse requirements, not proof of CanLang semantics. The actual corpus has 42 draft sources, 83 pages, no card/details/nav declarations, 361 descriptions and 85 explicit UI strings; declaration totals exceed proven exposed labels.

Saved fresh requests [A](27-frontend-source.questions.json), [B](27-frontend-source-b.questions.json), [C](27-frontend-source-c.questions.json), with complete results [A](27-frontend-source.result.json), [B](27-frontend-source-b.result.json), [C](27-frontend-source-c.result.json). A slot comparison confirmed different text in every explanatory state/instruction/criterion, unchanged exact code, alternatives and question types; the rewriters and coordinator checked semantic equivalence. The supplied alternatives and their framing remain reviewable, and agreement is not bias removal.

| Judgment | A | B | C |
| --- | --- | --- | --- |
| Preference shape | unnamed, confidence 1.0 | unnamed, confidence 1.0 | unnamed, confidence 1.0 |
| Label policy | finite_defaults, confidence .99, probability .99; explicit_labels .01 | finite_defaults, confidence .70, probability .78; explicit_labels .22 | finite_defaults, confidence 1.0, probability 1.0 |
| UI boundary, NOUL | .93 | .91 | .89 |
| Grouped labels, NOUL | .88 | .86 | .89 |

Other preference alternatives and unresolved received zero; generic-inference/unresolved label alternatives received zero. Every returned probability/confidence remains in raw evidence. B's materially higher explicit-label probability prompted review of ambiguous names, type matching and coverage: retain a finite exact vocabulary and explicit semantic overrides, not generic inference or a completeness claim. No rationale was returned, so wording sensitivity cannot be attributed to a particular sentence. Code review also resolved drawer auto-open, tab persistence and composition identity before sending: open is Collapse-only, bound tabs canonical-save immediately, and canonical owner preference sections deduplicate.

The chosen contract uses unnamed preferences, page-derived navigation, small UI extensions and source-owned grouped labels. No new app wrappers, catalogs, authored build files or copied account CRUD. Source/parser checks cannot establish executable rendering, preference isolation, ICU validity, complete localization, provider sinks or BDD behavior. The earlier `25-draft-i18n.questions.json` is an unsent historical proposal, not consultation evidence. Three jev-1.13.0 calls used 7750 input tokens and 429 output tokens.

## Canonical history presentation default

The source migration caught prospective repetition of a generic `history_open` field, caption and wrapper against 46 existing canonical history controls. Three complete rewritten requests/results are [A](28-history-default.result.json), [B](28-history-default-b.result.json), [C](28-history-default-c.result.json), with requests alongside them. All chose shared Appearance, confidence/probability 1.0; omit/per-owner alternatives each received zero. Boundary NOUL values .91/.84/.89 retain uncertainty. Full prose differs, facts/options are equivalent, and all raw values are preserved. No rationale was returned; the lower B value prompted a direct review that only initial expansion changes and current row/field grants still apply. Common history becomes a runtime-labeled Collapse, initially closed, with the shared authenticated-user/browser-local preference. Apps retain domain evidence groups and actual differences without copying this setup. This is a specification default, not implemented rendering. Three calls used 1741 input and 168 output tokens.

The final source cleanup reuses the first declared eligible static page title as the default owner/settings caption and references equal existing named whole messages. This follows the repetition constraint; these exact cleanup choices were made after consultation and were not separately classified by JEV. Private UI groups use existing presentation require semantics without changing server grants.

## Inline localization feasibility

The user requests translatables at their source sites wherever possible, particularly restoring meaningful `#` prose instead of mandatory `#=` indirection. The catalog requirement was an assistant choice. A read-only AST-scoped inventory of all 44 sources found 724 named messages: 699 used once and 25 used twice. Every one of the 373 description messages is static and used exactly once. Inline descriptions could remove 48 description-only imports (1720 Unicode characters including newlines). These are source counts, not token benchmarks or semantic validation. Actual sharing remains: 256 grouped label bindings cover 371 additional targets without copying translations, 18 label bindings reference named messages, two exported words cross owners, and one typed ICU plural is reused.

[FormatJS IntlMessageFormat](https://formatjs.github.io/docs/intl-messageformat/) accepts a message string or parsed AST directly; authored keys are not a formatting requirement. [ICU](https://unicode-org.github.io/icu/userguide/format_parse/messages/) requires whole-message grammar and placeholder handling regardless of source placement. [Fluent terms](https://projectfluent.org/fluent/guide/terms.html) illustrate useful sharing and grammatical-context limits. Existing source strings, business data and machine identities retain their meaning. Inline assets can be derived by canonical owner/metadata slot; names remain useful for intentional reuse. Common runtime wording and schema/type caption inheritance remain implicit.

Requests [A](29-inline-i18n.questions.json), [B](29-inline-i18n-b.questions.json) and [C](29-inline-i18n-c.questions.json) compare source text with tagged translation suffixes, fully keyed inline bundles, owner-scoped positional variants, existing mandatory named tables, and leaving notation unresolved. All 13 explanatory prose slots differ pairwise; sketches, structure, question types and alternatives match. Coordinator and independent rewriters reviewed semantic equivalence before dispatch. Complete requests/responses are saved in [A](29-inline-i18n.result.json), [B](29-inline-i18n-b.result.json) and [C](29-inline-i18n-c.result.json).

| Judgment | A | B | C |
| --- | --- | --- | --- |
| Technical feasibility, NOUL | .88 | .75 | .85 |
| Representation selected | suffix | suffix | unresolved |
| Choice confidence | .48 | .29 | .28 |
| P(suffix) | .59 | .43 | .18 |
| P(keyed) | .24 | .17 | .37 |
| P(positional) | .05 | .06 | .01 |
| P(named) | 0 | .03 | .01 |
| P(unresolved) | .12 | .31 | .43 |

The notation disagreement is material. Re-reading all three requests found the same explicit unresolved source-language policy, marker escaping, caption-slot grammar and composed-app ownership costs; no changed fact explains C's different preference. No rationale was returned, so its cause remains unknown. The source audit confirms these are real open contracts: fields/parameters/cases and generated CRUD lack inline label slots; commas already delimit expression lists; plain descriptions have no source-language annotation. A source language must remain independent of deployment/viewer locale. These contracts require design work, while message formatting itself does not require authored keys. No averaging, approval threshold, majority decision or proof of bias removal was applied.

The feasibility conclusion is to place single-use descriptions, captions and messages inline, retain genuine reuse without duplicate translations, and keep `#` informative. A source-text suffix is an illustrative direction, not finalized syntax. Typed anonymous ICU bindings and exact notation remain to be specified; the current reusable typed declaration can cover shared plural messages meanwhile. This request changes no canonical grammar, parser or `.can` files and claims no executable localization. The three jev-1.13.0 consultations used 5521 input and 231 output tokens.

## Inline localization contract and source migration

The user subsequently approved keyed inline variants and authorized migration of every draft plus stale documentation. That instruction resolves the representation direction left uncertain by consultation 29; historical evidence above is retained. Fresh requests [A](30-inline-contract.questions.json), [B](30-inline-contract-b.questions.json) and [C](30-inline-contract-c.questions.json) compare one compound `label=` attribute, separate caption/case/action attributes, adjacent grouped target bindings and an unresolved option. NOUL questions assess independent logical-owner source language and explicit typed anonymous ICU argument binding. Complete results are [A](30-inline-contract.result.json), [B](30-inline-contract-b.result.json) and [C](30-inline-contract-c.result.json).

All 1892 prior label targets resolve to authored owner/field/parameter/case/action slots. Current types, ICU rules, caption inheritance and runtime defaults remain constraints. An inventory correction before dispatch distinguishes 48 description-only import lines from the one genuine cross-owner shared-word import; all three requests include that correction with different wording. All 13 explanatory strings differ pairwise, while technical sketches, request structure, options and question types match. Independent rewriters and the coordinator reviewed full-request semantic equivalence before calling the API.

| Judgment | A | B | C |
| --- | --- | --- | --- |
| Label placement selected | compound | compound | compound |
| Choice confidence | .84 | .85 | .86 |
| P(compound) | .88 | .90 | .90 |
| P(separate) | .01 | .03 | .02 |
| P(bindings) | .06 | .04 | .06 |
| P(unresolved) | .05 | .03 | .02 |
| Source scope, NOUL | .92 | .95 | .92 |
| Anonymous typed messages, NOUL | .90 | .86 | .88 |

No selected alternative disagrees; every probability/uncertainty is retained without an approval threshold or agreement-as-proof. The lower typed result in B prompted review of explicit bindings: descriptor calls require named arguments, ordinary strings remain non-callable data, every placeholder across all variants must bind and disclose safely, and type inference/ICU/provenance checking remain unimplemented. JEV returned no rationale; a sentence-level cause cannot be established. Three jev-1.13.0 calls used 6084 input and 249 output tokens.

The adopted contract keeps source text with keyed translation suffixes and readable `#` descriptions. One trailing `label=` supplies a static caption, a field/parameter `{text=...,values={case=...}}` map, or an enabled-CRUD-action map. There is no competing target-binding syntax. Shared values use `[export] message` Given leaves with the same descriptor representation, retaining existing exports/imports and typed shared ICU signatures. Anonymous message invocation reuses existing postfix named arguments. Source language defaults to English per logical owner, with a header `source` override; imported assets and composition retain their own source tags. Translation suffix keys name languages independently, avoiding column-shift edits when a language is added. Runtime-default wording remains implicit, and named assets are reserved for actual reuse. This adds no catalog folder, manifest, wrapper or duplicate operation signature.

Implementation updates all 44 source files plus current requirements/design/grammar and supporting docs. It inlines 699 one-use keys (373 descriptions and 326 expression sites), removes 48 metadata-only imports, preserves all 1892 label values and 256 shared target groups, and retains the 25 genuinely reused old message signatures/exports. The resulting 280 names all have actual reuse; 255 represent previously grouped labels. All 35 parser tests pass, including the corpus, and a bounded normalized AST/expanded-text comparison preserves business/presentation behavior across 99 owners. No semantic checker, ICU validation, runtime rendering or BDD execution is claimed. Final implementation details allow ordinary spaces before the contiguous `@{` marker, remove exactly one separator space in raw descriptions, and reject positional/empty calls on grouped anonymous descriptors too. These were grammar clarifications after consultation, not additional classified judgments.

## Initial compiler target advice

The user asks whether CanLang should compile applications to JavaScript or WebAssembly. This is a target recommendation, distinct from the compiler's implementation language; no backend has been implemented or added to the normative requirements in this consultation.

Primary evidence: [Workers web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) describe V8 running both targets. [Rust deployment internals](https://developers.cloudflare.com/workers/languages/rust/#how-this-deployment-works) use a JavaScript entrypoint, platform API glue and Futures/Promises interoperability, establishing Wasm feasibility and its host-integration requirement. [Wasm support](https://developers.cloudflare.com/workers/runtime-apis/webassembly/) documents SIMD, absent threading, potential dependency/size/startup costs and experimental partial WASI. These are platform facts, not CanLang speed measurements. Existing computational libraries and a portable pure core are legitimate Wasm benefits; managed Cloudflare services remain host-specific.

[D1's binding conversion contract](https://developers.cloudflare.com/d1/worker-api/#type-conversion) does not support BigInt through the API despite SQLite's signed 64-bit INTEGER storage. Exact int/decimal/money storage and wire encodings are necessary for either target. A Wasm arithmetic core does not eliminate this host boundary, and neither target establishes CanLang permissions, transactions, typing or BDD correctness.

Saved fresh requests [A](31-compiler-target.questions.json), [B](31-compiler-target-b.questions.json) and [C](31-compiler-target-c.questions.json) weigh JS-only, Wasm with a JS host adapter, an initial hybrid and leaving the choice unresolved. All 11 explanatory strings differ pairwise; facts, alternatives, question type and structure match. Coordinator and independent rewriters reviewed semantic equivalence and balanced tradeoffs before dispatch. The supplied alternatives/framing remain reviewable, and rewording is not proof of bias removal. Exact requests/results are [A](31-compiler-target.result.json), [B](31-compiler-target-b.result.json) and [C](31-compiler-target-c.result.json).

| Review | Selected | Confidence | P(JS) | P(Wasm) | P(hybrid) | P(unresolved) |
| --- | --- | --- | --- | --- | --- | --- |
| A | javascript | 1.0 | 1.0 | 0 | 0 | 0 |
| B | javascript | 1.0 | 1.0 | 0 | 0 | 0 |
| C | javascript | 1.0 | 1.0 | 0 | 0 | 0 |

No judgments disagree and no rationale was returned. The values are preserved exactly without an approval threshold or treating agreement as proof. Three jev-1.13.0 calls used 4580 input and 153 output tokens.

Recommendation: begin with one generated JavaScript ES-module target for workerd, a versioned canonical operation runtime and precise scalar/storage helpers. The fit judgment follows the existing CRUD/workflow, native managed-service and server-rendered interface scope; no workload-specific performance claim is made. CanLang's static restrictions remain compiler-enforced. Generated SQL/migrations, binding requirements and HTML/CSS/assets are companion outputs, not additional app backend choices or authored manifests. A runnable milestone should compile an existing small source, execute its authorized CRUD through browser and MCP, and run its inline examples; unsupported declarations must produce explicit errors. An internal Wasm helper may be justified later by measured computation or concrete library needs. The compiler implementation language, backend, checker and runtime remain unimplemented decisions/work; this consultation does not rewrite app source or claim a running result.

## Inspectable server output and browser responsibilities

The user requests 20 handwritten JavaScript targets containing actual owning business logic, schema/operation metadata and declared UI. Shared runtime, infrastructure and component implementations remain omitted. The initial positional UI helpers were too abstract for the user; large HTML strings were also rejected. A later relay treated exploratory `h()` discussion as acceptance, but the user withdrew that interpretation and said calling `h` is bad. Renderer-driven edits stopped; existing prototypes are preserved for review, with no renderer selected. Preact remains evidence about a possible server serializer, not a requirement for browser hydration or a proven fastest renderer. Browser business state and compiler/library responsibility placement are evaluated independently of notation.

Primary evidence: [Preact's API](https://preactjs.com/guide/v11/api-reference/) supplies `h()` trees; [its server serializer](https://preactjs.com/guide/v11/server-side-rendering/) offers synchronous/async HTML and Web Streams. [HTM](https://github.com/developit/htm) is another valid-JavaScript tree notation. Ordinary Preact children do not automatically run async row/guard callbacks or await arbitrary Promises; the future shared components must prepare bounded authorized data or integrate a supported async rendering path. That contract, pinned dependencies and workerd compatibility remain unimplemented/unverified.

[HTMX](https://htmx.org/docs/) consumes server HTML through request/swap attributes. It does not make draft/focus concerns disappear: [preservation](https://htmx.org/attributes/hx-preserve/) documents limitations; [synchronization](https://htmx.org/attributes/hx-sync/) and [pending controls](https://htmx.org/attributes/hx-disabled-elt/) provide reusable mechanisms. [Native constraint validation](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#the-constraint-validation-api) can give immediate schema-derived feedback, but does not enforce all exact CanLang values or business rules. [TanStack](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates) distinguishes pending UI from cache mutation and its rollback/refetch duties; [React](https://react.dev/reference/react/useOptimistic) documents temporary optimism and failure recovery. These are capabilities and costs, not evidence that these apps need either dependency.

Actual app requirements demand local presentation state, unsaved business input, upload/request progress and error/conflict feedback. Current revision/reviewer decisions, café availability, stock/leave aggregates and CRM outcomes still depend on authoritative current data. CanFeedback specifically avoids increasing an unconfirmed vote count. A general nonauthoritative cache can coordinate views and reduce reads; eligibility, exact scalars, invalidation, permission changes, concurrency and rollback add work. No latency/device/cache measurements or authored offline/cross-page transaction requirement currently establishes that the broader store pays for itself. Its absence is not a permanent prohibition or proof that previews/caches would never help.

Three fresh requests separate component granularity, JavaScript notation and browser scope: [A](33-server-ui.questions.json), [B](33-server-ui-b.questions.json), [C](33-server-ui-c.questions.json). All 22 explanatory leaves differ pairwise; only the three technical `choice` type strings match. Two independent source/equivalence reviews preceded dispatch. An earlier draft incorrectly attributed a ban on premature client-state implementation to the user and mixed component granularity with notation; both were corrected before any calls. Saved complete results: [A](33-server-ui.result.json), [B](33-server-ui-b.result.json), [C](33-server-ui-c.result.json).

| Question/review | Selected | Confidence | Returned probabilities |
| --- | --- | --- | --- |
| Granularity A | native | 0.12 | catalog 0.41; native 0.41; unresolved 0.18 |
| Granularity B | native | 0.49 | catalog 0.04; native 0.66; unresolved 0.30 |
| Granularity C | native | 0.24 | catalog 0.14; native 0.50; unresolved 0.36 |
| Notation A | h | 0.30 | h 0.54; htm 0.02; unresolved 0.44 |
| Notation B | h | 0.76 | h 0.84; htm 0.03; unresolved 0.13 |
| Notation C | h | 0.41 | h 0.60; htm 0.01; unresolved 0.39 |
| Client scope A | server_baseline | 0.51 | server_baseline 0.63; derived_preview 0.09; hydrated_store 0; unresolved 0.28 |
| Client scope B | server_baseline | 0.27 | server_baseline 0.45; derived_preview 0.17; hydrated_store 0.01; unresolved 0.37 |
| Client scope C | server_baseline | 0.36 | server_baseline 0.52; derived_preview 0.04; hydrated_store 0; unresolved 0.44 |

Selections agree, but uncertainty changes materially, including A's native/catalog tie. No rationale was returned. Rechecking wording found the same alternatives, missing measurements, async scope and shared obligations; it does not explain the probability variation or prove bias removal. No averaging or automatic approval threshold was applied. Three jev-1.13.0 calls used 7897 input and 411 output tokens.

At the time of this consultation, the target prototypes used `h()` for native card/details layout and named canonical data/operation components for standard controls. That output form was **undecided and not approved**; the subsequent user-directed revert replaced all app element calls with imported shared UI components. The renderer implementation remains deferred. Forms expose HTMX attributes and keep operation IDs/bound parameters tied to their owning schemas. The proposed response adapter handles shared shell versus authorized fragments and selective updates without overwriting unrelated drafts. No browser store, hydration or client business-rule implementation was added. The analysis recommends a server/HTMX baseline while leaving later advisory projections open to demonstrated needs; neither recommendation nor JEV selects a renderer on the user's behalf.

One CanLang semantic compiler can emit server JavaScript, metadata, SQL/assets/examples and any justified future client projections from the same checked declarations. Several output artifacts do not require several DSL compilers. Adding client logic still increases projection checks, protocols and runtime obligations; an existing library can implement local interaction without forcing a new authored language primitive. Current needs fit shared canonical components. A new primitive needs a concrete behavior those declarations cannot express.

These are handwritten desired-output artifacts, not generated or end-to-end executable applications. CanCRM business and native-tree binding checks use stand-ins only; JavaScript syntax checks cannot establish semantics, live Cloudflare behavior or speed. Source gaps remain visible rather than being repaired silently in the output.

## Draft contract refinements — October 4, 2026

Three focused workers inspected demonstrated static, workflow and frontend gaps; no classifier was asked to research. Each domain supplied three fresh requests with identical alternatives/source facts and rewritten explanatory context, instructions and criteria. Exact code/identifiers were preserved. Complete distributions and uncertainty remain in the following artifacts, without averaging or automatic approval thresholds.

| Domain | Requests | Complete responses | Wording/evidence review |
| --- | --- | --- | --- |
| Static language | [A](draft-static-20261004-a.questions.json), [B](draft-static-20261004-b.questions.json), [C](draft-static-20261004-c.questions.json) | [A](draft-static-20261004-a.response.json), [B](draft-static-20261004-b.response.json), [C](draft-static-20261004-c.response.json) | [Checks](draft-static-20261004-self-check.json) |
| Workflow contracts | [A](draft-workflow-20261004-a.questions.json), [B](draft-workflow-20261004-b.questions.json), [C](draft-workflow-20261004-c.questions.json) | [A](draft-workflow-20261004-a.result.json), [B](draft-workflow-20261004-b.result.json), [C](draft-workflow-20261004-c.result.json) | [Equivalence](draft-workflow-20261004-equivalence.md), [full review](draft-workflow-20261004-review.json) |
| Frontend contracts | [A](draft-ui-20261004-a.questions.json), [B](draft-ui-20261004-b.questions.json), [C](draft-ui-20261004-c.questions.json) | [A](draft-ui-20261004-a.result.json), [B](draft-ui-20261004-b.result.json), [C](draft-ui-20261004-c.result.json) | [Wording check](draft-ui-20261004-wording-check.json) |

Static selections agree on lexical-first names, nested scopes, earlier-only defaults, decimal ratios and nonoverlapping examples. Catalog NOUL is .87/.80/.83; review narrowed plain Display interpolation rather than claiming unspecified scalar encodings. Workflow selections disagree on versions, tick routing and trusted requires; coherence is .36/.36/.33. Frontend polling and order selections disagree; coherence is .78/.74/.84. Rechecking source and alternatives located real costs rather than factual reversals. These classifications supply advice without rationale, proof of correctness or guaranteed bias removal.

DESIGN records the integrated rules: preserve ordered source version calculations with write-intent semantics; make authored requires match business-error expectations; bound recurrence to supported D1 scopes; preserve receiver attachment authority; adopt one page-only GET poll and one order-default map. Source reprojection is a separate app integration gap. Proposed imports remain unimplemented. No parser/compiler/runtime/renderer work, execution proof, performance benchmark or token-saving benchmark resulted from the consultations. Earlier sandbox network failures obtained no response; successful calls used the standing API authorization, with no secrets saved.

Post-consultation integration review found four additional direct lexical/enum collisions in CanPurchase, CanBook, CanTable and CanVolunteer. Renaming their boolean inputs to approve/attend/missed follows the consulted lexical-first rule; raw request/response evidence is unchanged. Plain-format Display output was pinned for the restricted supported types, rather than adding unspecified decimal/money/datetime coercions. These are source/integration corrections, not additional classifier judgments.


### Explicit subjects for declared roles — October 4, 2026

Requests/results: [A](draft-role-subject-20261004-a.result.json), [B](draft-role-subject-20261004-b.result.json), [C](draft-role-subject-20261004-c.result.json); [wording/equivalence check](draft-role-subject-20261004-wording.md). All raw distributions and NOUL uncertainty are preserved. A/C favored role calls; B favored a new builtin. DESIGN §4 selects the role-call form based on reuse of declaration/call syntax and explicit subject semantics, not classifier consensus. Source review resolved actor-narrowing, team-owner, historical-invariant and lexical-shadowing boundaries. CRM now requires a declared salesperson assignment in addition to employee location authority.


### Reviewed CSV intake and trusted app links — October 4, 2026

[Request/result A](draft-import-links-20261004-a.result.json), [B](draft-import-links-20261004-b.result.json), [C](draft-import-links-20261004-c.result.json), [wording/equivalence review](draft-import-links-20261004-wording.md). All distributions and uncertainty remain saved. Form review was selected for operation-schema reuse and explicit app-owned candidate reads, not classifier approval. DESIGN §9 defines the full proposed form contract; §3 defines trusted `app_url`. Exact CSV dialect decisions draw on RFC 4180 while explicitly pinning CanLang's UTF-8/LF/header extensions. No parser, import service or renderer was implemented.


### Active-session source refresh — October 4, 2026

[Review A](draft-work-refresh-20261004-a.result.json), [B](draft-work-refresh-20261004-b.result.json), [C](draft-work-refresh-20261004-c.result.json), [wording check](draft-work-refresh-20261004-wording-check.md). Split, low-confidence advice is recorded in DECISIONS rather than treated as approval. DESIGN §9 selects bounded user-session refresh with actual canonical admission and preserved GET polling; source producer/retention work remains app-owned.

### Cumulative billing evidence

October 4, 2026: invoice-ledger ordering and cumulative settlement contract. [Wording/context equivalence](draft-billing-evidence-20261004-wording.md); [A request](draft-billing-evidence-20261004-a.questions.json), [A response](draft-billing-evidence-20261004-a.result.json); [B request](draft-billing-evidence-20261004-b.questions.json), [B response](draft-billing-evidence-20261004-b.result.json); [C request](draft-billing-evidence-20261004-c.questions.json), [C response](draft-billing-evidence-20261004-c.result.json). Snapshot probabilities .98/.90/.83, confidence .98/.84/.74. Delta alternatives .01/.07/.15 and dual alternatives .01/.03/.02. No automatic approval threshold; framing limits and source rationale are in DECISIONS.

### Payment consent and cancellation boundary

[Wording check](draft-payment-boundary-20261004-wording.md); [A request](draft-payment-boundary-20261004-a.questions.json) / [response](draft-payment-boundary-20261004-a.result.json); [B request](draft-payment-boundary-20261004-b.questions.json) / [response](draft-payment-boundary-20261004-b.result.json); [C request](draft-payment-boundary-20261004-c.questions.json) / [response](draft-payment-boundary-20261004-c.result.json). Dispatch probabilities/confidences 1/.99/1; preflight probabilities 0/.01/0. Contract sufficiency NOUL .82/.85/.69. No threshold approval; DESIGN defines the contract, DECISIONS records the source rationale and framing limitation.


### CRUD visibility and nested collection expansion — October 4, 2026

[Wording/equivalence record](draft-query-admission-20261004-wording.md). Full requests/results: [A request](draft-query-admission-20261004-a.questions.json), [A result](draft-query-admission-20261004-a.result.json), [B request](draft-query-admission-20261004-b.questions.json), [B result](draft-query-admission-20261004-b.result.json), [C request](draft-query-admission-20261004-c.questions.json), [C result](draft-query-admission-20261004-c.result.json). Prewrite/staged probabilities: 1/0, .97/.03, .88/.12; confidence 1/.93/.76. Flatten NOUL .66/.63/.46. Disagreement is not averaged away: flatten expands lists, while interval union requires the already available grouping/ordering/aggregate operations. Concrete bounded reporting remains checked in the Rent draft; no runtime result is claimed.

### Purchase/Stock and grant draft completion — October 4

- [Purchase/Stock evidence](2026-10-04-purchase-stock/): three fresh consultations compare additive frozen amendments/returns with alternatives; original probabilities and full requests remain in that directory. Adopted source and target workflows are in the app drafts; consultation is advice, not transaction or transport proof.
- [Grant correction evidence](grant-completion/): three requests and results evaluate preserving frozen intake through a linked private correction and fresh submission. Returned linked-correction probabilities are 0.98, 0.96 and 0.91; confidence is 0.97, 0.93 and 0.81. These differ and are retained without an automatic threshold. The source uses this design with deadline, predecessor-state and budget guards; examples remain unexecuted.

### Rent expiry and historical evidence — October 4

The three `rent-final-gaps-20261004-{a,b,c}` requests/results, wording check and assessment in this directory evaluate fenced late-money recovery and historical policy evidence. Returned preferred-choice probabilities are 1 in each result, with confidence 1, 0.99 and 1. Source guards still enforce invoice cancellation/refund and released-allowance fences; classification is not proof. Historical reports use actual stored owner snapshots and mark earlier coverage partial instead of reconstructing unknown policy. The source/target mapping and syntax checks do not execute that behavior.

- [Feedback completion](feedback-completion-20261004/): three fresh requests assessed contribution limits, retained votes, moderation and the actual Desk intake boundary; returned choice probabilities .99/1/1 for the recorded proposal, treated as advice rather than correctness proof.

- [Shared attribution capture](shared-attribution-capture-20261004-a.questions.json), [second](shared-attribution-capture-20261004-b.questions.json), [third](shared-attribution-capture-20261004-c.questions.json): owner-local common capture advice; matching result files preserve probabilities and uncertainty.
- [Rent commercial producer](rent-sales-producer-20261004/README.md#source-assessment) and [version-boundary correction](rent-sales-version-boundary-20261004/README.md#source-assessment): initial NOUL .86/.60/.39 triggered investigation; a concrete booking-version conflict was fixed with child commercial state. Corrected .84/.78/.61 remains advice, not proof.
- [Desk maintenance handoff](desk-handoff-20261004/README.md#source-review): three source-grounded choices favored the existing owning operation (.71/.96/.93; confidence .41/.92/.85). Full requests/results and wording review retained; contracts remain unexecuted.

- [Record-input admission](record-input-admission-20261004/README.md#source-assessment): three fresh choices split (.83/.77 for operation authority; .51 for a read prerequisite in the third). Investigation preserves the existing separate read/write boundary, explicit guards and safe output; this is not unanimous validation.

### Check lifecycle completion — October 4, 2026

[Saved requests and responses](check-completion-20261004/) assess owner-local D1 checks instead of an assistant-created cross-owner placement requirement. Canonical maintenance hooks, token admission, deadline/transition state and independent notice outcomes are reflected in the source and target. Consultations are design advice; no ingress or scheduler implementation has been executed.

### Loyalty source eligibility — October 4, 2026

[Requests, responses and assessment](loyalty-eligibility-20261004/) distinguish explicit account enrollment and program product/location eligibility from exclusive cash referral attribution. Returned preferences (.86/.12/.02, then 1/0/0 twice) remain advice with uncertainty in the saved assessment; ledger behavior is unexecuted.

### CanCatch intake completion — October 4, 2026

[Three fresh NOUL requests/results and source assessment](catch-intake-20261004/) retain values **0.60/.64/.64** for the proposed intake/normalization/replay/health boundaries. These are advisory classifications without an approval threshold. The collector source uses existing hooks, queues, retention and typed events; no SDK or adapter implementation was added.

### Hiring retention and onboarding handoff — October 4, 2026

[Retention evidence and correction](hire-retention-20261004/README.md#source-correction) preserves the invalid initial consultation premise (block derives do not exist) and superseding fresh requests/results. The corrected three choices favor nullable deadlines with returned probability/confidence 1 in each; this is advice, not proof. Closure stores one nullable parent deadline, reopening cannot revive expired candidates, and existing retain syntax consumes it. [Handoff consultations](hire-onboard-20261004/) review canonical Employee creation/reuse followed by an explicit authorized onboarding start instead of duplicating staff identity or automatically granting roles.

### Café reservation completion — October 4, 2026

[Requests, responses and analysis](cafe-completion-20261004/) retain D1-choice probabilities .95/.67/.85 and workflow NOUL values .84/.83/.80. The second choice has appreciable uncertainty; the source ownership evidence, not a voting threshold, justifies keeping location-work guards and café records at their actual common owner. Reservation moves, capacity conflicts and occupancy remain authored workflows.

### Time review and exported corrections — October 4, 2026

[Three requests/results and disagreement analysis](time-completion-20261004/) compare source correction strategies. The classifications disagree (one alternative .68, then the other .72/.82); actual Invoice cancel/refund/reconcile contracts support the chosen fenced full-source correction with an explicit cash round trip. Neither agreement nor a syntax pass establishes correct money movement.

### Website dimension breakdowns — October 4, 2026

[Three fresh choices and disagreement analysis](stats-breakdown-20261004/) compare an existing typed business-report capability with a new general analytics-read surface. They disagree: capability .98, shared analytics .62, capability .86 (full distributions/confidences saved). The selected scoped contract uses existing asynchronous primitives and explicitly discloses weighted estimates and incomplete groups; no adapter/query implementation is claimed.

<!-- consolidated-topic-records:start -->
## Consolidated topic records

These records combine each topic’s assessment, request comparison, correction history, and verification notes. Original source sections have stable anchors; exact request/result JSON and supporting evidence remain in their topic directories. This organization changes no design verdict or execution claim.

| Topic | Record |
| --- | --- |
| CanTable completion consultation | [Consultation record](cafe-completion-20261004/README.md) |
| CanCatch intake contract consultation | [Consultation record](catch-intake-20261004/README.md) |
| CanCheck completion consultation | [Consultation record](check-completion-20261004/README.md) |
| Enrichment declaration consultation | [Consultation record](complex-enrich-20261004/README.md) |
| CanInbox authoring comparison and verification | [Consultation record](complex-inbox-20261004/README.md) |
| CanSync preservation policy consultation | [Consultation record](complex-sync-20261004/README.md) |
| CRM appointment replacement consultation and verification | [Consultation record](crm-connections-reschedule-20261004/README.md) |
| daisyUI component vocabulary consultation | [Consultation record](daisyui-catalog-20261004/README.md) |
| Delivery recipe override consultation | [Consultation record](delivery-recipe-overrides-20261004/README.md) |
| Desk handoff consultation | [Consultation record](desk-handoff-20261004/README.md) |
| Feedback completion consultation | [Consultation record](feedback-completion-20261004/README.md) |
| Hire onboarding consultation | [Consultation record](hire-onboard-20261004/README.md) |
| Hire retention consultation and correction history | [Consultation record](hire-retention-20261004/README.md) |
| Loyalty eligibility consultation | [Consultation record](loyalty-eligibility-20261004/README.md) |
| Maintain inspection progress consultation | [Consultation record](maintain-inspection-progress/README.md) |
| Maintain recovery consultation | [Consultation record](maintain-recovery-20261004/README.md) |
| Shared attachment handoff consultation | [Consultation record](mcp-file-handoff-20261004/README.md) |
| Consumed membership replacement consultation | [Consultation record](member-consumed-stage-20261004/README.md) |
| Membership allocation ownership consultation | [Consultation record](member-owner-20261004/README.md) |
| Feedback history and Product selector consultation | [Consultation record](muse-feedback-20261004/README.md) |
| Record-input admission consultation | [Consultation record](record-input-admission-20261004/README.md) |
| Initial rental sales producer consultation | [Consultation record](rent-sales-producer-20261004/README.md) |
| Corrected rental sales version boundary consultation | [Consultation record](rent-sales-version-boundary-20261004/README.md) |
| Weighted statistics report consultation | [Consultation record](stats-breakdown-20261004/README.md) |
| CanTime correction consultation | [Consultation record](time-completion-20261004/README.md) |
<!-- consolidated-topic-records:end -->
