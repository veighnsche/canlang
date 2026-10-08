# Can proposal implementation plans

Use one direct, proportionate validation of changed behavior and a concise result. Reuse unchanged accepted checks. Do not create nested verification, review receipts, checks of checks, tests of testing code, duplicated snapshots or hash-manifest chains. Repeat a check only after a relevant change, failure or concrete unresolved risk.

The plans below preserve the 21 example identities. Every selected or conditionally worthwhile proposal has a concrete implementation path. Deferred grammar has a reconsideration gate instead of an implied commitment. All steps are proposed. Existing task IDs are dependencies or aliases, never duplicate jobs or claims of new completion.

## Common release requirements

Before assigning source changes, inspect current owner-approved commits and reuse accepted task slices. Record the smallest missing producer/consumer contract and obtain its owner handoff. Preserve the current package repair and compiler correctness scopes, native preparation HOLD, installed-release requirements and complete file-tree checkpoint. Narrow task releases may proceed without waiting for every unrelated programme parent.

For a new source feature, compare a complete current-source implementation and a complete proposed implementation with identical actors, permissions, failures, retries and retention. Count total source tokens, declarations, helper code and new public concepts. Require a demonstrated authoring reduction or prevention of a concrete error; record the cost rather than assuming syntax is beneficial. Update grammar, design, decisions, descriptions/editor support and canonical interface metadata together. Reject unsupported syntax explicitly. Capability-gate new artifact semantics and define what happens to pending work and stored data across upgrade.

Run focused parser/checker/emitter tests for source changes, state/interface tests for altered contracts, and actual generated app/browser/durable witnesses where the feature crosses those seams. Do not add implementation-mirroring tests. Broader release checks remain with the existing original qualification tasks.

## 1 Durable workflow composition

**Selected path:** qualified explicit stages and concrete helpers. **Deferred:** `workflow`, `await`, wait-all/wait-any, arbitrary continuation frames. Owners: app/source examples; compiler canonical effects; state/work; Cloudflare assembly. Dependencies: T04/T15 and FP.CONTEXT; T24/T25/T26; applicable T34 and FP.UPGRADE-JOIN; proposals 15, 20 and 21. See DESIGN §§5, 8 and the chat/media design.

1. Complete an image generation → review → publish flow and one contrasting external workflow with current models, scenarios, events and flat machines. Associate each attempt and immutable source revision explicitly. Produce a trace of atomic commits, external deliveries and continuation admission.
2. Finish missing generated effects/receipt/progress/context joins through their existing tasks. Reuse durable event identity and owner transactions. Pin each pending stage to compatible operation/schema versions. A resumed trusted occurrence uses verified system context, not the initiating user's fabricated actor.
3. Extract only repeated pure values or concrete canonical helpers that work under the existing owner boundary. Measure callback/source repetition after extraction.
4. Reconsider bounded await syntax only if both qualified flows still repeat continuation bookkeeping that a declarative owner can derive. Before implementation, specify checkpoint commit order, awaited predicates, read fences, timeouts, lost/duplicate notifications, grant revocation and upgrade behavior. Repeat JEV on that concrete semantic choice.

**Acceptance:** crash before/after each commit resumes safely; replay never creates another provider request; denied resumed work does not inherit stale human grants; an old attempt cannot finish a new one; no transaction spans network waiting. Negative controls include unknown acceptance, no progress, revoked references, invalid historical versions and failed later guards.

## 2 Cancellation and deadline coordination

**Selected path:** standard cancel/reconcile plus keyed schedules; share coordination only after repeated use. Owners: provider/work schedule contracts, app policy, state and generated effects. Dependencies: proposal 15, T24/T26 and FP.CONTEXT; proposal 1 only if a later coordinator controls multiple durable stages. See DESIGN §6 and chat/media stop/reconcile.

1. Qualify start, stop and deadline scenarios for one current attempt. Store immutable attempt/source keys and declare which undispatched work can be suppressed, which accepted work supports targeted cancel, and which work is uncertain.
2. Drive deadline events through existing durable keyed schedules. Define the winner when completion, user stop and timer race. Re-read current association; a repeated lifecycle state is insufficient correlation.
3. After a second application repeats the protocol, extract typed coordinator values and ordinary operations. Keep child membership and terminal evidence explicit; avoid the example's unimplemented `within`/`cancel_scope` effects.

