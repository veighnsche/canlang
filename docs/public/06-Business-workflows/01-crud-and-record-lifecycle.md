# Restrict CRUD and control record lifecycle

Choose which expense fields callers may create or edit, constrain candidate records, and expose a guarded withdrawal workflow. Distinguish hiding a public operation from disabling its lifecycle.

## Start from one canonical CRUD declaration

Use the complete [ExpenseOperations app](02-scenarios-and-effects.md#declare-a-guarded-mutation). Its `When` section contains:

```can
crud Expense by=members fields=purpose,amount,note when=row.submitted_by==actor and row.status==draft expose=create,update
```

This single declaration derives canonical create, update and delete operations. There is at most one CRUD declaration per model. `fields` is the update allowlist and, by default, the create allowlist. Status, submitter and reserved record metadata are not client-writable merely because the model contains them.

| Part | Effect in this app |
| --- | --- |
| `by=members` | Require membership in the resolved team |
| `fields=purpose,amount,note` | Admit only these ordinary mutation inputs |
| `when=...` | Require the normalized candidate to be the caller's own draft |
| `expose=create,update` | Permit public create/update selection; exclude direct public delete |
| Omitted deletion mode | Keep archive-delete enabled for the guarded withdrawal workflow |

Read policies remain independent. A readable record does not automatically become editable, and an operation's authority is not a blanket read grant.

## Separate create and update inputs

If a model should accept a field only at creation, provide a different `create_fields` list. For example, this is a replacement CRUD declaration in the same app, not an additional one:

```can
crud Expense by=members fields=note create_fields=purpose,amount,note when=row.submitted_by==actor and row.status==draft expose=create,update
```

It allows purpose and amount when creating an expense but only note edits through CRUD afterward. `create_fields` can differ from update fields in either direction. Omit it when the lists are identical. Model defaults/server initialization still supply omitted permitted defaults and server-owned values; every required create field must have a value.

On update, omitted fields remain unchanged and explicit null clears a nullable field. Create defaults do not run again. See [defaults and validation](../04-Model-and-query-data/02-defaults-and-validation.md).

`when` sees the normalized proposed create/update row, including defaults and server values. For deletion it sees the existing row. A query inside that predicate sees provisional owner state before this particular write, not the candidate already staged. Owner-wide rules belong in invariants and locks rather than only this CRUD gate.

## Archive, remove, and expose operations

Default deletion archives a row and its contained subtree atomically. Archived rows cannot be edited or newly referenced; existing references may remain for authorized history. Their retained unique keys are not immediately freed.

| Setting | Meaning |
| --- | --- |
| Omit `delete` | Archive-delete enabled |
| `delete=none` | Disable deletion, including an authored delete effect |
| `delete=remove` | Permanently remove where references, locks and other constraints permit it |
| `create=none` or `update=none` | Disable that canonical operation |
| Omit `expose` | Permit public selection of enabled canonical operations |
| `expose=none` | Exclude all CRUD operations from public selection, while enabled internal operations retain their rules |

An exposure list names only enabled operations. Duplicate, unknown or disabled selectors and mixing `none` with other selectors are errors. A UI `delete` control contradicts the sample's excluded public delete; use its declared `withdraw` action. Exposure does not control model read/list grants or enable a disabled lifecycle.

## Wrap a restricted workflow deliberately

The sample's `withdraw` scenario admits members, checks ownership and draft status, then archives with `delete expense`. Public callers use that operation instead of an unconstrained delete entry point. The guards belong in source; a confirmation dialog alone does not enforce them.

Authored scenarios can change fields beyond generic CRUD input allowlists through explicit effects, but cannot bypass ownership, references, versions, locks or invariants. Internal canonical calls recheck their ordinary admission and rules. See [scenarios and effects](02-scenarios-and-effects.md), [permission boundaries](../05-Permissions-and-policy/03-roles-and-operation-permissions.md) and [retention](../04-Model-and-query-data/06-history-and-retention.md).
