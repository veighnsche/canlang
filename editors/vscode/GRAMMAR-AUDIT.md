# Current draft grammar → highlighting audit

This inventory records the earlier audit baseline; its gap descriptions and source counts are historical. The corrections and settled grammar hash for extension 0.1.5 are recorded separately in [AUDIT-RESOLUTION.md](AUDIT-RESOLUTION.md). The completed independent audit is preserved in pinned Git history; [AUDIT-RESOLUTION.md](AUDIT-RESOLUTION.md#recover-the-historical-audit) records recovery and evidence limits.

Audit inputs: this repository's complete `GRAMMAR.md`, DESIGN source/composition, type/value, permissions, operations/examples, context/integration, presentation/i18n, maintenance and semantic-refinement sections; all 44 `.can` files under `draft/` and `examples/`; and `syntaxes/can.tmLanguage.json`. No old sibling checkout semantics are used.

This is an inventory and inspection baseline. The main implementation is reconciling TextMate patterns concurrently; entries below describe the inspected baseline, **not a claim that final highlighting fixes have landed**. Final mapping and token-scope checks remain the main agent's reconciliation responsibility. Scope names abbreviate the `.can` suffix. TextMate coloring is not syntax acceptance, semantic validation, compilation or execution.

## Lexical/layout inventory and mapping

| Construct | Complete inventory / boundaries | Inspected pattern → scope |
| --- | --- | --- |
| Names and paths | ASCII `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive; `.` qualification | declaration/name matches; fallback `variable.other.readwrite`; dot captures `punctuation.accessor` + `variable.other.property` |
| Numeric literals | integer, decimal; adjacent integer duration `ms s m h d`; bytes `B KiB MiB GiB`; signs separate; no exponents/separators | numeric/unit patterns → `constant.numeric` / `constant.numeric.unit` |
| Strings | JSON double quotes only; escapes `\" \\ \/ \b \f \n \r \t \uXXXX`; no interpolation or physical multiline | `#string` → `string.quoted.double`, escapes → `constant.character.escape`; ICU is string content, not expression syntax |
| Description/comment markers | full physical-line `##` ignored comment; `#` attached raw metadata; `#=` static message path; `\@{` quotes prose suffix marker | `#markers` → `comment.line.number-sign`, `string.unquoted.description`, `meta.description.reference`, marker `punctuation.definition.description`; referenced message `entity.name.constant.message` |
| Message variants | contiguous `@{`, source string/prose suffix; NAME or quoted locale keys; STRING or null values; comma-separated, optional trailing comma | `#variants` → `meta.message.variants`, marker `punctuation.definition.message`, unquoted keys `entity.other.attribute-name.locale`; quoted keys remain strings |
| Punctuation | `( ) [ ] { } , . : ; = ! | + - * / % < > == != <= >= ?? ?. -> @` | `#punctuation` → `keyword.operator` and `punctuation.separator`; object braces have `punctuation.section.braces.begin/end`; `@` only covered in variants |
| Layout | LF/CRLF; newline ends depth-zero logical line; balanced delimiters join lines; one-space suites; dedent to prior level; blanks/comments inert; EOF supplies final newline | anchors and delimiter states approximate layout; TextMate does not enforce indentation, category membership, attachment, balance or semicolon legality |
| Semicolon | only category-compatible leaves; no empty/trailing member, no compound header or suite on a sequence | statement-start alternatives recognize `(?<=;)`; punctuation scope only, no parser-level legality |
| Routes | root `/`; static `[A-Za-z0-9_-]+`; `{path.id}` and `{NAME:type}`; contiguous physical line only | page route → `string.unquoted.route`; baseline route character class permits `?` and cannot classify dynamic type/member slots |
| Type suffixes | named union `|`, one `[]`, optional container `?`, field-only `!`; enum/action nonempty call-shaped atoms | `#type` → `meta.type`, paths `entity.name.type`, enum/action `storage.type`, suffixes `storage.modifier.type`; only colon starts baseline type state |

## Context-sensitive names and syntax

All word-shaped tokens are lexical NAMEs. Introducers need their whole production shape in their enclosing category. A model may be called `event`, `contract` or `message` when followed by model ownership/schema shape. `preferences {…}` is the unnamed preferences declaration, not a model; `preferences Name {…}` is invalid. `derive path:type=…` and `derive path(parameters):type=…` are distinct declarations.

Authored declaration/parameter/field names, type path components, import members/aliases and members after `.`/`?.` may spell contextual words. `true false null` are literals and `not` prefix syntax only at expression-primary positions; these spellings remain legal in name slots. `and or in is`, plus query `archived as where order select`, become syntax only after a complete left expression. An operand can be named `where`/`select`/`from`/`until`/`end`; member names do not become operators. Global word matching cannot reproduce this boundary.

| Contextual family | Exact words/roles | Baseline mapping and limitation |
| --- | --- | --- |
| Top-level / sections | `app package context migration Given When Then` | `#statements` declaration/section captures; enclosing categories are not tracked |
| Visibility/import/composition | `export use as from uses deployment` | export/import captures; `as` approximated as query binding, `from/uses` generic `NAME=` keys; deployment ordinary path |
| Given declarations | `preferences contract event role derive policy require unique lock retain fixture capability message` | statement captures; invariant `require path:` collides with universal colon-type state |
| Type/schema slots | `enum action server trim unique min max label` | enum/action recognized inside type; `server/min/max/label` generic keys; bare trim/unique currently ordinary names; field label objects reuse object patterns |
| Query/expression | `not and or in is archived include as where order select true false null` | word/query regexes, generic assignment keys and literal regexes; archived/include not specialized; fallback flags legal contextual-name cases |
| Operation/body | `crud scenario require do let create set delete call emit send schedule cancel return if else for in limit as every` | statements/effects and let/for captures; effect `as` conflated with query as; inline `do let` lacks binding capture |
| Examples | `examples create update delete seed as request result error self other outsider` | examples keyword and generic identifiers/keys/call scope; account/request/result/error meanings are test-only semantic resolution |
| Presentation | `page card details tabs tab list table board calendar form require title text content metrics copy edit delete action actions history` | control/declaration captures; model-shaped lookahead may win over another contextual heading with brace-shaped operand |
| Maintenance | `migration rename drop invalidate backfill owner before to row require do let if else set` | directive introducers are control; before/owner/to generic identifiers, mapper is not a separate highlighting category |
| Context resources | `theme files locale binding DurableObject queue cache KV analytics` | context words control, resource type/name positions mostly generic identifiers |

Attribute boundaries occur only at current depth after a complete value; `NAME =` starts a checked next header attribute, `==` does not. Nested named arguments/fields isolate boundaries. `as NAME`, scenario `-> type`, and an expected schema/value brace also terminate applicable slots. Query clauses have fixed order `archived=include`, `as`, `where`, `order=`, `select`. A presentation `order=` slot wins over the same-spelled unparenthesized query clause; parenthesize a computed query. These require parser context, not a global attribute allowlist.

## Full closed header sets

The table below is copied from the current normative grammar to preserve every header and slot without inventing attributes. Its finite registries and required semantic representations are not proof of highlighting correctness. Baseline `NAME=` uses `variable.other.property.key` + `keyword.operator.assignment` for all these slots; the value is scanned with generic expression/type/object patterns. No baseline rule enforces the per-header sets.

| Header/context | Fixed syntax | Allowed attributes or entries |
| --- | --- | --- |
| app | `app NAME` | `uses=[NAME,...]` for a composed app, `source=STRING`, `label=caption`; caption belongs to the implicit owner semantically |
| package | `package NAME` | `source=STRING`, `label=caption` |
| import | `use path {NAME [as NAME],...}` | `from=path`; must resolve to a deployment binding |
| preferences | `preferences schema` | `label=caption`; section caption; at most one unnamed nonempty schema per owner |
| model | `NAME [in (path or app)] schema` | `at=path` between ownership and schema, `label=caption` after schema |
| contract | `contract NAME schema` | `label=caption` after schema |
| role | `role NAME` | `label=caption` |
| derived field | `derive path:type=expr` | trailing `label=caption` |
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
| scenario examples | `examples` | named input bindings `NAME=expr`, `seed=expr`; seed must resolve to a fixture list |
| CRUD examples | `examples (create or update or delete)` | named input bindings `NAME=expr`, `seed=expr`; seed must resolve to a fixture list |
| page | `page route` | `title=expr` **required**, `data=expr`, `order=expr`, `group=expr`, `nav=NAME`, `poll=expr`, `refresh=path`; refresh names a canonical user mutation and requires poll; nav supports only none, order is a constant integer, poll is a constant duration from 1s through 1h; title must be literal text or a message value, data a pure read call |
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

## Complete EBNF production inventory

Names below include every production defined in every EBNF block, grouped by its grammar section. `line`, `suite`, `optional_suite`, `leaf_lines`, `separated`, `bracketed` are notation helpers, not source keywords; `attributes` is expansion through the closed table above. NEWLINE/INDENT/DEDENT/EOF are layout tokens.

| Family | Productions | TextMate repository mapping |
| --- | --- | --- |
| Tokens and layout | `NAME`, `INTEGER`, `DECIMAL`, `DURATION`, `BYTES`, `STRING`, `path` | `#markers/string/punctuation/code` |
| Files, composition and sections | `file_source`, `app_composed`, `app_implicit`, `context`, `context_items`, `context_declaration`, `package`, `app_attributes`, `package_body`, `sections`, `section_given`, `section_when`, `section_then`, `then_items`, `import`, `import_members`, `import_member`, `deployment` | `#statements/object/code` |
| Types, schemas and signatures | `type`, `type_base`, `enum_type`, `action_type`, `field_type`, `schema`, `field`, `initializer`, `field_modifier`, `parameters`, `parameter` | `#type/object/code` |
| Expressions and values | `expr`, `ordinary`, `fallback`, `disjunction`, `conjunction`, `negation`, `comparison`, `comparison_op`, `additive`, `multiplicative`, `unary`, `postfix`, `primary`, `array`, `values`, `value_field`, `typed_value`, `VALUE_NAME`, `arguments`, `positional`, `named_arguments`, `call_expr` | `#code/object/string/punctuation` |
| Queries and scope | `query_tail`, `archive_clause`, `alias_clause`, `where_clause`, `order_clause`, `select_clause` | `#code query/operator captures` |
| Given declarations | `given_items`, `given_leaf`, `ordinary_given`, `preferences`, `model`, `contract`, `event`, `role`, `derive_field`, `pure_function`, `policy`, `invariant`, `unique`, `lock`, `retain`, `fixture`, `capability`, `capability_items`, `capability_leaf` | `#statements/type/object/code` |
| Inline messages, labels and locales | `message`, `message_parameters`, `message_value`, `message_variants`, `message_variant`, `caption`, `scalar_label_attribute`, `field_label_attribute`, `field_label_value`, `field_label_entry`, `case_labels`, `case_label`, `crud_labels`, `crud_label_entry` | `#statements/variants/string/object/code` |
| When declarations and execution | `when_items`, `crud_head`, `user_scenario`, `trusted_scenario`, `handler_source`, `scenario_body`, `guard_line`, `guard`, `do_body`, `effect_body`, `effect_line`, `effect_leaves`, `effect_leaf`, `let`, `create`, `set`, `delete`, `call`, `emit`, `send`, `schedule`, `cancel`, `return`, `conditional`, `loop`, `mutation_target` | `#statements/code` |
| Inline behavior examples | `scenario_examples`, `crud_examples`, `crud_action`, `example_bindings`, `example_table`, `observations`, `example_row`, `expected_error` | `#statements/code/punctuation` |
| Presentation and routes | `then_item`, `page`, `ui_body`, `ui_item`, `ui_leaves`, `ui_leaf`, `ui_group`, `tabs_group`, `tab_items`, `collection`, `collection_header`, `collection_head`, `form`, `form_header`, `selector`, `selectors`, `ordering`, `ui_order`, `preference_order`, `preference_order_member`, `order_case`, `route`, `route_segment`, `STATIC_SEGMENT` | `#statements/code/object` |
| Maintenance declarations | `migration`, `migration_items`, `migration_item`, `migration_leaves`, `migration_leaf`, `before_path`, `backfill`, `mapper_body`, `mapper_do`, `mapper_effects`, `mapper_leaves`, `mapper_leaf`, `mapper_conditional` | `#statements/code/object` |

Inventory completeness check: **168 production definitions** (including lexical tokens and `path`), with no omitted or extra production names relative to the normative EBNF blocks. This is documentation enumeration, not parser/highlighter verification.

## Boundaries and DESIGN additions

Builtin call spelling is ordinary `call_expr`; do not globally reserve or guess types from a callable's name. DESIGN §3's complete closed catalog is `count sum min max any all first group at abs round lower upper trim contains starts_with join format app_url active_member overlaps local_date local_instant add_days add_months date_year weekday dates money date datetime action random_secret`. `every(DURATION)` is a trusted handler-source production, not a general builtin. A declared team-role subject predicate reuses ordinary call syntax. Primitive/type/resource names such as `text`, `int`, `money`, `file`, `locale`, `Team`, `DurableObject` and `KV` gain meaning by resolution in a type/resource slot. `file {}` is a fixture-only recipe; there is no production file constructor. Builtin names may not be replaced by package declarations, but authored local shadowing is checked semantically. The baseline gives all calls `entity.name.function.call`; it cannot infer builtin/role/operation identity.

| Current addition / constraint | Authored syntax and highlighting family | Prototype/semantic boundary |
| --- | --- | --- |
| Personal preferences / tabs | `preferences schema`; tabs leaf, selector-backed/unbound block and direct tab suites; defaults value object | allowed types/defaults, enum ownership, exact case coverage and preference storage require checking/runtime |
| Preference ordering | UI `order={by=preferences.enumField,default=[selectors],cases={case=[selectors]}}` | signed symbolic selectors, not expression arrays; unchanged parser lacks this extension |
| Page polling / refresh | `poll=expr refresh=path` | constant 1s–1h and same-page canonical form contract; unchanged parser lacks these draft attributes |
| CSV intake / review | form `import=csv review=path` | canonical mutation/read compatibility; unchanged parser lacks form import/review attributes; filter/export transport operators add no source keywords |
| Localization | source/label/context locale, message descriptor, static description reference, caption/case/CRUD label objects | initial parser recognizes shapes; ICU internals, owner/asset resolution, signatures, language tags/fallback/provenance and storage remain unimplemented |
| Semantic refinements | lexical-before-enum binding, earlier-parameter defaults, example override conflicts, role(subject), inferred recurring scopes, finalized service file result | no new lexical grammar; identifier coloring cannot establish these contracts |
| Generated datetime/filter/instance labels | ordinary existing declarations, schemas and selectors | shared UI/typed wire behavior; `eq/ne/lt/lte/gt/gte/between/is_null/not_null` are generated transport operators, not new `.can` expression operators |
| Maintenance | existing migration/directive/mapper grammar | installed snapshot matching, complete mapping/initialization, locks and actual migration are absent runtime/checker work |

Parser statements above report documented prototype gaps, not a newly executed parser result. Neither a highlighted file nor a successful syntax tree proves the compiler/runtime exists or app workflows are executable.

## Prioritized inspected highlighting gaps

| Priority | Concrete baseline pattern failure / weak mapping | Reconciliation target |
| --- | --- | --- |
| High | Universal `#type` begins at any colon. `require WeeklyHours: row.opens<row.closes` (`draft/CanBook.can:35`) enters `meta.type` for the invariant predicate; type-entry is not a universal colon rule. | Separate invariant `:` from field/parameter/function/route type slots; preserve expression member scopes. |
| High | Only colon starts type state. Capability `settle(...) -> CommissionResult` and scenario result `-> Report` lack result-type context and type union/suffix scope. | Enter the same bounded type scanner from both signature/result markers; query/example arrows must keep expression sides. |
| High | Global `not` and literal matches color legal import/shorthand/declaration-name spellings as syntax outside expression-primary context. A boolean case key `true=` is correctly captured as a key before literals, but import `{true}` is not protected. | Contextual name positions win over word operators/literals; operand/member exceptions need focused token checks beyond corpus. |
| High | Statement rules run inside generic brace contents. A physical continuation line `theme {…}` in an expression may be classified as a model, and `context {…}` as a declaration; shape/context are not separated. | Delimiter and declaration category states should keep value names distinct from statement introducers. |
| Medium | Inline `do let answer=...` receives effect scope for let but the let-name rule only accepts line/semicolon starts. Inline `do`'s `answer` becomes a property assignment key. | Reuse binding capture for inline do effects. |
| Medium | `server=` gets generic assignment-key scope; bare field `trim`/`unique`, model `in`, import `as`, migration `to`/`owner` and query `archived=include` lack their contextual syntax scopes. | Color finite modifiers and separators in their owning contexts without globally reserving names. |
| Medium | Page route regex accepts `?` and colors scalar type/record `.id` uniformly as route text. Route slot grammar is stricter and accepts named unions/suffixes in type syntax. | Bound route recognition to complete contiguous valid route shapes, add captures where useful; highlighting need not diagnose every malformed route. |
| Medium | `derive` gives both fields and functions `entity.name.function`; all declaration identities, including scenarios, use `entity.name.type`; named messages share fixture constant scope. | Distinguish stable declaration roles while keeping matching independent of capitalization/name lookup. |
| Medium | Number/type/object/string scanners do not report every invalid source spelling; unknown attributes are still assignment keys. | Avoid treating recognition as normative acceptance. Only add invalid scopes where token boundaries are reliable. |
| Low | Quoted locale keys remain `string.quoted.double`, unquoted keys get locale-name scope; description suffix placement/attachment is not enforced. | Preserve all string content and JSON escapes; optional role-specific locale key capture should not parse ICU contents. |

These are inspection findings, including absent/weak role scopes; final token-level claims require the main agent's scope checks. No arbitrary builtin call list, unsupported historical `nav/link/render/then/email` vocabulary, or default runtime/auth/database boilerplate should be added as source syntax.

## Actual current corpus evidence

All **44** files are included: **39** top-level app drafts, **3** shared drafts, **2** examples; **7,397 physical lines**. Counts below are non-comment, nonblank physical lines whose first word (after optional `export`) matches the row. They are reproducible inventory counts, **not AST totals**: inline `do` effects and semicolon leaves can add constructs not represented by line-start counts. The first current source occurrence is given, rather than invented sample app syntax.

| Construct | Line-start count | First corpus example |
| --- | ---: | --- |
| `app` | 50 | `draft/CanAffiliate.can:2` — `app CanAffiliate uses=[affiliate]` |
| `package` | 49 | `draft/CanAffiliate.can:5` — `package affiliate` |
| `use` | 185 | `draft/CanAffiliate.can:6` — `use rent_catalog {Location,test_site}` |
| `preferences` | 46 | `draft/CanAffiliate.can:36` — `preferences { reversed:bool? label=label_CommissionResult_allocation_reversed }` |
| `contract` | 57 | `draft/CanAffiliate.can:11` — `export contract CommissionResult { source:text label=label_CommissionResult_source, amount:money, account:t…` |
| `event` | 90 | `draft/CanAffiliate.can:15` — `event changed { value:CommissionResult }` |
| `role` | 67 | `draft/CanAffiliate.can:16` — `role partner_manager label="Partner manager"@{nl="Partnerbeheerder"}` |
| `derive` | 79 | `draft/CanAffiliate.can:22` — `derive available(partner:Partner,currency:currency):money = sum(partner.Sale as sale where sale.commission.…` |
| `policy` | 300 | `draft/CanAffiliate.can:23` — `policy Partner read=partner_manager or finance where=all(row.locations as location,can_work(actor,location))` |
| `require` | 682 | `draft/CanAffiliate.can:58` — `require all(partner.locations as location,can_work(actor,location)) and partner.active and partner.onboarde…` |
| `unique` | 25 | `draft/CanApprove.can:21` — `unique Submission fields=revision` |
| `lock` | 91 | `draft/CanAffiliate.can:31` — `lock Sale fields=source,customer,location,amount,rate,agreement,commission` |
| `retain` | 5 | `draft/CanCatch.can:33` — `retain Issue until=row.last_activity+row.parent.issue_days*1d` |
| `fixture` | 146 | `draft/CanAffiliate.can:34` — `fixture broker=Partner {name="Broker",account=other,email="broker@example.test",locations=[test_site],produ…` |
| `capability` | 21 | `draft/CanAffiliate.can:12` — `export capability CommissionV1 version=1` |
| `crud` | 93 | `draft/CanAffiliate.can:55` — `crud Partner by=partner_manager fields=name,email,locations,products,rate,agreement,milestone,active create…` |
| `scenario` | 397 | `draft/CanAffiliate.can:57` — `scenario settle(partner:Partner,amount:money) by=finance label="Settle commission"@{nl="Commissie verrekenen"}` |
| `do` | 397 | `draft/CanAffiliate.can:59` — `do` |
| `let` | 145 | `draft/CanAffiliate.can:71` — `let existing=first(partner.Sale as sale where sale.source==event.value.source order=sale.id)` |
| `create` | 131 | `draft/CanAffiliate.can:61` — `create Settlement {parent=partner,source=operation.id,amount,delivery=delivery.id} as settlement` |
| `set` | 481 | `draft/CanAffiliate.can:76` — `set existing {reversed=true}` |
| `delete` | 13 | `draft/CanBook.can:334` — `delete` |
| `call` | 3 | `draft/CanField.can:71` — `call record_inspection {inspection=job.inspection,answers,result,evidence=notes}` |
| `emit` | 122 | `draft/CanCustomer.can:125` — `emit CompanyAccessChanged {customer=invitation.parent,account=actor,revision=invitation.version+1}` |
| `send` | 118 | `draft/CanAffiliate.can:60` — `send Commissions.settle {source=operation.id,account=partner.provider_account,amount} as delivery` |
| `schedule` | 46 | `draft/CanApprove.can:46` — `schedule submission.id at=due event=Due {submission,version=submission.version}` |
| `cancel` | 50 | `draft/CanApprove.can:42` — `cancel old.id` |
| `return` | 12 | `draft/CanPropose.can:66` — `return revision` |
| `if` | 359 | `draft/CanAffiliate.can:72` — `if existing==null and event.value.milestone==partner.milestone` |
| `else` | 136 | `draft/CanApprove.can:59` — `else` |
| `for` | 150 | `draft/CanAffiliate.can:69` — `for partner in Partner as row where row.id==event.value.attribution and row.active limit=1` |
| `examples` | 102 | `draft/CanAffiliate.can:62` — `examples seed=[test_worker,sale] partner=broker` |
| `page` | 90 | `draft/CanAffiliate.can:88` — `page /partners title="Partners"@{nl="Partners"}` |
| `card` | 166 | `draft/CanAffiliate.can:90` — `card "Partner intake"@{nl="Partner aanmaken"}` |
| `details` | 43 | `draft/CanAffiliate.can:100` — `details "Frozen sale evidence"@{nl="Vastgelegd verkoopbewijs"}` |
| `tabs` | 33 | `draft/CanAffiliate.can:97` — `tabs` |
| `tab` | 47 | `draft/CanAffiliate.can:98` — `tab "Sales and adjustments"@{nl="Verkopen en correcties"}` |
| `list` | 147 | `draft/CanAffiliate.can:92` — `list Partner columns=name,agreement,rate,milestone,onboarded,active filter=active search=name display=split` |
| `table` | 116 | `draft/CanAffiliate.can:99` — `table row.Sale columns=source,location,amount,rate,commission,reversed filter=reversed defaults={reversed=p…` |
| `board` | 1 | `draft/CanCRM.can:166` — `board Deal as deal by=stage columns=title,customer,contact,value,seats,next_action filter=location,owner,st…` |
| `calendar` | 4 | `draft/CanBook.can:348` — `calendar Appointment start=from end=until filter=state defaults={state=preferences.appointment_state}` |
| `form` | 157 | `draft/CanAffiliate.can:91` — `form Partner.create` |
| `title` | 2 | `draft/CanLearn.can:85` — `title row.title` |
| `text` | 136 | `draft/CanAffiliate.can:95` — `text row.agreement,row.milestone,row.onboarded` |
| `content` | 6 | `draft/CanDo.can:144` — `content row.detail` |
| `metrics` | 16 | `draft/CanCRM.can:200` — `metrics result.count,result.total` |
| `copy` | 2 | `draft/CanPropose.can:273` — `copy app_url(format("/offers/respond/{id}",{id=row.id}))` |
| `edit` | 83 | `draft/CanAffiliate.can:94` — `edit` |
| `action` | 42 | `draft/CanApprove.can:84` — `action withdraw` |
| `actions` | 50 | `draft/CanApprove.can:94` — `actions decide,assign` |
| `history` | 52 | `draft/CanAffiliate.can:107` — `history` |
| `context` | 2 | `draft/CanCatch.can:3` — `context` |
| `theme` | 0 | absent; normative construct still needs coverage |
| `files` | 0 | absent; normative construct still needs coverage |
| `locale` | 0 | absent; normative construct still needs coverage |
| `binding` | 0 | absent; normative construct still needs coverage |
| `queue` | 2 | `draft/CanCatch.can:4` — `queue ErrorJobs type=catch.ErrorWork` |
| `cache` | 0 | absent; normative construct still needs coverage |
| `analytics` | 1 | `draft/CanStats.can:5` — `analytics WebDimensions { site:text, name:text, path:text, location:text?, source:text?, value:decimal }` |
| `migration` | 0 | absent; normative construct still needs coverage |
| `rename` | 0 | absent; normative construct still needs coverage |
| `drop` | 0 | absent; normative construct still needs coverage |
| `invalidate` | 0 | absent; normative construct still needs coverage |
| `backfill` | 0 | absent; normative construct still needs coverage |
| `message` | 280 | `draft/CanAffiliate.can:37` — `message label_CommissionResult_source = "Source reference"@{nl="Bronreferentie"}` |

Feature counts below count matching physical lines, not occurrences or legal AST nodes. Quoted/prose occurrences are excluded where specified.

| Feature | Matching lines | Real current example |
| --- | ---: | --- |
| Safe access | 8 | `draft/CanField.can:193` — `text row.inspection?.checklist` |
| Fallback | 37 | `draft/CanField.can:77` — `source=job.schedule_source??job.source` |
| Duration literals | 92 | `draft/CanAffiliate.can:82` — `scenario reconcile on=every(5m)` |
| Bytes | 0 | use GRAMMAR/DESIGN context example `max=20MiB`; absent from corpus |
| Message markers | 1,614 | `draft/CanAffiliate.can:1` description suffix and inline/named descriptors throughout |
| Description references | 0 | normative `#= path` still needs separate scope coverage |
| Invariant colon | 97 | `draft/CanBook.can:35` — `require WeeklyHours: row.opens<row.closes…` |
| Record routes | 3 | `draft/CanCustomer.can:228` — `page /companies/{Customer.id}…` |
| Scalar routes | 0 | normative typed route slot still needs separate scope coverage |
| Explicit required arrays | 26 | `draft/CanAffiliate.can:18` — `products:text[]!` |
| Archived query clause | 14 | `draft/CanCRM.can:150` — `list Customer archived=include as candidate…` |
| Page poll and refresh | 1 each | `draft/CanDo.can:134` — `page /tasks/my-work … poll=5s refresh=refresh` |
| CSV form intake | 4 | `draft/CanCRM.can:144` — `form Customer.create import=csv review=duplicate_customers` |
| Review binding | 6 | includes intake and ordinary review forms; `draft/CanCRM.can:144` above |
| Preference ordering | 1 | `draft/CanDo.can:123` — `order={by=preferences.view,default=[due],cases={all=[-created]}}` |

A broad search for `source="…"` also matches business data fields; it must not be reported as app/package source-language coverage. Likewise a semicolon search finds punctuation in raw descriptions/strings and does not establish semicolon-leaf coverage. Absent corpus families include maintenance, bytes, scalar routes, description references, theme/file/locale/binding/cache contexts; presence in the normative grammar is sufficient to require inventory and focused examples, never app-draft changes merely to inflate coverage.