**Acceptance:** pending dispatch suppression, accepted remote cancel, denied stop, timer replacement, duplicate events, late success and cost reconciliation are distinct cases. A stop request cannot set provider success/failure or release a usage commitment without evidence. Restart must preserve outstanding deadlines and unknown outcomes.

## 3 Compensating recovery

**Selected path:** explicit domain recovery and optional helpers. **Deferred:** a compensation DSL. Owners: app/source, provider adapter, work recovery and state. Dependencies: T24/T25/T26, source authority/read fences, proposal 15 or the applicable external operation; proposal 1 only for a future sequencing construct. See DESIGN external effect/recovery rules and sync recovery.

1. Implement two specific protocols, such as refund after a definite charge and withdrawal after definite publication. Specify when reversal is permitted, what cannot be reversed, and who may request it. The earlier upload/publish sketch needs definite-success/result guards before it can reference a publication ID.
2. Atomically record durable recovery eligibility and the canonical recovery request identity with local state. Use the provider's existing idempotency/reconcile contract to cover a crash between remote effect and local observation. Never infer failure from silence.
3. Give recovery its own pending/succeeded/failed/unknown state, evidence, retention and manual escalation. Extract helpers only where both protocols genuinely agree; leave business eligibility in app scenarios.

**Acceptance:** crash at registration/dispatch/receipt boundaries, replayed refunds, duplicate recovery triggers, irreversible actions, rejected reversal and uncertain reversal. Multi-effect failure must preserve which effects were definitely completed; no claim of a cross-service rollback or guaranteed exactly-once remote execution.

## 4 Reusable approval protocols

**Selected path:** concrete ordinary composition, then a shared package/template where safe. Owners: app/package source, canonical state and identity policies, interfaces/UI. Dependencies: T04/T15/T19/T20, FP.CONTEXT, applicable identity and read-fence tasks, proposal 20. FP.INVOCATION is additionally needed only for approving protected operation values. Witnesses: ExpenseFlow, CanApprove and workbench.

1. Implement expense review and image revision review with the same outcomes as their explicit current models/scenarios. Separate common evidence values from domain-specific approval/finalization policies. Prove the storage-owner mapping before shared mutating calls; use concrete source templates if an ordinary imported package cannot participate in the same transaction.
2. Identify the exact subject revision and approval requirements. Specify eligible reviewers, distinct votes, exclusion of requester, quorum, rejection policy, expiry, escalation and re-request semantics. Decide each domain policy explicitly rather than hiding it in universal defaults.
3. Export typed request/approve/reject/read operations and protected review presentation. Source ownership derives schemas and actions once. Publishing/spending remains a separate authorized operation that checks current review evidence.
4. Compare all authored models/policies/helpers between concrete duplication, a template and a package. Promote the stable API only if both domains retain their full rules with less source or a clear correctness benefit.

**Acceptance:** two eligible distinct reviewers can reach quorum; duplicate/self/ineligible votes cannot. Concurrent votes have one consistent result; a modified revision invalidates approval; role revocation and stale submission are rechecked; rejection/expiry/escalation are replay-safe. Approved evidence cannot itself grant publication authority.

## 5 Resource accounting

**Selected path:** typed accounting and app-owned operations; package API conditional on owner proof. Owners: app/accounting values, state transaction/fence, work usage/provider. Dependencies: T16/T17/T24/T26/T32, FP.CONTEXT and applicable provider usage contract; proposal 15. See chat/media budgets and DESIGN atomicity.

