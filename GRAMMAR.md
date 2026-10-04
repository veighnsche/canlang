# canlang v1 grammar

This is the normative source grammar for the bounded v1 language in [DESIGN.md](DESIGN.md). It specifies tokens, layout, syntactic roles and AST boundaries; DESIGN owns business semantics. A successful parse does not establish valid names, types, permissions, application behavior, deployed resources or executable examples. Unknown syntax is an error. No production permits an unparsed tail or an arbitrary extension word.

## Notation

EBNF uses `=` for a production, `|` for alternatives, `[x]` for optional syntax, `{x}` for repetition, and quoted text for exact source tokens. Uppercase names are lexical/layout tokens. `line(x)` means `x NEWLINE`. `suite(x)` means `NEWLINE INDENT x DEDENT`, with at least one source item. `optional_suite(x)` is either `NEWLINE` or `suite(x)`; lookahead at the next noncomment logical line determines which. `leaf_lines(x)` means a nonempty sequence of `line(x {";" x})`. These are grammar notation, not source words. End of file supplies a final `NEWLINE` when the final nonblank logical line lacks one.

`separated(x)` means `x {"," x}`. `bracketed(x)` means `[separated(x) [","]]` inside an explicitly written pair of delimiters. Empty bracketed lists are therefore possible. Trailing commas are allowed only inside `()`, `[]` or `{}`, not in an unbracketed attribute list or example row. An attribute named in the table below is present at most once per header. An omitted attribute is absent; it is not a syntactic assertion of a default.

## Tokens and layout

Source is UTF-8 with LF or CRLF line endings. A bare CR, malformed UTF-8, tab in indentation/code or backslash line continuation is an error. Tabs inside literal `#` prose or `##` content are prose, not indentation/code; `#=` path content and a description's inline translation suffix are syntax. JSON strings reject unescaped tabs and allow the escaped `\t` value. Outside strings, spaces separate tokens. Identifiers are case-sensitive ASCII:

```ebnf
NAME       = /[A-Za-z_][A-Za-z0-9_]*/ ;
INTEGER    = /[0-9]+/ ;
DECIMAL    = /[0-9]+\.[0-9]+/ ;
DURATION   = INTEGER ("ms" | "s" | "m" | "h" | "d") ;
BYTES      = INTEGER ("B" | "KiB" | "MiB" | "GiB") ;
STRING     = JSON double-quoted string ;
path       = NAME {"." NAME} ;
```

There are no single-quoted strings, literal physical newlines inside strings, source-interpolated strings, exponent-number literals or numeric separators. Message source/variant strings remain JSON STRING tokens; their ICU patterns are validated by a later compiler stage, never by general string scanning. Raw description prose has its separate marker rules below. A sign is an operator, never part of a numeric token. Strings obey JSON escapes, including `\u` escapes. Bounds, finite representation, Unicode scalar validity and unit overflow need validation beyond token recognition. A unit suffix must be adjacent to its integer; `5 m` is not a duration. Tokenization uses longest match, distinguishing `?.`, `??`, `->`, `==`, `!=`, `<=` and `>=` from their one-character prefixes. A numeric/unit token cannot consume an identifier prefix: `5minutes` is invalid, not `5m` followed by `inutes`.

All identifier-shaped words are `NAME` tokens. The parser assigns contextual roles as described below. Punctuation tokens are:

```text
( ) [ ] { } , . : ; = ! | + - * / % < > == != <= >= ?? ?. -> @
```

`/` is division in expressions and begins a route only in a route slot. Route segments have the additional lexical rule defined below. `#` is recognized only as a physical-line marker, outside strings. `@` is valid only as the contiguous `@{` message-variant marker following a source string or final description prose; it is not a general object annotation.

At delimiter depth zero, a physical newline ends a logical line. Open balanced `()`, `[]` or `{}` join physical lines; they do not introduce a block. Continuation indentation has no layout meaning. A mismatched closer or unclosed delimiter is an error. Tokens retain their original physical line and column even when joined.

On noncontinued source lines, a block increases the preceding header's indentation by exactly one space. Dedentation must return to an existing indentation level. The first top-level declaration starts at column zero. Blank lines and full-line comments emit no `INDENT`, `DEDENT` or statement. Their indentation does not open or close suites. A suite belongs to one compound header, not to a semicolon sequence.

### Descriptions and comments

After leading spaces, `##` is recognized before `#`. The rest of a `##` physical line is ignored. A `#` physical line records its raw text and indentation as pending description metadata. The prose marker consumes one optional following space; additional content is retained. Consecutive prose lines at the same column join with a newline; blank or `##` lines do not break attachment. One unescaped `@{...}` suffix may appear on the final prose line only, supplying variant strings for the complete joined description. Its marker is contiguous and the suffix consumes the remainder of that physical line, allowing trailing spaces only. Remove exactly one optional separating space immediately before the suffix; other prose whitespace is retained. A backslash immediately before `@{` quotes that marker and only that backslash is removed; other raw-prose backslashes remain literal. Bare prose is static literal metadata with the logical owner's source-language identity, not an implicitly interpolated ICU expression.

`#= path` instead records an actually reused static message reference; there is no space between the marker and equals. Its remainder must parse as one `path`, with no call or extra tokens. It must be the sole description line for that declaration, without prose or a second reference. `# = text` is ordinary prose. These rules apply inside joined schema braces too. Inline hash comments are invalid. Reference resolution and static zero-parameter description validation are semantic work.

The next nonblank/non-`##` source item must be an eligible declaration starting at the same physical column. Its `export` modifier, if present, starts at that column. An ineligible item, a different column, a description at another column or end of source before attachment is an error. A pending description does not skip guards or effects to find a later declaration.

Eligible items are apps, contexts, packages, imports, stored models, schema fields/signature parameters, contracts, events, roles, derived fields/functions, capabilities and their operation signatures, named messages, policies, invariants, unique constraints, locks, lifetimes, fixtures, CRUD declarations, scenarios, all presentation declarations except `require`, context resources/settings and migration declarations/directives. Presentation metadata can describe content, grouping, navigation and operation controls in their view context. Section markers `Given`, `When`, `Then`, execution introducers `do`, guards/effects, `if`, `else`, execution `for`, examples headers/rows and presentation `require` are ineligible. Required descriptions and whether an attached description is sufficiently informative are semantic checks.

