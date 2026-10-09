# Can dev server for AI coding agents

**Status:** Living design draft. The user has selected Jev decision support for the future `can dev` workflow; the server, its tool names, response schemas and delivery stages below remain proposals. Add new ideas here without treating a draft interface as an implemented API. The [decision record](../docs/specification/DECISIONS.md) distinguishes the accepted direction from open implementation choices.

## Purpose

Can is authored by AI coding agents, including agents that have never seen this language. An agent should need only a tiny Given/When/Then orientation, be free to write a plausible first guess, and learn the closest supported Can construct from the error response. `can dev` should give it a short, reliable loop from a `.can` edit to an observed application result:

```text
guess .can → check the exact source revision → receive likely Can keyword + help
           → revise and check again → inspect the resolved app
           → run an isolated example or local request → explain a failure
           → make a change → compare and verify the new revision
```

The server is one long-lived local project session. It joins the compiler, test artifact, local workerd runtime and source-derived app interfaces. `.can` remains the source of app identity, composition, permissions, operations, pages and examples. The compiler and runtime retain ownership of their semantics; the server presents their evidence to an agent. A browser preview is useful to people too, but the agent must be able to inspect and drive the loop through structured tools without scraping terminal output or generated JavaScript.

## An unfamiliar agent's first loop

A discoverable bootstrap card should be about this small: **Given** declares data and rules; **When** declares permitted operations and their behavior; **Then** declares pages. Write the best `.can` draft for the requested app, run the check, use the suggested Can keyword and its signature to revise, and repeat. The agent can ask for the current app's available declarations and one relevant valid snippet at the error location. It should not have to ingest the full grammar or design book before its first edit.

The development error response should point to a **real language construct**, with enough local help to use it. For example, with an existing `Todo` model and member role, an agent might guess:

```can
When
 manage Todo by=members fields=title,done
```

An illustrative response could say:

```text
Unknown When construct: manage
Closest supported construct: crud
Signature: crud path by=expr fields=selectors
Meaning: generate create, update and delete operations for a model.
Reference: docs/specification/DESIGN.md#5-canonical-operations
Alternative: scenario (a custom operation with an authored body)
```