1. Select two actual resources with different behavior, such as verified generation usage and concurrent slots. Specify units, bounds, admission maximum, expiry, overflow, replacement and whether evidence may arrive after terminal progress. Establish a single authoritative storage owner for each balance/hold. Enforceable image/token ceilings are a first scope; a hard monetary ceiling additionally requires enforceable provider pricing/cap evidence. Ledger balance need not be universally nonnegative: the loyalty draft deliberately retains negative balances after valid reversals.
2. Implement app-owned admission in the same local transaction that creates its hold and outbox request. If a reusable package is a different owner, do not combine its mutation with the app transaction; choose explicit staged admission/reconciliation or a concrete same-owner source composition and document its crash semantics.
3. Settle only using verified operation-associated usage, idempotently by durable admission/evidence identity. Preserve holds for unknown acceptance, uncertain cancellation and missing usage. Separate concurrency-slot release from cost settlement where their evidence differs.
4. Extract common typed arithmetic/evidence helpers before exposing a mutating `admit`/`settle` API. Compare against explicit app logic; do not resurrect superseded source accounting verbs.

**Acceptance:** concurrent admissions cannot overspend; replay cannot double debit or settle; stale/mismatched/forged usage is rejected; amount overflow and changed currencies/units fail; late usage settles once; unknown acceptance retains the appropriate commitment. Crash tests cover both same-owner commit and any deliberately staged cross-owner handshake.

## 6 Durable bulk authoring

**Selected path:** qualify current cohort/CSV interface first, then a thin derived surface if useful. Owners: compiler descriptors, interfaces/UI, existing state/work cohorts. Dependencies: T19/T20/T24/T33/T34 and FP.CSV, current authority/fence contracts. T33's accepted decision is reused; no second scheduler is proposed.

1. Run a complete reviewed CSV/bounded collection operation against one canonical item scenario. Preserve original item order where required, invalid/excluded rows, cutoff membership, per-item consent, current authority, bounded concurrency and durable outcomes.
2. Measure whether the complete existing form/CSV/cohort source still repeats schemas or orchestration. If it does, specify a minimal bulk binding to the item operation; derive input fields, item results and permissions. Keep independent invocation identities and partial outcomes.
3. Implement descriptor/interface and optional source spelling together, lowering into the existing cohort protocol. Own concurrency/fairness configuration at its actual scheduler owner; app syntax cannot promise an unsupported backend limit.

**Acceptance:** empty and oversized sets, invalid rows, source-order execution, changing grants, restart, per-item retry/unknown outcome and completed-item replay. New/excluded members do not silently enter frozen membership; one item failure does not roll back successful independent items. The derived surface must outperform the existing complete authoring path before adoption.

## 7 Business calendar recurrence

**Conditional trigger:** two apps need matching business-calendar rules that fixed durations/pure current helpers cannot express concisely. **First path:** calendar data/helpers and explicit keyed scheduling. Owners: canonical calendar/value library, work schedules, app policy. Dependencies: T24 and schedule/context qualification; date/time provider/data availability must be established. General recurrence remains outside current grammar.

1. Specify calendars/timezone revisions, holiday ownership, next instant, local-time gaps/folds, missing days, missed occurrence coalescing, overlap and pause/restart behavior on two real calendars.
2. Implement pure next-occurrence calculation where possible plus a standard adapter for versioned timezone/calendar data. Schedule its explicit UTC result through current keyed effects. Keep the business policy visible and avoid duplicated scheduler persistence.
3. Reconsider a declaration only if helpers still repeat stable scheduling boilerplate. Specify occurrence identity and calendar-change migration before parser or runtime changes.

**Acceptance:** DST gaps/folds, leap years, month-end weekends/holidays, timezone/calendar revisions, restart after missed occurrences and simultaneous runs. Events use verified system context and never fabricate a consenting human actor. A calendar helper's date calculation alone does not qualify durable delivery.

## 8 Exhaustive outcome handling

**Selected candidate:** enum-only match, subject to the value gate. Owners: syntax/checker/IR/emitter, source descriptions/editor, testkit. Dependencies: stable existing enum typing and generated scenario seam; provider cases need proposal 15 only for their actual runtime witness. This work can prepare independently of unrelated provider implementation.

