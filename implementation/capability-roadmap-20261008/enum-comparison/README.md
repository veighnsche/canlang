# SEQ-006 finite enum comparison — preparation only

Awaiting SEQ-001 source/ownership reconciliation and an independent reviewer. No language contract is adopted. No compiler build, runtime test, remote call, JEV request, staging or commit was performed. All writes belong to this packet. `source-manifest.json` records observed HEAD and source hashes; the checkout already had active compiler/package changes, so HEAD alone is not a clean-source certification.

## Scope and honest baselines

`originals/` preserves complete current Generation, CanCreative, CanApprove, CanHire and TeamTasks sources byte-for-byte, including inline examples and draft sequence syntax. Each comparison has a full source variant plus a focused handler. No original app is trimmed or certified complete by a finite handler.

Three complete **added bounded read witnesses** use current enum/if syntax: Generation `Job.status` to its five existing English status captions; approval `Submission.state` to four captions under the current Submission read predicates; ordinary non-provider `Candidate.stage` to six captions under recruiter/location authority. They are supplementary operations, not already implemented current app handlers. Their full variants add exactly one scenario and no model, contract, role, policy or shared helper. Existing locale labels, public boolean approval operation, immutable submissions, notice dispatch, hiring operations and lifecycle remain in the full sources. A production UI replacement would need a separate localization/source-message decision; these English read witnesses do not replace translated captions.

Generation currently has five presentation `alert require` blocks, not a statement dispatch. CanApprove `decide` branches on `approve:bool`; replacing that with enum-only match would change its public input and cannot establish a fair equivalent. These gaps are explicit acceptance questions for tasks 28–32. The added read operations carry the same actors, admission guards, read result types and side-effect-free execution in all three variants; their new API is charged equally to every variant.

`generation-effects/` additionally compares the **actual existing** complete `CanCreative.image_progressed` handler and full app. Existing canonical query identity, progress null guard, requirements, usage settlement, terminal running release, deduplicated outputs and examples remain. The enum-only match expands terminal membership into explicit cases and duplicates the release body across three arms, while queued/running/unknown are explicit no-ops. This supplies an effect-bearing counterweight to short caption examples. The source catalog declares `ImageRun.state` as `enum(queued,running,succeeded,failed,unknown,cancelled)` in `compiler/src/analysis/catalog.rs`; provider execution and full app qualification remain independent.

## Alternatives and future cases

1. Current nested `if`/`else` uses a once-bound subject and a deliberate final fallback. Every current enum value returns one text result. A newly admitted value returns that fallback; omission of an explicit branch has the same behavior. This is a real extension policy, not automatically a bug.
2. Improved existing-if analysis preserves those exact sources. A proposed checker can recognize an immutable once-bound exact enum subject, ordinary equality or membership tests, ordered branches and the finite set left at `else`. It can describe cases handled only by fallback and identify duplicate/unreachable comparisons without altering existing semantics. An informational report on newly added fallback values is honest; an unconditional missing-case error would break deliberate fallback. Mandatory strictness would need an explicit opt-in policy (a new public concept), or a clearly agreed diagnostic rule. No opt-in syntax is invented here.
3. Proposed statement `match subject` with indented `case exact_case` arms explicitly covers every current owner case. No wildcard, OR-case list, patterns, guards, tagged unions, exception capture or recovery. It adds one public control construct with an arm keyword and an exhaustiveness obligation. A new/omitted owner case rejects the source. Current-domain behavior equals baseline; future-domain acceptance intentionally differs from fallback. Thus rejecting new cases is not free preservation of existing forward fallback behavior.

`*-add-case-full.can` and `proposed-match-omit-case-full.can` are raw mutation inputs. Added cases are paused/deferred/screening respectively. Sources are **uncompiled**, including baseline witness additions and all proposed-match variants; no diagnostic outcome is presented as observed. Existing syntax was checked by source inspection: GRAMMAR execution productions permit inline enum types, reference types, `read=true -> text`, `let`, `return`, nonempty `if`/`else` bodies and nested `else`/`if`; parser.rs dispatches `if` and requires an indented body. `else if` shorthand and `match` are absent from the current grammar. Exact enum case ownership, nullable narrowing and all-branch return checking still need independently pinned checker verification.

## Complete authoring cost

Compiler/model token counts are **not measured**. `measurements.json` reports exact UTF-8 bytes and whitespace-separated source units, including the entire app, retained comments/examples and equal added operations. Whitespace units are an authoring proxy, not compiler or model tokens; no precise token savings claim follows. A reproducible tokenizer comparison should be rerun against the accepted compiler version if a token value gate is required.

