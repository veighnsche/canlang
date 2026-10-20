# Handle expense events, hooks and durable fanout

Build a complete asynchronous expense app with CRUD hooks, committed events and per-record fanout. Separate source transactions from later work, preserve event facts, and recover without repeating completed effects.

## Start with a complete asynchronous app

`ExpenseAsync` is a separate complete teaching application. Members share expense records so the lesson can focus on event lifecycles; it does not replace the narrower assignment and finance rules in [ExpenseReview](../05-Permissions-and-policy/01-authentication-and-teams.md).

The app normalizes references, records submissions asynchronously, marks scheduled reminders as handled and flags overdue records during an hourly sweep. A reminder here is a stored marker, not an email or provider call. No external service binding is required.

Save the entire listing as `ExpenseAsync.can` and run `can check ExpenseAsync.can`:

```can
# Track expense submissions, scheduled reminders and overdue review attention.
app ExpenseAsync
Given
 Expense {reference:text trim min=1,purpose:text trim min=1,status:enum(draft,submitted,closed)=draft,reminder_generation:int=0,reminder_at:datetime?,reminded_at:datetime?,needs_attention:bool=false}
 Submission {expense:Expense,reference:text,recorded_at:datetime server=now}
 event Submitted {expense:Expense,reference:text}
 event Reminder {expense:Expense,generation:int}
 event Sweep {cutoff:datetime}
 policy Expense read=members
 policy Submission read=members
 invariant Expense: row.reference==upper(row.reference) and starts_with(row.reference,"EXP-")
 derive reminder_key(expense:Expense):text = format("expense-reminder:{id}",{id=expense.id})
When
 crud Expense by=members fields=reference,purpose when=row.status==draft delete=none
 scenario normalize_create on=Expense.create
  do
   set event.after {reference=upper(event.after.reference)}
   require starts_with(event.after.reference,"EXP-")
 scenario normalize_update on=Expense.update
  do
   set event.after {reference=upper(event.after.reference)}
   require starts_with(event.after.reference,"EXP-")
 scenario submit(expense:Expense) by=members
  require expense.status==draft
  do
   let generation=expense.reminder_generation+1
   let due=now+1d
   set expense {status=submitted,reminder_generation=generation,reminder_at=due,needs_attention=false}
   emit Submitted {expense,reference=expense.reference}
   schedule reminder_key(expense) at=due event=Reminder {expense,generation}
 scenario record_submission on=Submitted
  do create Submission {expense=event.expense,reference=event.reference} as recorded
 scenario reschedule(expense:Expense,due:datetime) by=members
  require expense.status==submitted and due>now
  do
   let generation=expense.reminder_generation+1
   set expense {reminder_generation=generation,reminder_at=due,needs_attention=false}
   schedule reminder_key(expense) at=due event=Reminder {expense,generation}
 scenario cancel_reminder(expense:Expense) by=members
  require expense.status==submitted
  do
   set expense {reminder_generation=expense.reminder_generation+1,reminder_at=null,needs_attention=false}
   cancel reminder_key(expense)
 scenario close(expense:Expense) by=members
  require expense.status==submitted
  do
   set expense {status=closed,reminder_generation=expense.reminder_generation+1,reminder_at=null,needs_attention=false}
   cancel reminder_key(expense)
 scenario mark_reminded on=Reminder
  require event.expense.status==submitted
  require event.expense.reminder_generation==event.generation and event.expense.reminder_at!=null
  do set event.expense {reminded_at=now,reminder_at=null,needs_attention=false}
 scenario hourly_sweep on=every(1h)
  do
   let pending=count(Expense as expense where expense.status==submitted)
   if pending>0
    emit Sweep {cutoff=now}
 scenario flag_overdue on=Sweep each=Expense as expense
  do
   if expense.status==submitted and expense.reminder_at!=null and expense.reminder_at<=event.cutoff
    set expense {needs_attention=true}
Then
 page / title="Expense reminders"
  form Expense.create display=inline
  list Expense columns=reference,purpose,status,reminder_at,reminded_at,needs_attention
   edit
   action submit
   action reschedule
   action cancel_reminder
   action close
 page /submissions title="Recorded submissions"
  list Submission columns=reference,recorded_at
```

