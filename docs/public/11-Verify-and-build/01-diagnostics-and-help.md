# Diagnostics and help

Read source diagnostics, repair errors at their owning declarations, and use revision-bound help and failure details to distinguish source problems from preview or test setup failures.

## Read a diagnostic

Text diagnostics identify a source path, line, column, severity, code and message. Text lines and columns are one-based; columns count UTF-8 bytes. JSON primary/related spans are zero-based, half-open UTF-8 byte offsets into the identified source revision, not editor character positions. LSP positions use their negotiated encoding (UTF-16 by default). JSON output is available for commands that support `--format=json`; preserve its completeness and omitted-count fields when automating. Exit status `0` means no blocking diagnostics, `10` means source errors were reported, and `2` means command or tool failure. Warnings alone do not block.

```sh
can check Tasks.can
can check --format=json Tasks.can
can explain E7004
```

Use `can explain CODE` when a diagnostic code has a registered explanation. A corrective suggestion is guidance; recheck the source after applying it, since a fix can expose another type or authority issue.

## Repair at the owner

Follow the name in the diagnostic to its owning declaration. A missing imported member is usually repaired in the provider declaration or composition, not by adding a guessed local alias. A type error belongs at the expression or declared field boundary. An authorization error belongs in the policy or operation declaration; exposing a hidden control does not repair it.

Parser errors can cause later lines to be interpreted incorrectly. Fix the earliest structural error first, then rerun the check. When a diagnostic refers to generated implementation, use [generation lifecycle](../03-Generate-implementation/01-generation-lifecycle.md) and [editing and refinement](../03-Generate-implementation/04-editing-and-refinement.md); do not weaken a source contract merely to silence a generated-code mismatch.

## Inspect source constructs

`can help COMMAND` displays command help. `can policy FILE.can` inspects the declared role and policy gates. Construct-specific help uses stable source-owned identifiers through the development controls; it is tied to a source revision. If a request refers to an obsolete revision, refresh status and ask for help against the current source. Exact language forms remain owned by the [grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md) and [language design](https://github.com/veighnsche/canlang/blob/main/docs/specification/DESIGN.md).

Do not paste private business records, credentials or generated customer content into diagnostic feedback. Report the source location, diagnostic code, expected behavior and a small safe reproduction.

## Work through a concrete source error

In a temporary copy of [VerifiedTasks.can](../examples/verified-tasks/VerifiedTasks.can), change `task:Todo` in `complete` to `task:MissingTodo`. Run:

```sh
can check VerifiedTasks.can
can check --format=json VerifiedTasks.can > diagnostics.json
```

The second command intentionally fails while saving diagnostics. Read the primary source location for the unresolved type, restore `Todo`, save and recheck. Do not create a new model just to make an accidental name resolve. If several errors follow, repair the earliest structural/name error first.

For a running session, get its current revision and diagnostics, then use a returned zero-based index:

```sh
can dev diagnostic.detail --session SESSION --app VerifiedTasks --revision REVISION --index 0
```

Replace placeholders with the current session/revision, and use index `0` only if that result contains a first diagnostic. Example failures are a different result family: list `failures`, then pass its returned occurrence reference to `failure.detail` or `example.rerun`. Never manufacture a failure reference from a filename.

| Symptom | Check next |
| --- | --- |
| Editor disagrees with CLI | Save the file and confirm both use the same executable, workspace and catalog. |
| Control request refuses a revision | Fetch status and list diagnostics/failures for the new revision. |
| Check succeeds but preview is old | Inspect preview readiness and serving revision; successful source analysis is not publication. |
| Example caller gets `forbidden` | Inspect the declared gate and that fixture caller's grants, not the browser's selected actor. |
| Browser acceptance fails at setup | Check the browser add-on, app-local config and candidate session before investigating app assertions. |
