# Scenarios and effects

A user scenario declares typed parameters, a `by` admission rule, optional leading `require` guards, and one `do` body. Parameters are explicit; a mutation record input carries an expected version. `by` runs before explicit parameter defaults. Guards and body statements then evaluate in written order. `require` failure rejects the complete provisional mutation.

## Declare a guarded mutation

```can
When
 # Finish an open task.
 scenario finish(todo:Todo) by=members
  require todo.done==false message="Task is already finished"
  do
   set todo {done=true}
```

The example is a fragment whose `Todo` model, policy, and membership context must be declared. Effects include create, set, transition, delete, canonical local call, emit, send, schedule, cancel, bounded loop, conditional, enum match, and return. A mutation has one owner transaction; nested `atomic` blocks and arbitrary SQL/JavaScript effects are not language features. A pure `read=true` scenario has no mutation effects and returns a checked result.

A successful mutation returns a receipt plus authorized projections by default. External `send` persists intent and returns a delivery receipt, not provider success. See [transactions and concurrency](03-transactions-and-concurrency.md), [events and hooks](05-events-and-hooks.md), and [actions](08-actions-and-invocations.md).
