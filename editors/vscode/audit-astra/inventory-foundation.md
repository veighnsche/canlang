# Independent foundation inventory

This report audits the frozen `audit-astra/snapshot` only, except the explicitly marked live-source recheck below. All relative `file:line` citations in this report resolve under that snapshot. I read its AGENTS.md and the normative grammar/design, searched the decision history for the relevant changes, and scanned every one of the 44 source files: 39 `draft/Can*.can`, three `draft/shared/*.can`, and two `examples/*.can`, totaling 7,489 physical lines. I did not read `GRAMMAR-AUDIT.md` or `check-highlighting.cjs`, modify source/extension files, install anything, or consult JEV. This is a factual inventory; no difficult design choice was made.

The grammar explicitly owns syntax, DESIGN owns semantics, and neither parsing nor corpus coverage proves executable validity (`GRAMMAR.md:3`, `DESIGN.md:3`, `GRAMMAR.md:429`). The observations/counts below came from independent text/depth/section scans, not a compiler or semantic checker. Tokenizer/theme behavior is left to the parent audit.

## Coverage table

“Absent” means no authored occurrence in this frozen 44-file corpus; it does not mean unsupported grammar. “Partial” means some alternatives have witnesses while others need probes.

| Normative family | Corpus coverage and witnesses | Missing discriminating cases |
| --- | --- | --- |
| UTF-8/ASCII NAME, one-space suites, LF/CRLF, logical-line joining (`GRAMMAR.md:13`, `:35`, `:37`) | Partial: all 44 files use LF; nested one-space bodies throughout; multiline schema `examples/ExpenseFlow.can:8`–`:16` | CRLF, EOF without newline, malformed encoding, code/indent tabs, allowed prose tabs, mismatched/unclosed delimiters, continuation indentation, blank/comment-only lines between suites |
| INTEGER/DECIMAL/DURATION/BYTES/STRING (`GRAMMAR.md:16`–`:25`) | Integers/JSON text/durations abundant; decimals `draft/CanAffiliate.can:34`; `1ms` `draft/CanBook.can:22` | Byte quantities; suffix boundaries (`5minutes`), separated units (`5 m`), numeric separators/exponents, signs as operators, JSON escapes, invalid scalar/overflow values; lexical and semantic failures differ |
| Semicolon leaves (`GRAMMAR.md:341`) | Absent: stripping JSON string/prose/comment contents leaves zero executable semicolons | Every allowed category; rejection of mixed categories, compounds, empty/trailing entries and child suites on sequences |
| Descriptions/comments (`GRAMMAR.md:41`–`:47`) | Prose with translations across apps/operations/pages; ordinary `##` comments `draft/CanCRM.can:210`; multiline **schema** exists but no field-level description lines | `#= path`; joined prose lines; blank/`##` attachment; raw tabs; escaped `\@{`; description inside joined braces; same-column export attachment; ineligible/unattached/inline-hash rejection |
| Contextual NAME roles (`GRAMMAR.md:70`–`:72`) | Actual names such as `from`, `end`, `role`, `owner`, `action` occur as fields/parameters: `draft/shared/Employees.can:6`, `draft/CanBoard.can:9`, `draft/CanBook.can:15`, `draft/CanRent.can:184` | Lowercase/contextual stored-model names (`event {}`, `contract {}`, `message {}`); introducer-versus-name lookahead; `.where`, `.select`, query clause words as operands; literal/prefix exceptions |
| App/package composition (`GRAMMAR.md:130`–`:158`) | 50 app headers: 48 composed, two implicit; 49 explicit packages. Implicit bodies and composition in one file `examples/TeamTasks.can:2`, `:31`, `:51`; package-only sources `draft/shared/Suppliers.can:2` | Empty sections independently; reordered/incomplete/duplicate triples; multiple packages/apps with optional contexts; empty `uses` distinction; context merge conflicts; cycles/identity deduplication require checking |
| Imports/export (`GRAMMAR.md:148`–`:158`) | 185 grouped imports; 58 bound imports; aliases `draft/CanCheck.can:8`; message-only group `examples/TeamTasks.can:32`; export models/contracts/events/roles/functions/capabilities/fixtures/user scenarios/messages | Empty group and trailing comma; contextual member/alias names; duplicate/local collisions; exported unsupported categories; bind/interface closure checks |
| Rich contexts (`GRAMMAR.md:134`–`:139`, table `:113`–`:119`) | Only two contexts, two queues and one analytics schema: `draft/CanCatch.can:3`–`:4`, `draft/CanStats.can:3`–`:5` | Theme differences, file-policy overrides, locale default, DurableObject binding, KV cache; required attributes/nonempty suite; defaults are semantic, not repeated setup syntax |
| Types/schemas (`GRAMMAR.md:163`–`:184`) | Named/reused field types, primitives, enums, arrays, nullable values; required arrays `draft/CanBoard.can:10`; nullable arrays `draft/CanInvoice.can:41`; action types `draft/CanDo.can:16` | Named unions; enum/action atom versus same-spelled path; nullable union arrays; unresolved reused-array `!`; suffix stacking/nullable-element/grouped-type failures; empty schema, multiline field descriptions, trailing commas |
| Field/parameter metadata (`GRAMMAR.md:169`–`:184`) | Default/server, trim/unique/min/max, direct/static labels, enum label maps; field example `draft/CanCheck.can:15`; signature parameter label `draft/shared/Employees.can:18` | Duplicate/reordered modifiers, default boundary at contextual `trim`/`unique`, forbidden scalar `!`, required-array initializer, field-only metadata on parameters; type compatibility is semantic |
| Stored models and ownership (`GRAMMAR.md:254`, `:271`; `DESIGN.md:95`–`:101`) | 195 stored declarations, 145 explicit containment headers; team omission and child containment coexist `draft/shared/Locations.can:6`–`:9` | `in app`, `at=Binding`, qualified containment/placement; redundant `in team` rejection; metadata-name collision/resolution and authority checks |
| Other Given declarations (`GRAMMAR.md:249`–`:273`) | All families appear: 46 preferences, 57 contracts, 49 owner-level events, 67 roles, 37 derived fields, 42 functions, 304 policies, 97 invariants, 25 composite unique, 91 locks, five retain, 146 fixtures, 21 capabilities, 282 messages | Export combinations/contextual names; incompatible field rules; semantic restrictions on preference types/defaults/consumers; reused-field constraints; local/private/canonical owner resolution |
| Capability signatures/events (`GRAMMAR.md:266`–`:268`) | `draft/CanAffiliate.can:12`–`:15` has named operation parameters/results and nested event | Empty suite, semicolon signatures/events, declaration-level descriptions, contextual operation/type names; `version=expr` is not proof of integer revision |
| Fixture model/file recipes (`GRAMMAR.md:265`, `:273`) | Exported fixtures `draft/CanBook.can:43`; three file recipes, all empty (`draft/CanContract.can:30`, `:31`, `draft/CanExpense.can:23`) | Nonempty `type`/`owner` recipes, bad recipe keys/shorthand, compound fixture values, namespace/test-only identity checks |
| Descriptors/messages/labels (`GRAMMAR.md:278`–`:300`) | Inline variants, direct/path labels, field case maps, CRUD labels; one parameterized named message `examples/TeamTasks.can:11` | Source-only `@{}`, quoted BCP 47 keys, explicit null variants, duplicates/canonical aliases, description references, parameterized/defaulted message signatures, anonymous explicit named binding; ICU validation is later work |
| Closed header attributes (`GRAMMAR.md:74`–`:125`) | Many rows covered; exact absence inventory below | Unknown/repeated keys, alternative order, `=` versus `==`, delimiter/query boundary, missing RHS, unbracketed trailing commas, unsupported finite values; tokenizer coloring cannot certify these |
| Expressions/query AST (`GRAMMAR.md:191`–`:244`) | Literal/value/typed-value/call/member/operators/query families occur throughout; complete production-name inventory below | Parent audit owns detailed expression probes; grammar role differs from inferred builtin/type/record role |
| When/effects/examples/presentation (`GRAMMAR.md:305`–`:400`) | User/trusted scenarios, CRUD, nested effects, attached examples, pages and all collection heads occur | Parent/other assigned audit owns detailed coverage; declaration/effect/selector contexts must remain separate |
| Maintenance (`GRAMMAR.md:405`–`:425`) | Entire family absent: zero migrations/backfills | Predecessor header, optional/nonempty body, owner/model/field directives, invalidation, mapper `before`/`row`, restricted effects and leading-guard ordering |

