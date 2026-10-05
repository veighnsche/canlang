# MCP P1 evidence: operation descriptors in the artifact

Scope: `/tmp/mcp-scope.md` packet §c-P1. Branch `muse/closeout/mcp`. No
commit. Shared contract for the P2/P3 siblings — do not deviate.

## The contract

`CompileArtifact` gains additive `operations[]`. Each entry is exactly
`{name, kind, description, inputs}`:

- `name`: canonical operation identity (`expenses.approve`,
  `expenses.Expense.create`).
- `kind`: `scenario`, `read` (`read=true` scenarios), `create`,
  `update`, `delete`. (`list`/`team` have no `.can` source and never
  appear; the loader rejects them.)
- `description`: verbatim `#` description source text, `""` when the
  operation carries none. Generated CRUD operations never inherit
  captions. Locale variants (`@{nl=...}`) never leave the source.
- `inputs`: `{fields: [{name, field, required}]}` — the closed typed
  input schema in signature order. `field` is one of `ref` (with
  `model` + `requireVersion`), `string`, `integer`, `decimal`,
  `money`, `datetime`, `boolean`, `file`, `enum` (with `values`).

JSON shape (exactly as emitted; from real
`can compile --format=json examples/ExpenseFlow.can`):

```json
{
  "name": "expenses.approve",
  "kind": "scenario",
  "description": "Approve a submitted expense from another teammate, optionally recording a note.",
  "inputs": {
    "fields": [
      {
        "name": "expense",
        "field": {"kind": "ref", "model": "expenses.Expense", "requireVersion": true},
        "required": true
      },
      {
        "name": "note",
        "field": {"kind": "string"},
        "required": false
      }
    ]
  }
}
```

A CRUD entry from the same artifact:

```json
{
  "name": "expenses.Expense.update",
  "kind": "update",
  "description": "",
  "inputs": {
    "fields": [
      {
        "name": "record",
        "field": {"kind": "ref", "model": "expenses.Expense", "requireVersion": true},
        "required": true
      },
      {
        "name": "purpose",
        "field": {"kind": "string"},
        "required": false
      },
      {
        "name": "amount",
        "field": {"kind": "money"},
        "required": false
      }
    ]
  }
}
```

## Derivation rules (all pinned by `compiler/tests/mcp_p1.rs`)

- Source operations in IR item order: untrusted scenarios + generated
  CRUD ops. Trusted (`on=`) event handlers are excluded (separate test).
- Scenario inputs follow the signature: `required` clears on `=`
  defaults and `?` nullability. Record params are `ref`;
  `requireVersion` is set for mutations, clear for `read=true`.
- CRUD inputs flatten the `fields=` allowlist (dotted paths match on
  the first segment): create takes the fields (`required` from
  no-default + non-nullable), update takes `record` + optional fields,
  delete takes `record` only. `server=`-owned fields are never inputs.
  An empty allowlist means all non-server fields (defensive: analysis
  requires `fields=` and E3009 bars server-owned fields from it).
- Scalar mapping: text/email/url/locale/timezone/currency/secret/
  date/user/member → `string`; int → `integer`; decimal → `decimal`;
  money → `money`; datetime → `datetime`; bool → `boolean`; file →
  `file`; enum → `enum` with declaration-order `values`.
- Fail-closed omission: an operation with ANY input that has no MCP
  mapping (arrays, compound values, `duration`, `json`, `bytes`) is
  omitted from the descriptors entirely — no diagnostic, no partial
  entry. Descriptors never block compilation and never advertise a
  skewed closed schema; the operation stays invocable over HTTP/browser.
- Name collisions omit too: a model field literally named `record`
  collides with the synthesized `record` ref on update, so update is
  omitted (create keeps the field; delete takes only the ref). The
  compiler therefore never emits duplicate operation or input names.
  The loader rejects duplicates anyway (`operations repeats operation
  "…"`, `operations[i] repeats input "…"` — same vocabulary as P2's
  adapter, which fails the whole `/mcp` registry build on them).
- The entrypoint `canApp()` registry carries the same descriptor
  objects as a sparse `operations:[...]` member (omitted when the
  program has no operations, like every other `canApp()` member). One
  renderer (`operations_json`) serves both sites — verified byte-equal
  on ExpenseFlow.

## Implementation

**`compiler/src/codegen/js.rs` (modified).** `JsOperationKind` /
`JsMcpField` / `JsOperationField` / `JsOperation` + `to_json`
renderers and `operations_json`; `Emitter::collect_operations`
derives descriptors once up front in `emit_program`; `emit_can_app`
takes them and emits the sparse member; `JsOutput` gains `operations`.

**`compiler/src/codegen/artifact.rs` (modified).**
`CompileArtifact` gains `operations: Vec<JsOperation>`; `assemble`
carries `js.operations`; `to_json` emits `"operations":[...]` (always
present, possibly empty) between `callables` and `pages`.

**`packages/contracts/src/artifact.ts` (modified).**
`ArtifactOperationField` / `ArtifactOperationInput` /
`ArtifactOperationKind` / `ArtifactOperation` (JSON-identical to
`McpSchemaField` / `McpNamedField` / `OperationDescriptor`, redeclared
so the lane-01 boundary stays dependency-free);
`CompileArtifact.operations?` is OPTIONAL — old artifacts without the
key are valid; loaders treat absence as no descriptors.

**`packages/cloudflare/src/runtime/artifact.ts` (modified).**
`loadArtifactFile` accepts a missing `operations` key (additive) and
validates a present one strictly: array of `{name, kind, description,
inputs}` with closed typed fields; unknown operation/field kinds,
missing `ref.model`/`requireVersion`, empty/non-string enum `values`,
and duplicate operation/input names are loud errors naming the field
path.

Mechanical one-line companions (compilation only): `operations:
Vec::new()` in the `CompileArtifact` literal
(`compiler/src/codegen/mod.rs`, E6005 path) and the `JsOutput` literal
(`compiler/tests/b3_migrate.rs`).

## Verification

- `compiler/tests/mcp_p1.rs` (new, 3 tests): golden over an inline
  app — declaration-order names, verbatim descriptions, every
  scalar/enum/ref mapping, CRUD flattening, fail-closed array omission
  with zero diagnostics, `canApp()` markers — plus the trusted-handler
  exclusion test and the `record`-collision omission test. Written
  failing-first (failed on missing `operations[]`).
- `packages/cloudflare/test/artifact-operations.test.ts` (new, 20
  tests): old-artifact back-compat, valid-shape preservation, 18
  rejection cases (including both duplicate-name rejections). Written
  failing-first (16 failed pre-change).
- Full `cargo test`: all targets green (no new diagnostics on any
  existing fixture — the `int[]` scenario in `codegen.rs` still emits
  zero diagnostics). `cargo clippy --all-targets`: clean.
  `cargo fmt --check`: clean.
- `vitest run packages/cloudflare`: 234/234. `vitest run
  packages/contracts`: 12/12. `vitest run packages/testkit`: 96/96.
  `tsc --noEmit` clean for cloudflare + contracts.
- Round-trip: real `can compile` output for ExpenseFlow (6 operations)
  loads through the new validator; `canApp()` descriptors deep-equal
  artifact `operations[]`.
