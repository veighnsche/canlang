# Fixtures and examples

Write behavioral examples with explicit callers, fixture records and expected outcomes. Use isolated cases or shared-state sequences to check successful operations and precise refusals.

Examples are attached to operations in `.can`; they describe expected behavior rather than deriving expectations from an implementation. A fixture recipe creates only the records, users, files or delivery receipts needed by the selected example. Declare shared baseline dependencies once, then add row-specific dependencies where needed. A row must not depend on unrelated rows' fixtures.

For complete applications to read or adapt, use the [example progression](../01-Get-started/02-example-progression.md). A behavioral `examples` block tests an operation; it is not a complete app or a browser-data seed.

## Table examples

A table example supplies common inputs and fixture dependencies, then lists rows with values and either expected observations or an exact expected error. The runner provisions the selected row's dependency closure, evaluates its input values against the seeded baseline, invokes the operation, and compares observations afterward. When multiple selector fields change together, they represent one simultaneous override; do not rely on an order between cells.

The [ExpenseFlow example](https://github.com/veighnsche/canlang/blob/main/examples/ExpenseFlow.can) shows source-owned fixture and table syntax in a complete application context:

```can
fixture pending=Expense {purpose="Travel",amount=money(25,"EUR"),submitted_by=other,status=submitted}
scenario approve(expense:Expense,note:text?) by=reviewer
 require expense.status==submitted and expense.submitted_by!=actor
 do set expense {status=approved,decision_note=note,decided_by=actor,decided_at=now}
 examples expense=pending
  as,expense.status,expense.submitted_by -> expense.status,expense.decided_by
  reviewer,submitted,other -> approved,self
  reviewer,draft,other -> error(rule_failed)
  members,submitted,other -> error(forbidden)
```

This is an excerpt: it depends on the app's `Expense` model, `reviewer` role, policy and scenario context in that file. The cases assert both a permitted approval and exact rejected outcomes. No helper names are implied beyond the declarations shown.

## Sequence examples

Use a sequence when behavior depends on earlier committed calls: create, capture the returned business value or version, then call the next operation and observe the result. Seed the dependency closure once for the sequence. Each statement reloads fixture records from the shared isolated stored state, including earlier committed changes; it does not recreate the baseline. Immutable bindings retain values captured by earlier steps, including old versions. Assert each call's exact success or error and state that must remain unchanged after refusal. An expected rejection clears the current `result` and preserves earlier successful commits. A rejected call cannot bind a successful business result. Example external effects are inspectable queued intents; examples do not dispatch live network calls or advance the fixed example clock.

Examples run against a test context, not production data. Test inspection authority is separate from the genuine caller authority used by each operation. See [workflow and interface testing](04-workflow-and-interface-testing.md) for joined journeys and [transactions and concurrency](../06-Business-workflows/03-transactions-and-concurrency.md) for version behavior.

## Run a complete task example

[VerifiedTasks.can](../examples/verified-tasks/VerifiedTasks.can) is a complete application with a reviewer-only completion operation. Its table has three isolated cases: completion succeeds for a reviewer, refuses an already-completed task, and refuses an ordinary member. Download the file, then run:

```sh
can check VerifiedTasks.can
can compile --format=json VerifiedTasks.can > VerifiedTasks.artifact.json
can build --artifact VerifiedTasks.artifact.json
can test --artifact VerifiedTasks.artifact.json
```

Stop after any failed command. Source checking verifies the example's declarations and types; only the example run checks its behavioral expectations. Fixture records are isolated test data, not preview seeds.

The complete source includes this sequence attached to `complete`; it needs the file's `pending`, `checker` and `member` fixtures:

```can
examples seed=[pending,checker,member]
 do
  call complete {task=pending} by=member -> error(forbidden)
  pending.done -> false
  call complete {task=pending} by=checker
  pending.done -> true
  call complete {task=pending} by=checker -> error(rule_failed)
  pending.done -> true
```

The failed first call changes nothing; the successful second call persists for the third. A sequence does not implicitly invoke its enclosing operation. Bind declared business results with `call ... as name` when later steps need them; immutable bindings keep captured values rather than tracking later changes.

## Choose the right fixture family

These are contextual `Given` recipes, not additional complete applications:

| Family | Example | What it establishes |
| --- | --- | --- |
| Model | `fixture pending=Todo {title="Prepare demo"}` | A typed stored record; references pull in their required fixture dependencies. |
| User | `fixture checker=user {roles=[reviewer]}` | A same-team actor with explicit static role grants. `user {}` has membership without that custom role. |
| File | `fixture note=file {type="text/plain",owner=self}` | A test file with controlled provenance; not an arbitrary production file constructor. |
| Delivery | `fixture sent=Mail.send {request={to="demo@example.invalid",subject="Demo",body="Hello"},status=pending}` | A typed receipt for an actual bound operation, with complete request input and consistent status/result/error. |

The delivery line assumes a bound `std.EmailV1 as Mail`; check that operation's schema before adapting it. Use the [mail](../08-Connect-services/04-email-and-mailboxes.md) and [runtime AI](../09-Runtime-AI/01-text-and-image-generation.md) examples for richer typed request/results. Pending receipts do not prove external delivery. File results need valid finalized provenance, not fabricated strings.

Use `seed=[...]` for dependencies needed by observations or sequence steps that are not already reachable from inputs. User roles cannot be edited through table selectors. Delivery recipes may select permitted whole status/result/error values for setup; protected identity/request metadata is not editable. Invalid fixture setup fails before the business invocation and cannot satisfy an expected business error.