For a multiline schema, field descriptions use the field's actual column:

```can
# Track work.
app Tasks
Given
 Todo {
  # The work to carry out.
  title:text trim,
  ## The comma and brace still delimit the schema.
  done:bool=false
 }
When
 crud Todo by=members fields=title,done
Then
```

The two spaces before `title` create no suite while `{` is open; they still determine metadata attachment.

## Contextual roles and header attributes

At declaration/statement start, choose among the productions permitted by the enclosing grammar using written syntax. Do not select a production from capitalization, an import lookup or a resolved type. For example, a named stored model has `NAME [in ...] [at=...] schema`, a derived field has `derive path : ...`, and a derived function has `derive path (...) : ...`. `event {...}` can be a model named `event`; `event NAME {...}` is an event declaration. `contract {...}` can be a model named `contract`; `contract NAME {...}` is a contract declaration. A recognized introducer must have its full production shape. Failure is not permission to ignore its remaining tokens.

Authored declaration, parameter and field names, type-path components, import members/aliases and names after `.` or `?.` accept contextual words. At expression-primary position, `true`, `false` and `null` are literals and `not` is the prefix operator; they cannot simultaneously be bare lexical references in that position. Infix `and`, `or`, `in` and `is` and query clause words act as syntax only after a complete left expression. A clause word can still be a primary name where an operand is required, or a member name after a dot. These exceptions do not globally reserve words such as `from`, `until`, `event`, `action`, `order` or `end`.

Header attributes have the following closed sets. Fixed syntax before the attributes is shown separately. `expr` means the value-expression production; `ordinary` excludes an unparenthesized query tail. `selectors` and `ordering` have their own productions below. Required attributes are marked **required**. Other listed attributes are optional. Attributes may occur in any order except query clauses, the fixed schedule `at`/`event` order and explicitly placed schema/parameter/derived-field labels. The scenario result annotation `-> type` may occur once among its header attributes. No other header admits that annotation. The table separates syntactic slots from subsequent value/type checks: an `expr` or `NAME` slot is not proof that its value has the required representation or belongs to the supported finite registry.

| Header/context | Fixed syntax | Allowed attributes or entries |
| --- | --- | --- |
| app | `app NAME` | `uses=[NAME,...]` for a composed app, `source=STRING`, `label=caption`; caption belongs to the implicit owner semantically |
| package | `package NAME` | `source=STRING`, `label=caption` |
| import | `use path {NAME [as NAME],...}` | `from=path`; must resolve to a deployment binding |
| preferences | `preferences schema` | `label=caption`; section caption; at most one unnamed nonempty schema per owner |
| model | `NAME [in (path or app)] schema` | `at=path` between ownership and schema, `label=caption` after schema |
| contract | `contract NAME schema` | `label=caption` after schema |
| role | `role NAME` | `label=caption` |
| derived field | `derive path:type=expr` | trailing `label=field_label_value` |
| field | `NAME:type` | one initializer `=expr` or `server=expr`, then `trim`, `unique`, `min=expr`, `max=expr`, optional trailing `label=field_label_value` |
| signature parameter | `NAME:type` | one optional `=expr` default, then optional `label=field_label_value` |
| policy | `policy path` | `read=expr` **required**, `where=expr`, `fields=selectors` |
| composite unique | `unique path` | `fields=selectors` **required**, `where=expr` |
| lock | `lock path` | `fields=selectors` **required**, `when=expr` |
| retain | `retain path` | `until=expr` **required** |
| capability | `capability NAME` | `version=expr` **required**; an integer interface version is required semantically |
| CRUD | `crud path` | `by=expr` **required**, `fields=selectors` **required**, `create_fields=selectors`, `when=expr`, `create=NAME`, `update=NAME`, `delete=NAME`; supported explicit modes are create/update `none` and delete `none`/`remove`; `label=crud_labels` is a closed enabled-operation caption map |
| user scenario | `scenario NAME parameters` | `by=expr` **required**, `read=true`, `scope=authority`, one `-> type` result annotation, `label=caption` |
| trusted scenario | `scenario NAME` | `on=source` **required**; no parameters, `by`, `read`, `scope` or result annotation |
| execution/mapper guard | `require expr` | `message=expr`; a literal text or message value is required semantically; presentation require has no attributes |
| send effect | `send ordinary values` | `when=ordinary`, followed by mandatory `as NAME` binding |
| schedule effect | `schedule expr` | `at=expr` **required**, `event=path values` **required** |
| scenario examples | `examples` | tables: named input bindings `NAME=expr`, `seed=expr`; sequences: only optional `seed=expr`; seed resolves to a fixture list |
| CRUD examples | `examples (create or update or delete)` | named input bindings `NAME=expr`, `seed=expr`; seed must resolve to a fixture list |
| page | `page route` | `title=expr` **required**, `data=expr`, `order=expr`, `group=expr`, `nav=NAME`, `poll=expr`, `refresh=path`; refresh names a canonical user mutation and requires poll; nav supports only none, order is a constant integer, poll is a constant duration from 1s through 1h; title/group must be static text or a context-free message value, data a pure read call |
| card | `card expr` | `layout=NAME`; supported values are stack/columns |
| details | `details expr` | `display=NAME`, `open=expr`; drawer is the sole display exception, open applies only to Collapse |
| tabs | `tabs [expr]` | none; leaf requires an enum preference selector, otherwise tab suites required |
| tab | `tab expr` | none; nonempty suite, directly inside tabs only |
| list | `list expr` | `columns=selectors`, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`, `display=NAME`; split is the sole display exception |
| table | `table expr` | `columns=selectors` **required**, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`, `display=NAME`; split is the sole display exception |
| board | `board expr` | `by=selectors` **required**, `columns=selectors`, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`; by must resolve to one enum field |
| calendar | `calendar expr` | `start=selectors` **required**, `end=selectors` **required**, `columns=selectors`, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`; each endpoint must resolve to one field |
| form | `form expr` | `arguments=values`, `fields=selectors`, `submit=expr`, `display=NAME`, `import=NAME`, `review=path`; inline is the supported display value, csv the sole import mode; review requires import=csv |
| edit | `edit` | `fields=selectors` |
| migration | `migration NAME` | `from=STRING` **required** |
| context theme | `theme` | at least one of `mode=NAME`, `accent=NAME`, `density=NAME`; mode must be system/light/dark, accent blue/green/purple, density comfortable/compact |
| context file policy | `files` | at least one of `types=STRING`, `max=expr`; max must be a positive byte quantity |
| context owner binding | `binding NAME DurableObject` | `key=path` **required** |
| context queue | `queue NAME` | `type=type` **required** |
| context cache | `cache KV` | `ttl=expr` **required**; a positive duration is required semantically |
| context analytics | `analytics NAME schema` | none |
| context locale | `locale` | `default=STRING` **required**; canonical BCP 47 value/difference validation is semantic |

