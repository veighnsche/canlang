# Initial delivery recipe selectors

This is a focused draft-contract decision, with a [Can witness](jev/delivery-recipe-overrides-20261004/witness.can), [desired JavaScript witness](jev/delivery-recipe-overrides-20261004/witness.mjs), and [three saved consultations](jev/delivery-recipe-overrides-20261004/README.md#source-wording-check). Shared DESIGN/GRAMMAR and application files are deliberately unchanged in this lane. Nothing here implements provisioning or a runner.

## Verified problem and alternatives

DESIGN §5.1 permits simultaneous initial model-snapshot selector overrides, evaluates all row cells against untouched initial state, rejects overlapping paths, and distinguishes invalid setup from an actual business rejection. User/file recipe internals remain protected. §8.1 adds operation-resolved delivery recipes with complete normalized `request` and initial `status/result/error`; framework-derived identity, owner, principal and binding are protected. §13 lowers these to a distinct `delivery` recipe discriminator with deferred `values`, ordinary dependency closure and table selector metadata. It currently permits no initial receipt selectors.

Grant and Mail each need five complete receipts to distinguish pending, succeeded, failed, unknown and skipped. Approve uses those five plus a different frozen decision request. Repeating complete normalized requests adds no independent assertion: their differences are the initial status/result/error envelopes. Request differences remain meaningful and must still use distinct recipes.

| Alternative | Same outcome coverage and safety | Authoring and contract cost |
| --- | --- | --- |
| Distinct complete recipes | Full legal envelopes, existing identity/provenance and untouched-state rules; independently authored expected values remain. | No selector extension; five complete declarations repeat an identical request. |
| Direct initial recipe selectors | Same full validation and expectations; request/identity/authority remain fixed; no production or sequence-time writes. | One declaration per distinct request; requires a precise setup-planning boundary before final receipt provisioning. |
| Factor existing frozen values | Keep complete per-status recipes but reference already-needed model fields or named text messages where available. | Can reduce literal duplication without changing receipt semantics; repeats request/recipe shapes, may introduce model↔receipt cycles, and is not a universal typed request-value fixture. |

The third is an existing local optimization, not a smaller general solution. A message supplies text, not a reusable normalized operation-input object. A model that already points to its receipt cannot also provide that receipt's request through a cyclic fixture declaration. No general value fixture, inheritance, send constructor or test-write action is needed for this problem.

## Decision and uncertainty

Adopt **direct initial selectors for the whole `status`, `result` and `error` attributes of a named delivery recipe in an ordinary isolated table**. Reuse the existing path notation and simultaneous override rules. This revises the explicit recipe restriction; it is not a claim that the current contract already permits it.

All three independently rewritten JEV requests choose `initial_selectors`:

| Run | Confidence | Initial selectors | Separate recipes | Factor existing fields |
| --- | ---: | ---: | ---: | ---: |
| [1](jev/delivery-recipe-overrides-20261004/1.result.json) | 0.72 | 0.81 | 0.14 | 0.04 |
| [2](jev/delivery-recipe-overrides-20261004/2.result.json) | 0.91 | 0.94 | 0.05 | 0.01 |
| [3](jev/delivery-recipe-overrides-20261004/3.result.json) | 0.93 | 0.95 | 0.03 | 0.02 |

There is no categorical disagreement. The first response retains material preference for the simpler existing setup contract; its probabilities total 0.99 and are preserved without renormalization. No confidence threshold was applied. The remaining concern is whether an implementation can make baseline planning and final provisioning explicit without accidentally editing an already-published receipt. The exact phase boundary below addresses the design issue; it is not implementation evidence. JEV supplies advice, not proof.

## Bounded selector rules

`mail_attempt.status,mail_attempt.result,mail_attempt.error` resolves to the fixture declaration `mail_attempt=Mail.send {...}`. Only a direct, unambiguous named delivery-recipe root, including a legal imported alias to that same declaration, has this initial-setup meaning. An operation-input alias holding a receipt does not acquire recipe-write authority.

Each selector chooses a whole initial attribute. `status` has `DeliveryResult.status`; `result` has the target's declared result type or null; `error` has closed safe `DeliveryError` or null. There is no new initial-envelope constructor. Defaults remain pending/null/null. A valid recipe baseline is still required; a row cannot repair a malformed declaration into a usable fixture.

The following stay forbidden:

- `mail_attempt.request` or its children; target/binding, owner/team/principal, credentials/grants, provider identity, ID, revision and other protected metadata.
- `item.notice.status` and any other path through a stored association, even if it references `mail_attempt`.
- `mail_attempt.result.reference`, `mail_attempt.error.code` and other descendant patches. Supply the entire typed result or error cell instead.
- Whole receipt assignment as a recipe constructor, selector mutation between sequence calls, or any production `set` of receipt observations.

Whole **domain reference** selectors such as `item.notice=null` or `item.notice=another_attempt` retain their existing valid-snapshot meaning. They change which initial receipt the model references; they do not edit either receipt. A domain association selector and a direct recipe attribute selector are independent when neither traverses the other's assigned edge. Existing duplicate/ancestor/descendant/alias conflict checks still apply: two import aliases identifying the same `attempt.status` conflict. Never determine conflicts after applying an earlier cell.

A succeeded initial envelope requires the declared result and null error; failed requires null result and a nonnull safe error; unknown has null result with null or safe error; skipped and pending have null result/error. Nullable or no-result operations follow their actual declared result schema. Validate the combined envelope once, rather than rejecting a temporary `succeeded` status before its sibling result cell is applied. Invalid shapes and protected/conflicting selectors are setup/checking failures. They cannot satisfy `error(rule_failed)` or any other expected business error.

File-valued cells must reference valid finalized file fixtures or otherwise satisfy the already-declared test-result provenance contract. Applying a result cell neither creates a file nor confers file authority. Keep receiving app/team/storage owner, operation/binding, verified source, delivery/result field-path and ordered-item provenance, MIME/content/size/quota checks and destination attachment rules. A foreign upload, raw ID, URL or structural file object cannot become an admissible result through this selector. File recipes remain immutable. Existing receiving-store content is reusable only when its provenance is verified; initial selectors add no shortcut.

## Exact initial evaluation order

This is setup planning followed by provisioning, not an operation that updates a provisioned receipt:

1. Resolve the exact selected app/team/binding and the seed/common-input/selected-row fixture dependency closure. Expected expressions still do not seed fixtures. Reject cycles. Resolve user grants and deterministic row-local identities using the existing fixture rules; prepare independent finalized file fixtures through the existing file path.
2. Construct an immutable **baseline setup view** of valid fixture declarations/defaults, model snapshots and complete normalized delivery recipes. Reserve deterministic opaque references, but do not publish a canonical receipt, run hooks/callbacks or dispatch a provider. This internal view supplies the same typed fixture references and baseline query values; it introduces no authored reference constructor or recipe proxy API.
3. Establish common input bindings. Evaluate every row cell exactly once against that untouched baseline, as self for fixture defaults. An invocation caller selector changes the eventual call context, never recipe authority. Baseline request normalization freezes its inputs, locale/release and target under the original context. Later model-field overrides do not silently recalculate that frozen request.
4. Resolve selector paths and all alias/overlap conflicts against that baseline. Fold independent ordinary initial model changes, call-input/wire-envelope overrides and the permitted initial delivery attributes together in the planned final row. Keep each recipe's target, frozen request, opaque identity and authority unchanged.
5. Validate complete resulting normalized requests, full status/result/error envelopes, same-owner associations, final result-file provenance and all model/file constraints against this final planned setup. A model invariant observing its associated status sees the final planned envelope. Never publish an inconsistent receipt or invoke the operation on invalid setup.
6. Provision that validated row's canonical protected receipt **once**, with framework-owned identity/revision and any required finalized result provenance; materialize validated records and associations. The baseline view was not a second real receipt. Do not implement this phase as a mutable status patch on an earlier published receipt. Internal setup retries reuse the same identities and final payload.
7. Record the operation-rejection baseline only after setup is valid. Invoke the registered operation once through its real authority/validation/commit path. Compare independently authored expected observations over fresh state; perform ordinary row cleanup afterward. Receipt provisioning emits no business completion and proves no provider lifecycle or send guards.

An implementation may prepare internal views or isolated staging differently, but must preserve those observable boundaries. Existing callbacks and real multi-call journeys remain distinct. Sequence seeds can use ordinary declared receipt recipes, but this extension adds no sequence-time state editing or automatic background execution.

## Source and desired target correspondence

The [witness](jev/delivery-recipe-overrides-20261004/witness.can) uses one Mail recipe and one file-result recipe, each with a complete fixed request and pending defaults. Two ordinary guarded read operations return the current associated status or file result. Three tables have ten independent expected rows: all five transport states, unknown with/without a safe diagnostic, no selected receipt, and successful/failed/unknown file results. Every row also asserts that the immutable approved domain decision remains unchanged. File success uses the existing finalized `file {}` fixture; successful setup still depends on the provenance checks above.

The JavaScript has the same canonical targets and `delivery` recipe discriminator, dependencies, deferred normalized request `values`, table `selectors`, row `values` and independent `expected` callbacks. There is no new override descriptor or helper. `s.mail_attempt` remains a protected typed reference once final setup is provisioned; the selector string is declaration metadata interpreted by the test planner, not a JavaScript property assignment. Production reads retain `delivery(c,{record:item,field:"notice"},["status"])` and the analogous explicit result property set, with existing record/leaf authorization and receipt fences. Production operations contain no recipe-write capability.

Required diagnostics can be checked independently of operation rejection examples:

| Initial declaration/header/row | Required result |
| --- | --- |
| `mail_attempt.status,mail_attempt.result,mail_attempt.error` with `succeeded,null,null` for EmailV1 | Setup failure: missing declared result; operation never runs. |
| Same header with `failed,null,null` | Setup failure: missing safe error. |
| Same header with `pending,{reference="unexpected"},null` | Setup failure: pending carries a result. |
| `mail_attempt.id` or `mail_attempt.request.to` | Protected selector diagnostic. |
| `item.notice.status` or `mail_attempt.error.code` | Unsupported selector diagnostic. |
| Two aliases of the same recipe's `status` in one header | Alias conflict diagnostic before provisioning. |
| A file-result cell containing a raw ID, foreign/unproven upload or incompatible file | Existing type/provenance/setup failure; no new file privilege. |
| `item.notice=null` | Valid unassociated model snapshot; nullable result, unchanged decision. |

These are specified negative checker/runner cases, not fake business-error rows or executed tests.

## Propose closure and frozen snapshot check

The current `current_offer=Revision {...}` fixture initializes neither `notice` nor `document`; both associations default null. `priced_item=Item {parent=current_offer,...}` gives a one-way containment dependency. Each `Documents.quote` recipe includes `revision=priced_item.parent.number`, explicitly making that Item reachable before evaluating `snapshot=current_offer.snapshot`; the derive's line collection can then see the already-planned Item. `source=current_offer.id` uses the deterministic protected record identity. This is not a delivery association or back-edge.

Closure remains per selected fixture declaration and selected cell references, not per model type or all fixture declarations: a query over `row.Item` does not automatically provision every possible child fixture. Keep the explicit `priced_item` dependency (or an equivalent explicit seed) when reducing the recipe declarations. A selected successful whole result containing `generated_pdf` loads that file through that row's result-cell closure; failed/unknown rows need no file result fixture. Common baseline dependencies remain even if a row replaces them, exactly as the existing table contract states.

An initial `current_offer.document=the_attempt` model association selector is folded only after the receipt's request has been normalized from this untouched graph. It does not add a declaration cycle or a new identity. That recipe denotes one deterministic row-local baseline attempt, reused by all its aliases and that row's internal setup retries; rows remain independent. Do not make `current_offer` declare that receipt as its default while the same receipt request depends on `current_offer`. Do not recompute the frozen request snapshot after changing the initial result, association or other model fields. Wrong result source/revision cases remain valid typed envelopes rejected by the actual business completion guard; they do not change the frozen request or waive file provenance.

## Verification and adoption handoff

The standalone desired JavaScript passes `node --check`. The current parser rejects `delivery(Target)?` at witness line 9. A disclosed temporary structural projection changes only those two field types to `text?`; all declarations and three tables parse. Descriptor-only construction validates dependency closure, exclusive recipe discriminators and ten row/observation arities. Source/target token checks compare all input cells, expected values, recipe requests and canonical operation references. No fixture planner, provider, finalized-file provenance engine or business runner executed.

The coordinator can apply the accepted rules to DESIGN §5.1/§8.1/§13 and the relevant grammar explanations, then reduce recipes per **distinct normalized request**, retaining all independent status/result/error cases. Keep separate declarations for independently required attempt identities and for different frozen requests, as the actual application below demonstrates. Existing status-only leaf grants, domain completion callbacks and typed receipt authority stay unchanged. Full-envelope/provenance validation, baseline planning, protected-path checking and eventual runtime acceptance tests remain explicit implementation work.


## Applied normalization size evidence

The subsequent focused application preserves distinct receipt identities where association independence or superseded completion requires them. Grant retains both detached failed and succeeded receipts beside its varying selected receipt, including pending and no-request cases. All production source bodies and JavaScript production prefixes compare unchanged after test erasure; every original independent expected value/error is retained. Measurements are UTF-8 bytes of each entire `.can` file against the captured pre-normalization state, excluding documentation changes and earlier semantic migrations:

| App | Receipt declarations before → after | Source bytes before → after | Delta |
| --- | ---: | ---: | ---: |
| Grant | 5 → 3 | 43,453 → 43,411 | −42 |
| Mail | 5 → 2 | 38,700 → 38,382 | −318 |
| Approve | 6 → 3 | 31,350 → 31,169 | −181 |
| Propose | 12 → 3 | 42,241 → 41,010 | −1,231 |
| Total | 28 → 11 | 155,744 → 153,972 | −1,772 (about 1.14%) |

No model tokenizer is readily installed, and no token-saving claim is inferred from declaration counts. Explicit initial-selector columns offset much of the eliminated request repetition. Trusted completion tables also repeat event and initial-recipe status/result/error cells so both envelopes are valid and independently checked. A reusable structural fixture value or event-from-recipe form could address that remaining duplication only under a separate contract decision; this application introduces neither.

The coordinator also shortened the unexported primary recipe name to `attempt` where unambiguous; selector/dependency identities changed consistently in source and target, without changing request values or operation behavior. The measurements above include this final normalization.
