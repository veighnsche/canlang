# Bounded 0.1.4 palette and contextual-role recheck

Captured **2026-10-04T01:51:30.833Z UTC**. One filesystem/theme capture was made; no UI actions, installs, settings changes, or source/extension writes. Earlier evidence was preserved. The probe used the immutable snapshot grammar SHA-256 **5c0e667200b5bc73fffa21553e96207518694c583d3e0eb07d4642b06975b40d** with current captured user rules and each editor's bundled engine.

**Most focused snapshot palette checks pass, but inline `do require` has a concrete structural-color failure. Installed grammar drift limits the conclusion:** both registries identify 0.1.4, but both installed grammars have hash **12320c040fac06952bb19a593b41c686fc2450cfa9518d892734bd346c0288b1**, which differs from the tested immutable grammar. Installed behavior is not established by this snapshot tokenization. No further polling or recapture was attempted.

## Resolved palette in both editors

| Actual source role | Observed scope | Foreground | Style |
|---|---|---|---|
| Given / When / Then | `keyword.control.section.*.can` | #FFFFFF | bold |
| app / package | `keyword.declaration.owner.can` | #FFFFFF | bold |
| scenario declaration | `keyword.declaration.scenario.can` | #FFFFFF | bold |
| Leading backend do / require / examples | `keyword.control.structure.can` | #FFFFFF | bold |
| Presentation require | `keyword.control.guard.can` | #FFFFFF | bold |
| Actual page declaration | `entity.name.tag.component.page.can` | #FFFFFF | bold |
| Record declaration / text primitive | `entity.name.type.can` / `support.type.primitive.can` | #A5AEB8 | plain |
| use / role / let / return / as | import, declaration, control, effect, query keyword scopes | #67E8F9 | plain |
| Then title / text / table / form / card | `entity.name.tag.component.can` | #C7AD8E | plain |
| Scenario name / form target | `entity.name.function.can` / `.reference.can` | #FBBF24 | plain |
| Bindings / parameters / namespace identity | readwrite / parameter / namespace scopes | #93C5FD | plain |
| Fields / property keys / member names | `variable.other.property.*.can` | #D8B4FE | plain |
| Translation opening and closing markers | `punctuation.definition.message.can` | #D6D6DD | plain |
| Bare / quoted locale-key text | `entity.other.attribute-name.locale.can` | #D8B4FE | plain |

The seven role foregrounds (white structures, muted gray types, cyan language keywords, muted tan components, amber functions, blue bindings, lavender fields) are distinct. Page's component sub-scope wins over the component family rule, producing the required white exception. The source strings retain theme values: Cursor **#E394DC**, Antigravity **#CE9178**. Engine versions: Cursor TextMate 9.2.0, Antigravity TextMate 9.3.1, both Oniguruma 1.7.0. Cursor is configured for Cursor Dark High Contrast; Antigravity has no explicit colorTheme user setting, so its bundled Dark Modern default was used.

## Contextual authored names

The complete multiline cases in `theme-evidence.json` preserve tokenization state. Contextual spellings are classified by their written roles:

- `Record {do:text,require:text,page:text,examples:text,scenario:text,title:text,form:text}`: authored field names are lavender property declarations; primitive `text` is muted gray.
- `scenario page(do:text,require:text,examples:text,scenario:text) -> text`: declaration keyword `scenario` is white/bold, authored operation name `page` is amber, and parameters `do`, `require`, `examples`, and `scenario` are blue.
- `let examples = row.page`: `let` is cyan, binding `examples` blue, member `page` lavender.
- `text row.require` and `text row.page`: actual leading `text` component is muted tan; authored members remain lavender.
- `form page`: actual `form` component is muted tan; authored operation target `page` remains amber.

No structural-scope promotion was observed for these authored fields, members, bindings, or parameters.

`table Record as page` emits the collection operand `Record` as `variable.other.readwrite.can` (blue), while the record declaration is a gray type. This is the expected semantic-limit fallback for a generic collection operand, not a concrete syntax defect: the slot can also hold an authored value, and syntax-only tokenization does not resolve declaration identity.

## Concrete inline require defect

Using the same captured settings (01:51:30 UTC), the additional bounded probe at **01:53:27 UTC** resolves this actual backend line:

```can
  do require item.ready; require item.ready
```

| Token, both editors | Actual scope | Foreground/style | Required |
|---|---|---|---|
| first `require`, immediately after `do` | `keyword.control.effect.can` | #67E8F9, plain | #FFFFFF, bold |
| second `require`, after semicolon | `keyword.control.structure.can` | #FFFFFF, bold | #FFFFFF, bold |

The same authored structural spelling changes color with placement. The first `require` fails the requested white structural palette. Exact full stacks and metadata are saved in `inline-require-evidence.json`. No settings were recaptured; theme files were checked against hashes from the original capture.

## F9 regression check

Both `# Label @{nl="Hallo","nl-NL"="Hallo"}` and `text "Label"@{nl="Hallo","nl-NL"="Hallo"}`, plus standalone bare/quoted locale cases, yield matching opening/closing marker foregrounds **#D6D6DD** in both editors. Locale-key text consistently remains **#D8B4FE**. Quoted-key quote delimiters retain theme-specific colors (Cursor #E394DC, Antigravity #D6D6DD), as in the earlier focused verification. No marker-inheritance regression was observed.

`theme-evidence.json` contains exact strings, full scope stacks, resolved colors/styles, filtered settings, registered manifests, installed/snapshot hashes, and theme hashes. `theme-probe.cjs` reproduces this focused probe. Installed manifests remain syntax-only. Runtime rendered editor colors are **visually unverified**.