Finite value lists in the table describe semantic alternatives; `/` within such a list is not part of the attribute spelling. Resource references, positive intervals, actual changes from pinned defaults, media-type allowlists, field-selector validity and context conflicts require semantic checks. There is no syntax for repeating unchanged `runtime`, `database D1`, `auth email password`, `teams`, R2 or the default theme setup. Queue/telemetry quotas and adapter implementation mappings belong to deployment contracts, not an unspecified attribute bag.

For an expression-valued header slot, a current-depth `NAME "="` after a complete expression begins the next attribute. Nested delimiters isolate their own named arguments/fields. The candidate attribute is checked against this table, so an unknown attribute is rejected rather than swallowed. A binding marker `as NAME`, the scenario `->` result marker, and a schema/value brace expected by that production also end the preceding slot. An operator requiring a right operand must obtain it before a boundary can terminate its expression.

An attribute value never crosses its enclosing comma, closing delimiter, semicolon, logical newline or dedent. Different token sequences `=` and `==` prevent assignment/attribute boundaries from splitting comparisons. A new attribute after a comma is not accepted: unbracketed selector-list commas belong to that list. Thus `fields=a,b when=predicate` is valid, and `fields=a,b, when=predicate` is invalid.

## Files, composition and sections

```ebnf
file_source     = {app_composed | app_implicit | package | migration} EOF ;
app_composed    = line("app" NAME app_attributes)
                  [context] {line(import {";" import})} ;
app_implicit    = line("app" NAME app_attributes) [context] {line(import {";" import})} sections ;
context         = "context" suite(context_items) ;
context_items   = leaf_lines(context_declaration) ;
context_declaration = "theme" attributes | "files" attributes | "locale" attributes
                    | "binding" NAME "DurableObject" attributes
                    | "queue" NAME attributes | "cache" "KV" attributes
                    | "analytics" NAME schema ;
package         = "package" NAME attributes suite(package_body) ;
app_attributes  = attributes with uses present for app_composed and absent for app_implicit ;
package_body    = {line(import {";" import})} sections ;
sections        = section_given section_when section_then ;
section_given   = line("Given") given_items ;
section_when    = line("When") when_items ;
section_then    = line("Then") then_items ;
then_items      = {then_item} ;
import          = "use" path "{" import_members "}" ["from" "=" path] ;
import_members  = separated(import_member) [","] ;
import_member   = NAME ["as" NAME] ;
deployment      = "deployment" "." NAME ;
```

The presence of `uses=` selects the composed-app production; its absence selects the implicit-app production without name/type lookup. App attributes follow the closed table and may occur in any order. In an explicit package, the three section markers are one space deeper than `package`, and their declarations are another space deeper. In an implicit app, section markers/imports are top-level and their declarations are one space deeper. Each section's items may be empty: no `INDENT` is required for an empty section. A nonempty section has exactly its declaration indentation, not arbitrary depth. `then_items` is empty or a sequence of the presentation declarations below.

`context` immediately follows the app it configures, ignoring blank/comment lines. Its suite is nonempty and contains only the context declarations in the table. Composition apps have no package body; their single-use descriptions are inline, and imports after their optional context must resolve to local message-only groups for actual static-description reuse. App/package source overrides belong to their own logical owner, including their attached descriptions; composing/importing does not retag another owner. Source language and context default locale have different roles. The parser does not resolve that restriction or grant visibility from `uses`. An implicit app requires the whole ordered section triple and ends at the next top-level app, package or migration, or EOF. A migration cannot terminate an incomplete triple. A package has only one triple. Imports precede `Given`; neither imports nor arbitrary top-level expressions occur within the sections. An empty import group is syntactically invalid. An empty `uses` group is a semantic error rather than an inferred dependency selection. Provider paths and bound `from` paths are parsed uniformly; checking must establish the canonical owning package and the supported deployment-binding form. A path is not permission to introduce a nested package namespace.

`export` is optional on stored models, contracts, events, roles, derived functions, capabilities, fixtures, user scenarios and named messages. It prefixes the declaration at its existing indentation. It is unavailable on imports, apps, packages, contexts, preferences, derived fields, trusted scenarios, CRUD, policies/rules, presentation, migrations or effects. Exported declaration visibility and whether a scenario is a legitimate user operation are checked after parsing.

Page title/group/attached-description metadata is static: any message arguments must be context-free constants. Page `require` expressions retain their existing pure-expression syntax, including legitimate data dependencies; no new navigation declaration or guard syntax is introduced. DESIGN §9 defines derived page admission versus local container gates, dependency-limited discovery, current eligibility and ordering. Descriptor generation/admission is semantic compiler/runtime work, not parser behavior.

## Types, schemas and signatures

```ebnf
type             = type_base ["[" "]"] ["?"] ;
type_base        = path {"|" path} | enum_type | action_type | delivery_type ;
enum_type        = "enum" "(" separated(NAME) [","] ")" ;
action_type      = "action" "(" separated(path) [","] ")" ;
delivery_type    = "delivery" "(" path ")" ;
field_type       = type ["!"] ;
schema           = "{" bracketed(field) "}" ;
field            = NAME ":" field_type [initializer] {field_modifier} [field_label_attribute] ;
initializer      = "=" expr | "server" "=" expr ;
field_modifier   = "trim" | "unique" | "min" "=" expr | "max" "=" expr ;
parameters       = "(" bracketed(parameter) ")" ;
parameter        = NAME ":" type ["=" expr] [field_label_attribute] ;
```

