# Additional inline fixture actors — 2026-10-04

## Verified question and decision

DESIGN §5.1 originally provided only self/other in the current team and outsider in another team. Its role selectors assigned roles only to self and each example row invoked one enclosing operation exactly once. The L3C evidence in `design/evaluation/evidence/language/experiment-final-review.md` identifies the missing third current member and warns against equating seeded historical outcomes with executed earlier transitions. Existing `declared_role(subject)` already checks the subject's current role. `fixture NAME=path {fields}` already parses, so a test-only user recipe requires semantic meaning rather than a separate declaration grammar.

Choose `fixture name=user {roles=[role]}` and `as=name`, preserving ordinary-member default and legacy role-to-self selectors. Explicit self/other callers are also defined. A new actor map would keep identity setup adjacent to each table, but introduces another reusable binding mechanism for the same identity/dependency problem. User recipes fit existing shared fixture identities, imports and dependency loading. Deferral would leave the concrete positive noncaller/third-account cases unsupported. This is a reasoned bounded decision, not a probability threshold.

| Review | user_fixture | actors_map | defer | confidence |
| --- | ---: | ---: | ---: | ---: |
| 1 | .92 | .06 | .02 | .88 |
| 2 | .99 | .01 | .00 | .99 |
| 3 | .81 | .18 | .01 | .72 |

There is no winning-choice disagreement, but the third wording assigns appreciably more probability to the map. Its real advantage is local discoverability, while recipes reduce repeated declarations across tables. The fixture option is developed in more detail in every prompt because it is the concrete candidate; this framing limitation remains. Shared agreement is neither execution evidence nor proof that alternatives were exhaustively explored. All requests and complete responses retain model, probabilities, confidence and usage.

## Wording and provenance

The three requests independently rewrite every context paragraph, question and option description. They preserve the same checked source facts, success criteria and three outcomes; syntax/identifiers are intentionally stable. No attached repository files or undisclosed research were sent. JEV was asked to choose from supplied information, not to discover facts.

Initial sandbox invocations of all three requests failed to connect without producing responses. Elevated requests 1 and 2 succeeded. Request 3 was initially rejected by automatic approval review: “This sends internal fixture-design context to an external JEV service; although JEV consultation is generally preauthorized, the trusted instructions do not specifically authorize this payload to this destination.” Inspection confirmed only the stated Can design facts/options in the saved payload. The unchanged command was presented again through the same tool/endpoint, explicitly identifying the user's authorization to send relevant Can design context via TypeSafe. That review approved and the third response succeeded. No alternate route or payload bypass was used; no approval block remains.

## Scope and validation

Changed contract: DESIGN §5.1, GRAMMAR fixture/caller semantic rules, REQUIREMENTS actor examples, and the proposed user recipe lowering in DESIGN §13. Existing syntax is retained. `examples/ExpenseFlow.can` adds two same-team reviewer fixtures, a submission by built-in other proving both noncaller grants and three distinct actors, and approval rows selecting each named reviewer. Its original role-selector rows remain. This reference exercises actor semantics without changing the app's production workflow or pretending that its separate rows run sequentially.

`python3 tools/can_parser.py examples/ExpenseFlow.can` accepts the reference (syntax only). Semantic grant validation, role observations, provisioning, identity isolation, authorization and runtime BDD execution are unimplemented and were not executed. Full claimant/reviewer/finance and finance-rejection/correction/reimbursement shared-state journey authoring remains a separate concrete gap. A user fixture in a file owner recipe is an additive dependency meaning, not a new upload path.
