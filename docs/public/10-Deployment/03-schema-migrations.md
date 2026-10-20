# Schema migrations

Change stored data with an explicit migration from the installed predecessor schema and prove the complete resulting dataset satisfies the new contract.

## Declare the change

Model evolution must identify the exact predecessor and the intended transformation. Renames, drops and value maps are explicit because a rename cannot safely be inferred from similar names, and dropping a field can destroy information. New required fields need a deterministic value for existing rows or an explicitly staged transition that remains valid for old and new data.

Use the migration forms defined by the current language grammar and the app's installed schema history. Do not invent automatic rename detection or assume a new default retroactively populates stored rows. The exact syntax is owned by the [grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md) and language design; this page focuses on the release procedure and data guarantees.

For this illustration, the predecessor must contain `Todo {label:text trim max=200,done:bool=false,legacy:text?}` under the same logical owner. The following source excerpt shows a pinned predecessor, explicit field rename, row backfill and field drop. Replace the placeholder with the compiler-recorded snapshot ID for the actual installed owner; the placeholder itself must fail validation.

```can
# Track team work.
app TeamTasks
Given
 Todo {title:text trim max=200,done:bool=false,priority:enum(low,normal)}
 policy Todo read=members
When
 crud Todo by=members fields=title,done,priority
Then

# Preserve task labels and derive initial priority from completion.
migration TeamTasks from="<installed-owner-snapshot-id>"
 rename before.Todo.label to Todo.title
 backfill Todo
  do
   if before.done
    set row {priority=low}
   else
    set row {priority=normal}
 drop before.Todo.legacy
```

This example is the accepted migration shape, but the model shown is an illustrative destination; it is not the history of the reference app. A real migration must use its own exact predecessor snapshot and owner names.

## Validate before activation

Evaluate the migration against the full installed dataset, including uniqueness, references, invariants and any derived generated-code constraints. Include archived records and preserve old locks, protected identity and reference constraints. Expired content cannot be resurrected by backfill. A collision or invalid converted record blocks activation; preserve the installed data/release while preparing the candidate. A successful conversion plan is not permission to discard source values unless the declaration explicitly does so.

Each predecessor model/field is retained, renamed or explicitly dropped once; each destination has at most one mapped source. Structural mappings are resolved before backfill regardless of directive order. A mapper may read its frozen old row and initialize the desired row, but cannot query/dereference other records, use actor/clock/random values or perform business/provider effects. Physical storage/authority transfers and record splits/merges are outside this migration subset.

The migration must be based on the exact predecessor expected by the selected environment. If the environment advanced independently, stop and reconcile from its actual schema rather than applying a stale plan. Test meaningful edge cases such as null/omitted values, duplicate normalized keys, missing references and records at boundary values.

## Coordinate the release

Schema conversion and code generation are separate: generated code does not migrate deployed rows. Review the compatibility result with the app release, ensure pending old-version work is handled under [upgrades and recovery](./04-upgrades-and-recovery.md), and activate only after the validated migration and runtime are ready as one release process. The exact source syntax remains owned by the [grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md) and language design.