`enum(...)`, `action(...)` and `delivery(...)` are recognized by their exact call-shaped type production. A bare type path component named `enum`, `action` or `delivery` is not globally banned. Their atom forms are not union arms. Union `|` combines all named paths before array/container suffixes: `A|B[]?` means a nullable array of union values. There are no grouped types, repeated array suffixes or nullable-element spelling `T?[]`. A scalar may have `?` without an array. Enumerator/allowed-action lists are syntactically nonempty, and enum entries are unqualified names. Checking requires distinct values and valid canonical action targets. Union arms must resolve to the supported tagged named value types; primitive unions are not authorized by their syntactic path shape.

`delivery(path)` resolves exactly one bound capability operation or bound exported user operation, not a model or arbitrary string. Normal nullable/array suffix rules apply. Its read-only members, send result and protected association follow DESIGN §8.1; no production constructor is added. The current prototype does not recognize this type form.

The trailing field `!` is creation metadata, not a value-type operator. `text!`, `text?!`, `text[]?!` and repeated `!` are invalid; an explicitly written nonnullable array can use `text[]!`. A qualified field path whose representation is unresolved can be parsed with `!`, as in `items:Contract.rows!`; later checking must prove that the reused field is a nonnullable array. A required-array-input field cannot also have a default or server initializer. A syntax-only parser must not claim it knows an unresolved path's representation.

Suffixes act on the resolved value, including inherited field types. Applying `[]` to an already nullable value or array is forbidden. Applying `?` to an already nullable value is redundant and invalid. A reused nonnullable array may acquire container nullability or the field-only required marker, but not both. These rules prevent qualified field reuse from smuggling nested arrays or nullable elements into the subset. Reuse retains representation/nullability and normalization/value bounds, but never the old initializer, required-array-input marker, server ownership, uniqueness, scope or policy.

Fields may have one initializer and one occurrence of each modifier; initializers precede modifiers. A field default or bound is delimited by the next field modifier at current depth or the schema comma/closer. Bare `trim`/`unique` terminate the preceding complete value just as `min=`/`max=` do. Type checking determines compatible modifiers, default values, nullability and initialization obligations. Schema fields use colons and require commas, including between fields on joined physical lines. An optional `label=` follows its initializer/modifiers and delimits a preceding complete expression. A field description does not replace its comma.

Parameters have no field-only `!`, server initializer or field modifier list; their optional trailing `label=` follows any default. Their required/defaulted/nullable input behavior comes from their signature and DESIGN. Capability operation signatures use `NAME parameters "->" type`, pure functions parse `derive path parameters ":" type "=" expr`, and scenario signatures use the table's header attributes/result annotation. Checking must establish a valid owning function name for a parsed derive path; a path is not an automatic cross-package extension. Parameters and defaults must resolve and type-check; parameter spelling never infers a type.

## Expressions and values

The following productions are syntactic. Their apparent function/type paths require later resolution; constructors, functions and operation identities are not inferred from an attractive name.

```ebnf
expr           = ordinary [query_tail] ;
ordinary       = fallback ;
fallback       = disjunction ["??" fallback] ;
disjunction    = conjunction {"or" conjunction} ;
conjunction    = negation {"and" negation} ;
negation       = "not" negation | comparison ;
comparison     = additive [comparison_op additive] ;
comparison_op  = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "is" ;
additive       = multiplicative {("+" | "-") multiplicative} ;
multiplicative = unary {("*" | "/" | "%") unary} ;
unary          = "-" unary | postfix ;
postfix        = primary {"." NAME | "?." NAME | arguments} ;
primary        = INTEGER | DECIMAL | DURATION | BYTES | STRING [message_variants]
               | "true" | "false" | "null" | VALUE_NAME
               | "(" expr ")" | array | values | typed_value ;
array          = "[" bracketed(expr) "]" ;
values         = "{" bracketed(value_field) "}" ;
value_field    = NAME ["=" expr] ;
typed_value    = VALUE_NAME {"." NAME} values ;
VALUE_NAME     = NAME except "true", "false", "null", "not" ;
arguments      = "(" [positional ["," named_arguments] [","]
                      | named_arguments [","]] ")" ;
positional     = separated(expr) ;
named_arguments = separated(NAME "=" expr) ;
call_expr      = postfix with a final arguments suffix ;
```

The call-argument parser detects `NAME "="` at an argument's start before choosing a positional expression. Once that form occurs, remaining arguments must be named; duplicate names are invalid. Empty calls and a trailing comma after positional arguments are allowed. The displayed argument production is interpreted with this lookahead, so the positional list cannot consume a named argument as an expression. Assignment is absent from `expr`.

`path values` wins over a plain name/member expression when the path is immediately followed by `{` in an expression slot. It creates a typed structural value. In schema slots, `{` uses `field`; in value slots, `{` uses `value_field`; route slots use their separate production. `{field}` is shorthand for `{field=field}`. Colons are not a structural value spelling, and equals signs are not schema field separators.

No postfix indexing, optional calls, optional indexing, arbitrary JavaScript or assignment expression is present. A call suffix cannot follow a safe member suffix to form `receiver?.method(...)`; an ordinary call on a safe-access result also requires a compatible callable type, which v1 does not introduce. Array access uses `at(array,index)`. Safe access is read-only and cannot form a mutation target.

Binary arithmetic/boolean operators associate left; `??` associates right. Comparisons are nonassociative: `a<b<c` fails, including mixed chains such as `a==b in c`. `is` has this syntactic precedence but its right operand must resolve to the permitted type-test target. In each unparenthesized expression segment, mixing `??` with `and` or `or` is invalid. Parentheses and separate call arguments establish new segments. There is no implicit coercion/truthiness. Safe access, null narrowing, enum expectation and all operator types are semantic checks.

### Queries and scope

```ebnf
query_tail    = [archive_clause] [alias_clause] [where_clause]
                [order_clause] [select_clause] ;
archive_clause = "archived" "=" "include" ;
alias_clause  = "as" NAME ;
where_clause  = "where" ordinary ;
order_clause  = "order" "=" ordinary ;
select_clause = "select" ordinary ;
```

A tail contains at least one clause. Repetition, reordering and an incomplete clause are errors. An alias-only tail is valid. Domain parsing finishes its whole ordinary expression before attaching the low-binding tail. Thus `[from]+(Booking as b select b.from) as point` has an array-concatenation domain and an outer alias. A query result participating in larger arithmetic is parenthesized: `(Booking as b select b.amount)+other`.