1. Compare three complete finite handlers: Generation status, approval outcome and an ordinary non-provider enum. Evaluate stronger if/else coverage analysis against a `match` statement. Add a new case in each comparison to demonstrate exactly which error the checker prevents; ordinary `else` remains intentional fallback behavior, not automatically a bug.
2. Specify a single evaluation of the subject, exact enum owner, one selected branch, lexical bindings, branch return typing, source-order effect semantics, duplicate/unreachable cases and mandatory full coverage. Start without wildcard cases or general patterns. Tagged-union refinement is a later separately checked slice.
3. Implement parser/AST, coverage analysis, IR and emitter lowering into ordinary owner execution. Update editor diagnostics/descriptions and reject unsupported pattern forms. Version/capability-gate artifact changes only if the emitted runtime contract needs them.
4. Run compiled causal examples proving branch effects and later rollback. Compare total authored tokens and diagnostics with improved conditional analysis; accept whichever finite surface meets the same outcomes more simply.

**Acceptance:** an added/removed case invalidates incomplete branches; duplicates, foreign-enum cases and unsupported patterns fail. Subject evaluates once; exactly one branch runs; failure rolls back earlier effects. Nullable subject handling must be explicit. Existing if/else behavior is unchanged. No catch/recoverable-call semantics are bundled with match.

## 9 Input dependent forms

**Selected candidate:** bounded binding to an existing authorized read operation. Owners: compiler form descriptors, contracts, interfaces/read lookup, UI/browser. Dependencies: T15/T19/T20, T08/T32, FP.BROWSER and FP.CONTEXT. Witness: CanApprove's authorized candidate read and nested bound selection forms.

1. Finish ordinary canonical form generation/submission and authorized reference lookup. Compare a complete country/region form, CanApprove reviewer selection and CanRent's available → hold workflow before/after; preserve all candidate and final mutation guards. A lookup is advice and cannot reserve availability.
2. Specify a closed candidate binding whose parameters come from typed, potentially absent canonical draft inputs. Only an authorized read operation with a compatible bounded result can supply choices. Reject mutation calls, dependency cycles, implicit ambient input capture and unreadable projected fields. Do not adopt the sketch's arbitrary `choices=(query)` or repeat input constraints.
3. Carry checked dependencies and parameter mapping in the owning form descriptor. Implement cancellable/debounced lookup, sequence/context fencing, descendant invalidation, loading/empty/error presentation and accessible selection. Preserve unrelated unsaved values.
4. Submit through the existing canonical operation. Current business eligibility is checked again on the server; MCP uses the same final schema and operation, without a browser draft requirement.

**Acceptance:** changing parent clears an incompatible child; delayed responses cannot reinstate it. Unauthorized/expired candidates never leak. Revocation or relation changes before submit reject safely and retain correctable input. Keyboard, focus, errors, localization and simultaneous forms retain stable identity. No change to server authority follows from client filtering.

## 10 Durable multi step drafts

**Conditional trigger:** a real multi-session application needs resume, rather than merely a long form. **Selected first layer:** wizard presentation over explicit draft models/scenarios. Owners: app draft/lifetime policy, canonical forms, UI, files/state. Dependencies: proposals 19/20/21 and T19/T20, FP.BROWSER, FP.FILES-DURABLE, applicable lifetime/upgrade tasks.

1. Author one private versioned draft with explicit ownership, sharing policy, retention, file association and finalization scenarios. Define partial field validation separately from final business validation. The `draft for=apply` sketch is not adopted: required parameters alone cannot derive these policies.
2. Implement accessible step navigation over each canonical save/read operation. Back/advance saves do not execute the final operation. Provide resume, conflict, discard and expiry states using existing records.
3. Final submission revalidates current references/files, performs the complete business mutation, and consumes/finalizes the draft in one allowed owner transaction with replay protection. If owners differ, specify staged finalization instead of claiming atomic consumption.
4. Measure a second workflow before considering generated draft storage or new wizard grammar. Keep current form-draft retention distinct from durable app records.

**Acceptance:** reload resumes saved values; unsaved values remain distinguishable; step navigation never submits business work; two tabs show version conflicts; denied sharing and revoked files fail. Final replay creates one application, and crash/expiry/cancellation follows explicit file retention rules. Schema upgrades migrate or reject old drafts predictably.

## 11 Named reusable views

