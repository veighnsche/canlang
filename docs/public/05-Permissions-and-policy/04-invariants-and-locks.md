# Preserve expense rules with invariants and locks

Keep amounts valid and submitted evidence stable across every write path. Use the expense-review example to distinguish operation guards, final-state invariants and locks evaluated before a mutation.

## Cover every write path

Use the complete [ExpenseReview app](01-authentication-and-teams.md#use-one-complete-business-example). Its amount invariant is:

```can
invariant Expense: row.amount.minor>0
```

This `Given` declaration validates each affected expense's final provisional state, including hook changes. A CRUD operation, scenario or internal package call cannot commit a zero or negative amount by bypassing one particular form or guard. Failure rolls back the mutation. Invariants are pure; they do not emit events or perform effects.

Dependencies can cause relevant rows to be rechecked when referenced data changes. Work remains bounded and local to the authoritative owner; a cross-owner query cannot provide an atomic invariant. For normal input normalization and bounds, see [defaults and validation](../04-Model-and-query-data/02-defaults-and-validation.md).

## Freeze submitted facts using pre-state

The first lock is:

```can
lock Expense fields=purpose,amount,submitted_by,assigned_reviewer when=row.status!=draft
```

Before submission, the predicate is false. Once the stored expense is submitted, those field values cannot change through any write path. This includes reassignment, even if a later caller is a team owner. A lock is not just a disabled edit control.

The predicate is evaluated on pre-state. The transition that first establishes the condition can set its final values; afterward those values are protected. The app's submission only changes status because assignment and draft edits already happened earlier.

If a reviewer's role is revoked after submission, this lock does not disappear. Current role checks can stop approval, but a recovery or reassignment workflow would need its own explicitly designed rules; no automatic owner bypass is implied.

## Freeze the final decision separately

```can
lock Expense fields=status,review_note,decided_by,decided_at when=row.status==approved
```

Before approval, this predicate is false. One approval atomically sets the approved status, note, reviewer attribution and time. Subsequent writes cannot change those values. Together, the locks preserve both submitted evidence and the recorded decision.

| Check | When it applies | Example |
| --- | --- | --- |
| Operation `by` | Admission | Only a reviewer may call `approve` |
| Scenario `require` | Before its guarded effects | The reviewer must be assigned, and the expense submitted by someone else |
| Model invariant | Final provisional state of each affected row | Amount stays positive |
| Conditional lock | Predicate on pre-state | Submitted purpose and amount cannot change |

One check does not replace the others. A reviewer admitted to `approve` still faces guards and locks, and a valid positive amount does not grant permission to edit it.

## Preserve evidence through lifecycle changes

An omitted lock condition means always locked. A true lock protects its listed values and prevents removal of the protected row, including through scenarios and hooks. Archival preserves locked values; this app additionally disables CRUD deletion with `delete=none` rather than offering an archive workflow.

Declared expiry may eventually dispose of the whole record under [retention rules](../04-Model-and-query-data/06-history-and-retention.md). That exception does not authorize early removal or editing a locked field. Stale versions and receipt replay retain the [transaction rules](../06-Business-workflows/03-transactions-and-concurrency.md); a failed operation commits no change.

Verify both the allowed transition that establishes a lock and refused later mutations. Testing only a disabled browser button does not establish owner enforcement. Continue with [the policy review cases](05-reviewing-business-policy.md).
