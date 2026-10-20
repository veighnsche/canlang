# Write expense operations with explicit effects

Create, change and return expense records through typed scenarios. Use local bindings, branches, bounded loops and canonical calls while keeping every effect inside one owner transaction.

## Declare a guarded mutation

Use this complete `ExpenseOperations` application to study operations. It is a separate teaching app, not replacement source for ExpenseReview: reviewers here may read all team expenses, while the [permission lesson](../05-Permissions-and-policy/01-authentication-and-teams.md) demonstrates assignment-specific access.

Save the whole listing as `ExpenseOperations.can`, then run `can check ExpenseOperations.can`.

```can
# Prepare and submit expense records with explicit owner transactions.
app ExpenseOperations
Given
 role reviewer
 Expense {
  purpose:text trim min=1 max=300,
  amount:money,
  note:text?,
  submitted_by:user server=actor,
  status:enum(draft,submitted,approved)=draft machine
 }
 policy Expense read=members where=row.submitted_by==actor
 policy Expense read=reviewer
 invariant Expense: row.amount.minor>0
 lock Expense fields=purpose,amount,note,submitted_by when=row.status!=draft
When
 crud Expense by=members fields=purpose,amount,note when=row.submitted_by==actor and row.status==draft expose=create,update
 scenario create_draft(purpose:Expense.purpose,amount:money,note:text?) -> Expense by=members
  do
   let cleaned=trim(note ?? "")
   create Expense {purpose,amount} as expense
   if cleaned!=""
    set expense {note=cleaned}
   else
    set expense {note=null}
   return expense
 scenario submit(expense:Expense) by=members
  require expense.submitted_by==actor
  do transition expense.status draft -> submitted
 scenario approve(expense:Expense) by=reviewer
  require expense.submitted_by!=actor
  do transition expense.status submitted -> approved
 scenario submit_many(expenses:Expense[]) -> int by=members
  do
   for expense in expenses limit=20
    call submit {expense}
   return count(expenses)
 scenario withdraw(expense:Expense) by=members
  require expense.submitted_by==actor and expense.status==draft
  do delete expense
 # Describe the current status of a readable expense.
 scenario status_message(expense:Expense) read=true -> text by=members
  do
   match expense.status
    case draft
     return "Draft: ready to edit"
    case submitted
     return "Submitted: awaiting review"
    case approved
     return "Approved"
Then
 page / title="Expense operations"
  form create_draft display=inline
  list Expense columns=purpose,amount,status
   edit
   action submit
   action approve
   action withdraw
   action status_message
```

