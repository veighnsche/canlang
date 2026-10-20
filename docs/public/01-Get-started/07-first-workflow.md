# Add a guarded completion workflow to Tasks

Extend your Tasks app with a guarded completion action and a recorded completion time. Run behavioral examples, try the action in preview, and preserve existing records when changing the schema.

## Before you change Tasks

Finish the [first-app tutorial](05-first-app.md) and keep its `can-tasks` folder and `Tasks.can` file. This tutorial changes the same application, with the same `app Tasks` identity and `Todo` records.

The first version lets members edit `done` directly. This version lets them edit only the title and introduces a `complete` operation that records the time. Create, title editing and archive-delete remain available. You will check four cases: a permitted completion, an already-complete refusal, a caller without membership, and a stale record version.

If your preview is running, keep its development terminal available. Read the existing-data section before applying the new source to stored records.

## Preserve existing task data

Adding `completed_at:datetime?` changes the stored schema. The field is nullable because the first version never recorded completion times. Keep each existing task's identity, title, `done` value and archive state; initialize the new field to null when no recorded timestamp exists.

| Existing record | Meaning after the change |
| --- | --- |
| Open task (`done=false`) | It remains open with `completed_at=null`; completing it records the time. |
| Completed task (`done=true`) | It remains completed with `completed_at=null`, meaning the historical completion time is unknown. The completion guard refuses to complete it again. |
| Archived task | It stays archived and absent from the ordinary list; adding a field does not restore it. |

A compatible nullable field is a candidate for an automatic schema change, subject to validation against the installed schema and complete dataset. It is not permission to reset storage. If compatibility checks require an explicit transition, follow [schema migrations](../12-Deploy-and-operate/03-schema-migrations.md) using the exact installed predecessor snapshot before activating the change. Fresh installations start with the new schema and have no old rows to convert.

Do not backfill historical completion with `now`, reset completed tasks to open, or assume a new default rewrites old rows. This model deliberately allows a completed task whose time is unknown. An invariant requiring every completed task to have a timestamp would need a separate, justified data transition.

Removing `done` from the CRUD allowlist also changes the write contract: existing clients must use `complete` rather than submit status edits. Saving source or passing a source check does not by itself migrate an installed app or establish release compatibility. For a deployed installation, follow [upgrades and recovery](../12-Deploy-and-operate/04-upgrades-and-recovery.md) as well.

## Declare a completion operation

Replace the contents of `Tasks.can` with this entire listing and save it. Do not append a second app declaration. The listing is complete application source; an environment-specific migration, when required, must use that environment's actual predecessor.

```can
# Manage team tasks and record completion.
app Tasks
Given
 Todo { title:text trim, done:bool=false, completed_at:datetime? }
 policy Todo read=members
 fixture open_task=Todo {title="Ship prototype"}
When
 crud Todo by=members fields=title
 # Complete an open task and record its completion time.
 scenario complete(todo:Todo) by=members
  require todo.done==false message="Task is already complete"
  do
   set todo {done=true,completed_at=now}
  examples todo=open_task
   as,todo.done,request.todo.version -> todo.done,todo.completed_at!=null
   members,false,1 -> true,true
   members,true,1 -> error(rule_failed)
   public,false,1 -> error(forbidden)
   members,false,0 -> error(conflict)
Then
 page / title="Tasks"
  form Todo.create display=inline
  list Todo columns=title,done,completed_at
   edit
   delete
   action complete
```

The change has three parts:

1. `completed_at:datetime?` stores a completion timestamp or null. The list displays it alongside the title and done status.
2. `crud ... fields=title` permits title edits while preventing callers from assigning `done` or `completed_at` through CRUD. New tasks still get `done=false` from the model default.
3. `scenario complete(todo:Todo) by=members` admits members, checks that the current task is open, then sets both fields together. `now` comes from the operation's execution context, not a user-entered time.

The `action complete` control invokes the scenario for its list row. Keeping `delete` preserves the first tutorial's archive control; the completion guard restricts completion, not archiving or title edits.

`by=members` is checked before operation defaults or body effects. The guard checks business eligibility before the mutation commits. A rejected operation commits no field or history change. Existing record arguments carry an expected version, so a stale submission conflicts instead of overwriting newer state. See [transactions](../06-Business-workflows/03-transactions-and-concurrency.md) for atomicity and replay.

## Check the changed source and preview

In a shell in `can-tasks`, run:

```sh
can check Tasks.can
```

Resolve any source diagnostics before proceeding. If you stopped the development terminal after the first tutorial, start it again from this folder:

```sh
can dev ui --source Tasks.can --app Tasks
```

