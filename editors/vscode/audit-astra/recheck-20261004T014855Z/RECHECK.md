# Independent correction recheck — frozen 0.1.4

**Most original cases are corrected. Four narrower defect groups remain in the tested snapshot:** contextual owned-model declarations (F1), a multiline form operation target (F5), qualified migration target paths (F8), and the first guard immediately after inline `do` (F10/structural palette). F2, F3, F4, F6, F7 and F9 pass the focused cases described below. “Fixed” here means the original case and the listed necessary variants produce the required roles; it is not a complete grammar or runtime certification.

## Scope and exact inputs

This is verification of the reported highlighting corrections, not another language-design/corpus inventory. The initial input was copied at **03:48:55 Europe/Brussels on October 4, 2026** (01:48:55 UTC):

- Manifest version: **0.1.4**.
- TextMate source SHA-256: **`5c0e667200b5bc73fffa21553e96207518694c583d3e0eb07d4642b06975b40d`**.
- Normative GRAMMAR SHA-256: `bd21a290fb4fa0b753cfe6e655b7aca4e65763dd5b42b7c36c7e83b825b24014`.
- Preserved bytes: `snapshot/`; hashes and timestamp: `manifest.json`.

Root replayed the original 27 independent probe groups, then used three focused contextual/structural variants. Independent reviewers replayed execution/presentation and type/selector/route/maintenance cases, putting former fragments inside valid app/section/scenario/page contexts where required. All actual scope conclusions use the real TextMate/Oniguruma engines. No implementer checker results or audit verdicts were used. The old orphan `page` probes intentionally no longer select a Then-page rule; this is **not** reported as a regression in valid source.

No extension, application source, editor setting or installed package was changed. No UI/CUA control, clicks, reloads or approvals were requested. Only separate audit evidence was written. No compiler, semantic checker, business operation or runtime example was executed. JEV was unnecessary for factual scope/palette verification.

## Per-finding outcome

| Finding | Status for this snapshot | Verified correction / remaining boundary |
| --- | --- | --- |
| **F1 effect/model/context/loop** | **Partly fixed** | `return {value=1}` remains an effect in a When body; contextual loop binder `for in in values` is binder then fixed `in`; `context {...}` is a Given model. **Remaining:** models named `app`, `package`, `event`, `contract`, `role` or `capability` followed by `in app {…}` are taken as other declaration prefixes. See R1. |
| **F2 examples** | **Fixed in tested cases** | `examples create/update/delete` scopes the fixed action separately; `title -> count(Item)` treats `title` as an observation/input name instead of a UI keyword. Contextual example expressions are isolated from presentation rules. Selector validity and outcomes remain semantic. |
| **F3 expressions and joined queries** | **Fixed in tested cases** | Actual operators after `.return`, `.where`, `.not` and query aliases/domains named contextual words retain operator/clause scopes. Joined-line `as`, `where`, `order=`, `select` preserve query roles; same spellings where an operand is expected remain names. Precedence, resolution and alias lifetime are not semantically checked. |
| **F4 contextual types** | **Fixed in tested cases** | `trim`/`unique` type atoms and union arms work inline and on joined lines; real field modifiers remain modifiers. Multiline signatures/results preserve type roles. Named type resolution and union admissibility remain semantic. |
| **F5 operation reference slots** | **Partly fixed** | `actions`, `refresh=`, `review=`, plain/parenthesized call/send targets and single-line form targets now have operation-reference scopes. **Remaining:** an operation name in a multiline parenthesized form target becomes a variable. See R2. Arbitrary expressions still cannot have their resolved declaration identity inferred from spelling. |
| **F6 selectors** | **Fixed in tested cases** | Signed/plain/qualified selectors, including `not`, `true`, `false`, `null`, remain `variable.other.property.selector.can`; preference ordering selectors and successive attributes retain boundaries. Field/grant/type suitability remains semantic. |
| **F7 multiline values/types/routes** | **Fixed for the three reported subissues** | Multiline shorthand value keys now match inline keys; spaced and split array suffix brackets remain type modifiers; route enum/action/union/array/nullable subroles are preserved. Runtime support for a parsed scalar-route type remains a separate question. |
| **F8 maintenance** | **Partly fixed** | Original simple model, field, handler, predecessor, owner and backfill cases have correct roles, including semicolon leaves. **Remaining:** qualified target paths are truncated/mis-split. See R3. Predecessor/target resolution and migration execution remain unverified. |
| **F9 localization boundary** | **Fixed; no regression in tested cases** | Opening/closing localization markers remain matching light gray inside descriptions and after source strings; bare/quoted locale-key text remains lavender. String colors follow each theme. |
| **F10 components and structural tokens** | **Components fixed; one structural placement defect remains** | Actual Then components use dedicated muted-tan tag scopes; page is the white exception. `text` type/component/member, `delete` effect/control and `action` type/call/control distinctions are preserved in tested contexts. Fields/members/parameters with structural spellings stay authored names. **Remaining:** first `require` after inline `do` receives effect scope/color, unlike the same guard after a semicolon. See R4. |