## Exhaustive production-name inventory

This groups **every named production printed in GRAMMAR**, so broad families cannot conceal omitted syntax. The helper notation `line`, `suite`, `optional_suite`, `leaf_lines`, `separated`, `bracketed` is separately specified in `GRAMMAR.md:7`–`:9`; `attributes` expands the closed table, not an unrestricted production (`:271`). Several rules also have mandatory prose refinements, so the EBNF blocks alone are not a complete machine grammar.

| Family / definition lines | Production names |
| --- | --- |
| Lexical, `:16`–`:22` | `NAME`, `INTEGER`, `DECIMAL`, `DURATION`, `BYTES`, `STRING`, `path` |
| Source/composition, `:130`–`:151` | `file_source`, `app_composed`, `app_implicit`, `context`, `context_items`, `context_declaration`, `package`, `app_attributes`, `package_body`, `sections`, `section_given`, `section_when`, `section_then`, `then_items`, `import`, `import_members`, `import_member`, `deployment` |
| Types/schema/signatures, `:163`–`:173` | `type`, `type_base`, `enum_type`, `action_type`, `field_type`, `schema`, `field`, `initializer`, `field_modifier`, `parameters`, `parameter` |
| Ordinary expressions, `:191`–`:215` | `expr`, `ordinary`, `fallback`, `disjunction`, `conjunction`, `negation`, `comparison`, `comparison_op`, `additive`, `multiplicative`, `unary`, `postfix`, `primary`, `array`, `values`, `value_field`, `typed_value`, `VALUE_NAME`, `arguments`, `positional`, `named_arguments`, `call_expr` |
| Query clauses, `:229`–`:235` | `query_tail`, `archive_clause`, `alias_clause`, `where_clause`, `order_clause`, `select_clause` |
| Given, `:249`–`:268` | `given_items`, `given_leaf`, `ordinary_given`, `preferences`, `model`, `contract`, `event`, `role`, `derive_field`, `pure_function`, `policy`, `invariant`, `unique`, `lock`, `retain`, `fixture`, `capability`, `capability_items`, `capability_leaf` |
| Messages/local labels, `:278`–`:291` | `message`, `message_parameters`, `message_value`, `message_variants`, `message_variant`, `caption`, `scalar_label_attribute`, `field_label_attribute`, `field_label_value`, `field_label_entry`, `case_labels`, `case_label`, `crud_labels`, `crud_label_entry` |
| When/body containers, `:305`–`:318` | `when_items`, `crud_head`, `user_scenario`, `trusted_scenario`, `handler_source`, `scenario_body`, `guard_line`, `guard`, `do_body`, `effect_body`, `effect_line`, `effect_leaves`, `effect_leaf` |
| Effects/control, `:320`–`:332` | `let`, `create`, `set`, `delete`, `call`, `emit`, `send`, `schedule`, `cancel`, `return`, `conditional`, `loop`, `mutation_target` |
| Examples, `:346`–`:353` | `scenario_examples`, `crud_examples`, `crud_action`, `example_bindings`, `example_table`, `observations`, `example_row`, `expected_error` |
| Presentation structure, `:363`–`:380` | `then_item`, `page`, `ui_body`, `ui_item`, `ui_leaves`, `ui_leaf`, `ui_group`, `tabs_group`, `tab_items`, `collection`, `collection_header`, `collection_head`, `form`, `form_header` |
| Selector/order/routes, `:381`–`:393` | `selector`, `selectors`, `ordering`, `ui_order`, `preference_order`, `preference_order_member`, `order_case`, `route`, `route_segment`, `STATIC_SEGMENT` |
| Maintenance, `:405`–`:419` | `migration`, `migration_items`, `migration_item`, `migration_leaves`, `migration_leaf`, `before_path`, `backfill`, `mapper_body`, `mapper_do`, `mapper_effects`, `mapper_leaves`, `mapper_leaf`, `mapper_conditional` |

