# Fixture validity and shared-state journeys — 2026-10-04

## Verified input and alternatives

Read DESIGN sections 3–5.1/13, GRAMMAR inline examples/call rules, REQUIREMENTS inline BDD requirements, `design/evaluation/evidence/language/findings.md` L3 and `experiment-final-review.md` L3C. Current table rows isolate state and invoke exactly one enclosing operation. A production `call` shares caller/transaction, so wrapping calls cannot produce the required distinct callers or separate commits. Named user fixtures provide accounts/grants but cannot alone establish earlier authorized transitions. Existing ExpenseFlow snapshots explicitly set server=actor `submitted_by` to other. The current grammar/parser has no multi-step example body.

Verified actual reference order: submit by=members then owner/status guard; approve by=reviewer then submitted/distinct-claimant guard, then set status/decision fields. Actual CanExpense submit checks membership, claimant/active employee, draft/work scope, different reviewer, role(subject) and reviewer work scope. Decide checks reviewer authority before submitted/assigned/different claimant/work eligibility/reason guards. Reimburse checks finance authority before approved status, exact amount/evidence/date/duplicate conditions. The new notation must invoke these declarations, not repeat their business logic in test helpers.

Compared (A) attached examples/do, (B) a separate named package journey using identical calls/expectations, and (C) explicitly deferred sequence coverage. Equal mandatory outcomes are recorded in each request. Also compared stored-snapshot fixtures with domain server values versus production-creation-input fixtures requiring extra creator setup or real creation calls.

## Full uncertainty and decision

| Review | attached_do | package_journey | defer | journey confidence | stored_snapshot | creation_inputs | fixture confidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | .39 | .59 | .02 | .38 | .96 | .04 | .92 |
| 2 | .93 | .05 | .02 | .90 | .83 | .17 | .67 |
| 3 | .45 | .50 | .05 | .25 | .88 | .12 | .75 |

The notation votes disagree. The independent journey's advantages are real: a cross-operation story is discoverable without picking one operation, and attached examples always retain one body meaning. The attached form avoids a second test declaration/name category and keeps the relevant scenario as the review anchor. It is selected by design judgment, not a vote or confidence threshold: its `do` child unambiguously distinguishes a sequence from a table; no automatic enclosing call exists; at least one explicit call must target the attached scenario; all arguments/callers are stated per call. These checks address ambiguity while retaining shared fixtures and source ownership. The existing table stays canonical for isolated cases. This remains a tradeoff, not proof that one layout always wins.

Stored snapshots preserve existing deliberate historical values without treating fixtures as privileged client inputs. Only domain fields can be supplied; metadata remains reserved, invalid types/references/constraints/files fail before invocation, and seeding claims no prior history. This addresses the actual distinction between valid initial state and valid business execution. Real sequence steps must still use ordinary creation/update allowlists and authorization.

All three contexts, questions and alternative descriptions were fully independently reworded. Facts, compared outcomes and example spellings/identifiers remain equivalent. The concrete candidate necessarily has more syntax detail than deferral; the separate journey option explicitly shares those same semantics, but unequal elaboration and placement still risk framing bias. JEV saw the supplied verified facts only and was not asked to research missing runtime behavior. Complete responses include probabilities, confidences, model and usage. All three external calls succeeded under the standing explicit authorization; no blocked review remains for this consultation.

## Canonical source and desired output

DESIGN §5.1 and GRAMMAR define `examples [seed=[...]]` with a `do` body of `let`, `call Operation {args} by=identity [request={...}] [as typedResult] [-> error(code)]`, and `observations -> expected` statements. The outer example performs no hidden call. Identity selection cannot grant/revoke roles; user fixture grants stay fixed. Each call has a fresh real admission/transaction/step identity, and a matching failure preserves state from immediately before that call, including earlier successful commits. This supports actual recovery without test-only mutation helpers.

Fixture names reload for each statement. A `let` binds ordinary values/versions and requires requery after an intervening write for a fresh record version; a `condition -> true` assertion supplies ordinary true-branch narrowing. `as` can bind only a real declared business result, never an operation-local create binding from a void action. Stale request examples use `request={expense={version=captured_version}}`. Expected-only references do not secretly seed records. The clock is fixed; background delivery/time advance is outside this narrow sequence.

Desired JS preserves flat examples metadata with outer `operation`, `dependencies` and `sequence` descriptors. Nested steps discriminate on `operation`, `let` or `observations`; pure callbacks use `(c,s,b)` with reloaded fixture scope and immutable captures. Calls obtain a separate production context from their selected account. Read-only test inspection cannot become write authority. No runner, parser, compiler or standard library implementation was added.

## Reference trace and focused verification

`examples/ExpenseFlow.can` attaches a sequence on approve. Coordinator review removed the proposed extra draft snapshot because it repeated the pending recipe only to vary state; the sequence now creates the draft through canonical Expense.create and queries it. Existing tables remain unchanged. Manual trace:

| Step | Ordinary admission / first relevant check | Expected state |
| --- | --- | --- |
| Create and query draft | Expense.create by other admits writable purpose/amount; server submitted_by=other | draft, initial version |
| Capture original version | newly created draft | immutable initial version |
| Submit by other | member, owns submitted_by=other, draft | submitted, version 2 |
| Approve by other | lacks reviewer role; by fails before body | forbidden; submitted/version 2 unchanged |
| Approve by reviewer_one with captured version | reviewer by passes; supplied 1 differs from current 2 | conflict; submitted/version 2 unchanged |
| Approve by reviewer_one at freshly queried current version | reviewer, submitted, other differs from caller | approved, decided_by=reviewer_one, version 3 |
| Approve by reviewer_two | reviewer passes, status guard fails | rule_failed; approved/prior decider/version 3 retained |

This reference demonstrates connected transitions and three named/current actors without pretending its second reviewer is finance. Complete claimant/reviewer/finance and correction/reimbursement business traces belong to the CanExpense app owner's source, using this same sequence contract; that work is a separate app change.

`python3 tools/can_parser.py examples/ExpenseFlow.can` rejects the sequence header with `examples require one header and at least one row`, as expected for the explicitly unimplemented sequence grammar. A temporary projection removing only the new sequence validates the unchanged supported fixture/table/production syntax; it is not sequence parsing. `git diff --check` passes for owned files. No sequence or table was executed. The saved trace is manual evidence, not a test result.

A final bounded clarification requested by the coordinator pins deterministic verified example.test email facts for provisioned test accounts, exposed only on the current actor through the existing canonical-auth contract (DESIGN §4). Seeding still uses self. This is a fixture default, not another account-directory or identity-provider API; unverified-auth setup remains unsupported by this recipe.
