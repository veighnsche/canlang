# Syntax reference

Look up application declarations, dollar prompts, named style reuse and operation syntax. Find where each form belongs, what it generates, and which implementation files ordinary builds consume.

The [normative grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md) owns complete productions and contextual boundaries. The forms below summarize those rules; fragments need their stated enclosing sections and referenced declarations.

## Declaration and statement lookup

These are syntax patterns, not one complete application. Capitalized names and words such as `predicate` stand for declarations or expressions in the enclosing owner. Follow the linked chapters for complete files.

| Form | Placement | Meaning and example destination |
| --- | --- | --- |
| `app Name` + `Given`/`When`/`Then` | Top level | Implicit owning package; [first app](../01-Get-started/05-first-app.md) |
| `app Office uses=[Tasks,Notes]` | Top level | Select declared owners; cannot also have an implicit body |
| `package work` + indented sections | Top level | Explicit reusable owner; [complete multi-file project](../02-Language-foundations/04-apps-and-packages.md) |
| `use work {Todo as Task,finish}` | Before an owner's Given | Import exported names; visibility grants no authority |
| `use std {EmailV1 as Mail} from=deployment.mail` | Import position | Bind a remote interface; [localized mail](../07-Build-interfaces/06-localization.md) |
| `export Model {...}` / `export scenario ...` | Declaration's existing indentation | Export an eligible declaration, not a separate export list |
| `Model {field:Type=default}` | Given | Stored team-scoped record schema |
| `Child in Parent {...}` / `Model in app {...}` | Given | Explicit containment/app scope; [data models](../04-Model-and-query-data/01-models-and-relationships.md) |
| `contract Name {...}` / `event Name {...}` | Given | Typed structural/event payload; no stored table implied |
| `derive name(input:Type):Type = expression` | Given | Pure reusable computation; [derives](../02-Language-foundations/03-expressions-and-derives.md) |
| `policy Model read=predicate` | Given | Read grant; no implicit write grant |
| `invariant Model: predicate` | Given | Stored rule across mutation paths |
| `unique Model fields=a,b` | Given | Composite uniqueness; [validation](../04-Model-and-query-data/02-defaults-and-validation.md) |
| `role reviewer` | Given | Declare a team role; assignment and permissions remain explicit |
| `lock Todo fields=title when=row.done` | Given | Freeze the listed fields under the owning pre-state rule |
| `retain Model until=row.expires_at` | Given | Pure nullable lifetime expression; requires that declared datetime field |
| `fixture sample=Todo {title="Review"}` | Given | Behavioral-example setup recipe, not production seed data |
| `capability Name` + operation/event suite | Given | Typed external interface; binding supplies its implementation |
| `judgment Name` + typed question suite | Given | Source-owned judgment contract, not a dollar generation prompt |
| `corpus Name model=Model ...` | Given | Schema-bound retrieval declaration; the ellipsis denotes required owner-specific options, not literal syntax |
| `migration Name ...` + mapper/directive suite | Top level | Explicit predecessor-bound evolution; not a business operation |
| `crud Model by=members fields=title` | When | Canonical CRUD with an explicit writable surface |
| `scenario name(input:Type) by=members` | When | User mutation with leading guards and one do body |
| `scenario name(...) read=true -> Type by=members` | When | Pure canonical read returning the declared result |
| `scenario name on=Event` / `on=Model.create` | When | Trusted event handler / precommit CRUD hook |
| `scenario name on=every(1h)` | When | Recurring handler; [asynchronous examples](../06-Business-workflows/06-events-and-hooks.md) |
| `require predicate` | Guard position, do body or presentation container | Reject mutation or gate presentation according to its owner |
| `let name=expression` | do | Immutable executable binding |
| `create Model {field=value} as record` | Mutation do | Create and bind a record |
| `set record {field=value}` / `delete record` | Mutation do | Mutate through the owning transaction |
| `call operation {input=value} as result` | do | Canonical local call and optional result binding |
| `if predicate` / `else`, `match value` / `case value` | do suites | Explicit branches; [operations](../06-Business-workflows/02-scenarios-and-effects.md) |
| `for item in items limit=20` | Mutation do | Bounded loop within the transaction |
| `return expression` | do | Declared result; does not bypass final checks |
| `transition row.state old -> new` | Mutation do | Managed enum transition, not ordinary set |
| `emit Event {...}` | Mutation do | Durable committed event intent |
| `schedule key at=instant event=Event {...}` / `cancel key` | Mutation do | Stable-key future work; [scheduling](../06-Business-workflows/07-scheduling-and-recurring-work.md) |
| `send Service.operation {...} as receipt` | Mutation do | Durable external delivery, not a synchronous local call |
| `page /tasks/{Todo.id} title="Task"` | Then | Typed record route; [pages](../07-Build-interfaces/01-pages-and-navigation.md) |
| `form operation arguments={record=row}` | Page/group | Canonical inputs with explicit bindings |
| `view Summary(row:Todo)` / `show Summary {row=row}` | Then / presentation | Ordinary checked view and use |
| `preferences {view:enum(all,open)=all}` | Then | Personal presentation extension with an actual consumer |
| `message count_label(n:int) = "{n} tasks"@{}` | Given | Typed message descriptor; [localization](../07-Build-interfaces/06-localization.md) |

