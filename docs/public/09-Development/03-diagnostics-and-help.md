# Diagnostics and help

Use diagnostics to locate a source problem, understand its owning rule, and make a change that preserves the app's intended behavior.

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

Parser errors can cause later lines to be interpreted incorrectly. Fix the earliest structural error first, then rerun the check. When a diagnostic refers to generated implementation, use [generation lifecycle](../08-Code-generation/01-generation-lifecycle.md) and [editing and refinement](../08-Code-generation/04-editing-and-refinement.md); do not weaken a source contract merely to silence a generated-code mismatch.

## Inspect source constructs

`can help COMMAND` displays command help. `can policy FILE.can` inspects the declared role and policy gates. Construct-specific help uses stable source-owned identifiers through the development controls; it is tied to a source revision. If a request refers to an obsolete revision, refresh status and ask for help against the current source. Exact language forms remain owned by the [grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md) and [language design](https://github.com/veighnsche/canlang/blob/main/docs/specification/DESIGN.md).

Do not paste private business records, credentials or generated customer content into diagnostic feedback. Report the source location, diagnostic code, expected behavior and a small safe reproduction.
