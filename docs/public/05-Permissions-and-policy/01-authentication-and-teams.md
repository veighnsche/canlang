# Understand sign-in, teams and expense-review access

Follow one expense from its requester to an assigned reviewer and a finance report. Learn how verified sign-in and team membership establish context while policies and operations decide actual access.

## Meet the people in the workflow

The complete `ExpenseReview` app below extends the expense-review teaching example with assigned reviewers, a private review note and an aggregate finance report. It is a separate complete application, not a fragment to append to ExpenseFlow or ExpenseData.

Use these responsibilities when reading the code:

| Person | Membership and roles | Intended access |
| --- | --- | --- |
| Ava, requester | Team member | Create and edit her drafts, assign an eligible reviewer, submit, and read her expense status |
| Ben, assigned reviewer | Team member with `reviewer` | Read assigned expenses and their review notes; approve another person's submitted expense |
| Cal, finance | Team member with `finance` | Obtain the team's approved count and total without a blanket expense-row grant |
| Another member | Team member without either role | Their own requester workflow; no access to Ava's expense |
| Signed-out or other-team account | No active membership in this team | No entry to this team's member operations or private expense data |

A person may have several roles; matching read grants combine. These names are illustrative, not special accounts built into the application.

## Sign in and select the team

Default authentication provides verified-email registration, sign-in/out, sessions and expiring email-token recovery. Default teams provide owner-managed membership, verified-email invitations, role assignment and team selection. These facilities need no app-authored login or membership-table declaration. Deployment provisions the first owner.

1. Obtain access to the deployment or local preview. A preview access link is not application sign-in; follow the [first-app access procedure](../01-Get-started/05-first-app.md#obtain-access-and-sign-in) locally.
2. Sign in with the account's credentials. Being signed in establishes identity but does not make the account a member of every team.
3. Select a team where that account has active membership. Team-scoped operations resolve and verify this context.
4. Have an authorized team owner assign the declared reviewer or finance role to the appropriate member. A role declaration alone assigns nobody.

Invitations and recovery belong to the configured identity lifecycle. Accepting an invitation verifies its addressed email and cannot grant roles beyond the stored invitation. Supplying a team ID, role string or copied user ID in a request cannot establish those facts. The last owner cannot be removed or demoted by membership management.

## Use one complete business example

Save this as `ExpenseReview.can`, then run `can check ExpenseReview.can`. Its fixtures and examples describe isolated checks, not browser seed records.

```can
# Review assigned expenses and release finance totals without disclosing rows.
app ExpenseReview
Given
 role reviewer
 role finance
 Expense {
  purpose:text trim min=1 max=300,
  amount:money,
  submitted_by:user server=actor,
  assigned_reviewer:user?,
  status:enum(draft,submitted,approved)=draft,
  review_note:text?,
  decided_by:user?,
  decided_at:datetime?
 }
 contract Totals {count:int,total:money}
 policy Expense read=members where=row.submitted_by==actor fields=purpose,amount,submitted_by,assigned_reviewer,status,decided_by,decided_at
 policy Expense read=reviewer where=row.assigned_reviewer==actor fields=purpose,amount,submitted_by,assigned_reviewer,status,review_note,decided_by,decided_at
 invariant Expense: row.amount.minor>0
 lock Expense fields=purpose,amount,submitted_by,assigned_reviewer when=row.status!=draft
 lock Expense fields=status,review_note,decided_by,decided_at when=row.status==approved
 fixture designated=user {roles=[reviewer]}
 fixture pending=Expense {purpose="Train to client",amount=money(25,"EUR"),submitted_by=other,assigned_reviewer=designated,status=submitted}
When
 crud Expense by=members fields=purpose,amount when=row.submitted_by==actor and row.status==draft delete=none
 scenario assign(expense:Expense,person:user) by=members
  require expense.submitted_by==actor and expense.status==draft
  require reviewer(person) and person!=actor
  do set expense {assigned_reviewer=person}
 scenario submit(expense:Expense) by=members
  require expense.submitted_by==actor and expense.status==draft
  require expense.assigned_reviewer!=null and reviewer(expense.assigned_reviewer)
  do set expense {status=submitted}
 scenario approve(expense:Expense,note:text?) by=reviewer
  require expense.status==submitted and expense.assigned_reviewer==actor and expense.submitted_by!=actor
  do set expense {status=approved,review_note=note,decided_by=actor,decided_at=now}
  examples expense=pending
   as,expense.status,expense.submitted_by -> expense.status,expense.decided_by
   designated,submitted,other -> approved,designated
   designated,draft,other -> error(rule_failed)
   members,submitted,other -> error(forbidden)
   designated,submitted,designated -> error(rule_failed)
 # Summarize only the expense rows and amounts this caller may read.
 scenario visible_totals(currency:currency) read=true -> Totals by=members
  do
   let selected=Expense as expense where expense.amount.currency==currency
   return Totals {count=count(selected),total=sum(selected as expense select expense.amount,currency)}
 # Release the team's approved expense count and total in one currency to finance, without receipt-level data.
 scenario approved_totals(currency:currency) read=true scope=authority -> Totals by=finance
  do
   let selected=Expense as expense where expense.status==approved and expense.amount.currency==currency
   return Totals {count=count(selected),total=sum(selected as expense select expense.amount,currency)}
Then
 page / title="Expense review"
  form Expense.create display=inline
  list Expense columns=purpose,amount,status
   edit
   action assign
   action submit
   action approve
   card "Review note"
    require reviewer and row.assigned_reviewer==actor
    text row.review_note
 page /reports title="Expense totals"
  form visible_totals
  form approved_totals
```

For local role exercises, start a new preview with the seeded Ben actor assigned `reviewer` and Cal assigned `finance`:

```sh
can dev ui --source ExpenseReview.can --app ExpenseReview --preview-roles '{"Ben":["reviewer"],"Cal":["finance"]}'
```

Use its `check` and `open` controls, then sign in with the returned actor credentials and select the team for the exercise. These preview grants are not production role assignments. Use the canonical account/team controls to establish the intended memberships and roles in a deployed app. See [development controls](../15-Tooling-reference/02-development-controls.md) for the seeded-actor mapping and session-selection rules.

Read the app in order: the policies grant reads, CRUD restricts draft edits, `assign` checks another person's role, `submit` verifies the assignment, and `approve` records a decision. The two reports deliberately have different information boundaries. The following pages explain each part without changing this source.

## Admit current team members

`by=members` checks active membership in the resolved team. Current identity, membership and role facts form a trusted admission snapshot. They do not create a cross-owner transaction with unrelated storage.

Completed membership removal blocks new admission. Already admitted work follows its owner fence; D1 fenced commits also detect intervening membership changes. Do not promise that revocation retroactively cancels every external effect or already admitted operation.

Team scope does not give every member every field. Cal's finance role does not grant row browsing, and a team owner is not automatically a reviewer. Continue with [roles and subject predicates](03-roles-and-operation-permissions.md), [row and field policies](02-read-policies-and-field-access.md), and [invariants and locks](04-invariants-and-locks.md).
