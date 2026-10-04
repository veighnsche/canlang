# Focused independent recheck: F4, F6, F7, F8

Frozen extension **0.1.4**, TextMate grammar SHA-256 `5c0e667200b5bc73fffa21553e96207518694c583d3e0eb07d4642b06975b40d`. This report uses only this recheck snapshot's normative GRAMMAR and actual TextMate/Oniguruma tokenization. It does not reuse implementer test conclusions, install/activate anything, change extension/settings/app source, or inspect the UI. The existing independent inventory was not rebuilt.

Eleven focused probes and complete emitted token scopes are saved in `foundation-probes.json`, `foundation-results.json`, and the readable `foundation-results.txt`; identical source is in `foundation-can-probes/*.can`. `foundation-tokenize.cjs` is the independent replay runner. It loads the existing Cursor-bundled `vscode-textmate` and `vscode-oniguruma` modules and checks the frozen grammar hash/version in its output.

The former schema/type/selector/object/route fragments were placed inside an actual app with ordered Given/When/Then sections at the correct one-space declaration depth. Migration probes are valid top-level maintenance declarations and use correctly nested backfill guards/do/if/else. Unknown referenced types, operations, prior snapshots, and preferences remain semantic resolution questions; the probes claim syntactic role coverage, not executable apps. No invalid fragment fallback is treated as a valid grammar defect.

| Finding | Outcome for original issue | Concrete evidence | Remaining/semantic limit |
| --- | --- | --- | --- |
| **F4 contextual type atoms/union arms** | **Fixed** in these replays | `F4-inline-contextual-type-atoms.can:4`–`:5`: bare `trim`, `unique`, `server`, `min`, `max`, `label`, `enum`, `action`, qualified paths, and `A|unique` all receive `entity.name.type.can`. `F4-multiline-contextual-type-atoms.can:6`, `:8`, `:10`: newline-separated `trim`/`unique` atoms/union arms get the same type scope. Actual `text trim` and newline `text` / `unique` modifiers retain `storage.modifier.field.can` (`:11`, `:13`). Multiline signature inputs/union result also preserve type scope in `F4-multiline-signature-types.can:6`–`:9`. | Named type spelling is syntactic (`snapshot/GRAMMAR.md:72`, `:163`–`:184`); whether a name resolves to a permissible type/union arm remains a checker question. No compiler/type checker was invoked. |
| **F6 selectors mistaken for literals/operators** | **Fixed** in these replays | `F6-selector-literal-prefix-names.can:5`–`:7`, `:9`, `:12`–`:13`: policy/unique/lock/CRUD/columns/order/filter/search/edit selectors have `variable.other.property.selector.can`, including `not`, `true`, `false`, `null`. Signed order entries separate `-` as `keyword.operator.can`, preserving the following selector scope. `F6-spaced-signed-and-qualified-selectors.can:8` also handles `- not`, `- true`, `-pkg.trim`; `:9` handles selector paths inside preference-order default/case arrays. The next header attribute still terminates the previous list. | Optional signs/path lists are syntax (`snapshot/GRAMMAR.md:381`–`:389`). A particular selector's field suitability, signedness, readable grant, ordering type, or preference declaration/case completeness remains semantic (`:400`). |
| **F7 multiline shorthand/spaced suffixes/route subroles** | **Fixed** for all three original subissues | `F7-multiline-values-shorthand.can:6` now gives multiline shorthand `name` `variable.other.property.key.can`, matching inline shorthand at `:9`; following `title=name` distinguishes key from value. `F7-whitespace-array-suffixes.can:4`–`:5`, `:9`–`:10`: `[ ]`, split physical-line brackets, `?`, `!` and spaced union suffixes retain `storage.modifier.type.can` in schema/input/result positions. `F7-route-type-subroles.can:11`: enum atom is `storage.type.can`, cases `one`/`two` are `variable.other.constant.enum.can`; `:12`: action atom is `storage.type.can`, targets `pkg.first`/`pkg.second` are `entity.name.function.reference.can`. Record route `pkg.Item.id` and union/array/null suffix subroles also split correctly (`:9`–`:10`). | Route source is contiguous with no spaces/newlines inside route tokens (`snapshot/GRAMMAR.md:398`). A route type's supported scalar representation, referenced model/operation identity, field representation, nullability and required-array obligations remain checking work. The replay does not certify action/array/enum routes as supported runtime scalar inputs. |
| **F8 maintenance model/field/handler roles** | **Original simple-path cases fixed; qualified target path remains** | `F8-original-maintenance.can:3`–`:7`: `Task`/`Work` receive `entity.name.type.can`, `title`/`name`/`old` receive `variable.other.property.can`, `refresh` receives `entity.name.function.reference.can`, and backfill `Work` receives type scope. `F8-model-field-handler-shapes.can:2`–`:4` preserves these roles across semicolon leaves, including contextual handler name `not`. Mapper `before.title` and `set row` retain predecessor-expression/property and mutable-row target roles. | **Surviving concrete case:** qualified target component scopes truncate; detailed below. Installed predecessor identity, target-owner resolution, permitted handler kind, initialization and migration application remain semantic/runtime checks. |

## Surviving narrow F8 defect

`foundation-can-probes/F8-qualified-target-paths.can:2`:

```can
 rename before.Task to pkg.Work
```

TextMate emits `pkg` as `entity.name.type.can`, `.` as `punctuation.separator.can`, and `Work` as `variable.other.readwrite.can`. The target is a model path, so the model portion `pkg.Work` does not retain the type-reference role used for unqualified `Work`.

`foundation-can-probes/F8-qualified-target-paths.can:3`:

```can
 rename before.Task.title to pkg.Work.name
```

TextMate emits `pkg` as `entity.name.type.can`, `Work` as `variable.other.property.can`, and `name` as `variable.other.readwrite.can`; the type/field split occurs after the first component rather than before the final field. The expected grammatical split is model path `pkg.Work`, field `name`.

These spellings use the normative target production **`path`**, not a fixed one- or two-NAME target: `snapshot/GRAMMAR.md:22` defines repeated path components, `:410` specifies `rename before_path to path`, and `:423` explicitly describes model paths and matching directive kinds. The old-side `before_path` has its own narrower shape (`:412`); the probes do not invent qualified old model names or multi-component handler paths. Semantic resolution could reject a particular `pkg.Work` identity, but that does not make its source path spelling invalid or turn the observed role truncation into an invalid-fragment artifact.

The frozen TextMate rules explain the actual output: `snapshot/editors/vscode/syntaxes/can.tmLanguage.json:155` matches only a two-component field target, and `:181` only a one-component model target, without consuming the complete normative target path. The remaining components fall through to generic tokenization. Correcting this should remain a target-path classification change; it does not require resolving package identities or adding semantic diagnostics.

The recheck outcome is therefore: F4 fixed, F6 fixed, F7 fixed; F8's recorded simple model/field/handler examples fixed, with this narrower qualified-target case remaining. These are emitted-scope conclusions for the preserved probes, not claims of complete grammar coverage or business-language correctness.
