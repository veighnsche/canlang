# Add a guarded workflow

Continue the `Tasks` app from the [first-app tutorial](03-first-app.md). Add a `completed_at` field and replace direct status editing with an explicit completion operation. This example shows an authored business rule, a typed mutation, and an independently written behavior example.

## Declare a completion operation

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
  list Todo columns=title,done
   edit
   action complete
```

The fixture supplies an open task. Each row starts from isolated fixture state; `todo.done` on the left changes that initial state, while `request.todo.version` changes only the submitted version. The successful row checks completion and the non-null timestamp. Other rows expect a rule rejection for an already completed task, forbidden admission for a public caller, and a conflict for a stale version. These expectations are written independently of the effect body. See [fixtures and examples](../09-Development/04-fixtures-and-examples.md) for fixture setup and observation selectors.

`by=members` is checked before operation defaults or body effects. The guard checks current business eligibility, then the body stages a single owner transaction. If the guard fails, no field or history change commits. Existing record arguments carry an expected version; stale submissions conflict rather than overwrite. For reusable lifecycle edges use [state machines](../05-Workflows/04-state-machines.md); for atomicity and replay see [transactions](../05-Workflows/03-transactions-and-concurrency.md).