## Reproducible remaining defects

All examples below are syntax-role probes inside valid enclosing source; unresolved model/operation identities are not presented as executed source facts.

### R1 — F1: contextual model names with ownership select a declaration prefix

Inside Given:

```can
app Names
Given
 app in app {title:text}
 package in app {title:text}
 event in app {title:text}
 contract in app {title:text}
 role in app {title:text}
 capability in app {title:text}
When
Then
```

For `app in app {title:text}`, the first `app` is emitted as `keyword.declaration.owner.can`, `in` as `entity.name.namespace.can`, and the ownership `app` as `entity.name.type.constructor.can`. The required roles are model name/type, ownership keyword, and explicit app ownership respectively. The other listed declaration spellings similarly select incomplete declaration prefixes. By contrast, owned models named `context`, `scenario`, `do`, `require`, `page` and `examples` in the independent cases use the model rule correctly.

Each individual variant was also replayed independently as the same five-line file above with the inner model name replaced. The minimal exact sources are `owned-model-minimal-sources/app.can`, `package.can`, `event.can`, `contract.can`, `role.can`, `capability.can`; the failing line is **line 3** in every file. The wrapper has no preceding declarations that could contaminate TextMate state. Actual results are in `owned-model-minimal-results.json`/`.txt`.

For every row, the expected first token is a model/type name (e.g. `entity.name.type.can`), the expected `in` is ownership syntax (e.g. `keyword.control.ownership.can`), and final `app` is the explicit app-ownership slot rather than a structural constructor:

| Authored model name | Actual first-token scope | Actual `in` scope | Actual ownership `app` scope |
| --- | --- | --- | --- |
| `app` | `keyword.declaration.owner.can` | `entity.name.namespace.can` | `entity.name.type.constructor.can` |
| `package` | `keyword.declaration.owner.can` | `entity.name.namespace.can` | `entity.name.type.constructor.can` |
| `event` | `keyword.declaration.can` | `entity.name.type.can` | `entity.name.type.constructor.can` |
| `contract` | `keyword.declaration.can` | `entity.name.type.can` | `entity.name.type.constructor.can` |
| `role` | `keyword.declaration.can` | `entity.name.function.predicate.can` | `entity.name.type.constructor.can` |
| `capability` | `keyword.declaration.can` | `entity.name.type.can` | `entity.name.type.constructor.can` |

GRAMMAR lines 70 and 72 require contextual role selection by full shape within the enclosing grammar; lines 249–254 permit a `NAME` model with ownership and schema. An owner/package declaration is not a Given item. This is **not** a semantic name-resolution limitation. Gate declarations by section and complete production shape before matching their name prefix. Do not globally reserve contextual model names.

Evidence: `root-focused-probes.json` case `structural-name-overlap`, lines 3–4 and associated `root-focused-results.json`; independently `execution-probes.json` case `valid-owned-contextual-models`, lines 4–9. The new Given matcher still includes app/package and other declaration-prefix rules ahead of the model shape.

### R2 — F5: joined-line form target loses the operation-reference role

Inside a Then/page body:

```can
  form (
   change
  )
```

`change` receives `variable.other.readwrite.can` rather than the `entity.name.function.reference.can` used for the equivalent single-line `form (change)`. This is a syntactic operation-valued form slot; the line break inside balanced parentheses is legal joining (GRAMMAR line 33; form expression at lines 379–380).

The corresponding joined call/send targets are corrected, so their general operation-expression handling provides a useful comparison. Single-line form parentheses also have only the enclosing page meta scope instead of punctuation; this smaller subrole gap need not block the role correction itself. Preserve operation-target context across the joined physical lines instead of dropping back to general presentation expressions.

Evidence: `execution-probes.json` case `valid-operation-slots`, lines 32–34; exact tokens in `execution-results.json`/`.txt`.

### R3 — F8: qualified migration target paths truncate or split too early

```can
migration Move from="old"
 rename before.Task to pkg.Work
 rename before.Task.title to pkg.Work.name
```

Observed target scopes:

| Target | Emitted roles | Required grammatical roles |
| --- | --- | --- |
| `pkg.Work` | `pkg` type, `Work` variable | Model path `pkg.Work` retains a type-reference role (namespace/type splitting is also acceptable). |
| `pkg.Work.name` | `pkg` type, `Work` property, `name` variable | Model path `pkg.Work`, final field `name`. |

