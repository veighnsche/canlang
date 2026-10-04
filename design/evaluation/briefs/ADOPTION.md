# A — Adoption and AI efficiency

## Assignment

Run this evaluation as `gpt-6.1-sol` with `ultra` reasoning, using focused subagents. Preparation of this brief does not launch the evaluation.

Evaluate whether companies can economically replace selected subscriptions with AI-generated applications tailored to their departments. Staff describe needs and review outcomes; they are not expected to program. Adoption is primary. Measure reliable generation, use, change and ownership, preserving business behavior when assessing token savings. Challenge the DSL's value and the economics of ownership; neither is assumed to win.

Own **F001–F003, F015; E001–E006, E008, E010–E025, E098–E101, E103–E105**: 34 items. The live [ownership map and handoffs](../../../EVALUATION.md#orchestrator-ownership) are authoritative. B owns source semantics and E102 alternative comparisons; C owns interfaces, targets and provider/toolchain evidence. Root coordinates routing and checklist updates.

Apply the shared [draft-only boundary](../../../EVALUATION.md#draft-only-product-evaluation) and [fair comparison rules](../../../EVALUATION.md#fair-comparison-rules), including in JEV's mock-company inputs. A records the common company outcomes, starting situation, support and economic horizon in existing evidence, and aligns experiment assistance and cost boundaries. Evaluate prospective product value; present shipping readiness is outside scope. Missing implementation cannot be a reason to reject Can or an adoption blocker. The `.mjs` files are handwritten desired outputs, not generated code.

Future outputs: `design/evaluation/ADOPTION.md` and supporting artifacts under `design/evaluation/evidence/adoption/`. Keep report editing with this orchestrator; give workers separate evidence paths.

## Relevant inputs

Use [baseline-20261004T041647Z](../baseline-20261004T041647Z/README.md) as the source version. Cite snapshot-relative paths and line numbers. Read the current [AGENTS.md](../../../AGENTS.md) and evaluation working/JEV rules for instructions; identify later evidence explicitly.

- [Requirements](../baseline-20261004T041647Z/snapshot/REQUIREMENTS.md): audience, scope, adoption, token economy and ownership assumptions.
- [Design](../baseline-20261004T041647Z/snapshot/DESIGN.md), especially composition/defaults, BDD, presentation, migrations and desired JavaScript; [grammar](../baseline-20261004T041647Z/snapshot/GRAMMAR.md) and [decisions](../baseline-20261004T041647Z/snapshot/DECISIONS.md) when an experiment depends on a rule.
- [Draft overview](../baseline-20261004T041647Z/snapshot/draft/README.md), [portfolio](../baseline-20261004T041647Z/snapshot/draft/PORTFOLIO.md), [workspace case](../baseline-20261004T041647Z/snapshot/draft/WORKSPACE_OPERATOR.md), [administration](../baseline-20261004T041647Z/snapshot/draft/ADMIN_SURFACES.md) and [migration notes](../baseline-20261004T041647Z/snapshot/draft/MIGRATION.md). Verify coverage claims against source.
- Use the baseline index to open each selected app's requirements, Can and available MJS together. Candidates include CanTable, CanExpense, CanMail and a CanBook/CanPropose/CanRent journey. Select a small shared set by coverage; these are candidates, not a mandatory list or a requirement to reproduce every app.

## Execution and delegation

1. Reuse the captured inventory. Check its outstanding coverage claims under E006. Publish a small set of company profiles and selected journeys early, with actors, constraints, intended outcomes and explicit hypothetical assumptions. Include ordinary departments beyond the workspace-operator example. B and C use these same journeys.
   Apply the live evaluation's suite-replacement clarification: include several Can apps replacing one suite's required workflows. Compare their combined ownership burden, retained subscriptions and phased migration against the incumbent, avoiding double-counted savings. Carry this complete alternative into JEV's mock-company decisions.
2. Establish pinned generation/edit briefs and a measurement method. Obtain B's rule interpretations and expected business outcomes before judging ambiguous results; request C's interface criteria where relevant. Other inventory and cost work can proceed meanwhile.
3. Run bounded first-app and later-change experiments in the evidence directory. Preserve briefs, supplied documentation, exact model/effort, outputs, repairs, interventions and available usage/wall-time data. Pin the tokenizer for source counts; identify unavailable usage rather than inventing exact totals. Compare complete equivalent behavior, not favorable fragments or line counts. Include a credible existing-framework alternative for the DSL comparison without building a new platform.
4. Route observed semantic issues to B and interface/target issues to C using the same artifacts. Incorporate their assessments without duplicating experiments. Distinguish language ambiguity, app omission, agent error and missing implementation.
5. Combine C's verified provider/setup costs with B's workload mechanics and stated company support/maintenance assumptions. Consult JEV as described below. Consolidate E101, obtain B's E102 alternatives and C's relevant costs, then complete E103–E105. Reopen a conclusion if new evidence changes it.

Use Luna Low for inventory extraction, Luna Medium plus scripts for measurements, Sol High for generation/edit assessment and department journeys, and Astra High for the consequential DSL/ownership comparison. Luna Medium and Sol Medium can be generation subjects on matched briefs; keep reviewers independent of their conclusions. Ultra belongs to this coordinator, not automatically to its workers. Delegate bounded questions with relevant context, and publish useful handoffs without waiting for every item in the lane.

## JEV responsibilities and bias checks

Own JEV's **mock-company decision-maker role** and difficult design questions within A's scope. Supply profiles, current alternatives, decision-maker responsibilities, company workloads, capabilities, gaps, costs and support obligations yourself. JEV is a classifier and cannot research those facts. B and C provide relevant evidence; their findings must inform adoption judgments.

Frame company choices prospectively: if the stated product contracts were implemented, under explicit cost/support assumptions, would the composed solution offer worthwhile value for this company? Keep actual design gaps and uncertainty visible. Never ask whether a company should replace live SaaS with today's drafts, or let the absence of implementation decide the product's merit. Any pilot option is a future pilot under that scenario.

Use the existing [caller](../../../tools/jev.py) and [usage documentation](../../../tools/README.md#jev-caller). Standing authorization applies. For each decision, make three fresh consultations: rewrite all explanatory context, instructions, questions, option descriptions and criteria while preserving facts, constraints and alternatives. Do not reattach unchanged explanatory prose as context. Check semantic equivalence and full-request wording differences before sending. Choose `choice` for alternatives, `noul` for yes/no properties and `score` for an ordered rubric. Save all requests, raw responses and returned probabilities/uncertainty under your evidence directory; investigate disagreements without automatic approval thresholds.

Check every version for leading questions, loaded labels, assumed benefits, omitted counterevidence, uneven detail and company assumptions selected to favor CanLang. Apply equal evidentiary standards without inventing false balance. Do not reveal a preferred answer or previous votes. Include credible alternatives such as the existing subscription and a bounded pilot. Three paraphrases and unanimous results cannot establish neutrality. Report mock-company results as simulated advice, not customer testimony, market demand or demonstrated willingness to pay. Refer technical E102 consultations to B rather than duplicating them.

## Evidence, deliverable and completion

Apply the shared [improvement-feedback requirement](../../../EVALUATION.md#improvement-feedback-for-negative-findings) to every supported negative result. Consolidate causes and recommendations from B/C into an adoption-focused improvement path with expected benefits, tradeoffs and re-evaluation under the same comparison conditions; preserve original findings and uncertainty.

Keep the baseline and live design/Can/MJS files unchanged. Bounded scratch experiments are permitted; feature implementation and broad redesign are outside this evaluation. Source inspection, parser acceptance, static review, simulation and executed behavior are different evidence types. Proposed imports are not working capabilities. Do not present hypothetical company profiles as real customer research.

The report contains scope/methods; a result for every owned item with evidence and uncertainty; consolidated findings with affected company task, category, adoption impact and smallest credible remedy/tradeoff; and handoffs/open dependencies. Include an integrated product-design verdict and finite prioritized correction plan after B/C findings and E102 are available. Link contributed evidence rather than copying whole reports. Justify any not-applicable or implementation-dependent result; missing user evidence remains a limitation, and expected implementation absence is not evidence for rejecting Can. Completion is the supported design verdict and improvement plan, not implementation of the remedies or execution of every proposed guarantee.
