# Schedule a reminder and reject stale escalation

Schedule a task reminder with a stable key and business generation, replace it safely, cancel on completion and verify that stale or duplicate work cannot change the current task.

## Source and prerequisites

Download [Reminders.can](../examples/recipes/Reminders.can), a complete task app with record-bound scheduling. Use a preview or test deployment whose scheduler supports the declared contract. No mail provider is required: escalation here is the visible `escalated` flag for the task owner, not an email or a manager notification.

```sh
can check Reminders.can
can dev ui --source Reminders.can
```

Sign in as a member, create “Review demo contract” and choose **Arrange** with a due time a few minutes in the future.

## Replace one pending reminder

The operation increments a business generation and schedules the same key for this task:

```can
let generation=task.generation+1
set task {due,generation,escalated=false}
schedule reminder_key(task) at=due event=Reminder {task,generation}
```

This is a `do` excerpt from `arrange`; the complete source defines `reminder_key` from the task ID. The key remains stable when due time changes. The generation travels in the event so an old occurrence cannot act on the new schedule. The task update and schedule commit together.

Choose **Arrange** again with a later due time. Confirm the new time replaces the old pending reminder. Do not include the generation in the key: that would create another logical schedule instead of replacing this one.

## Observe escalation or finish first

When due, the handler requires unfinished status, a matching generation and an active due time no later than `now`. It records `reminded=now`, clears `due` and raises `escalated`. The polling page shows that result.

Alternatively choose **Finish** before the due time. It marks the task done, clears the due time, increments the generation and cancels the stable key. Clearing the flag does not erase a previous `reminded` timestamp; that is historical evidence.

## Verify races and failures

1. Let one reminder run and verify its timestamp and escalation flag.
2. Reschedule another before its original due time. The old generation must not escalate it; the replacement can.
3. Finish a third task before due. No later stale occurrence may reopen or escalate it.
4. Try arranging or finishing another member's task: ownership checks refuse it.

A cancelled/superseded occurrence skipped before admission differs from an admitted stale handler whose authored guard fails. The latter produces a terminal business refusal with no partial writes; it is not an instruction for endless retry. Duplicate dispatch of a completed occurrence replays its outcome rather than producing another timestamp.

If you add external notification, retain its receipt and use a current-state `send ... when=...` guard. Cancellation can race an already accepted provider call and cannot undo it. Reconcile uncertain delivery by its original identity. See [scheduling](../06-Business-workflows/07-scheduling-and-recurring-work.md) and [delivery recovery](../08-Connect-services/02-deliveries-and-recovery.md).
