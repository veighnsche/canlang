# Grant expense rows, fields and report results

Trace who can read an expense and its private note, then compare a viewer-filtered summary with an explicitly authorized finance report. Keep returned information within the declared grant.

## Grant rows and fields together

In the complete [ExpenseReview app](01-authentication-and-teams.md#use-one-complete-business-example), the requester policy is:

```can
policy Expense read=members where=row.submitted_by==actor fields=purpose,amount,submitted_by,assigned_reviewer,status,decided_by,decided_at
```

This `Given` excerpt grants members the listed fields on their own expenses. It does not include `review_note`. The second policy grants the assigned reviewer a broader set:

```can
policy Expense read=reviewer where=row.assigned_reviewer==actor fields=purpose,amount,submitted_by,assigned_reviewer,status,review_note,decided_by,decided_at
```

Both the role and row predicate must match. Being a reviewer does not disclose every expense. Matching policies union their grants for each matching row: an account satisfying both policies receives both field sets. There is no subtractive “deny” policy that cancels a matching grant.

With no applicable policy, reads are denied. Omitting `fields` grants ordinary fields and safe metadata, never secrets. Explicit field lists make this example's private-note boundary visible in source.

## Do not confuse withheld values with null

Ava may read her expense's status and decision attribution, but not its `review_note`. Ben may read the note when he is its assigned reviewer. Cal's finance role alone does not grant either record read. If Cal also submits an expense, the requester policy applies to that record independently.

A withheld field is not a null field. Null can be a valid visible value, such as a review note not yet recorded; withholding means the caller has no grant to observe it. `?.` and `??` do not turn access failures into empty values or default text.

Ordinary lookups and lists omit unreadable rows and must not distinguish a hidden record from a nonexistent one. Filters, counts, ordering, exports, history and aggregates retain current row/field rules. A derived value needs both its grant and its readable dependencies; a helper cannot launder a confidential field into a public result. Changed-record and replayed-result projections are checked against current access too.

## Field selectors and safe projections

A policy may grant a leaf of a singular embedded typed value, rather than its whole container. For example, if an expense had a `payee:Payee` contract containing `name` and `email`, `fields=payee.name` would grant the name and required nullable-prefix presence, not the email or every payee field. This is a hypothetical field extension, not a field in ExpenseReview's listing.

Selectors cannot traverse model/user/member references, arrays, JSON, files, secrets or actions. A reference field grant never grants another record's fields. A parent-value grant subsumes its leaves; a leaf does not grant its parent. Partial projections are not automatically complete assignable values or lookup authority.

## Summarize what the caller can already read

The app's ordinary report is declared as:

```can
scenario visible_totals(currency:currency) read=true -> Totals by=members
 do
  let selected=Expense as expense where expense.amount.currency==currency
  return Totals {count=count(selected),total=sum(selected as expense select expense.amount,currency)}
```

This `When` excerpt requires the app's `Expense` and `Totals` declarations. It sums only viewer-authorized rows and amounts. Ava sees her expenses; Ben sees his own plus those assigned to him under the matching policies. Cal does not receive every row merely because a report has “totals” in its name.

The currency input filters the dataset and gives an empty sum its currency. It does not convert other currencies. Counts and totals remain information disclosures, even when no receipt list is returned.

## Release an authority-scoped report explicitly

Finance needs the team's approved totals without a general expense-browsing policy. That is a separate information grant:

```can
# Release the team's approved expense count and total in one currency to finance, without receipt-level data.
scenario approved_totals(currency:currency) read=true scope=authority -> Totals by=finance
 do
  let selected=Expense as expense where expense.status==approved and expense.amount.currency==currency
  return Totals {count=count(selected),total=sum(selected as expense select expense.amount,currency)}
```

This excerpt belongs in `When` with the same declarations. `by=finance` identifies who receives this information; `Totals {count:int,total:money}` limits its shape. `scope=authority` deliberately reads the bounded authority dataset at the resolved owner rather than applying Cal's ordinary row grants. It does not cross team/storage boundaries or return receipt details.

The description names what is disclosed. This report intentionally reveals count and total, including for a single matching expense; it is not an anonymity guarantee. Ordinary `read=true` reports and viewer helpers do not inherit this authority. Private authority-derived values cannot be leaked from an ordinary mutation return by moving a calculation into a helper.

## Keep presentation gates subordinate to policy

The sample shows its review-note card only when the viewer is both a reviewer and the assigned account. That `require` uses readable assignment information, but the field policy is still the authority. Removing the card gate would not grant Ava access to the note.

A page's admission does not guarantee every row, field or action is available. Empty private lists can be valid; a signed-in finance member can be admitted to the report page while the underlying expense list remains empty. Every form/action invocation still checks its own `by` and guards.

Use the [business-policy walkthrough](05-reviewing-business-policy.md) to verify these distinctions across browser, tools and direct operation calls.