`deployment` is explanatory binding spelling in `:151`; actual imports parse `from=path` and check supported binding form later (`:148`, `:156`). It is not a globally reserved namespace token.

## Closed attributes: covered versus absent alternatives

The following preserves the entire closed table, including context/header distinctions. A star marks a syntactically required attribute. “No witness” applies to an **attribute in that header**, not a same-spelled field or query clause elsewhere. Physical-header scans were followed by inspection of the cited shapes; these are coverage observations, not rejection tests.

| Header | Exact closed slots | No witness in frozen corpus |
| --- | --- | --- |
| app | `uses`, `source`, `label` | `source`, `label` |
| package | `source`, `label` | `source` |
| import | `from` | None (`draft/CanCheck.can:8`) |
| preferences | trailing `label` | Section `label`; field labels are covered |
| model | pre-schema `at`, trailing `label` | `at` |
| contract / role / derive field | trailing `label` | None |
| field | initializer `=` or `server=`, `trim`, `unique`, `min`, `max`, trailing `label` | None; specific compatible combinations still need probes |
| parameter | default `=`, trailing `label` | None |
| policy | `read*`, `where`, `fields` | None |
| unique / lock / retain | `fields*`, `where`; `fields*`, `when`; `until*` respectively | None |
| capability | `version*` | None |
| CRUD | `by*`, `fields*`, `create_fields`, `when`, `create`, `update`, `delete`, `label` | None; supported modes and enabled-label keys require checks |
| user scenario | `by*`, `read=true`, `scope`, `-> type`, `label` | None |
| trusted scenario | `on*` (only) | None |
| execution/mapper require | `message` | No `message=` diagnostic witness; mapper entirely absent |
| send / schedule | `when`, then mandatory `as NAME`; ordered `at*`, `event*` | None |
| examples / CRUD examples | named input bindings and special `seed` | Many operation-specific bindings occur; this is intentionally not a global finite input-name registry |
| page | `title*`, `data`, `order`, `group`, `nav`, `poll`, `refresh` | `data`, `group`, `nav`; `poll`/`refresh` only `draft/CanDo.can:134` |
| card / details | `layout`; `display`, `open` | None |
| tabs / tab | no attributes | Both leaf and grouped forms exist; no attribute bag |
| list / table | `columns` (required only table), `order`, `search`, `filter`, `empty`, `defaults`, `display` | None |
| board | `by*`, `columns`, `order`, `search`, `filter`, `empty`, `defaults` | `order`, `empty`; single board witness `draft/CanCRM.can:166` |
| calendar | `start*`, `end*`, `columns`, `order`, `search`, `filter`, `empty`, `defaults` | `columns`, `order`, `search`, `empty` |
| form | `arguments`, `fields`, `submit`, `display`, `import`, `review` | `submit` |
| edit | `fields` | `fields` (83 bare edit lines) |
| migration | `from*` | Entire header absent |
| theme | at least one of `mode`, `accent`, `density` | Entire header absent |
| files | at least one of `types`, `max` | Entire header absent |
| binding / queue / cache / analytics / locale | `key*`; `type*`; `ttl*`; no attrs; `default*` respectively | binding/cache/locale absent; queues/analytics covered |

