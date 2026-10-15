# Operations, workflows and events

Use canonical CRUD for routine record changes and typed scenarios for the business actions that make an application specific to your company.

## Enable routine operations

In `When`, one `crud` declaration per model generates create, update and delete:

```can
crud Todo by=members fields=title,done
```

`fields` is the update allowlist and the default create allowlist. Use a different `create_fields` only when creation genuinely takes different inputs. `create=none`, `update=none` or `delete=none` disables that operation. `when` adds an operation-specific predicate; cross-path protections still belong in invariants and locks.

Default deletion archives a record and its contained subtree. `delete=remove` explicitly requests permanent removal where references and lifecycle permit it. Archived records cannot be edited or become new relationship targets. Do not assume a default delete permanently erases audit or receipt history.

`expose` can narrow which enabled CRUD operations are public. It does not change internal authorization or re-enable a disabled lifecycle operation.

## Give business actions a name

This fragment belongs in `When` with Todo declared and readable in `Given`:

```can
# Complete an open task.
scenario complete(todo:Todo) by=members
 require not todo.done
 do set todo {done=true}
```

Parameters are typed. Admission checks the actor and supplied values, then guards run before the ordered `do` effects. Record parameters on mutations carry expected versions so a caller cannot silently overwrite a change made since it read the record.

Use a multi-line `do` body for an ordered sequence of bindings and effects. Keep executable `let` bindings inside that body. `set`, `create` and canonical calls express mutations; a scenario does not bypass policies, locks, invariants, ownership or concurrency checks.

## Separate queries from mutations

A read scenario declares `read=true` and a result type. This `When` fragment counts the Todo records visible to a member:

```can
# Count the tasks you can read.
scenario total() read=true -> int by=members
 do return count(Todo)
```

Read scenarios cannot perform mutation effects. Use typed contracts for structured results. Browser forms and MCP consumers can reuse the same operation signature.

## Coordinate durable work

Declare typed events for facts that other handlers consume. Use `emit` for a business event, `schedule` for a keyed future occurrence, and a trusted scenario with `on=...` for the selected trigger. Event handlers keep an explicit declaring owner and authority context.

Scheduled work has a durable identity and must recheck current eligibility when it runs. External delivery has its own typed request, observation and receipt. A database commit is not proof that an email or another provider action happened. Design the business state for accepted, failed and uncertain outcomes rather than blindly sending again.

Use bounded iteration when a workflow affects a collection. Define its limit and failure behavior; do not treat truncation as successful completion. Preserve operation ordering when a later guard depends on an earlier effect.

## Capture the workflow's contract

Attach examples to a scenario for allowed and rejected transitions. Include stale versions and duplicated requests where they matter. A passing isolated example checks its own operation; a multi-step user journey also needs shared-state and browser checks. Continue with [testing](../03-Build-and-operate/02-testing.md) and [services](06-services-and-generation.md).