Schemas use `:`; value objects use `=`. `##` is an explanatory comment; `#` attaches description metadata to the following declaration. Arrays use `[a,b]`; query clauses follow `archived=include`, `as`, `where`, `order=`, `select`, each at most once. See the [basic syntax lesson](../02-Language-foundations/01-source-syntax.md) for indentation, identifiers and literal escaping.

## Operator precedence

Lowest precedence first. Parentheses override grouping; there are no assignment expressions or implicit truthiness.

| Level | Forms | Example / important rule |
| --- | --- | --- |
| 1 | `??` | `value ?? fallback`; right-associative, fallback evaluated only for null |
| 2 | `or` | `allowed or owner`; stops after true |
| 3 | `and` | `value!=null and value>0`; stops after false |
| 4 | `not` | `not task.done` |
| 5 | `== != < <= > >= in is` | Typed comparison/membership/narrowing; no chained comparisons |
| 6 | `+ -` | `2+3*4` gives 14 |
| 7 | `* / %` | `7/2` is decimal 3.5 |
| 8 | Unary `-` | Checked numeric/duration/money negation |
| 9 | `.`, `?.`, calls | `candidate?.title`; no optional call or unchecked array indexing |

Do not mix `??` with `and`/`or` without parentheses. `choose` is an eager function, not a lazy conditional operator. `?.` makes a read nullable but does not swallow authorization failures. Use `at(array,index)` for nullable indexing and the [narrowing rules](../02-Language-foundations/03-expressions-and-derives.md#narrow-values-before-using-them) before accessing optional data.

## Operator type lookup

Unlisted operand pairs are invalid; operators do not acquire overloads from a helper or field name.

| Operands | Operators | Result and worked example |
| --- | --- | --- |
| int, int | `+ - * %` | int; `7%3` is 1 |
| int, int | `/` | decimal; `7/2` is 3.5 |
| int/decimal, decimal/int with at least one decimal | `+ - * /` | decimal; `2+0.5` is 2.5 |
| money, money | `+ -` | Same-currency money |
| money, int/decimal | `* /` | Money; `money(10,"EUR")/4` is EUR 2.50 |
| int/decimal, money | `*` | Money |
| money, money | `/` | Same-currency decimal ratio |
| duration, duration | `+ - %` | Duration; `5m%2m` is 1m |
| duration, duration | `/` | Decimal ratio; `5m/2m` is 2.5 |
| duration, int | `* /` | Duration; division must yield exact integer milliseconds |
| int, duration | `*` | Duration |
| datetime, duration | `+ -` | Datetime; instant plus 1d adds exactly 24 hours |
| duration, datetime | `+` | Datetime |
| datetime, datetime | `-` | Elapsed duration |
| Compatible ordered sequences | `+` | Concatenation; `[1,2]+[2]` preserves duplicate 2 |
| int/decimal/duration/money | Unary `-` | Same type, checked for overflow |
| bool / bool pair | `not` / `and or` | Boolean, with short-circuit binary evaluation |
| Compatible values | `== !=` | Typed equality, including explicit null rules |
| Compatible ordered scalars | `< <= > >=` | Boolean; matching currencies required for money |
| T, collection of compatible T | `in` | Boolean membership |
| Nullable T, T or T? | `??` | Compatible fallback without coercion |
| Union value, declared case | `is` | Case test and appropriate branch narrowing |

Ordered scalars include numeric, temporal, validated string-like and byte values. Enums use equality/membership rather than relational order; bytes have comparison without arithmetic. References compare typed identity; arrays/contracts use typed structural equality. Text is not concatenated with `+`: use `join` or `format`. Calendar-date changes use `add_days`/`add_months`, not invented date arithmetic. Overflow, zero division and invalid construction fail rather than yielding NaN/infinity or truncated results. See [builtin lookup](02-types-and-builtins.md#worked-uses-of-all-36-builtins).

## Dollar prompts and named styles

`$"..."` is a static generation prompt. `$Name` is a named style attachment. The dollar sign must be adjacent to its string or name; it is not a general expression operator, runtime interpolation or a universal prefix for generated declarations.

| Form | Legal placement | Meaning |
| --- | --- | --- |
| `trait Name $"..."` | Directly in `Given` | Define a reusable model/field trait |
| `trait $"..."` | After a model schema or stored-field modifiers | Attach an inline trait |
| `keyword Name(signature) $"..."` | Directly in `Given` | Define a typed custom keyword |
| `style Name $"..."` | Directly in `Then` | Define a reusable scoped style |
| `$"..."` on a visual header | After its checked payload/options, before the header ends | Attach one inline style |
| `$Name` on a visual header | In the same style attachment position | Reuse the named style's saved CSS |
| `view Name(row:Model) $"..."` | Directly in `Then` | Define a generated renderer for one stored-model row |

The table uses schematic names and `signature`; the following examples show concrete fragments. Generated fragments require accepted saved implementation for their owning application. Prepare that implementation explicitly before using them in ordinary builds; copying a prompt alone does not supply it.

### Model and field traits

Place this fragment in an application's `Given` section:

```can
trait completable $"Add done:bool=false to each attached model."
trait title_text $"Constrain the text field with trim, min=1 and max=80. Keep its type and add no default."
Todo {title:text title_text} completable
Note {title:text trait $"Constrain this text field with trim and max=80. Keep its type and add no default."}
```

`title_text` and `completable` are bare-name applications. Neither `$completable` nor `trait completable` applies a named trait. Inline attachments require `trait` before the prompt. Traits attach only to models and stored fields, not parameters or arbitrary schemas; they cannot grant permissions or bypass storage and transaction rules.

### Typed custom keywords

This `Given` fragment defines a keyword and applies it to a local model field:

```can
Alias {handle:text trim}
keyword canonical_identity(target:model,field:field(target,text)) $"Compute a unique key using Unicode NFKC normalization followed by ASCII A-Z lowercasing only. Preserve stored spelling and non-ASCII case. Return the key as text. Keep uniqueness, permissions and transactions with the canonical owner."
canonical_identity target=Alias field=Alias.handle
```

The definition owns the prompt. Applications use the bare keyword name and each required named argument once: no positional arguments, defaults, anonymous keyword prompts or new prompt on an application. Signatures are nonempty; supported reference parameter kinds include `model`, dependent `field(target,type)` and `operation`, while ordinary typed arguments must be compile-time constants. See [traits and custom keywords](../03-Generate-implementation/02-traits-and-custom-keywords.md).

### Named styles and inline styles

This fragment belongs directly in `Then` and needs no model:

```can
style TaskSurface $"Keep owned typography and spacing readable. Preserve canonical controls and shared theme tokens."
page / title="Tasks"
 card "Today" $TaskSurface
  text "Review today's work."
 card "Tomorrow" $TaskSurface
  text "Plan the next task."
 card "Help" $"Keep this text readable at narrow widths using the shared theme."
  text "Choose a team before working with tasks."
```

Both named attachments share the definition's saved CSS with separate instance hooks. Each eligible visual header accepts at most one style attachment. `require`, schema declarations and slot markers are not style targets. `primary` and `secondary` action declarations accept no attachment, and ancestor styles cannot restyle their standard controls. Styles cannot escape their scope, import remote assets or redefine global theme variables.

### Generated views

This `Then` fragment requires a same-module stored `Todo` model with `title:text`. It defines its own style and instantiates its renderer for each listed row:

```can
style TaskSurface $"Keep owned text readable using the shared theme. Preserve canonical card presentation."
view TaskTile(row:Todo) $"Render the complete source-owned canonical card once, preserving its checked bindings. Add no network or state operations." $TaskSurface
 card "Task"
  text row.title
page / title="Tasks"
 list Todo
  show TaskTile {row=row}
```

The first prompt in the view header describes the **renderer**. The optional following style suffix styles its root; it is a separate generation target. A view binds one required nonnullable stored-model row, and `show` supplies exactly `{row=expression}`, evaluated once. Renderers retain canonical action bindings and receive only admitted presentation data. An ordinary view has no renderer prompt and needs no generation; its definition accepts no root style, though its visual children and `show` instances can carry styles. See [styles and custom views](../03-Generate-implementation/03-styles-and-custom-views.md).

### Static strings, profiles and saved implementation

Prompts are static JSON strings without interpolation or translation suffixes. They are not ordinary expressions and cannot be computed from runtime values. Escape quotes inside them using JSON string escaping. Trait and keyword definitions are local `Given` declarations; style definitions and views belong directly in `Then`. These definitions cannot be exported.

An optional `agent=profile` selects a generation profile on the owning definition or an inline attachment. It precedes the inline prompt, for example `style TaskSurface agent=frontend $"Keep text readable."`. Named uses cannot override their definition's profile; a visual attachment with `agent=` must have an inline style prompt. Omitting the profile uses the shared generation recipe, with `frontend` used for `Then` when configured. See [generation configuration](../15-Tooling-reference/03-generation-configuration.md).

`can gen Tasks.can` explicitly prepares and validates generated implementation with the configured coding runner. Accepted files are saved under tracked `can.generated/<opaque-unit-id>/`; keep them with the owning source. Ordinary checks and builds consume current saved files, including validated direct edits, and make zero AI calls. Missing or stale required implementation requires explicit preparation, not automatic generation during a build. Compatible named reuse consumes the saved definition.

Prompts do not replace authored `When` guards or `do` effects and do not make runtime model requests. For the latter, use [runtime generation](../09-Runtime-AI/01-text-and-image-generation.md); for saved implementation and acceptance, use [generation lifecycle](../03-Generate-implementation/01-generation-lifecycle.md).

## File and declaration forms

```can
# Manage team tasks.
app Tasks
Given
 Todo { title:text, done:bool=false }
 policy Todo read=members
When
 # Complete an open task.
 scenario finish(todo:Todo) by=members
  require not todo.done message="Task is already complete"
  do
   set todo {done=true}
Then
 page / title="Tasks"
  list Todo columns=title,done
```

An explicit package uses `package Name` with indented sections. Composition uses `app Name uses=[Package]`, optional context, then imports before declarations. Models, contracts, field/parameter enum types, policies, invariants, unique constraints, locks, retention, fixtures, CRUD, scenarios, events, capabilities, judgments, corpora, pages, forms, collections, and components have distinct productions; similar-looking names do not choose a production by capitalization.

## Expression and operation forms

Fields and parameters declare types explicitly. Nullable values use `?`; arrays use `[]`; enums use `enum(a,b)`. Query clauses have grammar-defined order. A mutation has one `do` body with source-ordered effects. Effects include `create`, `set`, `transition`, `delete`, `call`, `emit`, `send ... as name`, `schedule ... at=... event=...`, `cancel`, `if/else`, exhaustive enum `match/case`, bounded `for`, and `return`. There is no arbitrary SQL/JS body or nested atomic block. See [scenarios](../06-Business-workflows/02-scenarios-and-effects.md), [language values](../02-Language-foundations/02-types-and-values.md), and [UI constructs](../07-Build-interfaces/01-pages-and-navigation.md).

## Basic syntax and expression details

| Question | Guide |
| --- | --- |
| What is a valid name, indentation or continuation? | [Identifiers and logical lines](../02-Language-foundations/01-source-syntax.md#write-identifiers-and-logical-lines) |
| When do I use `#`, `##`, `#=` or `desc=`? | [Descriptions and comments](../02-Language-foundations/01-source-syntax.md#separate-descriptions-from-comments) |
| Why do schemas use colons and values use equals signs? | [Schemas and value objects](../02-Language-foundations/02-types-and-values.md#schemas-and-value-objects) |
| Which string, number and collection literals are valid? | [Literal values](../02-Language-foundations/02-types-and-values.md#literal-values) |
| Which operator binds first? | [Operators and precedence](../02-Language-foundations/03-expressions-and-derives.md#operators-and-precedence) |
| How do `??`, `?.` and narrowing interact? | [Null fallback and optional access](../02-Language-foundations/03-expressions-and-derives.md#null-fallback-and-optional-access) and [narrowing](../02-Language-foundations/03-expressions-and-derives.md#narrow-values-before-using-them) |
| Does `choose` skip the unselected argument? | [Eager calls and Boolean guards](../02-Language-foundations/03-expressions-and-derives.md#calls-are-eager-boolean-guards-are-not) |
| How do I define a computed field or pure helper? | [Derives](../02-Language-foundations/03-expressions-and-derives.md#reusable-pure-computation) |
| Where do `actor`, `row`, `parent` and other context names exist? | [Contextual variables and lexical scope](../02-Language-foundations/03-expressions-and-derives.md#contextual-variables-and-lexical-scope) |
