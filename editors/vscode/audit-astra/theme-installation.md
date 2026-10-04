# Independent installation and theme audit

Captured at **2026-10-04T01:03:37.825Z** (UTC). No editor UI actions, source/extension edits, installs, settings changes, reloads, or removals were performed. Only audit artifacts were written. `GRAMMAR-AUDIT.md` and `check-highlighting.cjs` conclusions were not read.

The corrected requirement is **one shared WHITE standout color for actual Given/When/Then markers**, distinct from ordinary control keywords. The final captured customizations give all three markers the same white #FFFFFF and bold style, distinct from ordinary muted gray control/declaration keywords (#A5AEB8), so the resolved token metadata satisfies that requirement. Uncustomized default themes give the three markers one shared color, but also give ordinary control keywords that color; they do not make the markers stand out.

The four core role colors also collide under each uncustomized default theme: Cursor types/functions share one color; Antigravity variables/properties share one color. With the captured user overrides, the four representative role colors are pairwise distinct in both editors. This proves the resolved foreground values, not completeness or correctness of all grammar classifications.

## Method and evidence boundaries

The probe loads each editor’s bundled `vscode-textmate` and `vscode-oniguruma`, flattens theme includes in include-first order, supplies `editor.foreground`/`editor.background`, and decodes `tokenizeLine2` foreground/fontStyle metadata. Synthetic scoped probes measure scope mappings; actual standalone indented Given/When/Then lines and canonical `.can` lines measure real emitted scopes and colors. Canonical examples are tokenized from the beginning of their entire file, preserving TextMate state. No semantic token provider is contributed by the draft manifest.

The original immutable audit snapshot is 0.1.1. During the audit the installed registry changed to 0.1.2; all current-install conclusions below describe the timestamped 0.1.2 capture, not the snapshot. The editor registries identify installed packages but do not prove an already running window reloaded them. The currently rendered window state was not inspected.

Antigravity has no explicit `workbench.colorTheme` user setting. Its bundled workbench default constant is `Default Dark Modern`, whose `dark_modern.json` includes `dark_plus.json`, which includes `dark_vs.json`. The Antigravity configured-theme probe therefore uses that default. Cursor’s bundled dark default constant is `Cursor Dark`; its explicit user selection is `Cursor Dark High Contrast`. The configured-theme probe uses the selected high-contrast theme plus captured user overrides.

## Versions and installation status

| Editor | Editor package version | TextMate | Oniguruma | Registry draft |
|---|---|---|---|---|
| Cursor | 3.23.12 | 9.2.0 | 1.7.0 | 0.1.2 |
| Antigravity IDE | 1.107.0 | 9.3.1 | 1.7.0 | 0.1.2 |

Both registries contain `canlang.canlang-draft-highlighting` 0.1.2 and `ai-lang.ai-lang` 0.1.0. The old `can-lang.can-lang` entries are absent from both registries, although their old folders remain on disk and `.obsolete` marks them true (Cursor 0.2.0; Antigravity 0.1.0). Draft 0.1.0/0.1.1 folders likewise remain obsolete. Presence of old files is not evidence that those extensions remain registered. ai-lang was left untouched.

Both installed 0.1.2 manifests contribute only `.can` language registration, the `source.can` TextMate grammar, and indentation configuration defaults. They have no `main`, `activationEvents`, commands, language-server contribution, semantic-token contribution, theme contribution, or token-color rules. Syntax-only behavior is supported by those manifests; custom colors come from editor user settings.

## Exact foreground results

The values below are identical for snapshot 0.1.1 and installed 0.1.2 where the same scopes exist. Styles are plain unless indicated.