Other declaration categories (events, pure functions, fixtures, named messages, invariants, capability operations, section markers, effects without listed slots) do not acquire generic attributes by analogy. Inline schema/value/label object keys occupy different closed/typed roles. For example `source=` inside a structural object does not cover app `source=`, and `type=` in a queue does not make `type` a globally reserved word.

## Semantic-name inventory and highlighter boundary

All identifier-shaped words are lexical `NAME` (`GRAMMAR.md:27`). Context selects a role; casing, import lookup and resolved type are explicitly forbidden as parser-production selectors (`:70`). Authored names/types/import aliases/member names accept contextual words; only expression-primary `true`, `false`, `null`, `not` have the listed exclusions (`:72`, `:210`). This requires separate syntax highlighting contexts, not one global keyword pattern.

The type registry in `DESIGN.md:105`–`:118` includes `text bool int decimal email url locale date datetime duration timezone currency money user member file secret json`, named record/struct/field paths, enum/action types and the bounded array/null/union suffixes. Frozen corpus contains each primitive spelling in type position except `locale` and `json`; `member` occurs only at `examples/TeamTasks.can:5`. Resolving a contextual path named `enum`/`action` differs from the exact call-shaped atom (`GRAMMAR.md:176`). Closed builtin identities may not be replaced by package declarations, but ordinary locals may hide callable/predicate names (`DESIGN.md:268`); even builtin-looking call text is not semantic proof.