**Conditional trigger:** a repeated customized subtree remains after using existing defaults. Owners: compiler presentation/type resolution and UI/contracts. Dependencies: ordinary rendering/form qualification; proposal 9 only if the chosen view actually uses its new binding. See DESIGN's existing named-view deferral and CanApprove's two similar candidate lists.

1. Choose one real subtree, including its different bound actions, and measure maintenance/source duplication. Compare inline defaults, shared captions and typed reusable presentation on equal authorized output.
2. Specify explicit typed parameters and operation/action bindings, lexical isolation, import/export rules and acyclic expansion. A view cannot mount routes, grant access, write state or capture implicit caller inputs.
3. Lower checked expansion or shared render functions through existing factories. Derive stable per-use control/modal/form identities and normal field projections; avoid a second fragment endpoint registry.

**Acceptance:** both uses produce expected output/actions; inaccessible fields remain inaccessible; foreign operation values fail; recursive definitions and incompatible arguments are rejected. Repeated/nested uses never collide in IDs or draft values. Qualify imports, localized captions and pending edits on the concrete witness before widening the construct.

## 12 Parameterized domain packages

**Disposition:** defer unrestricted model/role generics; no implementation plan is released. Existing plain packages, exports and concrete templates remain the alternative. Owners for any later decision: package resolver/type system, storage/schema upgrades, identity and interface descriptors.

**Reconsideration gate:** at least two working ordinary domain packages duplicate stable behavior that imports/templates cannot express without substantial maintenance. Document the exact variation points, nominal type constraints, containment/owner compatibility, role substitution and durable instance identity. Compare finite explicit instances against ordinary operations on complete workflows. Consult JEV again on that concrete contract before syntax work.

Any future plan must prove distinct storage/tool identities, no automatic role grants, cross-instance reference rejection, source-derived interfaces and compatible upgrade of existing instances. The earlier unrestricted approval package sketch supplies none of this acceptance.

## 13 Richer and reusable machines

**Current work:** retain implemented flat fields and explicit scenario-owned transitions; complete SM.QUALIFY through proposals 20/21. **Conditional later path:** shared flat lifecycle types. **Deferred:** hierarchy, orthogonal/parallel states, history, terminal annotations with new enforcement, entry/exit callbacks and eventless cascades. Owners: compiler types/graph, state schemas/mutations, UI/tooling, upgrades.

1. Qualify current flat machines through all generated rule/writer paths, persisted upgrades and the actual image app. Preserve current creation defaults, operation edges, ordered provisional state and late-attempt correlation.
2. If at least two qualified models repeat a stable graph, compare existing source composition against a named flat type. Define whether only states/defaults or operation bindings are reusable; do not move permissions out of canonical operations.
3. For a useful flat type, specify nominal identity, default ownership, edge binding, imported compatibility and stored-state migrations before parser/checker/schema changes. Test two real models with different actor policies.
4. Reopen statecharts only with a real nested/parallel workflow whose flat representation demonstrably fails the simplicity/value test. Use the SCXML semantics as a reference and settle target resolution, conflicts, exit/entry order, history and upgrades together. Do not bolt these effects onto the flat implementation piecemeal.

**Acceptance:** flat reuse cannot grant an undeclared edge, allow `set`/CRUD/hook bypass, reset existing rows on upgrade or treat terminal state as an automatic lock. New nominal types cannot collide across imports. Reentering the same state does not admit a stale completion. Advanced semantics require their own complete positive and negative vector set.

## 14 Live subscriptions

**Conditional trigger:** measured polling traffic or freshness fails an application target agreed before comparison. **Selected layer:** platform invalidations and authorized rereads. Owners: state/work commit notification, interfaces/backend, UI/browser. Dependencies: T08/T15/T20/T32 and FP.BROWSER, actual current-authority and installed transport qualification. Existing polling remains the baseline.