| Role / marker | Scope | Cursor Dark, no overrides | Antigravity Dark Modern, no overrides | Current user rules, both editors |
|---|---|---|---|---|
| Type | `entity.name.type.can` | #EFB080 | #4EC9B0 | #67E8F9 |
| Function | `entity.name.function.can` | #EFB080 | #DCDCAA | #FBBF24 |
| Variable | `variable.other.readwrite.can` | #87C3FF | #9CDCFE | #93C5FD |
| Property | `variable.other.property.can` | #AAA0FA | #9CDCFE | #D8B4FE |
| Given | `keyword.control.section.given.can` | #82D2CE | #C586C0 | #FFFFFF bold |
| When | `keyword.control.section.when.can` | #82D2CE | #C586C0 | #FFFFFF bold |
| Then | `keyword.control.section.then.can` | #82D2CE | #C586C0 | #FFFFFF bold |
| Ordinary control | `keyword.control.can` | #82D2CE | #C586C0 | #A5AEB8 |

**Collision counts:** among the six unordered pairs of the four core roles, Cursor default has **1/6** same-color pair (type/function), Antigravity default **1/6** (variable/property), and captured overrides **0/6** in each editor. The three marker scopes produce **one** distinct color under each default and **one** distinct color under captured overrides. All three default marker-to-ordinary-control comparisons collide (3/3). Final captured overrides have no marker-to-ordinary-control collision (0/3) and give all markers the required one shared white color.

The current colors are the result of `editor.tokenColorCustomizations.textMateRules` in both editors. Cursor additionally has a pre-existing error-specific red/bold rule. Neither the snapshot nor installed draft supplies these customizations itself.


## Final palette and perceptual hue separation

The final user preference is **muted neutral gray keywords**, shared bold WHITE sections, cyan types, amber functions, blue bindings, and lavender fields. The captured keywords now use muted slate gray #A5AEB8, meeting the requested palette direction at the token-color level. It has a slight blue bias rather than perfectly equal RGB channels. No further polling was performed. `keyword.declaration.can` (package/role/event), `keyword.control.import.can` (use), `storage.modifier.export.can` (export), and `keyword.control.can` (policy) resolve to #A5AEB8 in both editors. This gray has low saturation and separates declaration words from cyan types primarily by saturation rather than hue. No editor window or display rendering was visually verified.

| Palette family | Color | HSL saturation | Style |
|---|---|---|---|
| Sections | #FFFFFF | 0.0% | bold |
| Types | #67E8F9 | 92.4% | plain |
| Keywords | #A5AEB8 | 11.8% | plain |
| Functions | #FBBF24 | 96.4% | plain |
| Bindings | #93C5FD | 96.4% | plain |
| Fields | #D8B4FE | 97.4% | plain |

All six families have different RGB foregrounds; zero of the 15 family pairs have identical RGB values. Cyan types and blue bindings remain neighboring cool families, and white sections add bold weight. Palette geometry does not guarantee recognition for every user.

Earlier captures are preserved in `theme-installation-evidence-005813.json` (three marker colors), `theme-installation-evidence-010004.json` (shared green), and `theme-installation-evidence-010146.json` (shared WHITE with pink keywords). This report and `theme-installation-evidence.json` describe the final bounded capture above. Externally observed settings updates were not made by this audit agent.

## Actual source role examples

Current configured colors below resolve identically in both editors. The snapshot column shows the emitted scope and Cursor uncustomized default foreground; Antigravity snapshot equivalents are recorded in the JSON evidence. The snapshot’s role mistakes are not automatically present in installed 0.1.2.

| Captured source and token | Snapshot 0.1.1 scope / color | Installed 0.1.2 scope / configured color |
|---|---|---|
| `CanLeave.can:25` `Day.year` | `entity.name.function.can` / #EFB080 | `variable.other.property.derived.can` / #D8B4FE |
| `CanDo.can:41` `Task` | `variable.other.readwrite.can` / #87C3FF | `entity.name.type.constructor.can` / #67E8F9 |
| `CanDo.can:42` `WorkView` | `variable.other.readwrite.can` / #87C3FF | `entity.name.type.constructor.can` / #67E8F9 |
| `CanLeave.can:44` `Calendar` | `variable.other.readwrite.can` / #87C3FF | `entity.name.type.constructor.can` / #67E8F9 |
| `CanDo.can:121` `create` | `variable.other.property.can` / #AAA0FA | `entity.name.function.reference.can` / #FBBF24 |
| `CanDo.can:137` `refresh` | `variable.other.readwrite.can` / #87C3FF | `entity.name.function.reference.can` / #FBBF24 |
| `CanDo.can:145` `action` | `variable.other.property.can` / #AAA0FA | `entity.name.function.reference.can` / #FBBF24 |
| `CanLeave.can:120` `request` | `variable.other.readwrite.can` / #87C3FF | `entity.name.function.reference.can` / #FBBF24 |
| `CanPropose.can:224` `revise` | `variable.other.readwrite.can` / #87C3FF | `entity.name.function.reference.can` / #FBBF24 |