The target production is `path`, with repeated components (GRAMMAR lines 22,410,423), unlike the deliberately narrower predecessor production. The frozen rename rules match only a one-NAME model target or a two-NAME field target, leaving the rest to general tokenization. Consume the full target path and split off the final field only for a field directive. This does not require resolving package identities or validating migration execution.

Evidence: `foundation-can-probes/F8-qualified-target-paths.can:2` and `:3`, `foundation-results.json`/`.txt`; rule references and normative explanation in `foundation-recheck.md`.

### R4 — F10/structural palette: inline guard changes category with placement

Inside a scenario:

```can
  do require item.ready; require item.ready
```

| Token | Actual scope | Both engines with captured palette | Required |
| --- | --- | --- | --- |
| First `require` immediately after `do` | `keyword.control.effect.can` | Cyan `#67E8F9`, plain | White `#FFFFFF`, bold structural/guard role |
| Second `require` after semicolon | `keyword.control.structure.can` | White `#FFFFFF`, bold | Same white guard role |

This is a supported inline do leaf sequence. Both guards retain their written order; no executable binding or effect was moved. Extend the explicit guard treatment to the after-`do` position while retaining authored same-spelled identifiers in parameter/field/member/value contexts.

Evidence: root case `inline-structural-guards:7`, independent execution case `valid-inline-structural-guards:9`, and `inline-require-evidence.json`, which resolves both tokens using the already captured settings in both editor engines.

## Palette and semantic limits

The **snapshot grammar plus settings captured at 03:51:30 Europe/Brussels** resolves the required roles in both editor engines, apart from R4:

| Role | Foreground/style |
| --- | --- |
| Actual Given/When/Then, app/package, scenario, leading do/require, page, examples | `#FFFFFF`, bold |
| Types | `#A5AEB8` |
| Other language keywords | `#67E8F9` |
| Frontend components, with page exception | `#C7AD8E` |
| Functions / bindings / fields | `#FBBF24` / `#93C5FD` / `#D8B4FE` |
| Translation markers / locale-key text | `#D6D6DD` / `#D8B4FE` |
| Strings | Cursor `#E394DC`; Antigravity `#CE9178` |

Actual field/member/parameter spellings such as `do`, `require`, `page`, `examples`, `scenario`, `title`, `form` keep their authored roles in tested contexts. A collection operand such as `table Record` may still be blue rather than the declaration's gray: the expression can name a value or model, and the lexical highlighter cannot generally resolve which. That is a **semantic-limit fallback**, not a new defect or a reason to color every capitalized name as a type.

## Concurrent edits and verification limit

The input was frozen while implementation continued. At **03:51:30**, both installed registries still said **0.1.4**, but their grammar hash was **`12320c040fac06952bb19a593b41c686fc2450cfa9518d892734bd346c0288b1`**, differing from the tested source snapshot. At the read-only drift observation **03:53:11**, live source hash was **`1930cc000941c8e9f2b16b5920d5e039482e33182696d76176127b8315524cf8`**; changed rule families were `type`, `result-type`, `field`, `parameter` and new field-expression helpers. See `source-drift.json`.

Accordingly, this report attributes every status to **5c0e667…**, not to every build bearing version 0.1.4. Later changed type/field rules were not silently substituted or marked passing. The rule families directly responsible for R1–R4 were unchanged in that drift observation, but the later full file was not replayed. No repeated live-file/palette chasing, new inventory, corpus framework or UI validation was done. A later targeted changed-rule replay should be tied to a settled implementation hash.

## Evidence index

- `manifest.json`, `snapshot/`: exact immutable inputs.
- `original-probes.json`, `replay-original.cjs`, `probe-results.json`, `original-probe-results.txt`: original audit replay, including fragments retained as historical comparisons.
- `root-focused-probes.json`, `root-focused-results.json`/`.txt`: contextual structural model names, inline guards and full presentation reference cases.
- `execution-probes.json`, `execution-results.json`/`.txt`: valid-context execution/query/example/operation/component cases and focused variants.
- `foundation-recheck.md`, `foundation-probes.json`, `foundation-results.json`/`.txt`, `foundation-can-probes/`: F4/F6/F7/F8 verification and qualified-path evidence.
- `theme-report.md`, `theme-evidence.json`, `inline-require-evidence.json`: exact scopes, token colors, relevant filtered settings, editor-library/theme hashes, and installed-version drift.

The recheck establishes substantial progress and the four specific remaining groups above. It does not establish semantic validity, executable behavior, a complete language audit, or currently displayed editor colors.