1. Measure CanCreative-style active pages: sessions, polling frequency, bytes/query cost and state-to-paint latency. Record actual workload, acceptable freshness and backend limits. Do not infer benefit from an arbitrary `live` keyword.
2. Pilot bounded authenticated invalidation hints after successful atomic commits. Define connection admission, dependency/scope bounds, permission revocation, backpressure, heartbeat/expiry and sequence behavior. Hints contain no business rows or content; even their owner/scope metadata needs permission review.
3. Coalesce hints and fetch the existing context-aware authorized partial. Reuse its draft/focus/version applicator, pause hidden pages, fence logout/team/navigation and recover missed signals by rereading current state. Retain polling fallback for unsupported backends.
4. Compare load, latency and operational cost against polling at equal authority/failure outcomes. Add a source opt-in only if apps must choose meaningful behavior beyond the existing refresh policy.

**Acceptance:** no signal for a rolled-back/precommit mutation; disconnected/disordered/coalesced signals recover; logout/revocation terminates promptly; reconnect never resubmits actions; unknown subscriptions cannot probe record existence. Test client/queue limits and installed transport availability. No client-side state stream becomes business authority.

## 15 Typed generation delivery and progress

**Disposition:** finish accepted source and standard contracts. Owners: compiler descriptors/effects, state receipt observations, work/provider, files, interfaces/UI. Reuse T24/T25/T26/T27, applicable image/text provider qualification and FP.FILES-DURABLE; do not create a second `run` primitive or app-owned progress journal.

1. Trace source send → canonical normalized inputs → same-owner outbox → installed dispatcher/provider → verified progress snapshot → authorized associated observation. Map each missing adapter to its existing task; explicit unsupported Cloudflare stdlib functions are scope evidence, not a replacement architecture.
2. Qualify original-target cancel/reconcile, exact source/revision/sequence, terminal output immutability and late verified usage. Bind current attempt IDs in domain reaction scenarios and keep transport/domain completion separate.
3. Finalize provider files under the existing file contract. Render queued/running/succeeded/failed/cancelled/unknown, withheld result and null observation explicitly. Correct the earlier gallery sketch with a nonnull authorized progress/output guard before gallery binding.
4. Run the installed private image app with meaningful provider/storage evidence and fault injection; complete only the accepted slice actually exercised.

**Acceptance:** superseded/out-of-order/duplicate events, source edits, grant withdrawal, provider refusal/timeout/unknown acceptance, stop with late success, late usage and retry. Protected receipt reads are fenced; missing/withheld outputs cannot trigger resubmission or leak files. One request is created per durable invocation identity; remote uncertainty stays visible.

## 16 Reviewed invocation values

**Disposition:** finish FP.INVOCATION and related current-authority joins. Owners: compiler canonical types, services/state, interfaces projection and protected actions. Dependencies: T04/T15/T16/T32, FP.CONTEXT and the allowed target operations.

1. Normalize and retain target identity, arguments, reference versions and provenance under the accepted finite allowlist. Reuse the existing invocation value; no string dispatcher or alternate execution endpoint.
2. Provide currently readable protected previews. Approve/call the exact value through current target admission, and store approval evidence with effects in the same allowed owner transaction.
3. Qualify actual Workbench update/complete and one publication operation, including post-call invariant rollback and server-managed fields. Descriptive proposals are never execution authority.

**Acceptance:** modified arguments, wrong target/owner, stale versions, revoked role/field access, unreadable preview, replay, nested failure and post-call invariant failure. A rendered action's visibility is advisory; an approval cannot bypass underlying admission.

## 17 Judgments

**Disposition:** finish source-derived judgment lowering/provider qualification. Owners: compiler judgment/catalog, contracts/services normalization, work/provider and testkit. Reuse T12/T13/T24 and FP.AW-JUDGMENT. Proposal 15's receipt/progress slice applies where the judgment is externally delivered.

1. Trace the declaration's versioned rubric, static/runtime choices and generated operation/result schemas to the actual provider request and normalization path. Avoid duplicated generic request APIs.
2. Qualify full probability distributions, completeness, numeric bounds/tolerance, score expectation and exact runtime option correspondence. Record the actual specification/model/usage; localized UI text must not alter inference prompts.
3. Run CanDecide or the accepted judgment consumer with provider negatives and explicit human/business policy. Measure authoring savings against manually repeated schemas only after equal validation is present.