Each clause parses ordinary operators until the next permitted query clause, enclosing delimiter or enclosing header boundary after a complete value. Nested queries occur through parenthesized expressions or call arguments. A clause cannot absorb a second unparenthesized query tail; `(selected as x where x.active) as item` makes the two extents explicit. A clause word used where an operand is expected remains that operand, and `.where`/`.select` are ordinary members.

Call commas are never ordering lists in a query. `sum(selected as expense select expense.amount,currency)` has two arguments. `order=` in a query contains one ordinary expression; `order=-item.created` preserves the signed ordering expression. In an unparenthesized presentation collection header, presentation attribute recognition wins over a query clause with the same `NAME=` spelling: `order=` is the UI selector list. To supply a computed query ordering within such a header, parenthesize that query. This distinction preserves `table row.Booking order=-priority,arrived columns=...` without changing call/example comma boundaries.

A query alias scopes over its following clauses, not backward into its domain and not into unrelated sibling expressions. `any(domain as x,predicate)`, `all(domain as x,predicate)` and `group(domain as x,keyExpr)` additionally make that first argument's alias visible in their second argument. Ordinary calls do not create that scope. A `for item in query` binds `item` to query results in its suite; the query's own alias remains separate. Presentation collection aliases remain visible in descendants alongside the enclosing row chain. These are fixed lexical scope rules, not name-based field lookup or privilege grants.

## Given declarations

```ebnf
given_items    = {line(given_leaf {";" given_leaf}) | ["export"] capability} ;
given_leaf     = preferences | ["export"] (model | contract | event | role | pure_function | fixture | message)
               | ordinary_given ;
ordinary_given = derive_field | policy | invariant | unique | lock | retain ;
preferences    = "preferences" schema attributes ;
model          = NAME ["in" (path | "app")] ["at" "=" path] schema [scalar_label_attribute] ;
contract       = "contract" NAME schema [scalar_label_attribute] ;
event          = "event" NAME schema ;
role           = "role" NAME [scalar_label_attribute] ;
derive_field   = "derive" path ":" type "=" expr [field_label_attribute] ;
pure_function  = "derive" path parameters ":" type "=" expr ;
policy         = "policy" path attributes ;
invariant      = "invariant" path ":" expr ;
unique         = "unique" path attributes ;
lock           = "lock" path attributes ;
retain         = "retain" path attributes ;
fixture        = "fixture" NAME "=" (path values | "file" values | "user" values) ;
capability     = "capability" NAME attributes suite(capability_items) ;
capability_items = leaf_lines(capability_leaf) ;
capability_leaf = NAME parameters "->" type | event ;
```

Here and below, `attributes` expands only the row for that header in the closed table; it is not a generic NAME/value bag. `given_items` consists of leaf lines and capability compounds. `capability_items` is a nonempty sequence of capability items. A field derive target must resolve to `Model.field`; syntactically its path need not be classified by length. A pure function is distinguished by its parameter parentheses. `invariant path: expr` is the sole Given invariant spelling; the former `require path: expr` is invalid. Its target path, colon, expression and `row` scope are unchanged. Execution/mapper guards and presentation gates retain `require`. Both words remain contextual names in name slots. `in team`, a role scope attribute, and arbitrary resource declarations in Given are invalid. `in app` is the explicit app scope; a model path denotes explicit containment. `at` and containment compatibility are semantic.

User-fixture recipes reuse the existing path/value-object syntax: `fixture NAME=user {roles=[ROLE,...]}` or `fixture NAME=user {}`. Only a static, duplicate-free list of `owner` and visible declared roles is valid; no other fields or dynamic values are accepted. Identity, active same-team membership, grants, dependency loading and caller selection follow DESIGN §5.1 and require semantic validation. File-fixture recipes reuse the value-object syntax. Their parsed fields must later validate as only `type=STRING` and `owner=(self|other|outsider|user_fixture)`; unknown recipe fields and inappropriate shorthand/value shapes are semantic errors. Duplicate object fields are syntactically invalid for every object. An empty recipe is valid. An operation-resolved fixture path provisions a typed delivery recipe with required complete `request={...}` and optional status/result/error; DESIGN §8.1 defines protected runtime identity, result consistency, same-owner association and finalized-file provenance. Resolution distinguishes this test-only operation recipe from ordinary model recipes. Other fixture objects use named/shorthand input fields and require ordinary model/constraint/fixture resolution. There is no production file constructor. Test-only fixture identities are not production globals.

Policy `fields` selector paths may descend only through the singular embedded value/receipt shapes specified in DESIGN §4. Leaf/prefix grants, derived dependencies and partial projection authority require checking; parsing a path does not grant record-relationship traversal or a whole containing value. No new selector spelling is introduced.

## Inline messages, labels and locales

```ebnf
message          = "message" NAME [message_parameters] "=" message_value ;
message_parameters = "(" separated(parameter) [","] ")" ;
message_value    = STRING message_variants ;
message_variants = "@" "{" [separated(message_variant) [","]] "}" ;
message_variant  = (NAME | STRING) "=" (STRING | "null") ;
caption          = STRING [message_variants] | path ;
scalar_label_attribute = "label" "=" caption ;
field_label_attribute = "label" "=" field_label_value ;
field_label_value = caption | "{" separated(field_label_entry) [","] "}" ;
field_label_entry = "text" "=" caption | "values" "=" case_labels ;
case_labels      = "{" separated(case_label) [","] "}" ;
case_label       = NAME "=" caption ;
crud_labels      = "{" separated(crud_label_entry) [","] "}" ;
crud_label_entry = ("create" | "update" | "delete") "=" caption ;
```

A named message is a Given leaf and may be individually exported; there is no locale-column container or `for` label-binding production. Its right side requires the explicit descriptor suffix, including `@{}` for a source-only asset. Models named `message` still select the model production when followed by schema/ownership shape. The `@{` marker is contiguous; ordinary spaces may separate a quoted source STRING from its suffix. Keys are simple language identifiers or quoted language tags such as `"pt-BR"`; strings/null are explicit variant/absence values. Empty suffixes and trailing commas inside braces are legal. Case-insensitive duplicate literal keys fail syntactically; BCP 47 canonical aliases, source-tag duplication and locale-data support require semantic checks. Message namespace collisions, parameter representations, patterns, variables, formatter compatibility and coverage require the checker.