The `crud` signature and [canonical-operations reference](../docs/specification/DESIGN.md#5-canonical-operations) come from Can's versioned language help, not from Jev-generated prose. Jev selects or ranks the closest supported construct ID using the guessed words and surrounding context. The response identifies the invalid span and source revision, exposes uncertainty and alternatives, and gives the agent enough information to write valid source. An exact edit can be included when the mapping is mechanical, but a full patch is not the primary requirement.

### Keyword and construct guidance in the error response

1. The compiler reports a useful primary error and its section, syntactic position, surrounding source, resolved names/types and owning declarations. Group downstream errors only when their causal relationship is proven; the current compiler does not supply that relationship.
2. Use grammar-position facts and the versioned help index to build a bounded list of supported keyword/construct IDs, with completion as supporting evidence. Include nearby constructs when an invented word suggests the agent chose the wrong section or abstraction; do not offer unavailable language features as working alternatives.
3. Jev ranks that **supplied** list only for reliable residual ambiguity after deterministic help, with “none/unclear” available. The response retains probabilities and uncertainty. A single unambiguous grammar match is reported without a Jev call.
4. Resolve each ranked ID through one version-pinned Can help index: canonical signature, one-sentence meaning, section, minimal valid example, implementation availability and stable documentation link. Jev returns an ID and probabilities; Can supplies all syntax and reference text. Keep the leading card inline in the error and expose alternatives by ID so normal output stays small.
5. The agent revises `.can` and checks again. A hash-guarded exact edit is optional for a genuinely mechanical substitution; any proposed patch must be checked against the pinned source before offering it. If intent is unresolved, show the nearest supported forms and what choice the agent must make. No suggestion may silently grant permission, invent a business effect, change evaluation order or alter an example expectation.

Jev cannot generate replacement `.can` text: its [documented interface](https://typesafe.ai/blog/introducing-system-one-models-and-jev) returns typed decisions over supplied options. The keyword list and help index therefore come from Can, and the compiler remains the validator of any revised source. Full-patch generation is an optional later extension if task evidence shows keyword guidance is insufficient.

The provider must keep three facts distinct: **the source is invalid** (compiler fact), **this is a supported construct at this position** (grammar/help fact), and **this construct is probably what the author meant** (Jev advice). A suggested keyword does not prove that an entire replacement declaration compiles or matches business intent. Existing [diagnostic design](../implementation/DIAGNOSTICS.md) supplies the machine format and guarded code-action boundary; the dev session joins the error to the keyword help card.

## What the session contains

### Project, revision and build state

- Discover the selected app and its owning package/import closure from `.can` declarations. Report the compiler, language, catalog, runtime and generated-asset versions used for a build. Do not require an authored duplicate source manifest.
- Watch the actual input closure: `.can` files, the producer catalog, required package outputs and browser assets. File additions, removals and changed dependencies cause a new analysis/build epoch. Superseded work cannot publish current diagnostics or replace the preview.
- Identify every answer by session, complete source set and revision. Distinguish current source, build in progress, failed build, ready preview, and a preview still serving an older successful revision. An incomplete or truncated check is never reported as clean.
- Let the agent ask for changes since a revision: new/resolved diagnostics, changed declarations, example outcomes and preview readiness. Keep full details addressable by stable IDs.

### Compiler feedback and app inspection

- Return existing stable diagnostic codes, primary and related spans, source hashes, completeness and omitted counts. Include an agent-friendly path/line/column view derived from the canonical byte spans. For an unknown construct, inline the top keyword help card and make alternatives addressable; optional exact edits use separate hash-guarded code actions.
- Inspect the checked declaration graph: models and fields, canonical operations and inputs, effective permissions and defaults, pages, generated business MCP tools, dependencies and required resource bindings. Each answer identifies the owning declaration and distinguishes source policy from language defaults.
- Show unsupported or unqualified capabilities as such. Inspection never infers an interface by reading generated JavaScript or treats a desired draft contract as an implemented API.

### Real local app preview

- Serve the compiled app, its released browser resources and app `/mcp` interface over loopback HTTP through the actual local workerd path. Local D1 and other declared resources must match the capabilities the selected app uses; missing bindings produce explicit startup failures.
- Exercise normal identity, authorization, validation, operation, state and interface paths. A development invocation may choose a fixture actor only inside an isolated test scope; it does not gain a bypass around business admission.
- Keep local state and provider behavior visible: which bindings are real local implementations, which external providers are simulated, and which requested capability is unavailable. A failed rebuild may leave an older preview available only with its old revision clearly displayed.

### Examples, controlled exercise and replay

- Run one inline example, one operation's examples or the app's selected suite. Compile examples into the separate test artifact and execute their independently authored expectations through the normal operation and permission path.
- Provision each fixture scope deterministically, including distinct actors and teams, files and required parent records. Report setup failure, business rejection, assertion failure and runtime failure separately. Repeated runs cannot inherit earlier test mutations.
- A qualified example runner may return a revision-pinned **rerun** reference for a new isolated execution. Exact replay is unavailable in the first profile. Claim execution replay only after source/artifact, realized fixtures, actor, clock, state and provider responses can be restored; a business receipt's saved outcome is not execution replay. The [replay boundary](can-dev-session-control.md#rerun-is-not-replay) keeps missing inputs explicit.
- Provide browser automation with a stable preview URL and revision; inspect rendered and accessible behavior through the served app. Browser observations remain distinct from unit/example execution.

### Deterministic failure explanation

`can explain CODE` currently describes a diagnostic code in general. `can dev` needs an explanation of **this occurrence**. A failure record should contain, when observed:

- its session and source/artifact revision, phase and stable failure ID;
- the first known failing boundary, code/status, exact `.can` location and related declarations;
- the actor, operation or example step, safe input path, expected outcome and observed result where applicable;
- a source-mapped runtime frame, relevant state/receipt effects and trace references where the runtime actually supplies them;
- whether analysis, mapping and trace collection were complete, with missing evidence named explicitly.

The first response is a compact summary. The agent can request the trace, source excerpt, related declarations or static code explanation separately. Link derivative diagnostics to their known root when the compiler proves that relationship. Do not turn a probable cause into an observed cause. Public HTTP/MCP business errors keep their safe disclosure contract; richer local debugging detail stays behind the development control boundary and is redacted according to the actor's access.

### Jev decision support

- The proposed [construct-ranking contract](can-dev-jev-ranking.md) specifies the automatic trigger, revision-pinned evidence packet, `none`/`unclear` outcomes, display gate and provider-failure fallback. Its thresholds are trial values awaiting the same-task comparison below.
- Use Jev within eligible syntax errors to rank finite, context-eligible Can construct IDs by likely author intent. Preserve “none/intent unclear” and alternative probabilities. The help index supplies the winning construct's signature, meaning, example and link. Also expose Jev as an explicit development tool over a bounded failure or design evidence packet from the current revision. Other suitable questions rank plausible causes, choose the next discriminating check, or assess narrow alternatives against declared criteria.
- Use the typed System One question that fits the task: Noul for a defined yes/no property, Choice for finite alternatives, Score for an ordered rubric. Batch independent questions that share one state. Return the model identity, complete probabilities, confidence where defined, usage, exact question/evidence IDs and source revision.
- Keep Jev's judgment visibly separate from compiler errors, runtime observations, test results and human approval. The agent runs the chosen check and verifies any fix. Jev does not edit `.can`, authorize an operation, decide that company intent is approved, or turn an incomplete build green.
- Keep credentials server-side. Bound and redact source/trace material sent to the remote provider; make provider unavailability explicit without blocking deterministic checking or local preview. Consequential project design choices continue to use the project's three independently worded consultations and preserved uncertainty.

This development use is separate from a Can application's source-declared `judgment` capability and its authenticated business `/mcp` tools. The recorded consultations cover [contextual failure explanation](jev/can-dev-explanation-20261008/assessment.md) and an earlier [patch-first repair comparison](jev/can-dev-repair-20261008/assessment.md). The latter does not evaluate this clarified keyword-first requirement; neither establishes agent speed or correctness gains.

### Change impact and verification

- Compare two checked revisions for changed models/schema, effective permissions, operations and their schemas, page/routes, business MCP exposure, resource bindings, migration requirements and affected examples. Link each change to its owner declaration and indicate what remains unverified.
- Return compact verification evidence: which exact revision ran, which examples or browser journeys executed, their outcomes, any simulated dependencies, and gaps. A successful compile is not a successful whole app workflow.
- Measure unfamiliar agents given only the bootstrap card on real app tasks, including invented constructs: completion, total input/output tokens, edit/check turns, keyword coverage, top-choice accuracy, wrong-intent selections, isolated-rerun usefulness and behavior-example coverage. Measure exact replay fidelity separately if a qualified replay profile is later added. Compare the same tasks with deterministic grammar-position help alone and with Jev ranking; shorter output alone is not proof of a better workflow.
- Repeatedly guessed forms are evidence about the language itself. Prefer simplifying or adding a canonical Can construct when that improves the same real tasks while preserving complete semantics, rather than compensating indefinitely with larger repair prompts.

## Agent control surface

An agent needs discoverable, versioned operations over the **same session state**. The [selected first control contract](can-dev-session-control.md) uses a JSON CLI attached to an owner-only local session service; a later development MCP adapter can expose the same facts and IDs. The first command families cover session status, check/diagnostics/help, preview, selected examples and failure detail. Eligible automatic Jev ranking stays in check; an explicit `ask_jev` action follows the bounded packet and disclosure policy. Richer `inspect`, `exercise`, `trace`, `diff` and `reset` operations follow their owning evidence and selected-profile support. Exact command spellings remain implementation work. The development control is separate from the generated app's business `/mcp` endpoint.

Every response should identify the exact source/session revision and its evidence completeness; preview or runtime responses also identify their serving build revision. Use stable codes and bounded output, with revision-bound references for deeper detail. Pagination, filters and change cursors prevent a large project or log from consuming the agent's context. Tool failure, compiler diagnostic, example failure and app business error are distinct result classes. Calls that affect local state are explicit and scoped; the agent writes source through its file tools and checks the next revision. Any optional edit action uses an expected source hash.

## Isolation and operational boundaries

Bind listeners to loopback and scope control access to the owning local session. Isolate data, ports, processes and evidence by checkout or worktree so parallel agents cannot mistake each other's revisions or mutate each other's fixture state. Validate paths against the selected workspace. Treat `.can` descriptions, runtime values, logs and provider text as data when they appear in an agent tool result.

Keep secrets and inaccessible business values out of control responses and Jev requests. Provider simulations must be explicit; live external effects need explicit configuration and remain subject to ordinary app authority. Bound request bodies, trace retention, memory, time and output size, and clean up listeners and local runtime instances when the session closes. Preserve the order of validation, authorization, business effects and receipts; tracing does not change evaluation.

## Before an implementation plan

This is a pre-planning checklist, not a task breakdown or an accepted API. Resolve each item enough to choose a supported first slice and its success criteria; record remaining uncertainty rather than filling it with invented capability. The proposed [three unfamiliar-agent app tasks](can-dev-agent-tasks.md) supply copy-ready requests and observable checks for the first evaluation.

1. **Define the unfamiliar-agent journey.** Fix the tiny Given/When/Then bootstrap card and a few real app requests the agent must complete without reading the full specification. State the observable result for each request: valid source, effective permissions, working interface, evaluation order and independently checked behavior. This is the product bar for the server.
2. **Collect a small corpus of actual wrong guesses.** Include invented `Given`, `When` and `Then` constructs, wrong-section declarations, misspelled source words, wrong signatures, and requests for unsupported features. Label the intended supported construct only when the task makes it clear; include cases whose correct answer is none/unclear. The [initial six-draft corpus](evaluation/can-dev-novice-20261009/findings.md) already shows broad source-shape errors and unsafe one-keyword matches; further interactive samples are needed to learn whether agents converge. This corpus defines help coverage and exposes language syntax that agents repeatedly guess differently.
3. **Choose the authoritative construct-help contract.** The proposed [Can v1 construct-help catalog](../docs/specification/CONSTRUCT-HELP.md) now gives each inventoried authoring construct a stable ID, signature, meaning, contextual example, availability and link. It covers core source forms, 68 UI words and 36 callable builtins while keeping internal helpers and unqualified context types out of working suggestions. Reconcile copied signatures with their grammar, UI and Values owners; qualify source-current compiler/runtime profiles before promoting a card to a working suggestion. The catalog is a design-stage reference, not a shipped help endpoint.
4. **Specify when and how Jev is asked.** The proposed [routing contract](can-dev-jev-ranking.md) now invokes Jev only for bounded residual ambiguity after deterministic help, with a revision-pinned, redacted context packet and explicit abstention/failure states. It also records a conservative display gate as a trial, not a calibrated threshold. The current compiler lacks structured expected-token/recovery metadata and the server join is not implemented, so eligibility and response behavior still need source-current qualification. Jev selects IDs; Can supplies all signature and documentation text.
5. **Compare help on the same agent tasks.** The [frozen pilot and local baseline](evaluation/can-dev-help-comparison-20261009/RESULTS.md) cover the three tasks and six observed drafts. Structural first errors mean automatic Jev ranking is ineligible there; six deeper extracted probes are prepared for an offline ranking comparison. External Jev and paired agent trials await approval for the exact project-derived packets, and full runtime completion is unqualified. Run the corpus with position-aware deterministic suggestions and with Jev ranking over the same eligible IDs. Measure top-choice usefulness, wrong-intent/permission suggestions, abstention, agent task completion, edit turns, total tokens, response latency and provider cost. Use the results to decide whether Jev belongs in every eligible error, only ambiguous errors, or a requestable deeper lookup. Consult Jev with the project's three independently worded requests for any consequential unresolved design choice; preserve its uncertainty as advice.
6. **Specify the compact error and inspection contract.** The selected [error and revision contract](can-dev-error-contract.md) gives one focused diagnostic, a short Can-owned card, counts/cursors for the rest, explicit incomplete/provider states, a readable rendering and revision-bound detail/help lookups. Its full source-set digest identifies the exact analyzed `.can` bytes and membership; a separate session epoch pins compiler/catalog/help/profile inputs. The current compiler supplies only per-file hashes and its released diagnostic envelope, so capture, joins and lookups remain to be implemented and qualified.
7. **Pick one real app and local runtime profile.** Name the first `.can` app, required bindings, auth/actor path, page and business `/mcp` behavior, and which external providers are simulated or unavailable. Check the artifact-to-Miniflare path, loopback browser access and isolated example execution with this app. The [Generation same-app feasibility check](evaluation/can-dev-generation-local-20261009/README.md) confirms an anonymous compiled preview and exact browser resources through the test bridge, while auth and authored example execution remain blocked. The present local runner only dispatches in process; `can run` does not serve HTTP and `can test` has no executing row loop, so these cannot yet be first-slice promises.
8. **Define session and failure evidence.** The [selected session/evidence contract](can-dev-session-control.md) binds one app/profile to a canonical checkout session, captures immutable revisions, isolates preview and example data, keeps stale serving builds visible, and wraps actual compiler/test/runtime owner records in a small occurrence with explicit evidence gaps. Exact execution replay is unavailable in the first profile; a future qualified example runner may offer a clearly labeled isolated rerun. The session owner, cross-owner joins and runtime trace are not implemented.
9. **Choose the first control and trust boundary.** The [same contract](can-dev-session-control.md#first-agent-control-transport-json-cli) compares the same operations through JSON CLI and local development MCP, selects an owner-only Unix-session JSON CLI first, and keeps browser preview and business `/mcp` separate. A later MCP adapter shares the session core. The access mechanism, redaction and effect limits are specified for the initial Unix profile but still require implementation and agent-use qualification.
10. **Agree on the first slice and exit criteria.** The [selected Office supplies slice](can-dev-first-slice.md) fixes the one-file local D1/Identity profile, A1–A7 acceptance thresholds and explicit exclusions. The [dependency-ordered implementation tasks](../implementation/can-dev-server/PLAN.md) derive from those contracts. Neither the slice nor its plan claims a working `can dev` server; the [decision record](../docs/specification/DECISIONS.md) preserves the distinction.

The pre-planning phase is complete when an unfamiliar-agent task set, construct-help/error contract, Jev comparison, one feasible runtime profile and first-slice acceptance bar are reviewable. Exact tool spellings and later resource profiles can remain open until their consumers are selected.

## Delivery sequence and open questions

The [selected first slice](can-dev-first-slice.md) is a complete Office supplies app loop: one revisioned local session, the tiny bootstrap card, check and Can-owned construct help with bounded Jev ranking, real signed-in preview and D1, compiled isolated examples, compact owner-backed failure evidence, an isolated example rerun, and owner-only JSON CLI control. All remain implementation targets until A1–A7 pass. Declaration inspection, change impact, richer traces, exact execution replay, optional patch generation and broader resource/provider support can expand as their owning contracts become available. Each delivered profile states which workflows, keyword help and resources it actually supports.

Open design questions to resolve with concrete consumers and evidence:

1. How should the later development MCP adapter register with different agent clients while preserving the selected CLI session identity and access boundary?
2. Which additional owner trace seams can enrich the selected minimal failure occurrence without inventing an evaluation path?
3. Which runtime guard, state and delivery stages can be traced accurately and safely on the first supported app?
4. After the first profile's fresh-data rebuild policy, which checked migrations could safely preserve local preview data across source or schema changes?
5. Which resource bindings and external-provider simulations belong in the first supported profile?
6. Which compact, versioned help index can provide signatures and deep links for every context-eligible construct without duplicating parser and completion rules?
7. What bounded unknown-keyword task set shows Jev's ranking improves over grammar-position help alone?
8. Which guessed constructs occur most often when an unfamiliar agent starts from the bootstrap card, and what help coverage lets it complete a useful app?
9. How should the provider present equally plausible permission or business-effect interpretations so the agent can choose without a hidden policy decision?

## Existing foundations and current gap

The compiler already has [versioned, source-hashed diagnostics](../compiler/src/diagnostic.rs), parser recovery in a [lossless syntax tree](../compiler/src/syntax/parser.rs), [position-aware keyword completion](../compiler/src/ide/queries.rs), [hash-guarded code-action transport](../compiler/src/ide/fixes.rs), a [static diagnostic-code catalog](../compiler/src/explain.rs), [compile artifacts with separate test modules](../compiler/src/codegen/artifact.rs), and [LSP authoring services](../compiler/README.md). Completion lists eligible keywords but currently gives no construct signature, meaning or documentation link; no Jev matcher or unified help index supplies the proposed error card. Cloudflare has an [in-process Miniflare runner](../packages/cloudflare/src/dev/local-run.ts) and [source-map lookup](../packages/cloudflare/src/runtime/sourcemap.ts); the current `can run` [assembles and reports an artifact entry](../packages/cloudflare/src/cli/platform.ts). The test-only [HTTP bridge](../tests/e2e/bridges/http-bridge.ts) demonstrates a real browser endpoint, but it is not a supported `can dev` server. The [Jev caller](../tools/jev.py) and [System One application adapter](../packages/services/src/judgments/systemone.ts) are separate existing pieces. None of them currently supplies the unified live development session described here.