**Acceptance:** missing/extra options, malformed probabilities, out-of-range scores, mismatched version/candidate set, invalid provider output, retries and unknown usage. Never substitute argmax for a declared distribution or treat confidence as calibrated truth or authorization.

## 18 Authorized knowledge corpora

**Disposition:** finish FP.CORPUS and accepted opaque grounding contract. Owners: compiler corpus, source indexing/provider work, state current authority, files and identical UI/MCP projection. Dependencies: T13/T14/T15/T24/T25/T26/T32, FP.FILES-DURABLE and relevant upgrade/retention joins.

1. Lower the single owning corpus declaration to its typed schema/interface and source lifecycle. Join eligible immutable source revisions, scope, index refresh/withdrawal and provider evidence without app-owned ACL/index mirrors.
2. Preserve every source actually supplied to inference. On later disclosure, recheck current authority and exact versions for all used sources, including uncited context. Withhold the whole answer when required; preserve historical status only as allowed by the contract.
3. Keep answer values opaque through rendering/MCP serialization. Join source/file withdrawal, retention and upgraded indexes to durable recovery. Do not convert them to plain text or reusable provider input.

**Acceptance:** revoked/withdrawn/superseded used context, an uncited denied source, unrelated scope change, corrupt provenance, arbitrary model URLs/HTML, provider unknown outcome and file expiry. No answer cache or projection may bypass whole-context checks; citations attest provenance, not entailment.

## 19 Canonical file transfer

**Disposition:** finish ordinary file inputs and opaque MCP slots through existing bridges. Owners: files upload/finalize/provenance/retention, canonical interfaces/schema, UI/browser, state/work. Reuse FP.FILES-DURABLE, T19/T20/T27 and applicable lifetime/installed qualification.

1. Trace browser and MCP transfer into finalized file metadata and owner-authorized references, then the same canonical business operation. Preserve bounded upload/session identity, MIME/size validation and private/public access policy.
2. Join durable metadata/blob storage and provider output finalization. Qualify failure between byte storage, finalization and business association; cleanup must follow existing retention/replay obligations.
3. Run a real attachment form and MCP upload/invocation outside the checkout. No app-specific SDK or `.can` upload primitive is added.

**Acceptance:** incomplete/expired/foreign uploads, forged finalization/provenance, changed content, oversized or invalid MIME, repeated invocation, denied downloads, provider output failures and orphan cleanup. A file token alone never grants bytes or association permission.

## 20 Hooks locks and invariants

**Disposition:** finish generated enforcement; retain accepted rule semantics. Owners: compiler rules/IR/emitter, contracts descriptors, state mutation and Cloudflare adapter. Reuse T04/T15/T31/T32, FP.CONTEXT and SM.QUALIFY; current scoped machine tests remain accepted at their scope.

1. Map each declared rule through checked metadata, actual generated handler, canonical invocation and mutation pipeline. Prove correct hook context, effect order and per-hook version observations. Do not infer complete wiring from descriptor presence.
2. Qualify ordinary CRUD, scenario `set`, nested calls, hooks, explicit transitions, deletion and relevant migration/activation. Preserve exact admission/error ordering, original parameter versions, provisional reads and one transaction version.
3. Ensure locks and final invariants evaluate the intended provisional state; late failure rolls back every staged record/outbox/schedule/history effect. Fixtures/migrations validate valid snapshots without synthesizing lifecycle history.

**Acceptance:** hook write bypass of a managed field fails; stale references, denied fields and forbidden secondary owners fail; aliases/query reads see ordered changes. A hook or post-call invariant failure leaves no committed business effects. Complete generated hook-version observations must be independently demonstrated before closing SM.QUALIFY.

## 21 Causal examples and full journeys

**Disposition:** strengthen existing source examples and original qualification tasks, not a new deployment/test DSL. Owners: compiler/testkit, original-app integration, browser/durable/provider/installed-release peers. Reuse T37–T40, FP.QUALIFY, FP.INSTALLED-RELEASE, applicable FP.UPGRADE-JOIN and SM.QUALIFY.