If it is already running for this app, use that terminal. Enter `check` at its control prompt and wait for a successful check and a serving preview of the changed revision. Use `status` to read the revision and `details` for diagnostics. A failed replacement does not mean the new workflow is live; the previous serving revision remains identifiable.

Complete any required schema transition described above before using the changed app against existing data. Do not delete the preview's records to bypass a compatibility refusal.

## Run the behavioral examples

The `fixture open_task` declaration supplies an isolated task for the example runner. It does not create a record in your browser preview. Each table row starts from its own fixture state; it does not continue from the preceding row.

Read the example table from left to right:

| Input or observation | Meaning |
| --- | --- |
| `as` | The caller used for this operation, independently of inspection authority |
| `todo.done` before the arrow | The task's stored done value before the call |
| `request.todo.version` | The version submitted by the caller; changing it does not change the stored record |
| `todo.done` after the arrow | The stored done value after the call |
| `todo.completed_at!=null` | Whether the operation recorded a completion time |

Open a second shell in the same `can-tasks` folder, leaving the development terminal running. Ask the selected owner for its current status:

```sh
can dev status --app Tasks
```

Copy the source revision for the successful check from that response. In the following command, replace `rN` with that exact revision, such as `r2` only if your session actually reports `r2`. Run all four cases:

```sh
can dev example.run --app Tasks --expected-revision rN
```

Read the result, not just the command's exit status. A successful run has `result.ok=true`, `result.executed=4`, and a `result.report.summary` with `total=4`, `passed=4`, `failed=0`, `setupFailed=0` and `unsupported=0`. An expected refusal counts as a passing case when its exact error and rollback behavior match.

| Row index | Request | Expected outcome |
| --- | --- | --- |
| 0 | Member completes an open task at version 1 | `done=true` and a non-null completion time |
| 1 | Member completes an already-completed task at version 1 | `rule_failed`; no committed change |
| 2 | Public caller completes an open task at version 1 | `forbidden`; no committed change |
| 3 | Member submits version 0 for the open version-1 task | `conflict`; no committed change |

These cases distinguish authority, business eligibility and concurrency. The public-caller case exercises operation admission even though that caller cannot use the member-only task list. The stale case uses an otherwise eligible open task so the version mismatch is the relevant refusal.

If the source changed after you copied its revision, check again and obtain the new revision before rerunning. Do not reuse the old value against new source. If a case fails, inspect the reported row and diagnostics; a setup failure is not evidence that the operation returned its expected business error. See [development controls](../15-Tooling-reference/02-development-controls.md) for inspecting retained failures and [fixtures and examples](../11-Verify-and-build/02-fixtures-and-examples.md) for the example semantics.

## Try a permitted completion in the browser

1. Enter `open` in the development terminal for a fresh access link. Follow the [first-app sign-in steps](05-first-app.md#obtain-access-and-sign-in), using a local member actor and the same team as before.
2. Confirm the Tasks list includes `completed_at`. Create a new task titled `Try guarded completion`; it should start with `done=false` and no completion time.
3. Open that row's edit control. It should offer title editing, with no writable `done` or `completed_at` field. Cancel the edit without changing the task.
4. Invoke the row's `complete` action and submit its form if one is shown. Confirm that the task now has `done=true` and a completion time.
5. Reload the page. Both values should remain saved. Other tasks should be unchanged.

The completion time records this operation. Older completed tasks with an unknown time remain valid and should not acquire today's timestamp merely because you opened the new page.

## Verify refused actions

If the completed row still offers the completion action, invoke it again. Expect the rule message **Task is already complete**, with the existing completion time unchanged. If the interface makes the action unavailable, use behavioral row 1 to verify the underlying refusal; button visibility alone is not an authorization or business-rule test.

Rows 2 and 3 deliberately exercise the other refused actions without requiring you to fabricate browser requests. The public caller cannot bypass membership checks, and an old submitted version cannot overwrite current data. All four rows should pass, including these refusal cases.

Reload the browser and confirm the completed task's timestamp is unchanged. The example runner's fixtures and overridden values must not appear as added or modified browser records. You can still edit a task's title and archive a task using the controls retained from the first tutorial.

## Continue with larger workflows

You have replaced direct status editing with an operation that owns its permission, guard, mutation and behavioral examples. Use [scenarios and effects](../06-Business-workflows/02-scenarios-and-effects.md) for richer operations, or [state machines](../06-Business-workflows/04-state-machines.md) when a workflow needs several named states and transitions. The [example progression](02-example-progression.md) carries these ideas into expense submission and review.

When finished, enter `stop` in the development terminal that owns the preview and wait for resource release.
