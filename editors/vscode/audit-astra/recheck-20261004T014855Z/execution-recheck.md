# Execution and presentation recheck — frozen 0.1.4

This is a narrow independent recheck of F1, F2, F3, F5, and F10 against `snapshot/GRAMMAR.md` and `snapshot/editors/vscode/syntaxes/can.tmLanguage.json`. The grammar SHA-256 is `5c0e667200b5bc73fffa21553e96207518694c583d3e0eb07d4642b06975b40d`. Later source changes are outside this report.

I used a separate TextMate registry with vscode-textmate and vscode-oniguruma, loading the frozen grammar directly. `execution-tokenize.cjs` is the independently run driver; `execution-probes.json`, `execution-results.json`, and `execution-results.txt` preserve sources and token scopes. Twelve standalone sources are also saved in `execution-sources/`. No implementer audit/test conclusions, extension activation, settings edits, or UI inspection were used. These checks concern written syntax and lexical roles, not compilation, authorization, runtime behavior, or provider installation.

## Status

| Family | Status in checked cases | Evidence and qualification |
| --- | --- | --- |
| F1 effects, contextual models, context, loops | Partially fixed | Complete backend contexts fix return-object and contextual loop-variable cases. Six owned contextual model shapes in Given still take declaration-prefix rules. |
| F2 inline behavior examples | Fixed in checked cases | CRUD action headers, scenario parameters named like actions, and ordinary example selector identifiers retain their different roles. |
| F3 contextual operators and query names, joined lines | Fixed in checked cases | Dotted contextual fields, primary contextual identifiers, actual word operators, alias bindings, and delimiter-joined query clauses classify correctly. |
| F5 operation-reference slots | Partially fixed | Bare, qualified, parenthesized, and joined call/send targets work. A delimiter-joined parenthesized form target loses function-reference classification. |
| F10 components, guards, effects | Partially fixed | Page/component separation and leading or multiline body guards work. The first inline require after do still takes an effect scope. |

“Fixed in checked cases” describes these specific probes; it is not a completeness claim for every possible source form. In particular, earlier orphan return/loop fragments are not sufficient evidence of a surviving defect once their valid scenario context produces correct scopes.

## Surviving findings

### P2 — F1: owned contextual model names select incompatible declarations

`execution-sources/valid-owned-contextual-models.can:4–9` places each of these model declarations inside Given:

```can
 app in app {title:text}
 package in app {title:text}
 event in app {title:text}
 contract in app {title:text}
 role in app {title:text}
 capability in app {title:text}
```

These are supported model shapes. GRAMMAR.md:70 requires the complete production and enclosing grammar to distinguish contextual words; :72 permits contextual declaration names. The model production at :82 and Given alternatives at :249–254 permit NAME followed by ownership and schema, while :271 explicitly permits ownership in app. App/package declarations are not Given leaves. The other declaration prefixes also do not match their complete productions here: they cannot consume the ownership sequence as written. The same enclosing source gives correct model-type scopes to `context in app {title:text}` and `scenario in app {title:text}` at lines 10–11.

Actual first-name scopes are `keyword.declaration.owner.can` for app/package and `keyword.declaration.can` for event/contract/role/capability, instead of `entity.name.type.can`. The ownership token `in` is also reinterpreted as a namespace, type, or predicate name. These are role errors in valid written model productions, independent of semantic binding resolution.

The responsible Given rule ordering is visible in the frozen JSON: `given-code` at :2324, capability prefix at :2330, owner prefix at :2498, role prefix at :2520, and contract/event/capability prefix at :2531. Those prefix matches run before the applicable model shape. The repair should recognize the whole owned-model production in Given before competing contextual declaration prefixes, while preserving true declaration forms.

### P2 — F5: joined parenthesized form targets lose their operation role

`execution-sources/valid-operation-slots.can:33–35` contains this form inside an authored page and list, referring to the scenario declared at line 10:

```can
   form (
    change
   )
```

The token `change` at line 34 gets `variable.other.readwrite.can`. The same operation in `form change` at line 31 and `form (change)` at line 32 gets `entity.name.function.reference.can`. The complete app also declares the model, read policy, and canonical operations needed for the surrounding presentation.