Scalar `label=` slots parse only a literal source STRING with optional descriptor suffix, or a static path; calls and arbitrary expressions are invalid. Field/parameter/derived-field labels additionally admit the closed object with exactly `text=caption` and/or `values={case=caption,...}`, with at least one member and nonempty case entries. CRUD labels require a nonempty closed object containing only `create`, `update` and/or `delete` captions. Unknown keys and duplicate entries/case keys are structural errors. Resolving a path to a zero-parameter message, validating enum/bool case ownership, inherited overrides and enabled CRUD operations remain semantic checks; enum syntax is unchanged. Case keys are stable wire values, including `true`/`false` for bool. Declaration-local attributes replace target-path label lists, and equal complete captions may reference a shared message. No label changes machine identity or access.

`source=STRING` belongs to app/package headers, defaulting to `"en"` per logical owner. Its validation and annotation of owned assets/attached prose are semantic; imported or composed owners retain their own source language. `locale` is a normal type-path name whose canonical BCP 47 value rules come from DESIGN §9.1. Its context declaration uses `default=STRING` above and controls deployment fallback/viewer selection only.

Text caption/submit/empty/diagnostic slots parse expressions; checking accepts literal text or message values and rejects other results. No configuration-wide localization is implied. Message references and calls reuse expression grammar. Anonymous descriptor calls require a nonempty list of explicit named arguments, with types resolved from their expressions and every placeholder across variants explicitly bound; there is no implicit capture. Named messages use their declared typed signatures. The initial parser does not parse ICU internals, resolve pure message import closure, execute fallback/formatting, or certify translations.

## When declarations and execution

```ebnf
when_items      = {line(crud_head {";" crud_head}) | crud_head suite(crud_examples)
                  | user_scenario | trusted_scenario} ;
crud_head       = "crud" path attributes ;
user_scenario   = ["export"] "scenario" NAME parameters attributes suite(scenario_body) ;
trusted_scenario = "scenario" NAME attributes suite(scenario_body) ;
handler_source  = path | "every" "(" DURATION [","] ")" ;
scenario_body   = {guard_line} do_body {scenario_examples} ;
guard_line      = line(guard {";" guard}) ;
guard           = "require" expr ["message" "=" expr] ;
do_body         = "do" (line(effect_leaves) | suite(effect_body)) ;
effect_body     = {effect_line | conditional | loop} ;
effect_line     = line(effect_leaves) ;
effect_leaves   = effect_leaf {";" effect_leaf} ;
effect_leaf     = let | guard | create | set | delete | call | emit | send
                | schedule | cancel | return ;
let             = "let" NAME "=" expr ;
create          = "create" path values "as" NAME ;
set             = "set" mutation_target values ;
delete          = "delete" mutation_target ;
call            = "call" ordinary values ["as" NAME] ;
emit            = "emit" path values ;
send            = "send" ordinary values ["when" "=" ordinary] "as" NAME ;
schedule        = "schedule" expr "at" "=" expr "event" "=" path values ;
cancel          = "cancel" expr ;
return          = "return" expr ;
conditional     = "if" expr suite(effect_body) ["else" suite(effect_body)] ;
loop            = "for" NAME "in" expr "limit" "=" expr suite(effect_body) ;
mutation_target = path ;
```

The table's `on=source` slot uses `handler_source`. Each effect suite is nonempty. `else` occurs at the same indentation as its paired `if` immediately after that suite, ignoring blank/comments. No `else if` shortcut is introduced; write a nested `if` in the `else` suite. The mandatory `limit` slot parses an expression whose value must be a positive integer within the work budget. It is not a query clause. Loop query expressions end at `limit=`. Call/send targets parse ordinary expressions with unparenthesized typed construction disabled so their following argument object remains a distinct effect slot; later checking requires a valid operation/action reference. A delete path must resolve to a permitted mutable record target.

There is exactly one `do` per scenario. `let` before `do` is invalid. Leading guards and statements inside `do` retain written order. Attached examples come after execution and cannot be effects. An inline `do` admits only semicolon-separated simple effects; `if` and `for` require indented suites. A single inline effect cannot receive a child suite. `set` and `delete` have path targets; invocation targets have their separate ordinary-expression slots above. Parsing a path/expression never establishes a writable record or authority-bearing operation. Safe access remains a read-only expression rather than writable field access. Record ownership/mutability and special `event.after` behavior require checks.

User scenarios require parameter parentheses even when empty and a `by` expression. Trusted scenarios have no authored parameters and use `on=source`; `by` and `on` cannot coexist. Capability/CRUD sources and `.completed` suffixes are parsed as paths, then validated against the finite source registry. Read return requirements, permissible read effects, synchronous call cycles, remote/local targets and all authority rules remain semantic work.

Leaf declarations in Given/context, import lines, named messages, leaf presentation items and migration directives can also use a `leaf {";" leaf}` logical line within their own enclosing category. Every member must be valid in that category and consume its entire syntax. A compound declaration/header or any item receiving a child suite must occupy its logical line alone. Empty entries, a trailing semicolon and mixed declaration/effect categories are errors. Section markers, apps, contexts, packages, scenarios, pages, capability headers, conditional/loop headers, examples and backfill headers are not semicolon leaves. A CRUD with attached examples is compound; a CRUD without them is a leaf.

## Inline behavior examples

```ebnf
scenario_examples = "examples" (example_bindings suite(example_table)
                  | ["seed" "=" expr] suite(example_sequence)) ;
crud_examples     = {"examples" crud_action example_bindings suite(example_table)} ;
crud_action       = "create" | "update" | "delete" ;
example_bindings  = {NAME "=" expr} ;
example_table     = line(observations "->" observations) example_row {example_row} ;
observations      = separated(expr) ;
example_row       = line(separated(expr) "->" (separated(expr) | expected_error)) ;
expected_error    = call_expr with bare callee "error" and exactly one argument ;
example_sequence  = "do" suite(example_step {example_step}) ;
example_step      = line(let | example_call | example_assertion) ;
example_call      = "call" ordinary values "by" "=" example_caller
                    ["request" "=" values] ["as" NAME] ["->" expected_error] ;
example_caller    = path ;
example_assertion = observations "->" observations ;
```