| Full source | Current if units | Improved if units | Proposed match units |
| --- | ---: | ---: | ---: |
| generation | 225 | 225 | 227 |
| approval | 1862 | 1862 | 1865 |
| ordinary | 2367 | 2367 | 2368 |
| generation-effects | 1474 | 1474 | 1515 |

Read witnesses add one declaration equally in each route. Improved-if source is byte-identical to baseline and adds no mandatory public source concept under informational checking. Match changes no model/interface declarations but adds the control/coverage concept. The actual generation effect route adds no scenario and repeats terminal effects in three arms; count the whole file, not just the shorter-looking `match` header. Shorter caption nesting alone does not establish whole-app adoption value, and a shared formatter would add its own declaration/call/localization costs to all candidates.

## Semantic obligations for tasks 28–32

The subject must evaluate once at its written position, with failure before branch effects and unchanged await/purity admission. Exact owning enum identity is retained even when two owners share spelling; case-position lexical collisions require an explicit resolver decision consistent with existing lexical binding rules. One selected arm runs; branch locals stay branch-local; returned expressions use the scenario's declared type. A required return cannot be inferred from a mere syntactic arm count, because a selected arm may fall through or fail. Existing ordinary effects after a match remain in source order.

Nullable subjects need an explicit null guard/branch outside the enum-only construct; no implicit null-to-fallback mapping. Do not assume a match on nullable `Run.state` is equivalent to matching guarded nonnull `value.state`. Pattern matching does not grant row access, reviewer authority, provider identity, protected output attachment access or mutation permission.

A branch failure and later failure must preserve the same owner transaction semantics. The read witnesses make no writes and cannot prove rollback. The generation effect substitution needs actual compiled owner-route proof that usage/running/output changes roll back together on later failure. Provider receipt facts already committed elsewhere and independently completed remote work cannot be undone by local rollback. No compensating send or catch semantics are proposed.

`expected-cases.json` contains raw expectations for independent review: finite values, added/removed/omitted/duplicate cases, intentional fallback, owner collisions, unsupported forms, nullable subjects, single evaluation, branch scope, return typing, authority failure, provider identity, repeated terminals/late usage and later rollback. They are not self-approved acceptance results.

## Proposed handoff, not a decision

Task 28 should first accept or replace the added read witness boundary and settle deliberate fallback diagnostics. Task 29 can then specify finite owner/nullable/return rules; task 30 implement the winning surface; tasks 31–32 must run compiled causal and interface/editor checks. Retain both alternatives until complete authored token counts, strictness policy and effect-bearing proof can be compared fairly. Root owns any DECISIONS.md/plan reconciliation after review; this packet intentionally makes no accepted decision or contract adoption.

## Correction receipt after independent ER-01–ER-05 review

The added approval tables now seed `reviewer_worker`; pending/approved/rejected use the assigned scoped reviewer, while withdrawn uses submitter `self`. Withdrawn reviewer denial remains separately specified with active reviewer grant and no submitter/coordinator privilege. Added hiring tables now seed `test_worker` for caller self with recruiter role; the negative setup retains membership/recruiter but sets that worker inactive and supplies no replacement grant. These edits apply to all focused, full and mutation variants; byte-identical originals remain unchanged.

Every finite route expectation now names actor, membership, fixtures, current work grants, location, readable reference and chosen route. Caption outcomes are body expectations after readable reference admission. A false leading require yields `rule_failed` only if reached; the actual canonical added-user-read facade may deny reference/field admission earlier. Its exact first error remains unverified. No global `not_found` substitution or observed diagnostic is claimed.

Raw sources now include current/improved-if omitted branches and all three owner-case-removal variants. Domain removals preserve full original operations/examples (which can themselves become invalid); this is a compound domain migration probe, not isolated diagnostic attribution. Isolated proposed `match` sources cover duplicate case, foreign case, wrong return type, nullable/explicitly guarded nullable, branch scope, lexical collision and unsupported wildcard. These remain uncompiled inputs to unresolved contract questions. An added ImageRun catalog case is a concrete JSON old/new catalog input paired with the full consumer sources; it does not mutate product catalog source. Effectful/awaited single-evaluation instrumentation remains a future contract vector, because inventing a legal effectful helper or execution route would exceed source preparation.

`measurements.json` refreshes the twelve principal source proxies. `packet-source-costs.json` separately tallies every `.can` original, principal variant, mutation and isolated probe. Source inventories identify the compared inputs. Token counts, tokenizer/config choice, strictness opt-in source and runtime/tooling costs remain unclosed; this receipt accepts no contract, diagnostics, runtime route or whole-app outcome.
