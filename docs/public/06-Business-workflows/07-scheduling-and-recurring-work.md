# Schedule, cancel and recover expense reminders

Use the complete expense app to schedule a reminder, replace or cancel it, reject stale work and fan out hourly checks. Distinguish calendar intent, recurring ticks and recovery of an existing occurrence.

## Use the same complete application

Start with [ExpenseAsync](06-events-and-hooks.md#start-with-a-complete-asynchronous-app). Its complete source includes every declaration used below; the following blocks are excerpts to read, not additional handlers to append.

The reminder writes `reminded_at` and clears `reminder_at`. The hourly sweep flags overdue records for attention. Both outcomes are stored application state; adding an external notification requires a delivery binding. Use the [integration chapter](../08-Connect-services/02-deliveries-and-recovery.md) when adding actual delivery.

## Schedule under a stable business key

The app's key helper and typed event are declared in `Given`:

```can
event Reminder {expense:Expense,generation:int}
derive reminder_key(expense:Expense):text = format("expense-reminder:{id}",{id=expense.id})
```

Submission sets a new generation and due time, then schedules that key with the matching payload. The default due time is `now+1d`: exactly 24 elapsed hours after admission. It is not “the same local time tomorrow”.

A schedule key is unique within app/owner/package, independent of the calling scenario. `submit`, `reschedule`, `cancel_reminder` and `close` therefore address the same logical reminder. Do not include the generation in the key: that would create different keys instead of replacing one pending reminder.

The schedule commits with the business fields. A failure before that source transaction commits rolls both back. Failure in the later reminder handler does not roll back the submission. The event carries a record reference and a generation copied at scheduling time; the record's current state is rechecked when due.

## Replace the pending occurrence

The replacement scenario is:

```can
scenario reschedule(expense:Expense,due:datetime) by=members
 require expense.status==submitted and due>now
 do
  let generation=expense.reminder_generation+1
  set expense {reminder_generation=generation,reminder_at=due,needs_attention=false}
  schedule reminder_key(expense) at=due event=Reminder {expense,generation}
```

The same key replaces pending work, while the incremented generation lets an old occurrence identify itself as stale. A business revision is used instead of assuming that any unrelated record-version change must invalidate the reminder. Protected record versions still guard the reschedule request itself.

Replacement supersedes the pending occurrence and its undispatched delivery intents. Work already admitted or a provider request already accepted may complete; replacement does not undo an earlier committed outcome.

## Cancel or close deliberately

```can
scenario cancel_reminder(expense:Expense) by=members
 require expense.status==submitted
 do
  set expense {reminder_generation=expense.reminder_generation+1,reminder_at=null,needs_attention=false}
  cancel reminder_key(expense)
```

Cancellation and the generation change commit together. The expense stays submitted, so cancellation means “no pending reminder”, not “withdraw or close the expense”. The separate `close` scenario additionally changes status to closed under the same transaction boundary.

The app does not erase an existing `reminded_at` marker when cancelling or rescheduling. If the previous reminder already completed, that historical result remains. Cancellation is not proof that earlier work or an external side effect never occurred.

## Reject stale work at execution

The due handler reads the record's current state:

```can
scenario mark_reminded on=Reminder
 require event.expense.status==submitted
 require event.expense.reminder_generation==event.generation and event.expense.reminder_at!=null
 do set event.expense {reminded_at=now,reminder_at=null,needs_attention=false}
```

Only a still-submitted expense with the matching generation and an active due time can be marked. A record reference is not a frozen copy of its status. An old generation cannot mark a newer reminder as complete.

Three outcomes must remain distinct:

| Situation | Outcome |
| --- | --- |
| Runtime sees a cancelled/superseded occurrence before admission | Lifecycle skip; handler effects do not run |
| An admitted handler reaches a false authored `require` | Terminal business failure, normally `rule_failed`; provisional effects roll back |
| `flag_overdue` sees a record that is no longer overdue | Its authored `if` takes no action and completes successfully |

A false handler guard is not an instruction for endless technical retry. The runtime's dispatch checks and current-owner fence resolve races; do not assume an earlier cancellation can retroactively undo a handler that committed first. Duplicates of a completed occurrence replay its receipt rather than setting a second completion time.

For a real state-dependent external notification, declare a pure `send ... when=...` dispatch guard as well. It is checked against current state before the provider call; false means skipped. A guard used before a business mutation is not implicitly rerun after its effects or just before every later delivery.

## Run recurring work per owner scope

The hourly source handler is:

```can
scenario hourly_sweep on=every(1h)
 do
  let pending=count(Expense as expense where expense.status==submitted)
  if pending>0
   emit Sweep {cutoff=now}
```

This `When` excerpt needs the app's `Expense` and `Sweep` declarations. Its query supplies the team-owned data dependency. The runtime admits one independent occurrence per eligible team-D1 scope, with verified team/storage context, a receipt and a bounded transaction. Exclusively app-scoped recurring work gets one app occurrence. The app does not loop over tenants or manufacture signed-in actors.

`every(1h)` ticks are aligned to UTC epoch periods, not one hour after the last handler happened to finish. Missed intervals coalesce into one current occurrence per scope rather than replaying every missed hour. New scopes begin at the next slot; removed scopes admit no future work. Compatible releases do not create a second identity for the same scope/slot.

The emitted sweep retains its cutoff and the [fanout handler](06-events-and-hooks.md#fan-out-one-event-into-independent-child-transactions) freezes its cohort. Later records are not appended to an interrupted cohort. They can be selected by a later sweep. Child transactions recheck current record conditions, so completing or closing an expense before its child runs avoids an obsolete flag.

Query work, cohort admission and child execution remain bounded. A loop or sweep is not permission to perform unbounded work. Mixed incompatible owner scopes cannot become one atomic handler. Root-owned recurrence uses explicit record-bound scheduling; `every` does not infer an authoritative enumeration of arbitrary roots.

## Calculate calendar occurrences before scheduling

For monthly work or a local-time appointment, compute an explicit instant using the [calendar recurrence lesson](../04-Model-and-query-data/05-dates-and-timezones.md#calculate-monthly-recurrence-from-its-original-anchor). Keep the original anchor, zone, cycle and stable key with the business record as needed. Handle month-end clamping, daylight-saving gaps/folds and missed cycles deliberately.

Neither `every(30d)` nor adding `1d` expresses all calendar requirements. The scheduler consumes an explicit instant; it does not invent renewal consent, working-day adjustment or monthly billing rules.

## Exercise the lifecycle in preview and deployment

1. Create a valid `EXP-001` expense and submit it. Confirm submitted status and a due time roughly 24 elapsed hours after the request's admission time.
2. Use `reschedule` with a near-future datetime. Confirm the displayed due time changes. Wait for that occurrence and verify `reminded_at` becomes populated while `reminder_at` clears.
3. On another submitted expense, reschedule then cancel before it is due. Verify the due time clears and the cancelled pending occurrence does not later mark it. If it already committed before cancellation, retain that observed result.
4. Reschedule twice under the same key. Verify only applicable current work can mark the record; the old occurrence cannot satisfy the new generation guard.
5. Close a submitted expense with pending work. Verify later work cannot make it active again or flag it as overdue.
6. Exercise an overdue record with delayed reminder processing across an hourly tick. Confirm the sweep can set `needs_attention`. A successful reminder or explicit reschedule/cancel clears that flag.

A normal promptly processed reminder may clear its due time before a sweep ever flags it. Testing the overdue path requires controlled delayed processing in integration/deployment tooling, not sleeping and assuming a specific queue race. Preview checks do not replace verification of durable scheduling on the deployed runtime.

## Recheck due work and recover failures

| Observed state | Recovery |
| --- | --- |
| Transient runtime failure | Retry the same occurrence with stable identity; do not create a new business reminder merely to recover transport |
| Stale-generation business refusal | Inspect the current expense and schedule; do not retry an obsolete intent forever |
| Current overdue reminder needs a new attempt | After reviewing current state, use `reschedule` to create a deliberately new generation and pending occurrence |
| Unknown whether a request committed | Resolve its canonical receipt/status with the same request identity before submitting a second operation |
| One sweep child failed | Preserve completed children and recover applicable incomplete child work under the retained cohort |
| Provider accepted a future notification extension but response is uncertain | Reconcile the durable delivery; cancellation cannot prove the provider stopped |

The `needs_attention` field is application state, not a queue-status replacement or proof of delivery. Inspect runtime diagnostics and retained outcomes to distinguish pending, failed, skipped and uncertain work. Business-operation receipts, handler occurrences and external deliveries each retain their own identity and recovery rules. See [transactions](03-transactions-and-concurrency.md), [events and hooks](06-events-and-hooks.md), [operating an app](../12-Deploy-and-operate/05-operating-an-app.md) and [delivery recovery](../08-Connect-services/02-deliveries-and-recovery.md).