In the table form, the first child line is a header, and at least one row follows it. Both sides are nonempty. `->` at current delimiter depth divides header/row sides; commas divide columns only outside brackets/braces/calls. A sole `error(code)` on the expected side is recognized as a rejection expectation and replaces the whole expected row; it cannot be combined with expected observation cells. Other calls/expressions are parsed normally and validated in test scope. Neither a header nor a row admits semicolons or a child suite.

Common bindings use the operation's input names, including `event` for a trusted handler, and may include the special `seed` list. Duplicate input/seed bindings are invalid. Both header sides parse expression lists; checking must establish that the left expressions are permitted input-selector paths. `as`, `request.*`, record-fixture fields and generated CRUD input selectors acquire their specified test meaning during validation. Caller-role arrays, fixture names and deterministic account names are ordinary expression shapes with test-only resolution. `as` can select a named user fixture or explicit `self`/`other`; identity values cannot occur inside caller-role arrays, and user recipe attributes are not editable selectors. Header/row arity and the whole-row single-argument `error(...)` shape are checked structurally. Valid input selectors, fixture setup validity, observation types, exact error-code values and production behavior are not established by parsing.

A scenario-attached sequence starts with a sole `do` child instead of a table header and accepts only `seed` on its examples header. It is available on user scenarios, not trusted handlers or CRUD declarations; calls inside it may name enabled generated CRUD operations. At least one explicit call must resolve to the enclosing scenario and at least one assertion or expected-error call must exist. There is no implicit invocation. `example_caller` must resolve to self/other/outsider/public or a user fixture, never a role expression/array; role grants stay fixed during a sequence. `request` is the existing envelope-override meaning in value-object form. `as` requires an actual declared typed operation result and is forbidden together with an expected error. The sequence body has no other effects or control flow. Observation tuples have matching nonzero arity; `condition -> true` permits the ordinary true-branch narrowing after the assertion. Name resolution, stored-snapshot setup validation, per-step admission/rollback and error codes follow DESIGN §5.1. Domain server fields can be explicitly initialized in fixtures; reserved metadata cannot. These sequence productions are a proposed grammar extension; the initial parser currently supports fixture shapes and tables only. No parser acceptance or BDD execution is claimed for a sequence witness.

## Presentation and routes

```ebnf
then_item      = page ;
page           = "page" route attributes optional_suite(ui_body) ;
ui_body        = {ui_item} ;
ui_item        = line(ui_leaves) | ui_group | collection | form | tabs_group ;
ui_leaves      = ui_leaf {";" ui_leaf} ;
ui_leaf        = "require" expr | "title" expr | "text" observations | "content" observations
               | "metrics" observations | "copy" expr | "edit" attributes
               | "delete" | "action" expr | "actions" separated(expr) | "history"
               | collection_header | form_header | "tabs" expr ;
ui_group       = "card" expr attributes suite(ui_body)
               | "details" expr attributes suite(ui_body) ;
tabs_group     = "tabs" [expr] suite(tab_items) ;
tab_items      = {"tab" expr suite(ui_body)} ;
collection     = collection_header suite(ui_body) ;
collection_header = collection_head expr attributes ;
collection_head = "list" | "table" | "board" | "calendar" ;
form           = form_header suite(ui_body) ;
form_header    = "form" expr attributes ;
selector       = path ;
selectors      = separated(["-"] selector) ;
ordering       = selectors ;
ui_order       = ordering | preference_order ;
preference_order = "{" separated(preference_order_member) [","] "}" ;
preference_order_member = "by" "=" path
                        | "default" "=" "[" ordering [","] "]"
                        | "cases" "=" "{" separated(order_case) [","] "}" ;
order_case     = NAME "=" "[" ordering [","] "]" ;
route          = "/" [route_segment {"/" route_segment}] ;
route_segment  = STATIC_SEGMENT | "{" path "." "id" "}"
               | "{" NAME ":" type "}" ;
STATIC_SEGMENT = /[A-Za-z0-9_-]+/ ;
```

Presentation suites are nonempty when present. A bare list/table/form remains valid without descendants. Top-level Then accepts pages, not arbitrary effects, authored navigation trees or free-standing business handlers. Within pages, `card`/`details` are scope-transparent groups; collections bind `row` and retain the enclosing record chain. A read form's result is scoped to its descendants; page `data` provides page-level result. The grammar does not infer a current record from a model name.

The record route production splits the final `.id` from the path and requires at least one preceding type-name component. The scalar route production declares a named typed parameter. Every route, including typed braces, must be contiguous on one physical line; joined delimiter lines or spaces within the route are invalid. Its static pieces must also satisfy the lexical token rules above. Route braces admit neither structural values nor arbitrary expressions. `/x/{id}`, optional segments, consecutive slash segments, query strings and trailing slash segments other than root `/` are not in this spelling. Whether a scalar route type is supported, a record route names a model, a data call is a pure read, a selector matches the current row, or two normalized route shapes conflict is checked after parsing. Static/dynamic routing behavior and authorization come from DESIGN.

The parsed expression in `form`/`action` must resolve to a canonical operation or typed action value, including `row.action`; it is not a schema copied into the UI. Selector attributes parse optionally signed paths, with sign/arity/schema suitability checked against their attribute purpose. Their ordering list is distinct from expression-query ordering. Both standalone `title` and page `title=` accept expressions; checking requires text/message results. Text/content/metrics accept comma-delimited expressions. Card/detail headings and link labels parse expressions and require appropriate typed text/message values later. No arbitrary HTML, CSS, chart, fragment, named render, drag/drop or visual-editor syntax is introduced. Page `poll` is an authorized GET reread only; it never invokes mutations or refreshes external source data. Preference ordering requires exactly `by`, `default`, `cases`, each once, an owned enum preference, nonempty selector lists, known distinct cases and only overrides differing from the default. All alternatives use the same schema/grant checks; omitted cases use the authored default. Page navigation `order` and expression-query ordering are unchanged. The syntax prototype has not yet implemented these two draft extensions.

## Maintenance declarations