1. Reconcile current Rust compiler/example support and the older syntax prototype at the chosen pin. Use operation-attached tables/sequences where actually supported; do not advertise proposed parser coverage as execution.
2. For each selected feature, keep inline complete behavior examples with meaningful actors, cause/order, rollback and preserved state. Add malformed/denied/stale/duplicate controls that distinguish correct behavior from a permissive implementation.
3. Qualify one whole image app and one whole approval app through real compiled artifacts and canonical browser/MCP operations. Run crash/restart/replay and schema-upgrade scenarios using the actual durable backend; use provider sandbox/live evidence at the promised scope.
4. Verify installed release/package closure outside the checkout and update the existing app/task evidence. Broaden to other original apps by their relevant dependency gates; do not make an unrelated global parent a prerequisite for every bounded slice.

**Acceptance:** causal sequences prove earlier success plus later rejected replay/guard preserves state; browser roles/actions/drafts remain correct; durable restart does not duplicate work; revoked access withholds outputs; old pending work upgrades compatibly or fails explicitly. Harness seams, mocks, source traces and installed provider behavior are reported separately.

## Parallel implementation lanes

The current integration points below guide ownership handoffs. They are existing locations, not a requirement to keep future code in large files or an active write allocation. Reconcile paths against the selected implementation commit before creating work packets.

| Responsibility | Current integration points |
| --- | --- |
| Source syntax, finite types and checked effects | `compiler/src/syntax/parser.rs`, `compiler/src/syntax/cst.rs`, `compiler/src/analysis/types.rs`, `compiler/src/codegen/ir.rs`, `compiler/src/codegen/js.rs` |
| Canonical form descriptors and browser input behavior | `packages/contracts/src/presentation.ts`, `packages/interfaces/src/http/presentation.ts`, `packages/ui/src/forms.ts`, `packages/ui/src/browser/bootstrap.ts` |
| Atomic mutation, receipt replay and generated execution | `packages/state/src/invocation/invoke.ts`, `packages/state/src/mutation/pipeline.ts`, `packages/cloudflare/src/runtime/invoke.ts`, `packages/cloudflare/src/runtime/stdlib.ts` |
| External dispatch, schedules and finite cohorts | `packages/work/src/dispatch/index.ts`, `packages/work/src/schedule/index.ts`, `packages/state/src/fanout/cohort.ts` |
| File transfer and finalization | `packages/files/src/bridge.ts`, `packages/files/src/finalize/index.ts`, `packages/interfaces/src/uploads/routes.ts` |
| Judgment adapter and normalization | `packages/services/src/judgments/systemone.ts`, `packages/services/src/judgments/harness.ts` |
| Polling baseline and optional notification applicator | `packages/ui/src/browser/polling.ts`, `packages/ui/src/browser/bootstrap.ts`, `packages/interfaces/src/http/presentation.ts` |

Ordinary approval/accounting/calendar source packages do not have adopted APIs or selected filenames yet. Their pilot must establish that contract before assigning new package leaves. Corpus and protected invocation task ledgers also contain proposed target filenames; use their defining-owner handoff rather than assuming every historical target already exists.

| Lane | Preparation or implementation scope | Join boundary |
| --- | --- | --- |
| Generated execution and real image app | Existing 15/19/20/21 tasks plus current machine qualification | Released canonical context/effect/form/file contracts |
| Bounded source ergonomics | 8 enum match comparison; 9 dependent binding specification and vectors | One compiler writer per shared AST/checker/IR/emitter file; descriptors released before consumers |
| Domain reuse | 4 approval pilots; 5 accounting owner/evidence proof; 2/3 explicit recovery examples | Same-owner mutation or explicitly staged protocol, never assumed package-wide atomicity |
| Existing specialized capabilities | 16 protected invocations; 17 judgments; 18 corpus | Existing owner-approved source/provider/projection contracts and original app gates |
| Conditional improvements | 6 bulk surface, 7 calendar helpers, 10 wizard, 11 views, 13 flat reuse, 14 push | Concrete witness and measurement trigger before source/API expansion |

Preparation and isolated vectors can overlap. Runtime releases integrate against exact descriptor versions; final app tests wait only for the features they exercise. This table does not lease files, stop the two coding chats, resume held native work or assign new coding tasks.