Installed 0.1.2 separates a typed constructor from an ordinary variable in these examples; identifies UI form and call targets as function references; and treats a derived field as a property while a derived operation (`source_names()` in CanDo line 19) remains a function. In `form Task.create`, `Task.` is still the variable/namespace-colored prefix (#93C5FD), while the actual operation `create` is function-colored (#FBBF24). This is a syntactic namespace-prefix policy, not proof that `Task` is semantically a variable.

## Captured paths and SHA-256

Full compact JSON evidence contains the relevant installation registry entries, obsolete status, syntax-only manifest contributions, filtered editor settings, applicable theme rules, all declared scope mappings, actual token scope/color records, editor default-theme code excerpts, and SHA-256 hashes. No unrelated user settings were copied.

- `theme-installation-evidence.json` — captured evidence.
- `theme-probe.cjs` — reproducible independent read-only probe.

| Source path | SHA-256 |
|---|---|
| `/Users/vince/Projects/canlang/editors/vscode/audit-astra/snapshot/editors/vscode/package.json` | `e65902d6e79437fa1cec5dd699db77bc029f9cecf999557de92cbca867e5161c` |
| `/Users/vince/.cursor/extensions/extensions.json` | `a7d673b3321d8def08d7df209ae0fcdd54f0d17f44bf365daaa83fb64eddec9a` |
| `/Users/vince/.cursor/extensions/.obsolete` | `1f4a1b37a67aef83d82b69acb23c57582d4ec4484706448c780bdcd8a5211525` |
| `/Users/vince/Library/Application Support/Cursor/User/settings.json` | `cf7424f1b41a9983a833e1206ba9e962649adc7356ead42ccfb17b53661b77c2` |
| `/Applications/Cursor.app/Contents/Resources/app/node_modules/vscode-textmate/package.json` | `6b32b1f3c89f4c41e3ee9893536df1ddd7361c6369753f5c4a5aac105441af13` |
| `/Applications/Cursor.app/Contents/Resources/app/node_modules/vscode-oniguruma/package.json` | `98a5eb60b6dbcad4e302c877b2d5aff312a890c42bddf32e0585cbd1e3ff0df9` |
| `/Users/vince/Projects/canlang/editors/vscode/audit-astra/snapshot/editors/vscode/syntaxes/can.tmLanguage.json` | `94611f8212994a898722205b5478d62ea534334d8cf0511c1a4ecc6cbcc25207` |
| `/Applications/Cursor.app/Contents/Resources/app/extensions/theme-cursor/themes/cursor-dark-color-theme.json` | `117a4d53e7869b7a780468ff54db2b4ba769c4a34303377ac31f8b99d8f84727` |
| `/Applications/Cursor.app/Contents/Resources/app/extensions/theme-cursor/themes/cursor-dark-hc-color-theme.json` | `c7efc127003937f1ab8de71ff6912595ef7462477b9fe91b641b8dcdf076fd33` |
| `/Users/vince/.antigravity-ide/extensions/extensions.json` | `17e7f36b45e65f8c99a0bf22925e07a7ee3011e0ba5f6d08d6a4d3d5301eef39` |
| `/Users/vince/.antigravity-ide/extensions/.obsolete` | `3d49550533ee91c23502a045fa2ef4e75991631897fa488f30000aae8c2bb8ef` |
| `/Users/vince/Library/Application Support/Antigravity IDE/User/settings.json` | `f8521bc0974ab6d6dccb4170c3578f84a6cc7e757ef783f36096d39c42231432` |
| `/Applications/Antigravity IDE.app/Contents/Resources/app/node_modules/vscode-textmate/package.json` | `2a0d68a3acee2cd8b1ac2ff103cc88c03e1799852b0e5cdaeb7d788898e5a47c` |
| `/Applications/Antigravity IDE.app/Contents/Resources/app/node_modules/vscode-oniguruma/package.json` | `98a5eb60b6dbcad4e302c877b2d5aff312a890c42bddf32e0585cbd1e3ff0df9` |
| `/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/theme-defaults/themes/dark_modern.json` | `89c6908e3251e356e5d418d2af65a5eca5a16784bd9db67d396fe8d01086eccb` |
| `/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/theme-defaults/themes/dark_plus.json` | `88f5b662378cbe39473a4a8d916a1b4ec580f85858876eaec440288aee2852df` |
| `/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/theme-defaults/themes/dark_vs.json` | `d1b5e8ff41010795e5a060450161539a363125fb6fc465483ea860d0ba16d4d4` |

## Exhaustive declared-scope foreground groups

These groups include intentional same-role inheritance and generic punctuation/meta scopes; they are not all semantic role errors. Font styles and actual scope stacks are captured in JSON evidence.

### Cursor: snapshot-0.1.1-default-dark

| Foreground | Declared scopes |
|---|---|
| #F0F0F099 | `comment.line.number-sign.can` |
| #D6D6DD | `constant.character.escape.can`, `keyword.operator.assignment.can`, `keyword.operator.can`, `keyword.operator.word.can` |
| #F0F0F0 | `constant.language.can`, `constant.language.literal.can`, `entity.name.constant.message.can`, `meta.description.reference.can`, `meta.message.variants.can`, `meta.type.can`, `punctuation.accessor.can`, `punctuation.definition.description.can`, `punctuation.definition.message.can`, `punctuation.section.braces.begin.can`, `punctuation.section.braces.end.can`, `punctuation.section.group.begin.can`, `punctuation.section.group.end.can`, `punctuation.section.parameters.begin.can`, `punctuation.section.parameters.end.can`, `punctuation.separator.can`, `punctuation.separator.invariant.can`, `punctuation.separator.type.can` |
| #EBC88D | `constant.numeric.can`, `constant.numeric.unit.can` |
| #EFB080 | `entity.name.function.call.can`, `entity.name.function.can`, `entity.name.function.reference.can`, `entity.name.type.can`, `entity.name.type.namespace.can`, `entity.name.type.reference.can`, `support.type.primitive.can` |
| #AAA0FA | `entity.other.attribute-name.can`, `entity.other.attribute-name.locale.can`, `variable.other.constant.can`, `variable.other.constant.enum.can`, `variable.other.constant.resource.can`, `variable.other.property.can`, `variable.other.property.declaration.can`, `variable.other.property.key.can`, `variable.other.property.predecessor.can` |
| #82D2CE | `keyword.control.can`, `keyword.control.effect.can`, `keyword.control.import.can`, `keyword.control.migration.can`, `keyword.control.ownership.can`, `keyword.control.query.can`, `keyword.control.section.given.can`, `keyword.control.section.then.can`, `keyword.control.section.when.can`, `keyword.declaration.can`, `keyword.declaration.page.can`, `storage.modifier.export.can`, `storage.modifier.field.can`, `storage.modifier.type.can`, `storage.type.can`, `storage.type.resource.can` |
| #E394DC | `string.quoted.double.can`, `string.unquoted.description.can`, `string.unquoted.route.can` |
| #87C3FF | `variable.other.readwrite.binding.can`, `variable.other.readwrite.can`, `variable.other.readwrite.import.can`, `variable.other.readwrite.route.can` |

### Cursor: installed-current-theme-and-user-rules

| Foreground | Declared scopes |
|---|---|
| #F0F0F05C | `comment.line.number-sign.can` |
| #D6D6DD | `constant.character.escape.can`, `keyword.operator.assignment.can`, `keyword.operator.can` |
| #F9A8D4 | `constant.language.literal.can`, `constant.numeric.can`, `constant.numeric.unit.can` |
| #F0F0F0 | `entity.name.constant.message.can`, `meta.description.reference.can`, `meta.message.variants.can`, `meta.type.can`, `punctuation.accessor.can`, `punctuation.definition.description.can`, `punctuation.definition.message.can`, `punctuation.section.braces.begin.can`, `punctuation.section.braces.end.can`, `punctuation.section.group.begin.can`, `punctuation.section.group.end.can`, `punctuation.section.parameters.begin.can`, `punctuation.section.parameters.end.can`, `punctuation.separator.can`, `punctuation.separator.invariant.can`, `punctuation.separator.type.can` |
| #FBBF24 | `entity.name.function.call.can`, `entity.name.function.can`, `entity.name.function.predicate.can`, `entity.name.function.reference.can` |
| #93C5FD | `entity.name.namespace.can`, `variable.other.constant.can`, `variable.other.constant.enum.can`, `variable.other.constant.resource.can`, `variable.other.readwrite.binding.can`, `variable.other.readwrite.can`, `variable.other.readwrite.import.can`, `variable.other.readwrite.namespace.can`, `variable.other.readwrite.route.can`, `variable.other.readwrite.target.can`, `variable.parameter.can` |
| #67E8F9 | `entity.name.type.can`, `entity.name.type.constructor.can`, `entity.name.type.reference.can`, `storage.modifier.type.can`, `storage.type.can`, `storage.type.resource.can`, `support.type.primitive.can` |
| #D8B4FE | `entity.other.attribute-name.can`, `entity.other.attribute-name.locale.can`, `variable.other.property.can`, `variable.other.property.declaration.can`, `variable.other.property.derived.can`, `variable.other.property.key.can`, `variable.other.property.predecessor.can` |
| #A5AEB8 | `keyword.control.can`, `keyword.control.effect.can`, `keyword.control.import.can`, `keyword.control.migration.can`, `keyword.control.ownership.can`, `keyword.control.query.can`, `keyword.declaration.can`, `keyword.declaration.page.can`, `keyword.operator.word.can`, `storage.modifier.export.can`, `storage.modifier.field.can` |
| #FFFFFF | `keyword.control.section.given.can`, `keyword.control.section.then.can`, `keyword.control.section.when.can` |
| #E394DC | `string.quoted.double.can`, `string.unquoted.description.can`, `string.unquoted.route.can` |

### Antigravity IDE: snapshot-0.1.1-default-dark

| Foreground | Declared scopes |
|---|---|
| #6A9955 | `comment.line.number-sign.can` |
| #D7BA7D | `constant.character.escape.can` |
| #569CD6 | `constant.language.can`, `constant.language.literal.can`, `keyword.declaration.can`, `keyword.declaration.page.can`, `storage.modifier.export.can`, `storage.modifier.field.can`, `storage.modifier.type.can`, `storage.type.can`, `storage.type.resource.can` |
| #B5CEA8 | `constant.numeric.can`, `constant.numeric.unit.can` |
| #CCCCCC | `entity.name.constant.message.can`, `meta.description.reference.can`, `meta.message.variants.can`, `meta.type.can`, `punctuation.accessor.can`, `punctuation.definition.description.can`, `punctuation.definition.message.can`, `punctuation.section.braces.begin.can`, `punctuation.section.braces.end.can`, `punctuation.section.group.begin.can`, `punctuation.section.group.end.can`, `punctuation.section.parameters.begin.can`, `punctuation.section.parameters.end.can`, `punctuation.separator.can`, `punctuation.separator.invariant.can`, `punctuation.separator.type.can` |
| #DCDCAA | `entity.name.function.call.can`, `entity.name.function.can`, `entity.name.function.reference.can` |
| #4EC9B0 | `entity.name.type.can`, `entity.name.type.namespace.can`, `entity.name.type.reference.can`, `support.type.primitive.can` |
| #9CDCFE | `entity.other.attribute-name.can`, `entity.other.attribute-name.locale.can`, `variable.other.property.can`, `variable.other.property.declaration.can`, `variable.other.property.key.can`, `variable.other.property.predecessor.can`, `variable.other.readwrite.binding.can`, `variable.other.readwrite.can`, `variable.other.readwrite.import.can`, `variable.other.readwrite.route.can` |
| #C586C0 | `keyword.control.can`, `keyword.control.effect.can`, `keyword.control.import.can`, `keyword.control.migration.can`, `keyword.control.ownership.can`, `keyword.control.query.can`, `keyword.control.section.given.can`, `keyword.control.section.then.can`, `keyword.control.section.when.can` |
| #D4D4D4 | `keyword.operator.assignment.can`, `keyword.operator.can`, `keyword.operator.word.can` |
| #CE9178 | `string.quoted.double.can`, `string.unquoted.description.can`, `string.unquoted.route.can` |
| #4FC1FF | `variable.other.constant.can`, `variable.other.constant.enum.can`, `variable.other.constant.resource.can` |

### Antigravity IDE: installed-current-theme-and-user-rules

| Foreground | Declared scopes |
|---|---|
| #6A9955 | `comment.line.number-sign.can` |
| #D7BA7D | `constant.character.escape.can` |
| #F9A8D4 | `constant.language.literal.can`, `constant.numeric.can`, `constant.numeric.unit.can` |
| #CCCCCC | `entity.name.constant.message.can`, `meta.description.reference.can`, `meta.message.variants.can`, `meta.type.can`, `punctuation.accessor.can`, `punctuation.definition.description.can`, `punctuation.definition.message.can`, `punctuation.section.braces.begin.can`, `punctuation.section.braces.end.can`, `punctuation.section.group.begin.can`, `punctuation.section.group.end.can`, `punctuation.section.parameters.begin.can`, `punctuation.section.parameters.end.can`, `punctuation.separator.can`, `punctuation.separator.invariant.can`, `punctuation.separator.type.can` |
| #FBBF24 | `entity.name.function.call.can`, `entity.name.function.can`, `entity.name.function.predicate.can`, `entity.name.function.reference.can` |
| #93C5FD | `entity.name.namespace.can`, `variable.other.constant.can`, `variable.other.constant.enum.can`, `variable.other.constant.resource.can`, `variable.other.readwrite.binding.can`, `variable.other.readwrite.can`, `variable.other.readwrite.import.can`, `variable.other.readwrite.namespace.can`, `variable.other.readwrite.route.can`, `variable.other.readwrite.target.can`, `variable.parameter.can` |
| #67E8F9 | `entity.name.type.can`, `entity.name.type.constructor.can`, `entity.name.type.reference.can`, `storage.modifier.type.can`, `storage.type.can`, `storage.type.resource.can`, `support.type.primitive.can` |
| #D8B4FE | `entity.other.attribute-name.can`, `entity.other.attribute-name.locale.can`, `variable.other.property.can`, `variable.other.property.declaration.can`, `variable.other.property.derived.can`, `variable.other.property.key.can`, `variable.other.property.predecessor.can` |
| #A5AEB8 | `keyword.control.can`, `keyword.control.effect.can`, `keyword.control.import.can`, `keyword.control.migration.can`, `keyword.control.ownership.can`, `keyword.control.query.can`, `keyword.declaration.can`, `keyword.declaration.page.can`, `keyword.operator.word.can`, `storage.modifier.export.can`, `storage.modifier.field.can` |
| #FFFFFF | `keyword.control.section.given.can`, `keyword.control.section.then.can`, `keyword.control.section.when.can` |
| #D4D4D4 | `keyword.operator.assignment.can`, `keyword.operator.can` |
| #CE9178 | `string.quoted.double.can`, `string.unquoted.description.can`, `string.unquoted.route.can` |