The complete frozen callable registry is `count sum min max any all first group at abs round lower upper trim contains starts_with join format app_url active_member overlaps local_date local_instant add_days add_months date_year weekday dates money date datetime action random_secret` (`DESIGN.md:210`, signatures `:228`–`:251`). All have call-shaped corpus witnesses except `abs`, `upper`, `contains`. Action **type** syntax also has the same spelling and parentheses; structural constructors/canonical operations/declared functions/declared role predicates are distinct semantic callees. Bare `owner members authenticated public` are actor predicates, and bare declared roles are predicates; only declared team roles gain subject calls (`DESIGN.md:276`–`:280`). `random_secret` is restricted to server defaults, despite ordinary call syntax (`:223`, `:262`).

Protected injected names are active-context facts `actor team now operation row event preferences result before`, not globally reserved spelling (`DESIGN.md:162`, `:268`). Actor/email facts, model metadata (`id version created updated created_by updated_by archived_at`), generated child collections/CRUD identities, query aliases and enum expectations need semantic scope resolution. The record metadata names are reserved **as model fields** (`:101`), rather than every occurrence of these words being a language keyword. Tests add fixture/account/input-selector meanings (`GRAMMAR.md:358`), without declaring production globals. Expected enum resolution yields to an existing lexical binding (`DESIGN.md:266`), so lexical coloring cannot establish a bare identifier is an enum value.

Source-only suites are exactly one-space increments; delimiter joins suppress layout, but field descriptions still attach at actual physical columns (`GRAMMAR.md:35`–`:37`, `:49`–`:66`). TextMate can style braces/fields/descriptions without proving this full layout contract. Treat its acceptance of unsupported indentation, attributes, modifiers or enum/name lookalikes as a diagnostic limitation, not automatic grammar correctness or necessarily a wrong theme.

The user's corrected visual requirement is that **Given, When and Then share one special standout color: white (bold is appropriate)**. They remain three distinct grammatical section markers, but this does not imply three colors. This report requests no IDE/UI mutation and performs no UI inspection; the parent can reconcile actual scopes/theme rules against that shared-color requirement using filesystem evidence.

## Contradictions, ambiguity, and specification refinements

1. **Concrete frozen-source semantic violation, subsequently corrected in live source:** `dates` has exactly three arguments (`DESIGN.md:216`, `:247`, `:262`). `draft/shared/Locations.can:17` contains two two-argument calls, and `draft/CanRent.can:188`, `:190`, `:220`, `:245`, `:269` each contains `dates(start,end)` with no work limit. These seven calls are valid expression syntax but incompatible with the finite builtin signature. Other sources demonstrate the supported form: `draft/CanLeave.can:62` uses limit 3660, `draft/CanMember.can:127` limit 3. At 2026-10-04 00:57 UTC, a read-only recheck of **live** `draft/shared/Locations.can:17` and `draft/CanRent.can:220`, `:222`, `:252`, `:277`, `:301` found all seven now explicitly pass 1000. This resolves the missing-argument issue only; I did not validate the business choice of limit or execution. Live DESIGN also adds `flatten`, which is outside the frozen registry being audited here.