Start preview with `can dev ui --source ExpenseAsync.can --app ExpenseAsync`. Enter `check`, wait for the serving revision, then use `open` and [sign in as a team member](../01-Get-started/05-first-app.md#obtain-access-and-sign-in). The complete app includes the scheduling and recurring-work declarations explained in the [next lesson](07-scheduling-and-recurring-work.md); do not paste its excerpts as duplicate handlers.

## Adjust or reject a pending CRUD write

`on=Expense.create` and `on=Expense.update` declare precommit CRUD hooks. Their `event` contains typed `before`, `after` and `input` values. The sample uppercases the proposed reference, then requires the `EXP-` prefix.

Creating `exp-001` through CRUD stores `EXP-001`. Creating `wrong-001` fails the hook's guard and commits no expense. On update, the same rule applies to the proposed replacement. `event.before` and `event.input` are read-only; `set event.after` adjusts the pending create/update without recursively calling CRUD.

On create, `before` is null. On update, both sides exist. For archive-delete, `after` is the archived record; for permanent removal, `after` is null. A delete hook may reject but cannot adjust its target. There is at most one hook per model/CRUD operation, and it cannot call back into its triggering CRUD operation.

Scenario effects do not pretend to be CRUD and do not rerun these hooks. That is why the sample also declares an invariant requiring uppercase `EXP-` references: every committed write path must respect the data rule, while CRUD supplies a helpful normalization step. A hook is not a substitute for owner-wide invariants and locks.

## Handle committed events separately

Inside `submit`, these effects belong to the expense's source transaction:

```can
set expense {status=submitted,reminder_generation=generation,reminder_at=due,needs_attention=false}
emit Submitted {expense,reference=expense.reference}
schedule reminder_key(expense) at=due event=Reminder {expense,generation}
```

This excerpt depends on the named parameters and local bindings in the full scenario. Status, event intent and schedule commit together. If the source mutation fails, none becomes committed work.

After commit, `record_submission on=Submitted` runs in its own owner transaction. It creates a `Submission` record containing the event's copied reference. If that handler fails, it cannot roll the expense back to draft or retroactively reject the submit request.

The custom payload deliberately contains both `expense:Expense` and `reference:text`. Loading the record reference observes current authority state; it is not a historical snapshot. The copied text preserves the reference chosen at emission. Likewise, `recorded_at=now` records when the handler records the submission, not necessarily the original submit time. Add an explicit emitted timestamp if the business needs that historical instant.

Can also supplies committed model-change sources such as `Expense.created`, `.updated` and `.deleted`, distinct from the singular CRUD hook sources. They identify the record, owner, resulting version and occurrence; they do not implicitly preserve every old field value. No event is inferred from an arbitrary scenario or enum name.

## Keep trusted handlers distinct from user operations

A user scenario has parameters and `by=...`. A handler has no client parameter list and uses `on=Source`; the two admission forms are mutually exclusive. Handler input is the typed `event` from a verified source, and handlers are not public MCP tools.

Trusted handlers have `actor=null`. Their team/storage context comes from the verified occurrence, not a supplied user ID. The sample's `Submission.recorded_at` can use `now`; it deliberately has no nonnullable `user server=actor` initializer that would pretend a handler is a signed-in person.

Named queues and adapter events follow their declared payload and verified ingress contracts. A transport can duplicate or reorder deliveries; handler occurrence identity and receipt replay prevent the same completed work from executing again. This does not deduplicate different business events that merely have equal payloads. See [context and defaults](../02-Language-foundations/05-context-and-defaults.md) for queue declarations and [delivery recovery](../08-Connect-services/02-deliveries-and-recovery.md) for external outcomes.

## Fan out one event into independent child transactions

The declared `Sweep` event drives this handler:

```can
scenario flag_overdue on=Sweep each=Expense as expense
 do
  if expense.status==submitted and expense.reminder_at!=null and expense.reminder_at<=event.cutoff
   set expense {needs_attention=true}
```

This is a complete handler excerpt requiring the same model/event declarations. `each=Expense` selects same-package records. `as expense` binds the current stored child for that invocation; `event.cutoff` remains the source event's copied cutoff.

The runtime freezes cohort membership for that source/handler occurrence and retains it across retries. It does not re-enumerate to add a later-created expense when resuming. Each selected child receives its own stable identity, current admission and one bounded owner transaction. Current guards still decide whether to act: a now-closed expense takes the no-op branch successfully.

A successful child's effects, receipt and checkpoint commit together. Replaying the source does not rerun completed children. If another child fails, only that child's provisional changes roll back; earlier children and the source transaction stay committed. This is not the all-or-nothing loop used by [batch submission](02-scenarios-and-effects.md#call-another-operation-and-loop-with-a-bound).

For a contained cohort, the alternative `each=event.batch.ExpenseLine as line` requires a declared event with a nonnullable `batch` model reference and an actual contained `ExpenseLine` collection. That is an alternative shape, not a declaration in this sample. It keeps the same frozen-membership and child-transaction rules.

## Verify hooks and asynchronous completion

1. Create `exp-001` with a purpose. Confirm the stored reference is uppercase. Try `wrong-001` and confirm the refused create leaves no record.
2. Submit the valid draft. Confirm its status and reminder due time are committed.
3. Open `/submissions`. Wait for the later handler to complete and confirm a separate submission record appears with reference `EXP-001`. The row is not evidence that an email was sent.
4. Treat the absence of that record as pending or failed handler work to inspect, not proof that submission itself rolled back. Use runtime diagnostics to distinguish those states.
5. For fanout, inspect two selected children where one handler is rejected or transiently fails. The already-completed child's flag and receipt must survive; only applicable incomplete work resumes.

The last case needs a controlled failure through the deployment's integration/operations tooling; do not invent a business API that triggers runtime failures. Source checking and isolated examples do not by themselves prove queue delivery, fanout checkpoints or deployed retry behavior. See [workflow testing](../11-Verify-and-build/04-workflow-and-interface-testing.md).

## Recover at the failed occurrence

| Failure | What remains committed | Correct recovery boundary |
| --- | --- | --- |
| CRUD hook refuses input | No source write | Correct the input and make a new deliberate request |
| Source submission fails | No submission event or schedule from that request | Resolve the source diagnostic/conflict; preserve request identity for an uncertain response |
| Submission event handler has a transient failure | Source expense and durable event | Retry the same handler occurrence; completed receipts replay |
| Handler `require` is false | Source remains; this handler commits no domain effects | Terminal business refusal; investigate current state rather than retry forever |
| One fanout child fails | Source and completed children remain | Recover applicable incomplete child work using retained membership and identities |

Error reporting cannot join a transaction that has already failed. Instrumentation is bounded and best effort, strips credentials, records dropped reports and excludes its own reporter failures to avoid loops. Use [operating an app](../12-Deploy-and-operate/05-operating-an-app.md) for runtime inspection, and the [scheduling lesson](07-scheduling-and-recurring-work.md) for supersession and cancellation races.
