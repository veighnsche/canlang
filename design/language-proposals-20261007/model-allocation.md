# Worker models for the 63-task Can roadmap

These are proposed task-worker defaults, including delegated support for coordinator-owned items. They do not change the coordinating chat or existing coding chats, assign authors, acquire file leases, dispatch implementation, or remove any original readiness/value/acceptance gate.

Choose for the expected complete run: enough capability to finish reliably, with the lowest justified cost for context, reasoning, retries and review. These allocations are judgments about the written tasks, not measured completion-token forecasts. Exact dispatcher settings use `low`, `medium` and `high`; the skill’s “Light” means `low`.

The choices follow the [model-selection skill](/Users/vince/.codex/skills/model-selection/SKILL.md) and the enabled dispatcher. Official guidance positions Luna for focused high-volume work, Sol for intelligence/cost balance and Astra for demanding reasoning. [OpenAI model guidance](https://developers.openai.com/api/docs/models).

## Pricing basis

API Standard short-context text prices, checked using the client date October 7, 2026, in USD per1M tokens. These are a comparison aid; processing mode, context and tool use affect actual cost, and this is not a Codex subscription-quota estimate. [Official OpenAI pricing](https://developers.openai.com/api/docs/pricing).

| Model | Input | Cached input | Output |
|---|---:|---:|---:|
| `gpt-6-luna` | $0.10 | $0.01 | $0.50 |
| `gpt-6.1-sol` | $2.00 | $0.10 | $10.00 |
| `gpt-6-astra` | $10.00 | $1.00 | $50.00 |

## Allocation

| Tasks | Model | Reasoning | Count |
|---|---|---|---:|
| 1, 2 | `gpt-6-luna` | `medium` | 2 |
| 3, 63 | `gpt-6.1-sol` | `low` | 2 |
| 6, 8, 13, 15, 16, 25, 29, 31, 32, 34, 36, 49, 51, 62 | `gpt-6.1-sol` | `medium` | 14 |
| 4, 5, 7, 9, 10, 11, 14, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 30, 33, 35, 37, 38, 40, 42, 43, 44, 46, 48, 50, 52, 53, 54, 55, 60, 61 | `gpt-6.1-sol` | `high` | 36 |
| 12, 39, 45 | `gpt-6-astra` | `medium` | 3 |
| 41, 47, 56, 57, 58, 59 | `gpt-6-astra` | `high` | 6 |

Most workers use Sol: 52 tasks. Luna handles two bounded collection tasks; Astra handles nine authority/recovery/accounting/disclosure or deferred architecture tasks. Higher-risk design tasks remain dormant until their original gates pass.

## Per-task rationale

| Task | Work | Model | Reasoning | Why this default |
|---:|---|---|---|---|
| 1 | Freeze the accepted source baseline | `gpt-6-luna` | `medium` | Bounded receipt, source-pin and digest collection; ambiguous acceptance scope returns to the coordinator. |
| 2 | Agree file ownership and handoffs | `gpt-6-luna` | `medium` | Collect explicit ownership releases and maintain a fixed matrix; competing claims require coordinator judgment. |
| 3 | Register two complete application witnesses | `gpt-6.1-sol` | `low` | Register the established complete witnesses and provenance; uncertain original intent escalates before selection. |
| 4 | Write the independent outcome matrix | `gpt-6.1-sol` | `high` | Independent cross-application expectations must preserve authority, failure, replay and upgrade behavior. |
| 5 | Inventory and release the narrow contracts | `gpt-6.1-sol` | `high` | Trace and reconcile cross-owner contracts; reuse accepted semantics and isolate genuinely unresolved boundaries. |
| 6 | Prepare the enum handling comparison | `gpt-6.1-sol` | `medium` | Finite comparison of three enum handlers and known alternatives with independent expected cases. |
| 7 | Prepare the dependent-input comparison | `gpt-6.1-sol` | `high` | Compare complete interaction and authoring behavior while retaining candidate and final authority. |
| 8 | Qualify actual emitted metadata | `gpt-6.1-sol` | `medium` | Bounded generated-artifact and production-loader qualification against the released declaration matrix. |
| 9 | Qualify canonical mutation and replay | `gpt-6.1-sol` | `high` | Canonical admission, durable mutation, versioning, rollback and replay interact across execution layers. |
| 10 | Carry verified context through every used scope | `gpt-6.1-sol` | `high` | Verified identity and context must remain correct across user operations, hooks and trusted events. |
| 11 | Enforce ordered rules and machine protection | `gpt-6.1-sol` | `high` | Ordered provisional rules, version observations and managed-field bypass prevention require cross-layer reasoning. |
| 12 | Enforce current authorized reads and fences | `gpt-6-astra` | `medium` | Current field/read authority and spending fences across revocation and dispatch are subtle disclosure boundaries. |
| 13 | Produce complete canonical form descriptors | `gpt-6.1-sol` | `medium` | Derive forms from the released operation contract and verify complete required metadata. |
| 14 | Join browser and MCP submissions | `gpt-6.1-sol` | `high` | Two real interfaces must preserve canonical admission, protected inputs, versions and correctable failures. |
| 15 | Qualify a read-only page and installed polling | `gpt-6.1-sol` | `medium` | Known read-only rendering/polling contract with bounded DOM, context and late-response checks. |
| 16 | Qualify refresh with editable forms | `gpt-6.1-sol` | `medium` | Implement and check refresh against released identity/draft rules; unresolved cross-context races escalate. |
| 17 | Stage a generated external effect atomically | `gpt-6.1-sol` | `high` | One transaction must join domain/history/replay identity and durable outbox rollback. |
| 18 | Qualify a scoped durable dispatcher and provider | `gpt-6.1-sol` | `high` | Installed claims, provider acceptance, crash/retry and reconciliation cross durable ownership boundaries. |
| 19 | Qualify keyed scheduling and dispatch guards | `gpt-6.1-sol` | `high` | Timer replacement, duplicate delivery and current dispatch eligibility interact with durable restart. |
| 20 | Qualify a scoped authorized receipt observer | `gpt-6.1-sol` | `high` | Result association, selected-leaf projection and current observer authority require cross-layer verification. |
| 21 | Qualify typed generation progress | `gpt-6.1-sol` | `high` | Correlated progress sequences, terminal outcomes, withheld evidence and late usage need protocol reasoning. |
| 22 | Qualify targeted stop and reconciliation | `gpt-6.1-sol` | `high` | Targeted cancellation must distinguish stopped, uncertain acceptance, late success and unknown cost. |
| 23 | Qualify generic canonical file transfer | `gpt-6.1-sol` | `high` | Real-byte finalization joins interface, private reference, lifetime, storage and current authorization. |
| 24 | Finalize provider outputs into the receiving app | `gpt-6.1-sol` | `high` | Provider evidence and file lifecycle must preserve original attempt identity through conflicting outputs and restart. |
| 25 | Render the complete generation lifecycle | `gpt-6.1-sol` | `medium` | Compose UI states from qualified domain/progress/read contracts; frontend rendering grants no authority. |
| 26 | Execute the whole private image journey | `gpt-6.1-sol` | `high` | Independent whole-app qualification spans browser, MCP, provider, durable storage and negative journeys. |
| 27 | Qualify image schema and pending-work upgrades | `gpt-6.1-sol` | `high` | Qualify the released upgrade path against persisted/pending work; new compatibility semantics require escalation. |
| 28 | Choose the bounded exhaustive surface | `gpt-6.1-sol` | `high` | Fairly choose bounded match versus conditional analysis while preserving evaluation and branch semantics. |
| 29 | Implement the selected enum coverage analysis | `gpt-6.1-sol` | `medium` | Finite parser/checker implementation follows a settled contract; the checker-only alternative stays available. |
| 30 | Lower exhaustive branches through existing execution | `gpt-6.1-sol` | `high` | Subject evaluation, branch-local values, effect order and transaction rollback meet in IR/emission. |
| 31 | Complete enum tooling and specification | `gpt-6.1-sol` | `medium` | Bounded formatter/LSP/specification updates follow the checked enum contract. |
| 32 | Independently qualify exhaustive handling | `gpt-6.1-sol` | `medium` | Independent finite handler and case-mutation checks have explicit expected diagnostics and behavior. |
| 33 | Specify the dependent input contract | `gpt-6.1-sol` | `high` | A new source/descriptor/browser binding needs a coherent narrow contract without introducing authority. |
| 34 | Implement the checked dependent descriptor | `gpt-6.1-sol` | `medium` | Implement the released binding/type/compatibility contract; unclear schema evolution escalates. |
| 35 | Implement the authorized lookup route | `gpt-6.1-sol` | `high` | Lookup must join partial inputs to existing canonical read limits and safe current-authority projections. |
| 36 | Implement dependent control interaction | `gpt-6.1-sol` | `medium` | Familiar bounded debounce/cancellation/sequence/focus interactions follow the released form contract. |
| 37 | Qualify dependent forms vertically | `gpt-6.1-sol` | `high` | Independent generated lookup/control/final-submission qualification includes revocation and stale selections. |
| 38 | Implement concrete approval protocols | `gpt-6.1-sol` | `high` | Concrete approval policies combine frozen evidence, eligibility, quorum and concurrent decisions. |
| 39 | Finish reviewed invocation value execution | `gpt-6-astra` | `medium` | Protected executable values must preserve normalized identity, provenance, current target admission and rollback. |
| 40 | Execute the whole approval application | `gpt-6.1-sol` | `high` | Whole original approval workflows require durable, interface, authority and upgrade evidence. |
| 41 | Prove accounting units and ownership | `gpt-6-astra` | `high` | Units, enforceable commitments and owner atomicity are consequential accounting/architecture decisions. |
| 42 | Implement admission hold and request staging | `gpt-6.1-sol` | `high` | Implement reservation and request staging inside the accounting ownership contract proved in task41. |
| 43 | Implement verified settlement and late usage | `gpt-6.1-sol` | `high` | Verified late settlement, replay, uncertainty and concurrency release interact across evidence lifetimes. |
| 44 | Test cancellation reuse in a second consumer | `gpt-6.1-sol` | `high` | Compare two real cancellation consumers before selecting shared membership/attempt coordination. |
| 45 | Implement explicit domain recovery | `gpt-6-astra` | `medium` | Recovery must represent definite effects, uncertain reversal and irreversible outcomes honestly. |
| 46 | Finish typed judgment generation and validation | `gpt-6.1-sol` | `high` | Join source rubric/options with provider validation, provenance and complete result distributions. |
| 47 | Finish authorized corpus lifecycle and disclosure | `gpt-6-astra` | `high` | Immutable corpus lifecycle and disclosure require current authorization over all supplied, including uncited, sources. |
| 48 | Qualify the existing cohort executor | `gpt-6.1-sol` | `high` | Actual cohort membership, per-child authority, fairness, independent outcomes and restart require protocol qualification. |
| 49 | Qualify reviewed CSV invocation | `gpt-6.1-sol` | `medium` | Known source-derived CSV preview/confirm/per-row contract with bounded consent and outcome checks. |
| 50 | Decide and implement only a thin bulk surface | `gpt-6.1-sol` | `high` | Compare complete bulk alternatives and introduce only compatible sugar into the existing engine. |
| 51 | Pilot wizard presentation when resume is needed | `gpt-6.1-sol` | `medium` | A bounded wizard pilot follows explicit ordinary draft/save/submit contracts. |
| 52 | Pilot typed views when custom content repeats | `gpt-6.1-sol` | `high` | Typed subtree reuse affects source scope, generated identity, projection and action binding. |
| 53 | Pilot versioned calendar helpers | `gpt-6.1-sol` | `high` | Two-consumer calendar policies involve timezone/holiday versions, DST and scheduling boundaries. |
| 54 | Pilot the smallest useful flat-machine reuse | `gpt-6.1-sol` | `high` | Flat-state/graph reuse changes identity, defaults and migrations while retaining operation-owned transitions. |
| 55 | Measure and conditionally pilot push | `gpt-6.1-sol` | `high` | Compare installed polling against a bounded transport pilot with revocation, reconnect and load behavior. |
| 56 | Reconsider bounded durable await only after evidence | `gpt-6-astra` | `high` | Potential continuation semantics affect durable history, authority, uncertainty and upgrade architecture. |
| 57 | Reconsider compensation grammar only after recovery reuse | `gpt-6-astra` | `high` | Possible recovery syntax must reconcile two consequential domain protocols, ordering and crash gaps. |
| 58 | Reconsider package parameters only after concrete reuse | `gpt-6-astra` | `high` | Parameterized package identity, owner boundaries, roles and migrations need major architecture judgment. |
| 59 | Reconsider richer statecharts only for a real workflow | `gpt-6-astra` | `high` | Nested/parallel/history state semantics, conflicts, effects and migrations must be designed together. |
| 60 | Review and integrate each released slice | `gpt-6.1-sol` | `high` | Independent review of the exact slice requires its authority/protocol context; clean integration can use a cheaper split. |
| 61 | Qualify the claimed installed and durable scope | `gpt-6.1-sol` | `high` | Interpret actual installed/backend/provider scope and unexplained failures without overclaiming acceptance. |
| 62 | Reconcile coverage and decisions after integration | `gpt-6.1-sol` | `medium` | Reconcile changes against reviewed receipts and the living checkpoint; collection can be delegated more cheaply. |
| 63 | Publish the capability evidence and remaining gates | `gpt-6.1-sol` | `low` | Publish a status matrix from already validated receipts; uncertain claims return to their qualified reviewer. |

## Escalation and cheaper splits

- Luna collects explicit receipts and confirmed releases; ambiguous acceptance or competing ownership returns to Sol/coordinator judgment.
- Sol low rises to medium for substantive provenance or status interpretation. Sol medium rises to high for unresolved interactions across subsystems.
- Sol high rises to Astra medium for conflicting bounded evidence; consequential new authority, ownership or architecture choices use Astra high upfront, with JEV where the project requires it.
- Task45 uses Astra medium for a released bounded recovery contract; payment or unresolved-owner recovery uses Astra high.
- Task60 reviews at the changed slice’s risk level. Routine clean integration can use Sol low; a high-risk accounting, privacy or architecture slice retains its Astra-level independent review.
- No default Ultra/max assignment is made. A newly warranted coordinated procedure requires a separate recorded selection under the skill; being in this orchestration alone is insufficient.

| Task | Cheaper bounded helper | Boundary |
|---:|---|---|
| 1 | `gpt-6-luna` / `low` | Run an approved digest/status extraction with no evidence classification. |
| 2 | `gpt-6-luna` / `low` | Apply already confirmed releases to the ownership matrix. |
| 5 | `gpt-6.1-sol` / `medium` | Trace already accepted contracts; consequential unresolved boundaries use Astra high and verified-context JEV before adoption. |
| 31 | `gpt-6-luna` / `medium` | Apply approved prose/checklist updates; formatter/LSP behavior retains the task worker. |
| 55 | `gpt-6.1-sol` / `medium` | Run the agreed polling benchmark before any transport design or authority decision. |
| 60 | `gpt-6.1-sol` / `low` | Clean integration of an independently accepted exact diff; authority/accounting/privacy/architecture review uses the slice risk profile, including Astra where applicable. |
| 61 | `gpt-6.1-sol` / `medium` | Execute scripted released qualification vectors; scope interpretation and unexplained failures retain the task worker. |
| 62 | `gpt-6-luna` / `medium` | Collect receipts and update an approved ledger; completeness/decision reconciliation retains the task worker. |
| 63 | `gpt-6-luna` / `low` | Format an already approved status report without changing any acceptance claim. |

## Keep dispatches concise

Pass the chosen task, exact producer handoffs, relevant source paths/excerpts and independent expected cases. Keep raw evidence in files and pass short receipts. Reuse stable lane context. Do not start duplicate shared-file authors or retry unchanged conceptual failures. Cheaper helpers never decide authority contracts, accept their own implementation or broaden a proof.

Before actual execution, recheck model/effort availability, current owners and released contracts. If Sol6.1 is unavailable, use available Sol6 at the same approved effort. No quoted task count predicts total token usage or cost.

The independent allocation review proposed the same final default groups and cheaper boundaries. This documents a scheduling proposal, not language acceptance. See [the complete sequence](task-sequence.md), [structured records](task-sequence.json) and [verification](model-allocation-verification.json).