2. **Unresolved secret-field scope ambiguity, still present live:** `DESIGN.md:120` says contract fields follow model field rules; `:128` says secret fields always require server initialization. However `draft/CanCheck.can:11` exports `contract Heartbeat { ..., token:secret }` without `server=`, while its stored `Check.token` correctly uses `server=random_secret()` (`:15`). The wording may intend the initialization rule only for stored fields (the immediately preceding subsection is “Stored field forms”), in which case the contract is legitimate ingress data. But that exception is not stated alongside “contract fields follow model field rules.” This needs semantic specification clarification, not highlighting rejection of the secret type. Live file/source wording remained identical at recheck.

3. **Intentional prose refinements, not newly discovered unsupported syntax:** the printed `field_type = type [!]` admits shapes that accompanying prose rejects (`GRAMMAR.md:167`, `:178`); `postfix` is also refined by the safe-call exclusion (`:202`, `:222`). Generic `model` ownership paths are narrowed by the explicit `in team` ban (`:254`, `:271`), and preferences wins its same-shaped declaration before model parsing (`:433`). `query_tail` printed optionals are constrained to at least one actual clause (`:229`, `:238`). These must be included in a grammar inventory/probe matrix. Do not evaluate the EBNF block in isolation and then call its broad acceptance normative.

4. **Broad contextual-name wording has explicit slot exceptions:** a model named `preferences` cannot use its indistinguishable ordinary schema shape because preferences is selected first (`GRAMMAR.md:433`). A bare containment spelling `in team` is rejected even though path components generally accept contextual words (`:72`, `:271`). These are documented grammar refinements; a test for contextual declarations should include both the broad allowance and these narrow exceptions. A name-coloring pass cannot resolve whether `team` denotes active injected context or an authored declaration.

5. **Recorded syntax-prototype gaps are not normative grammar exclusions:** preference UI ordering (`GRAMMAR.md:400`), CSV form attributes (`:447`) and page refresh (`:449`) are declared syntax even while the parser prototype is described as not implementing them. Conversely the absence of richer contexts, unions and maintenance from the corpus is expressly acknowledged (`:429`). Corpus-only or unchanged-prototype checks cannot claim complete language coverage.

6. **Historical alternatives are not current contradictions:** DECISIONS retains a prior implicit `main` identity (`DECISIONS.md:15`), then explicitly supersedes it with direct app identity (`:30`). The section title and surrounding historical sequence matter. Current grammar/design and TeamTasks source agree on app-owned implicit identity; no synthetic `main` should be inferred from the earlier entry.

## Version evidence for the live recheck

Full SHA-256 values were recorded rather than assuming a moving checkout matches the snapshot:

| File | Frozen SHA-256 | Live SHA-256 at recheck |
| --- | --- | --- |
| GRAMMAR.md | `bd21a290fb4fa0b753cfe6e655b7aca4e65763dd5b42b7c36c7e83b825b24014` | Same |
| DESIGN.md | `dd72a1d5869d74cdb7e419cd3cb885dfad4b3a00281d33f43a6ca093f3c21d14` | `fea86cd9fed26b5a3d5953a6e5497bbef3bdb27000eaa27e66d9c8622afd3c15` |
| DECISIONS.md | `4747af39bca7ecbbf66ce715bcfb9af0b6969923b6886601123da018e53e9256` | `cb178d30a2d3a4ed244da11ec7ed71bea797151e0be5efec1a48c80737324815` |
| draft/shared/Locations.can | `a60c13d9929d9a5e7a61f6c52719588bad063eddd86dd16aaf739d42c5c7ea15` | `46e6a468954bb64db534b2b6b64be168ea6263bad384e5107496cf08f17b8e5c` |
| draft/CanRent.can | `924f2a20224cd42776123891ac5da8e804e812a4dd7c56f310729bc300355ab8` | `d684771336652f5c42199494dfb374caff63a612c9fbaeabd97e70aa09ac236b` |
| draft/CanCheck.can | `de740a9657141916bd703235f075a5ff46ff1333a81a20650a6a32475515cb64` | Same |

The practical audit conclusion is limited: the existing source is broad business-language coverage, while lexical/layout edge cases, richer contexts, unions, source-language headers, description references and maintenance require purpose-built probes. Syntax/color coverage and semantic source compliance must be reported separately.