Preview it with `can dev ui --source ExpenseOperations.can --app ExpenseOperations`, then use `check`, `open` and the [first-app sign-in steps](../01-Get-started/05-first-app.md#obtain-access-and-sign-in). Member actors can create and submit their drafts; approval needs a different account with the declared reviewer role.

Each scenario declares typed parameters, optional result type, `by` admission, optional leading guards and exactly one lowercase `do` body. `by` runs before explicit parameter defaults; guards and statements then evaluate in written order. Uppercase `Then` still declares presentation, not effects.

## Bind values, create a record and update it

The `create_draft` operation first binds `cleaned` with `let`. A `let` is an immutable local value, not a stored field or assignment to the parameter. Executable bindings stay inside `do` and do not escape their lexical scope.

```can
let cleaned=trim(note ?? "")
create Expense {purpose,amount} as expense
```

This is an excerpt inside `create_draft`. The object shorthand reads its bound parameters: `{purpose,amount}` means `{purpose=purpose,amount=amount}`. `create ... as expense` binds the newly created record. The model supplies the initial machine state and server-owned submitter; these are not arbitrary client fields.

`set expense {note=cleaned}` changes the named field on that record. Omitted fields remain unchanged. Assigning a local variable is not a storage update. Arrays stored by value are replaced with `set`; there are no free-form `append`, `upsert` or SQL effects.

A new record remains version 1 throughout its creating transaction, including the subsequent note update. Nothing in this operation is committed until the complete transaction succeeds.

## Branch without changing transaction scope

The `if` branch stores a nonempty trimmed note; `else` stores null. With `note="  Keep receipt  "`, the record's note becomes `"Keep receipt"`. With null or whitespace-only text, it becomes null. This is an explicit application normalization choice, not a rule for every nullable text field.

Both branches belong to the same transaction. A later failure rolls back earlier `create` and `set` effects. A body `require` has the same rejection semantics as a leading guard: false normally yields `rule_failed` and rolls back the whole provisional mutation. It does not keep the earlier successful statements.

The `status_message` read operation demonstrates `match`. It evaluates the nonnullable enum once, selects one arm and returns the text for that state. Every case of that exact enum needs one arm; adding a new status requires updating the match. Missing, duplicate or unknown cases fail checking. There is no wildcard or fall-through. A result-bearing operation must actually return on every reachable path, not merely list every case.

For nullable values, handle null before matching. Use `if` for intentional fallbacks or type narrowing; this `match` form covers finite enums, not arbitrary union patterns or exception recovery.

## Call another operation and loop with a bound

`submit_many` calls the canonical `submit` operation for each supplied record:

```can
for expense in expenses limit=20
 call submit {expense}
return count(expenses)
```

This excerpt requires the array parameter and `submit` declaration from the full app. `call` retains the caller, team, operation identity and owner transaction. It rechecks the target operation's admission and guards. It is not an HTTP request, a privilege switch or an independently committed nested transaction. Cross-package mutation uses a canonical call to the owning package; it cannot make incompatible owners atomic. Calls cannot recurse.

The loop processes supplied array order and has an explicit maximum. More than 20 items fails the entire operation; it does not silently submit the first 20. An empty array does no work and returns zero. Duplicate references are not deduplicated: a second submission of the same record encounters its provisional submitted state and fails the transition, rolling back the batch.

For two distinct open drafts, the operation returns `2` and commits both submissions. If the second record is already submitted, belongs to someone else or fails a version/owner check, the batch commits neither submission. Use separate top-level requests only when separate commits are the intended product behavior.

A canonical call to a result-bearing operation may use `as name`. For example, inside a member scenario with matching `purpose`, `amount` and `note` parameters:

```can
call create_draft {purpose,amount,note} as draft
call submit {expense=draft}
```

Here `draft` is the declared `Expense` result of `create_draft`, not a generic receipt. The newly created record and submission still share the outer transaction; if submission fails, no draft from this call commits.

## Delete according to the model's lifecycle

`withdraw` checks that the caller owns the draft, then executes `delete expense`. The model's default deletion mode archives it, including any contained subtree. This is not permanent removal. `delete=none` would disable deletion even for an authored effect; `delete=remove` explicitly requests permanent removal where references and other constraints permit it.

The sample excludes canonical delete from public CRUD exposure and exposes the guarded withdrawal workflow instead. Internal enabled operations keep their canonical rules; no UI or exposure setting grants a lifecycle exception. See [CRUD restrictions](01-crud-and-record-lifecycle.md).

## Return business results without leaking authority

`return expense` ends `create_draft` and provides its declared business result. A later caller can bind that result with `call ... as ...`. `return count(expenses)` returns an integer from `submit_many`; `status_message` returns text on every path. A return does not bypass final invariants or commit checks.

Without an explicit result, a successful mutation supplies its receipt and currently authorized changed-record projections. Explicit results also obey disclosure rules. A record result is not a grant to all its fields, and private authority-derived scalars cannot be leaked from mutation returns. A deliberate privileged report needs the explicit [authority-scoped read contract](../05-Permissions-and-policy/02-read-policies-and-field-access.md#release-an-authority-scoped-report-explicitly).

A `read=true` operation has a required result type and returns on every path. It permits pure statements and viewer-authorized reads, not storage mutations. Calling a pure helper does not elevate its authority.

## Distinguish committed intent from external completion

Other effects include typed `emit`, `send`, `schedule` and `cancel`. They participate in the owner's transaction as domain events, delivery intent or scheduled work. `send ... as delivery` binds a delivery receipt, not proof of provider success. Network effects dispatch after commit and retain their own recovery outcomes.

There is no nested `atomic` block or arbitrary JavaScript/SQL effect: the mutation already has one authoritative owner. Continue with [transactions and concurrency](03-transactions-and-concurrency.md), [state machines](04-state-machines.md), [events](06-events-and-hooks.md) and [delivery recovery](../08-Connect-services/02-deliveries-and-recovery.md).
