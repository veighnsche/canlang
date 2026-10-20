# Approve expenses with separate requester and reviewer authority

Build an expense submission and review flow with explicit caller roles, immutable submitted values, attributed decisions and checks for self-approval, stale versions and repeated review.

## Source and prerequisites

Download the complete [ExpenseFlow.can](../examples/recipes/ExpenseFlow.can). It contains the expenses owner, reporting package, forms and inline table/sequence examples. Use the [installed toolchain](../01-Get-started/03-installation.md) and a local test team; no external provider is required. This version approves monetary claims and has no receipt attachment field or notification delivery.

From the directory containing the file:

```sh
can check ExpenseFlow.can
can dev ui --source ExpenseFlow.can --app ExpenseFlow --preview-roles '{"Ava":["reviewer"],"Ben":[]}'
```

Local preview roles are separate from the source's user fixtures. Use the preview's actor credentials and select the same team in each session.

## Submit as the requester

As Ben, create “Train to demo office” for EUR 25.00. The server owns `submitted_by`; the user cannot select a different requester. Submit the draft. Its status becomes `submitted` and its purpose, amount and requester become locked. A positive-money invariant refuses zero or negative amounts.

These are the actual guards and transition from the `expenses` package:

```can
scenario submit(expense:Expense) by=members
 require expense.submitted_by==actor and expense.status==draft
 do set expense {status=submitted}
```

The source's draft edit rule permits only the requester's own draft. Submitted values cannot be silently changed after the reviewer sees them.

## Review as another actor

As Ava, open the submitted claim and choose **Approve expense**, optionally recording a note. The operation checks both submitted status and that the actor is not the requester, then records `approved`, the note, reviewer and server time. Final decision fields are locked. **Reject expense** requires a nonblank reason and records the corresponding rejected decision.

Read the resulting decision as Ben. The ordinary member sees their own expenses; the reviewer has the broader review read grant. The reporting package summarizes only authorized expenses in the selected currency and status; it does not add cross-currency totals.

## Verify and recover

Compile, build and run the file's examples using the [example workflow](../11-Verify-and-build/02-fixtures-and-examples.md#run-a-complete-task-example), substituting `ExpenseFlow` for the sample filename. The included sequence creates and submits a claim, checks an unauthorized approval, checks a stale version, approves through a reviewer and refuses a second decision.

In the browser, also create an expense as Ava and attempt self-approval: being a reviewer does not bypass the separation rule. Try editing a submitted amount and reviewing a final claim; both must be refused. A stale mutation must be reread and deliberately reviewed with current data, not automatically overwritten.

No email is sent by this recipe. If you add one, retain its delivery separately: a delayed notification must not undo an already committed approval. Add finalized receipt files through the [file workflow](../08-Connect-services/03-files-and-attachments.md) and lock the evidence with the submitted values if your policy requires it.
