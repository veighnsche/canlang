# Fixtures and examples

Use independently authored examples to verify business outcomes with realistic identities, records, dependencies and exact expectations.

Examples are attached to operations in `.can`; they describe expected behavior rather than deriving expectations from an implementation. A fixture recipe creates only the records, users, files or delivery receipts needed by the selected example. Declare shared baseline dependencies once, then add row-specific dependencies where needed. A row must not depend on unrelated rows' fixtures.

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

Examples run against a test context, not production data. Test inspection authority is separate from the genuine caller authority used by each operation. See [workflow and interface testing](./05-workflow-and-interface-testing.md) for joined journeys and [transactions and concurrency](../05-Workflows/03-transactions-and-concurrency.md) for version behavior.
