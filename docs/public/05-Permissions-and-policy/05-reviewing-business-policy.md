# Walk through the expense permission rules

Review the complete expense workflow as requester, reviewer and finance member. Verify permitted actions, safe refusals, private fields, report results and evidence that stays locked after submission.

## Establish the accounts and expected grants

Use the complete [ExpenseReview source](01-authentication-and-teams.md#use-one-complete-business-example). Establish Ava as requester, Ben as reviewer and Cal as finance in one team. Add another ordinary member and use a separate team's account for the boundary check. Assign roles through the trusted team lifecycle, not an app-owned role table.

For local preview, use the seeded-actor role mapping described in [development controls](../15-Tooling-reference/02-development-controls.md). Verify each actor's team selection and current roles before interpreting results. An invitation or successful sign-in alone does not establish every required grant.

## Walk allowed and denied cases

1. As Ava, create a positive EUR expense with a synthetic purpose. Confirm it starts as her draft and `submitted_by` cannot be supplied as another account through CRUD.
2. Edit its purpose and amount. Try an invalid nonpositive amount and confirm no change commits. Try editing status through CRUD and confirm the input allowlist refuses it.
3. Assign Ben. A member without the reviewer role, a member of another team and Ava herself must not become the reviewer through `assign`.
4. Submit as Ava. Confirm purpose, amount, submitter and assignment are now protected. Another member cannot submit Ava's draft merely by knowing its ID.
5. As Ben, read the assigned expense and approve it with a synthetic review note. Confirm status, attribution and time change together.
6. As Ava, read the approved status and attribution, but verify the private review note is withheld. As Ben, verify the note is readable. An unrelated reviewer must not gain it merely by holding the role.
7. Try a second approval and mutations to locked evidence through operation boundaries. Confirm refusal and unchanged state, not just missing controls.

Repeat relevant calls through any exposed MCP or direct operation interface. Browser visibility does not prove server authorization. Compare safe failures without expecting hidden record contents or an error that confirms a confidential record exists.

## Compare the two reports

With only Ava's approved EUR 25 expense present, Cal's ordinary `visible_totals("EUR")` has no granted expense rows and returns count 0 with EUR 0. The authority-scoped `approved_totals("EUR")` returns count 1 with EUR 25. These expectations assume Cal has no requester or assigned-reviewer grant on another expense.

A non-finance member cannot call the authority report. Another team's approved expenses must not enter either report. The report intentionally releases its count and total, but must not return purpose, private notes or receipt-level records. Test empty results and a different currency as well.

## Run the authored behavior examples

The complete source includes four isolated approval cases: designated reviewer succeeds, a draft refuses, an ordinary member is forbidden, and self-approval refuses. `designated` is an example user fixture with an explicit reviewer role; it is not a production assignment or browser seed.

Use the [first-change example-running procedure](../01-Get-started/07-first-workflow.md#run-the-behavioral-examples) with `ExpenseReview.can` and app `ExpenseReview`. Check the source, obtain its successful revision, and run:

```sh
can dev example.run --app ExpenseReview --expected-revision rN
```

Run this from the app folder with its development owner running; replace `rN` with the actual checked revision. All four rows should pass, including expected refusals. They cover operation behavior, not all read projections, report boundaries or lock paths; the joined account walkthrough above covers those separately.

## Review changes and revocation

Remove a reviewer's role or membership and verify new admission is denied as specified. Historical attribution remains intact; do not replace it with a current-role lookup or make old expenses invalid through an always-current role invariant. Already admitted work follows its owner fence; use the [authentication rules](01-authentication-and-teams.md#admit-current-team-members) rather than assuming universal retroactive cancellation.

Check stale versions, direct CRUD exposure, internal calls, returned projections and replay after access changes. A replayed receipt is not an old permission grant. Keep [row/field policies](02-read-policies-and-field-access.md), [invariants and locks](04-invariants-and-locks.md), [retention](../04-Model-and-query-data/06-history-and-retention.md) and external outcomes distinct when reviewing a larger business workflow.