This is not an orphan-fragment fallback. GRAMMAR.md:35 permits delimiter joining; :205 includes parenthesized primary expressions; :379–380 defines the form expression slot. A line break inside these parentheses does not change the target's role. Joined parenthesized call/send targets in this same source preserve function-reference classification, providing a direct control.

The presentation matcher at frozen JSON:1701–1702 ends its outer context at the physical line and handles optional parentheses through its one-line target matcher. The fallback expression/parens machinery recognizes the expression but loses the operation-slot context. Carrying that slot context through joined parentheses should preserve the same target role as the one-line form.

A smaller punctuation gap also remains in `execution-sources/valid-qualified-operation-parentheses.can:17`: the parentheses in `form (Item.update)` are captured with only the surrounding presentation scope, whereas normal grouped expressions and call groups receive punctuation-group scopes. This is a P3 scope consistency issue, separate from the P2 target-role defect.

### P2 — F10: first inline body require gets an effect scope

`execution-sources/valid-inline-structural-guards.can:9` contains:

```can
  do require input.active; require input.active; set input {title="Changed"}
```

The first require is `keyword.control.effect.can`; the second, after the semicolon, is `keyword.control.structure.can`. Leading scenario require at line 8 and multiline body require at line 12 are structural. Presentation require at lines 16 and 18 correctly uses the separate guard scope.

GRAMMAR.md:314, :317–318, and :337 permit body guards and inline do leaf sequences. These two written require leaves have the same structural role. The requested palette makes require a white structural keyword, so assigning the first one to the general effect family is a material role mismatch. This report verifies scopes only; rendered colors are covered by the parent/theme review.

The frozen backend structural matcher at JSON:2160 recognizes line starts and semicolons. The effect fallback at :2236–2237 includes require and admits the position after do. The structural rule should also admit the initial inline do leaf, preserving the same guard role across line layout.

## Fixed controls and coverage

F1: `valid-backend-context.can:13` classifies return in `return {value=1}` as `keyword.control.effect.can`. At :16, `for in in values limit=1` yields control keyword, binding, and word operator respectively. At :18, return is a loop binding. Genuine app context at :3 is a declaration keyword. `valid-contextual-models.can` correctly gives unowned for/return/context/event/contract/do/require model names type scopes. These correct contextual results supersede earlier complaints based only on orphan executable fragments.

F2: `valid-crud-examples.can:9–16` covers create/update/delete example action headers and selector rows using title and as. Actions receive `keyword.control.example-action.can`; selector identifiers remain ordinary expressions. `valid-scenario-examples-contextual.can:7–8` keeps delete/action/history as example argument keys and title as a selector identifier. The dedicated examples region at frozen JSON:1845 avoids the prior presentation-header interference. The relevant written example productions are GRAMMAR.md:346–358.

F3: `valid-query-contextual-names.can:6–12` checks member names return/where/select, following and/or operators, aliases named where/order, contextual primary operands, and multiplication. `valid-joined-query.can:7–10,13–15,18` checks physical line breaks within parentheses, aliases, clauses, and a following word operator. `valid-operator-operand-boundaries.can` additionally checks contextual operands around not, and, or, equality, and multiplication. These produce the expected property, binding/reference, query keyword, and operator roles. GRAMMAR.md:191–244 and delimiter joining at :35 support those contexts; current operand/tail state rules avoid the earlier blacklist behavior.

F5: `valid-operation-slots.can:14–22` checks bare and grouped call/send references, including joined groups. Canonical operation names are function references, with qualification prefixes retaining namespace scopes. Page refresh and form review targets at :28–29 are function references. Bare form/action/actions and one-line grouped targets also classify correctly. This is lexical slot recognition; it does not establish runtime capability delivery, operation existence in every arbitrary expression, or semantic resolution of dynamic action fields.

F10: `valid-ui-query-and-guards.can` checks page's dedicated `entity.name.tag.component.page.can` scope, ordinary components' `entity.name.tag.component.can`, presentation guard scopes, scenario declarations, body structure, and business effects. `valid-inline-structural-guards.can` separates leading, multiline, inline, and presentation guards. Palette requirements remain one shared white structural treatment, gray types, cyan other keywords, muted tan components with the white page exception, amber functions, blue bindings, and lavender fields. This sub-audit makes no UI rendering claim.

No new inventory or language design recommendation is implied by these findings. F8 qualified migration paths belongs to the parent's separate recheck and was not assessed here.
