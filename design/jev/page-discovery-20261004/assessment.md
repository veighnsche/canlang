# Page discovery — 2026-10-04

## Verified scope

Read current DESIGN browser presentation/navigation and desired JavaScript contracts, GRAMMAR page attributes, REQUIREMENTS shell ownership, `design/evaluation/INTERFACES.md` E066/E093 and `evidence/interfaces/target-correspondence.md` navigation finding. Reviewed current CanCRM and CanExpense source pages and desired target `appDefinition.pages`/render functions. No compiler, standard-library or runtime behavior is implemented or presumed.

CRM `/sales` has `require salesperson`; its target registry contains only path/render, and salesPage performs the role check and supplies metadata. Expense `/expenses/mine` requires members and `/expenses/review` requires reviewer or finance, again inside target render functions rather than reusable page descriptors. Current static page-level guards found in draft sources use role/authentication facts; inspected dynamic detail guards include row-dependent conditions. The language's general pure `require` and page `data=` contract permits future data-dependent static guards. Source public model policies exist (Resource, Location, Product, Suggestion, Event and Grant); protected actions inside a public catalog must not turn catalog discovery into an operation invocation or implicit member-only page.

The task is compiler-derived safe static descriptors/current admission without unrelated rendering or data work. App source/targets remain owned by other workers. No separate authored navigation tree, permission schema, frontend business store or presentation framework is introduced.

## Compared outcomes and uncertainty

Three independently reworded requests compared the same outcomes:

- One derived admission evaluator, permitting only necessary pure guard-dependency reads.
- Context-only discovery, requiring data-gated static pages to use existing nav=none.
- Context-only candidate links whose full admission is deferred to GET.

| Review | derived_admission | context_only_hidden | candidate_links | confidence |
| --- | ---: | ---: | ---: | ---: |
| 1 | .99 | .00 | .01 | .98 |
| 2 | .70 | .09 | .21 | .54 |
| 3 | .83 | .16 | .01 | .75 |

No selected-choice disagreement occurred, but review 2 gives candidate links a material .21 and review 3 gives context-only exclusion .16. Investigated their genuine tradeoffs: they eliminate business reads during shell discovery, respectively accepting denial after clicking a listed destination or hiding legitimate data-sensitive destinations. Neither preserves the stated current-accessible meaning for all legal page guards. Chosen exact admission therefore explicitly permits bounded reads required by the gate and makes their failures visible as incomplete discovery. It does not claim zero queries, constant time or measured performance.

The supplied contexts/questions/options were independently reworded in all prose while keeping the same verified facts, outcomes and identifiers. The developed descriptor option carries more detail than the others, a framing limitation. Agreements support a design judgment, not a proof, vote or acceptance threshold. JEV received supplied facts and was not asked to research. Full requests/results preserve model, probabilities, confidence and usage; all calls succeeded using the explicitly authorized existing TypeSafe caller.

## Settled source/target contract

Keep existing page syntax. Static title/group/description values use context-free localized message descriptors; dynamic values belong in the body. Source context and direct page require derive one admission program; nested requires stay local. Collection access contributes only authentication/team prerequisites, not a query for a readable row or wholesale promotion of policy roles to page guards. Exact read grants remain on each data query. An explicitly public alternative allows public context, authenticated external grants do not imply membership, and a protected form/action does not raise the containing page's authority. A narrower page-wide restriction remains an explicit source require. Unconditional canonical read invocations additionally contribute their existing owner by admission without running an unrelated read body; this differs from a model row filter or a merely mounted action. The clarification follows required invocation authority, not a second authored page policy.

Canonical desired `appDefinition.pages` entries are `{owner,path,title,description?,order?,group?,nav?,admit,render}`. Registry and `renderPage(c,descriptor,children)` share the same descriptor, with no duplicated renderer title/access schema. `admit(c,routeBindings={})` returns private guard-needed bindings or the actual safe denial/failure. The canonical route dispatcher invokes admission before `render(c,bindings)`; discovery invokes admission only for eligible static candidates, never render. The active renderer reuses needed data at the checkpoint; unrelated body/data/action calls remain lazy. Discovery returns only allowed static metadata, never private bindings. Actual route/query/action checks still run under current authority.

Composition deduplicates canonical owner/route in uses order; source array order supplies ties. Omitted order means 0, negative exceptions precede default pages, positive exceptions follow, and explicit ties retain source order. Owner identity separates groups even if localized captions match. Default captions come from an explicit owner label or first currently eligible default-group page, never from a hidden/unavailable page. Dynamic/token routes are never enumerated. Failed dependency/budget checks produce a generic incomplete-navigation status and no unproven link/label/count, not permission or a stale prior grant.

## Focused manual correspondence

| Case | Discovery admission | Work deliberately deferred |
| --- | --- | --- |
| Expense ordinary active member | Own claims allowed; review denied without either role | Expense/Decision/Reimbursement list queries |
| Expense reviewer with zero readable rows | Review entry allowed; empty data is not denial | Actual scoped records/fields and action guards |
| CRM salesperson revoked/inactive | Canonical role predicate fails; no sales link | Deal scans and pipeline totals |
| Public Resource catalog containing hold form | Public read alternative keeps public entry (with its resolved public team context) | Resource reads and hold authorization/submission |
| Authenticated external customer | Authentication is not silently replaced by operator membership | Customer relationship/read grants remain ordinary queries |
| Static page require depends on stored entitlement | Only that bounded guard closure is read | Other data results, body lists and metrics |
| That required read is unavailable/over budget | Eligibility unavailable; no unproven destination disclosure | No fallback allow and no previous cached grant |
| Nested role-gated group unavailable | Group omitted when rendered; not an added page guard | Group content |
| Dynamic record/token route | Not a discovery candidate; no record/token enumeration | Direct route lookup/admission still required |
| Direct URL after membership/context change | Same admission reruns for current context | Previous navigation result grants nothing |

These are source/contract traces, not executed permission tests. The details of producing a minimal dependency program, bounded query sharing and descriptor dispatch remain implementation obligations.

## Validation and handoff

Extracted the illustrative desired JavaScript descriptor/render witness to a temporary .mjs file: `node --check` passed. A minimal temporary `.can` wrapper containing the same page/require/table declaration parsed with the existing syntax parser. Owned-file `git diff --check` passed. These establish syntax only, not declaration resolution, policy correctness, integration, runtime navigation or cost.

Changed only DESIGN.md, GRAMMAR.md, REQUIREMENTS.md, DECISIONS.md and this evidence directory. The source/JS witness lives in DESIGN §13. No app sources, targets, tracker, existing examples, compiler or library implementation were edited. Target-owner handoff: replace `{path,render}` entries with the single derived descriptor; move static metadata and page admission out of duplicate renderer code; pass admitted bindings into renderer and reuse descriptor in renderPage. CRM/Expense are concrete first mappings, with full source body/description retained. Apply the same shape to remaining targets through their owners.

A small related §13 precision resolves sequence assertion type IDs to underlying scalar/nullable/collection or qualified nominal types; scalar fields do not acquire new field-specific nominal IDs. This was requested by the active Expense target owner and changes no source semantics.
