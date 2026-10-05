# MCP P4 evidence: scenario `expose=` + `@{desc}` input descriptions (+ follow-ups)

Branch `muse/closeout/mcp`. No commit. Failing-first: `compiler/tests/mcp_p4.rs`
written before implementation (plus `packages/interfaces/test/
mcp-field-descriptions.test.ts` and `packages/cloudflare/test/
artifact-field-descriptions.test.ts`).

## (1) Exposure: `expose=` on user scenarios

Mirrors the CRUD `expose=` concept (GRAMMAR:95,500: closed allowlist,
omission permits all):

- Syntax (`compiler/src/syntax/parser.rs`): `expose=` joins the scenario
  attribute vocabulary; the value parses with the same `parse_selectors`
  production as CRUD `expose=` (`Selectors` of single-segment words).
  Trusted handlers reject it (`E1200`, alongside params/result/read/scope).
- Checking (`compiler/src/analysis/types.rs`, `check_scenario_expose`,
  `E3009`): closed set `{none}` — sole `none` excludes the operation from
  publication, omission exposes it. Unknown selectors fail with
  `unknown exposed surface 'bogus' (scenario expose= accepts only none)`;
  duplicates and non-word shapes fail precisely. The function documents
  the EXTENSION POINT for future surfaces (`http`/`mcp`): widen the set
  plus one emission rule in `collect_operations`.
- Recording (`compiler/src/analysis/effects.rs`): `ScenarioData.expose_none`
  via the shared `selector_words` helper (sole-`none` match).
- IR (`compiler/src/codegen/ir.rs`): `IrItemKind::Scenario.expose_excluded`.
- Emission (`compiler/src/codegen/js.rs`, `collect_operations`): excluded
  ops are skipped from the P1 `operations[]` descriptors. This one skip
  covers both `artifact.rs` (`operations: js.operations.clone()`) and the
  `canApp()` `operations:[...]` member (`emit_can_app` takes the same
  slice). Internal handler-map entries stay (admission/lifecycle unchanged).

Adjacent fix (same file, documented in-tree): `check_crud_expose` had a
known bug — multi-value `expose=create,update` spuriously failed `E3009`
on the comma separator (pinned NOTE in `compiler/tests/b4_parse.rs`). Both
expose checkers now skip separator leaves like `check_selectors`; the
b4 NOTE is updated and multi-value allowlists are pinned passing.

## (2) Descriptions: `@{desc="..."}` on params and fields

Mechanism survey (in-tree first): `@{...}` exists as the message-suffix on
string literals (`parse_message_suffix`, locale variants) and as `#`-prose
description suffixes (`layout.rs`). Neither fits per-input documentation
(`desc` is not a locale), so P4 adds a parallel closed annotation:

- Syntax: trailing `@{desc="..."}` on any field/parameter
  (`parse_field_or_param`, shared path). Shape mirrors the message suffix
  (contiguous `@{`, comma pairs) but the key set is closed to `desc` and
  values are literal text only — `E1214` otherwise (unknown key,
  duplicate, non-string, empty, split marker). New flat
  `SyntaxKind::Annotation` node (pairs unwrapped, so message-variant
  walks never see it).
- Threading: `FieldData`/`ParamData.description: Option<String>` (decoded
  via the existing `literal_string`) → `IrItemKind::{Field,Param}.
  description` → `JsOperationField.description` → artifact
  `inputs.fields[].description`, emitted ONLY when authored (additive:
  undescribed inputs are byte-identical to P1).
- Seams (all verified lacking, then extended): `ArtifactOperationInput`
  and `McpNamedField` gain optional `description`; `runtime/artifact.ts`
  accepts absent / requires string when present; `schemas.ts` maps it
  onto property schemas via `propertySchema` (ordinary AND handle-mode
  branches). `tools.ts` needed no change (pure `toToolInputSchema`
  delegation — verified).

## Follow-ups (parent packet 2)

1. CRUD op descriptions inherit the `label=` caption for that operation
   when authored, else `""` (`label.as_ref().map(source)` in the `CrudOp`
   branch; locale variants never leave). Required one shared fix:
   `decode_message_node` dropped bare `Literal` captions (`_ => None`),
   so literal labels decoded to nothing anywhere; it now decodes them to
   source-only text. No existing test pinned the drop (goldens all use
   suffixed labels).
2. One read op per model IFF `policy Model read=` exists
   (`IrItemKind::Model.grants` non-empty): `package.Model.read`, kind
   `read`, zero inputs, `""` description, in model-declaration order.
3. CRUD `expose=` allowlist was NOT respected by P1 emission (verified:
   no check in the `CrudOp` branch) and the fix was trivially adjacent
   (the existing `expose_excluded` flag) — wired with the same skip.

## Syntax acceptance proof (`can check`, real binary)

- `expose=none` + `@{desc}` on param and field: exit 0, zero diagnostics
  (with `--catalog packages/values/dist/catalog.json`).
- `expose=bogus`: `error E3009 unknown exposed surface 'bogus'
  (scenario expose= accepts only none)` (exit 10).
- `@{desc=42}`: `error E1214 annotation 'desc' requires a
  double-quoted string literal` (exit 10).

## TeamTasks answers (observed via in-process probe, examples/ untouched)

- YES: `TeamTasks.Todo.create` yields non-empty description `"Add"`
  through the rule (`label={create=add}` → message `add` source text).
  `update`/`delete` (uncaptioned) stay `""`. Same for `TeamNotes.Note`.
- Policy read ops appear: `TeamTasks.Todo.read` and `TeamNotes.Note.read`
  (kind `read`, 0 inputs, `""`).
- (`can compile` on the CLI cannot show this today: pre-existing E6008
  UI-lowering gaps on tooltip/delete/collapse report diagnostics instead
  of an artifact — unrelated to P4.)

## Emission diff (one fixture, before → after)

`Gadget {title,stock} + policy + crud + scenario approve`:

- Before: 3 ops (`create/update/delete`), all `description:""`, no
  `description` keys on inputs.
- After: 4 ops — `Shop.Gadget.read` (`read`, `""`, `fields:[]`) leads;
  CRUD/scenario entries unchanged unless captioned/annotated/excluded.

## Test results (all observed this session)

- `cargo test` (compiler): every suite green, 0 failures (incl. new
  `mcp_p4` 18/18, updated `mcp_p1` 3/3, `b4_parse` multi-value pin).
- `cargo clippy --all-targets`: clean. `cargo fmt --check`: clean.
- interfaces: build + `node --test dist/...` 285/285 + typecheck clean.
- cloudflare/contracts vitest: 27 files / 251 tests green (incl. new
  compat file 3/3 and the P1 compat file untouched 20/20); both
  typechecks clean.

## Known remaining items (out of this packet's file list)

- P2's `packages/cloudflare/src/runtime/mcp-registry.ts` `checkInput`
  (untracked sibling WIP, not in my file list) rebuilds each
  `McpNamedField` as `{name, field, required}` and DROPS the new
  `description` key — the worker MCP path needs a one-line additive
  mapping (`description?: string` on the `McpNamedField`/`ArtifactInputField`
  mirrors + pass-through) or field descriptions stop at the loader.
- GRAMMAR.md rows (scenario `expose=`, `@{desc}`) not updated — not in
  the file list.
- `decode_field_label` (field-label emission path) was not audited for
  the bare-`Literal` shape; only the `decode_message_value` path my
  inheritance needs was fixed.
- Excluded scenarios are skipped from P1 descriptors but not marked
  `expose:false` in the internal handler-map registry (CRUD entries
  carry the mark); internal invocation intentionally unchanged.