```ebnf
migration       = "migration" NAME attributes optional_suite(migration_items) ;
migration_items = {migration_item} ;
migration_item  = line(migration_leaves) | backfill ;
migration_leaves = migration_leaf {";" migration_leaf} ;
migration_leaf  = "rename" "owner" | "drop" "owner"
                | "rename" before_path "to" path
                | "drop" before_path | "invalidate" before_path ;
before_path    = "before" "." NAME ["." NAME] ;
backfill       = "backfill" NAME suite(mapper_body) ;
mapper_body    = {guard_line} mapper_do ;
mapper_do      = "do" (line(mapper_leaves) | suite(mapper_effects)) ;
mapper_effects = {line(mapper_leaves) | mapper_conditional} ;
mapper_leaves  = mapper_leaf {";" mapper_leaf} ;
mapper_leaf    = let | guard | "set" "row" values ;
mapper_conditional = "if" expr suite(mapper_effects)
                     ["else" suite(mapper_effects)] ;
```

Each migration is top-level, outside package sections, with a required string predecessor snapshot. `rename before.Model to Model` uses model paths, and field rename/drop uses exactly an old model/field pair; target path shape must match the directive kind. `invalidate` accepts exactly `before.handler`, not a field path. Owner rename/drop has no additional target token. Backfill names a desired model; logical-owner names, directive targets and predecessor identities require resolution. Structural directives describe mappings independent of their textual placement; the full mapping is established before executing any mapper. A standalone migration header can acknowledge a constraint-only transition without inventing a no-op directive. Its body, when present, is nonempty; omitting row directives never authorizes undeclared removals or inferred renames.

Mapper `before` is the pinned old row and `row` the partially initialized desired row. The mapper reuses expressions, leading guards, one do body, lets, conditional suites and `set row`. It has no for/create/delete/call/emit/send/schedule/cancel/return production. Pure expression parsing alone does not authorize queries, record dereferencing, actor/clock/random access or provider calls in a mapper; a checker must reject those dependencies. Complete initialization, old locks, identity/field mapping, desired constraints, installed snapshot matching, queued-work compatibility and actual migration application remain semantic/runtime work.

## Verification boundary

This grammar establishes source structure and rejects unsupported spelling. A syntax AST parser must retain physical start locations and parse every accepted token into structure, including examples and fields, and report the file, physical line, column and expectation for failures. Complete AST end spans are additional implementation work, not implied by a start location. Testing the current source corpus alone cannot exercise absent features such as semicolon sequences, unions, field descriptions, richer contexts and maintenance declarations. Syntax coverage neither supplies a type checker/runtime nor proves the design's business requirements. Compiler-derived schemas, interfaces, indexes and deployment plans do not require authored manifests or additional source primitives.

## Personal configuration and presentation boundaries

Given `preferences {fields}` is selected before the same-shaped model production. It is the sole unnamed extension declaration; `preferences Name {fields}` and exports are errors. A field called preferences remains legal. Empty and duplicate owner schemas are rejected syntactically; allowed field types, constant defaults, preference invariants and presentation-only dependency checks are semantic, as defined in DESIGN §9.

Then accepts only pages. Authored nav/link trees are removed; navigation derives from eligible pages with page-local exceptions. Grouping retains scope. Collection defaults use the existing values-object production, never a new query or permission grammar. Typed filter matching and display values require semantic checks. The parser rejects details with both display and open, since open is only for default Collapse.

`tabs [expr]` may have `tab expr` child suites; only direct tab children are allowed. A selector-free tabs header requires suites. Each tab requires a nonempty normal presentation body. A selector-backed leaf is allowed. Semantic resolution requires an owned enum preference selector and, in its block form, every exact distinct case once. Unbound tab captions must resolve to text/messages. Types do not choose the syntactic production.

Declaration-local `label=` and inline `@{...}` descriptors follow the closed forms above. Parsing their shape does not validate captions, inherited assets, source-language ownership or locale coverage.

## Semantic refinement boundary

DESIGN §3 defines lexical binding before enum-case expectation, protected active contextual facts, permitted nested authored shadowing, left-to-right signature defaults, and the finite numeric/builtin signatures. These are checking rules, not parser guesses. Defaults may reference earlier inputs, never later inputs or body locals. §5.1 rejects overlapping example selector paths and fixture aliases, resolves cells against untouched seeded state, and keeps common bindings as the override baseline. Trusted leading and body `require` share rejection semantics. §6 infers independent D1 team/app recurring scopes; root-bound ticks are unsupported in v1. §8 specifies receiver-finalized typed file results without additional source syntax. §9 defines datetime inputs, finite filters and safe instance labels as shared behavior. A parsed tree alone cannot establish any of these semantic contracts.

The §8 host/browser upload bridge and §10 opaque MCP file slots derive from the existing `file` type and canonical operation schemas. They add no `.can` upload declaration, file literal, provider DTO or alternate business invocation syntax; their wire/authorization contract is generated runtime behavior.

Declared team-role subject checks reuse `call_expr`: a resolved role callee accepts exactly one nonnull user expression and returns bool in the verified team context. Normal lexical/import resolution applies. A bare role remains the literal-actor predicate; an explicit `role(actor)` is redundant. This semantic call form creates no first-class function or role-value type, and does not authenticate or impersonate its subject. See DESIGN §4.

CSV form import uses existing attribute grammar with `import=csv` and optional `review=path`. The target must be a canonical mutation and the review a pure model-array read with compatible named input bindings. No new effect, batch scenario or form-input expression scope is added. `app_url` is a closed typed builtin using ordinary call syntax. The unchanged syntax prototype does not yet accept the new form attributes; this is a recorded prototype boundary, not alternate source spelling.

A page refresh attribute names a canonical operation, not an arbitrary expression, callback or source URL. Semantic checks require an existing same-page form, no record parameters, and the active-session invocation contract in DESIGN §9. Representation polling stays GET-only. The syntax prototype has not yet implemented this page attribute.

Retention keeps the existing `retain path until=expr` production. The expression may yield `datetime?` as specified in DESIGN §7.1; null adds no independent deadline and never cancels a finite ancestor lifetime. This is semantic typing, not a new condition attribute or ternary expression.

Derived model-field labels reuse the ordinary caption/value map. Values must belong to the resolved enum/bool type (after nullable unwrapping); null keeps shared unavailable/not-requested presentation, never an invented enum case. This conveys presentation only, not defaults, initialization or authority. Other declaration labels stay scalar. The current syntax prototype still rejects a structured derived-field label; this semantic/grammar draft extension is not parser implementation.
