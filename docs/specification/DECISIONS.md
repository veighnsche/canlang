# Canlang language design decisions

## Current status

The numbered list below is the historical audit of the drafts, including the choices that were open at that point. [DESIGN.md](DESIGN.md) now defines the chosen v1 design; [REQUIREMENTS.md](REQUIREMENTS.md) retains the product requirements. Historical **MINE** entries are not additional rules when the v1 design replaces them. **OPEN** below records the earlier question, not a second unresolved specification.

These v1 choices are still reviewable. JEV was consulted as an adviser; its choices are evidence, not user instructions or proof that a compiler works. [The consultation record](../../design/jev/README.md) preserves the exact questions, alternatives, answers, and confidence.

The later user requirement to mix tests with business logic is now captured in DESIGN §5.1 and the reference sources. **USER:** app behavior checks share their `.can` source with the operations and remain token-efficient. **MINE:** attach `examples` tables to operations and reuse named `fixture` data; expected outcomes are authored independently. This adds executable BDD checks without changing what production mutations mean. The test runner remains unimplemented.

The user subsequently requested package-owned import/export instead of a central connections file. **USER:** keep connections with their owning/consuming packages. **MINE:** prefix declarations with `export`, bind service imports through `use ... from=deployment...`, and distinguish executable local dependencies from exported-interface dependencies. The common Outcome schema becomes `std.OperationOutcome`. DESIGN §1/§8 and the source drafts now reflect these changes; earlier adapter declarations are superseded. No implemented compiler has assessed this follow-up.

The user then rejected `draft/apps/` and the authored `draft/builds.json`, and requested migration of all app sources. **USER:** app identity/composition belong in real business source; remove the wrappers and manifest, and record the violations in AGENTS.md. **MINE:** `app Name uses=[...]` explicitly selects package/app members; one app is selected per deployment from a compiler-derived project index, while other declarations remain inert. Runtime/auth/teams/theme defaults are version-pinned; explicit resource policies remain. Local dependency packages retain internal authority but do not automatically mount their whole UI/MCP product. Composed contexts deduplicate compatible settings and reject conflicts. All 39 drafts and both reference examples now use this design; seven portfolio compositions are declared alongside the related business apps. The assistant-created OperatorCore wrapper is removed rather than replaced with another scaffold. Shared-folder organization remains deferred.

Three reworded JEV consultations support the deployment/discovery/default/dependency boundaries. Advice on exact `uses` notation was tentative; single-package naming conventions and file policy inference produced disagreement. The migration retains explicit named membership (and implicit `main` for small apps), existing explicit upload policy, and a single unambiguous app/package name space. These are reviewable design decisions, not claims that JEV finalized or tested the grammar. The old exactly-one-app-in-all-loaded-files rule, explicit build-source inventories, opt-in team setup and repeated standard shell setup are superseded.

The user then identified the retained uniform R2 declaration as another repetition violation and requested a full audit. **USER:** common file setup must be a default, and repeated syntax must be examined for implicit meaning. **MINE:** infer R2 from included `file` declarations; pin the existing type/size baseline once, merge only explicit deviations, omit unchanged/empty context and normalize equal CRUD/default lock attributes. [The token audit](#token-repetition-audit) covers all 44 sources, records applied changes and ranks further grammar reductions. This correction supersedes the prior decision to require copied upload policy. Larger syntax proposals in the audit are not yet adopted.

After reviewing the NOUL results, the user authorized only the grouped-import proposal. All imports now use `use provider {Symbol,Other as Alias} [from=deployment.binding]`, grouping equal consumer/provider/binding declarations. All 305 imported symbols, their aliases and deployed boundaries remain; import declarations decrease to 167. Scalar requiredness, model/role scope and operation markers keep their existing grammar. Historical audit measurements and JEV evidence below retain their original context; import grouping is now adopted by this explicit user instruction.

The user subsequently requested replacing lowercase `then` with `do`. This is now the sole scenario-body introducer for inline and indented bodies, including reads and trusted handlers. All 254 source markers are renamed; business statements, nesting and examples are unchanged. Uppercase Given/When/Then is unchanged. Three JEV comparisons chose unresolved/do/unresolved with strongly varying probabilities; the rename follows the user's explicit instruction, not an assumed unanimous endorsement. The earlier marker-removal proposal and saved measurements remain historical; neither `scenario` nor the body container has been removed.

The user subsequently replaced PatternFly with daisyUI as the built-in presentation foundation. REQUIREMENTS and DESIGN now map the same canonical primitives to daisyUI components, with Tailwind CSS managed by the shared presentation build. The `.can` syntax, HTMX behavior and finite theme choices are retained; no per-app library declaration or class list is added. Historical PatternFly choices and saved JEV inputs below record the earlier design and are superseded by this user instruction.

The user then authorized the prioritized syntax borrowings: required scalar defaults and nullable expression operators. Scalar fields now use bare types for required/non-null values; nullable/default/server modes and all 18 required-array markers are retained. All 44 `.can` sources are migrated, removing 798 scalar suffixes. `?.` performs typed nullable member reads, and `??` is the sole lazy null-fallback form; four fallback calls and three result-presence checks are rewritten with explicit grouping and non-null-ID comparison facts. Type/permission checks, statements, examples and one-space nesting are preserved. Three JEV semantic reviews returned field coherence probabilities 0.73/0.83/0.52 and null-rule probabilities 0.67/0.72/0.74; these are advice with wording uncertainty, not executable proof. At that stage, compound updates, enum matching, scalar aliases, team-scope defaults and scenario removal remained unadopted.


The user subsequently authorized research, validation and implementation of team-scope defaults. Stored Given models now use `Model {...}` for team ownership; `in Parent` and `in app` remain explicit. Roles use `role Name` with the existing package-qualified, owner-assigned team semantics. Redundant `in team` and role `in=team` are invalid; the default is fixed by language version, not a package/context option. Structural types, constructors, test fixtures, permissions and storage placement remain separate. All 44 sources were inspected; 46 model and 67 role qualifiers were removed across 44 files, saving 904 UTF-8 bytes without line or indentation changes. Three fresh JEV consultations selected both defaults, with choice probability 0.94/0.95/0.45 and preservation probability 0.80/0.85/0.62. The variability remains uncertainty rather than proof. Specification review and source comparison found no concrete preservation blocker; no compiler/runtime execution occurred. Other grammar proposals remained open at that stage.

The user then authorized fixing small-app composition through research, validation and implementation. An implicit package now uses its authored app identity directly, such as `TeamTasks.Todo`, with the same canonical owner selected standalone or composed. One app declaration supplies both selection and its owning package; explicit app/package duplicates remain invalid. `uses=[TeamTasks]` selects that app and its context, while `use TeamTasks {Todo}` imports exported owner symbols under existing dependency/bound-interface rules. Composed apps expose no aggregate import namespace. Multiple implicit apps may share a file, each with one ordered Given/When/Then body ending at the next top-level app/package or EOF. The synthetic `main` identity and its collision restriction are superseded. App renames and extraction to a new explicit package identity still require deliberate migration; route/resource conflicts remain errors. Three JEV reviews selected direct app identity with reported probability 1.00 each, but coherence probabilities were only 0.71/0.75/0.71; neither is proof. The existing TeamTasks source now also contains TeamNotes and their TeamOffice composition, without package wrappers or a new source file. Existing named-package sources and the original task body are preserved. Compiler/runtime implementation remains open.

The user then authorized closing demonstrated calendar, retention and typed delegated-form gaps, starting with existing primitives. **MINE:** keep scheduling, owner transactions, locks and the canonical form/operation registry; add only pure calendar calculations, one `retain Model until=expr` lifetime declaration and finite mutation-valued `action(...)` references. Calendar addition clamps from the original anchor; date enumeration rejects excess work instead of truncating. Retention is irreversible, independent of user CRUD and narrowly permits disposal of expired locked records; reference/uniqueness blocks and physical erasure delays remain explicit. Action references bind all record parameters/versions and derive remaining inputs from the owning operation; forms use compiled target schemas, while authored calls must fit every possible target. Source authorization, interface revisions, source completeness and invocation receipts remain explicit; transport success never establishes business completion. Read forms keep their existing static operation form. No alternate scheduler, generic cleanup tool, JSON perform router or copied signature is added. [The consultation record](../../design/jev/README.md#demonstrated-primitive-contracts) preserves classifier uncertainty and review corrections; the decision rests on these concrete contracts, not probability thresholds.

Targeted adoption changes 11 existing `.can` files, adding seven inline example tables with 18 independently authored cases. The remaining 33 sources are byte-identical to the baseline; no source file or architectural layer is added. Calendar backfills, raw-file ownership transfer, changed term/work-list inputs and installed source/delegation mappings need deliberate migration if any prior draft has been implemented. Recurrence admission, availability expansion, daily reservation/pricing and automatic federated refresh remain app work. Compiler/runtime and all examples remain unimplemented/unexecuted; closing the language contracts is not application acceptance.

The user then requested finalized-file fixtures to complete inline BDD notation. **MINE:** extend the existing test-only fixture declaration with `fixture receipt=file {}`. A shared version-pinned valid PDF is the default, with `type`/test `owner` for deviations; there is no production file literal, asset-path API or byte constructor. The test runtime must provision actual checked bytes through normal finalization under the chosen owner, check seeded attachments as self and invoke the unchanged operation under its actual caller. Separate declarations retain distinct upload references despite identical bytes. Setup failures cannot count as business rejection; row isolation, production erasure and attachment rollback are explicit. This closes the notation gap, not the unimplemented runtime. CanExpense and CanContract add five tables/16 cases for receipt preservation, review/correction and distinct-file renewal; the other 42 sources and both apps' existing business text are preserved. Expense reuses one claim fixture through existing initial-state selectors rather than copying its required fields into three records.

Three fresh [JEV consultations](../../design/jev/README.md#finalized-file-fixtures) selected pinned samples and a fixed PDF default. Selected sample probabilities are 0.99/0.98/1.00; default probabilities are 0.99/0.60/0.99, with B giving explicit MIME 0.36. Coherence NOUL is 0.82/0.82/0.51. Re-reading the equivalent requests found no fact reversal or concrete design contradiction, but the classifier supplies no rationale and the variation remains uncertainty. No probability threshold or claim of bias removal establishes the design. Arbitrary file content/boundary tests stay with the shared runtime; unrelated app gaps and all example execution remain open.

The user then requested concrete schema-evolution notation and its declaration boundary. **MINE:** use top-level `migration Owner from="snapshot-id"` in actual business source, outside Given/When/Then. The owner is a logical package or implicit app; current declarations supply the desired schema and an exact compiler-recorded snapshot supplies the predecessor. Explicit one-to-one rename/drop directives and `backfill Model` reuse typed `before`, partial desired `row` and pure `require`/`do`/`if`/`set`. Generated snapshots, applied history and deployment plans replace authored version counters, schema copies, SQL and manifests. Automatic compatibility is conditional even for nullable/defaulted additions and indexes; dynamic defaults cannot invent historical facts. Bound providers remain outside consumer migration.

Three fresh [JEV consultations](../../design/jev/README.md#schema-evolution) all selected the top-level owner boundary and row mapper. Selected probabilities are 0.89/0.98/0.98 and 0.90/0.80/0.77; coherence NOUL is 0.86/0.67/0.82. The classifier gives no reasons for the variation. Subsequent review clarified removed-owner resolution, structural mapping versus value assignment, typed partial fields, preservation of old evidence locks, immutable applied artifacts and exact historical handler invalidation. These clarifications are our design work, not additional classifier judgments. Maintenance preparation/activation, replay/file/retention guarantees and unsupported record/authority transfers remain explicit. All 44 `.can` sources are unchanged: no installed schema history exists here, so real predecessor IDs or app backfills cannot be fabricated. Snapshot production and the migrator remain unimplemented.

The user requested an exact grammar and an initial parser exercised against existing sources. **MINE:** retain delimiter-aware logical lines, contextual words chosen by written production shape, closed header attributes, uniform type paths with later field-value resolution, a flat union/array/nullable subset and low-binding ordered query tails. Inline `do` admits leaf sequences; compounds use one-space suites. [GRAMMAR.md](GRAMMAR.md) records the complete source boundary and [the parser](../../tools/can_parser.py) builds located syntax trees without opaque tails or semantic inference. No app wrappers, manifest or new operation primitive is introduced.

Three fresh [JEV consultations](../../design/jev/README.md#exact-grammar-and-initial-parser) selected contextual query tails and bounded types with returned selected probability 1.00 in each review. Field-reuse NOUL is 0.83/0.87/0.88 and grammar coherence is 0.62/0.71/0.66; those estimates remain uncertainty, not executable proof. The implementation parses all 44 sources and has 25 focused parser tests. CanStock's pre-body `let` and two following guards moved inside block `do` without reordering; the other 43 sources are unchanged. Symbol/type/permission checking, compilation, migrations and inline BDD execution remain unimplemented.

The user requested built-in i18n with translations alongside business source and shared wording. The first implementation used an assistant-chosen locale-column table and mandatory named references. **USER:** put translatables inline where possible and keep `#` descriptions readable. The approved direction is source text plus explicitly keyed variants, such as `"Tasks"@{nl="Taken"}` and `# Manage tasks. @{nl="Beheer taken."}`. **MINE:** one declaration-local `label=` attribute covers captions and closed case/action maps; optional Given `message` leaves name genuinely shared values. A logical-owner `source` override changes the pinned English source language independently of app-default/viewer locale. Ordinary data and machine identities keep their meaning. Existing export/grouped imports still share pure assets; the old table/target-binding grammar is superseded. ICU, fallback, provenance and frozen outbound rendering retain their prior contracts. No translation folder, framework, manifest or lookup wrapper is added. [Fresh consultations](../../design/jev/README.md#inline-localization-contract-and-source-migration) preserve the remaining design advice and uncertainty.

The [three JEV reviews](../../design/jev/README.md#built-in-internationalization) split on layout: table probability .34/.50/.86, keyed .66/.49/.14, unresolved .00/.01/.00. This is not consensus. Tables are chosen for the user's repetition rule, with positional-column editing a real limitation. All selected ICU with probability .92/.98/.94. Sharing coherence NOUL is .86/.81/.81 and broader semantics .87/.90/.87; no rationale or executable proof was returned. The parser now recognizes these forms and 30 tests pass. Only the existing task/notes reference changes; ICU/locale/type validation, message asset closure, standard catalogs and runtime rendering/delivery remain unimplemented.

| Earlier decisions | V1 resolution |
| --- | --- |
| 1–21 | Retain the user goals: adoption, AI authorship, compactness, SaaS scope, one canonical primitive, workerd, shared context. |
| 22–64 | DESIGN §§1–3,5–6 define composition, typing, lexical scope, quantifiers, and the closed statement vocabulary. Explicit scenario types; semicolons separate effects; `by` and `on` have distinct meanings. Domain-shaped magic types and prose effects are removed. |
| 65–89 | DESIGN §4: read policies union row/field grants; operation `by` authorizes mutations. Remove `policy write`. Teams own role management. Auth implementation parameters belong to the pinned runtime release, without extra app syntax. |
| 90–114 | DESIGN §§2,4–5,7: metadata/history are implicit; version and replay ordering are defined. Archive remains a chosen default, not a user mandate. Typed copies plus one declarative `lock` replace snapshot/freeze/immutable variants. |
| 115–139 | DESIGN §§7–8: D1 defaults to a revision-fenced commit; model-level DO ownership is inherited. Remove explicit atomic blocks and hand-written mirrors. Reservation rules use authoritative records, queries, and canonical changes, not overlapping reserve/move/release verbs. Runtime chooses scheduling dispatch. |
| 140–158,160–178,180 | DESIGN §§2–3,6–8: exact money/rounding, UTC versus calendar time, durable delivery, replay horizons, file authorization, and payment uncertainty are specified. Zero-value payments do not call a provider. |
| Calendar/retention/form gaps | DESIGN §§2.1,3,7.1,8–10: anchored pure date helpers, owner-scoped declared expiry and finite typed action forms now have concrete contracts. Earlier open concerns are resolved at specification level; implementation and app workflow coverage remain explicit. |
| Finalized-file example gap | DESIGN §5.1: the existing fixture declaration provisions pinned valid files with normal finalization/authority, stable distinct references and isolated row storage. No file literal or second byte-input mechanism is added; runtime execution remains open. |
| Schema-evolution notation gap | DESIGN §§11.1–11.3: owner-scoped top-level transitions pin exact generated predecessors, explicitly map/drop declarations and initialize typed desired rows. No schema duplication or authored deployment manifest; unsupported transfers and unknown historical facts block upgrades. |
| Exact grammar gap | GRAMMAR fixes lexical/layout, contextual roles, type paths/suffixes, query extents and inline/block forms. The initial syntax parser exercises all 44 sources; semantic checking and runtime execution remain separate unfinished work. |
| i18n gap | DESIGN §9.1 and GRAMMAR define inline keyed variants, readable localized descriptions, declaration-local labels, genuine shared message values, explicit pure imports and ICU profiles. The parser accepts syntax; translation coverage, validation and rendering are not implemented. |
| 159,179 | DESIGN §6: explicit domain events and committed model-change sources; no implicit enum-state or scenario-name events. |
| 181–189 | DESIGN §8: structural contracts, versioned capabilities, deployed adapter implementations, and a finite first-class Cloudflare registry. No app-name magic or runtime contract negotiation. |
| 190–213 | DESIGN §9: bounded daisyUI components and finite themes, defined route/binding/pagination/HTMX behavior, composed boards/calendars/metrics/history. Charts and setup widgets are outside v1. Asset packaging remains implementation work. |
| 214–218 | DESIGN §1: one shared app context, package ownership, explicit imports, files without semantic ownership, and one composed app. |
| 219–223 | DESIGN §§1,9–10: `#` is the canonical description everywhere, `##` is a code comment, app description is required, generated interfaces reuse existing descriptions. |

## Sidebar, personal configuration and draft localization

**USER:** the shared left sidebar, bottom account menu/settings dialog and detailed app-specific daisyUI pages are standard SaaS presentation. Update actual drafts and make i18n seamless. **MINE:** make the shell/base settings implicit, derive navigation only from eligible pages, and use one unnamed `preferences` extension per owner with presentation-only use and runtime canonical self-save/reset. Existing groups/forms handle most layout work; tabs, selected-row split display, detail drawers and declared filter defaults close demonstrated gaps. No extra shell files, authored menu tree, preferences CRUD or settings business tools are added. The prospective repeated history_open schema/caption/wrapper was caught during migration: canonical history owns its runtime-labeled Collapse and shared Appearance controls initial expansion once.

**MINE:** pin exact identifier/type label defaults; preserve domain overrides, source-owned complete messages and labels carried by exported schemas. Declaration-local labels now reference genuinely shared `message` values where the earlier grouped target bindings avoided repetition. Owner captions reuse the first eligible static page title unless genuinely different. Model-caption reuse applies only to matching parameter names; field captions reuse only the same referenced field name. No arbitrary identifier translation or enum meaning inference is accepted. Human notices format explicitly with app-default locale; stored data and machine identities stay unchanged. These remain reviewable design choices.

[Three fresh JEV requests/results](../../design/jev/README.md#frontend-source-and-seamless-draft-localization) favored unnamed preferences and finite defaults. The second retained .22 probability for explicit labels; UI-boundary NOUL values were .93/.91/.89, grouped-label values .88/.86/.89. The probabilities do not prove implementation correctness. Exact type matching, author overrides and actual surface review address the ambiguity; the executable checker/renderer/catalogs remain absent.

## Historical decision audit

This numbered list covers canlang syntax, canonical primitives, semantics, defaults, compiler/runtime boundaries, and generated presentation behavior. Each item is a language design choice or an unresolved language design question.

**USER** marks your explicit language requirements. **MINE** marks a choice I made. **OPEN** marks an unresolved grammar, semantic, or boundary question. A choice remains reviewable even when it currently appears in REQUIREMENTS.md.

Sources: [root language requirements](REQUIREMENTS.md) and the language constructs used in the [draft sources](../../draft). Numbers have been reassigned consecutively for this language-only list.

## Language goals and constraints

1. **USER** — Adoption chances are the primary goal.

2. **USER** — AI writes the language; humans are not the intended authors.

3. **USER** — Token efficiency is essential.

4. **USER** — Repeated boilerplate is a language-design failure.

5. **USER** — The language uses Cucumber-style Given / When / Then semantics.

6. **USER** — The language is specifically for SaaS applications.

7. **USER** — workerd is the runtime.

8. **USER** — Cloudflare-provided services should be first-class language features.

9. **USER** — There is exactly one canonical way to express each basic SaaS primitive.

10. **USER** — CRUD is one of those canonical primitives.

11. **USER** — Authentication is one of those canonical primitives.

12. **USER** — Page definition is one of those canonical primitives.

13. **USER** — canlang handles its own bespoke HTML.

14. **USER** — canlang handles its own bespoke CSS.

15. **USER** — HTMX is preferred for interactions.

16. **USER** — Keep the language free of unnecessary abstractions.

## Source units and shared context

17. **USER** — Permit multiple packages in one .can source file; package boundaries are independent of file boundaries.

18. **MINE** — Support multiple named workflows without a maximum scenario count.

19. **MINE** — Set no maximum source-line count.

20. **MINE** — Judge compactness against the behavior expressed rather than raw line count alone.

21. **MINE** — Put shared guarantees in canonical primitives and runtime semantics rather than repeat them in each application.

## Syntax and primitive declarations

22. **MINE** — Declare an application with app followed by its name; multi-file composition syntax remains undecided.

23. **MINE** — Use indentation to structure declarations and workflow bodies.

24. **MINE** — Use one Given section per package and declare shared app context only once; a small app is an implicit package.

25. **MINE** — Put models, permissions, contracts, and derived values in package Given sections; share app runtime, storage bindings, and authentication without repetition.

26. **MINE** — Keep one When section per package containing multiple named workflows.

27. **MINE** — Express a workflow as scenario name(parameters) rather than repeat complete Given / When / Then blocks.

28. **MINE** — Use lowercase require for workflow guards.

29. **MINE** — Use lowercase then for workflow outcomes.

30. **MINE** — Put canonical CRUD declarations beside workflows in When.

31. **MINE** — Keep one Then section per package for pages and notifications.

32. **MINE** — Use inline record declarations with fields inside braces.

33. **MINE** — Declare ownership or containment through Model in team or Child in Parent.

34. **MINE** — Use named model types as relationships.

35. **MINE** — Use ! for required fields.

36. **MINE** — Use ? for optional fields.

37. **MINE** — Use enum(...) for allowed state values.

38. **MINE** — Use =value for defaults.

39. **MINE** — Put numeric bounds such as >0 or >=0 beside a type.

40. **MINE** — Use a money type rather than unrelated decimal and currency fields everywhere.

41. **MINE** — Include duration, datetime, date, timezone, email, URL, file, JSON, user, and member types.

42. **MINE** — Add domain-shaped types such as time_ranges, dated_time_ranges, weekday_set, and predicate.

43. **MINE** — Use server=... for values clients must not choose.

44. **MINE** — Use derive for computed values.

45. **MINE** — Use projection for an authorized subset of a model.

46. **MINE** — Use contract for an integration payload shape.

47. **MINE** — Use adapter for a declared external capability.

48. **MINE** — Use binding for a Cloudflare resource and its coordination key.

49. **MINE** — Use key=value parameters throughout the draft syntax.

50. **MINE** — Use expressions, queries, conditions, aggregates, and imperative effects inside scenarios.

51. **MINE** — Add create, set, clear, append, insert, upsert, remove, archive, purge, and return as draft effect forms.

52. **MINE** — Use let for a scenario-local calculated value.

53. **MINE** — Use if and else branches for alternative outcomes.

54. **MINE** — Permit compact multi-effect lines instead of requiring one statement per line.

55. **MINE** — Use by=... to select the actor or event source for a scenario.

56. **MINE** — Use by=Model.update and by=crud.delete as hooks on existing operations.

57. **MINE** — Allow explicitly named domain scenarios.

58. **OPEN** — I have not defined a formal grammar for these syntax choices.

59. **OPEN** — I mixed declarative constraints and procedural instructions without a complete execution specification.

60. **OPEN** — Bare identifiers, implicit current records, row variables, parent traversal, and name resolution still need precise semantics.

61. **OPEN** — Implicit operation, revision, and authority-state shorthand still needs precise definitions.

62. **OPEN** — Expressions such as all(Model where predicate), implies, and interval inside coverage need unambiguous quantifier and query semantics.

63. **OPEN** — The exact line between a language primitive, library capability, adapter operation, and app-defined expression remains unsettled.

64. **OPEN** — The syntax exposes considerable bookkeeping in app source; whether that harms token efficiency needs to be questioned.

## Authentication and permission semantics

65. **MINE** — Use auth email password as the drafted authentication declaration.

66. **MINE** — Include sign-in in the auth primitive.

67. **MINE** — Include sign-out in the auth primitive.

68. **MINE** — Include account recovery in the auth primitive.

69. **MINE** — Verify email ownership when an email address authorizes access.

70. **MINE** — Make team support opt-in through a teams declaration.

71. **MINE** — Let team owners manage memberships.

72. **MINE** — Use expiring invitations for team membership.

73. **MINE** — Revoke team access when membership is removed.

74. **MINE** — Preserve historical attribution after membership removal.

75. **MINE** — Make owner-managed role assignment part of the teams primitive.

76. **MINE** — Use policy declarations for record reads and file downloads.

77. **MINE** — Use by declarations to authorize mutations within their scope.

78. **MINE** — Deny access by default.

79. **MINE** — Enforce permissions on server requests as well as page controls.

80. **MINE** — Restrict writes to the CRUD field allowlist.

81. **MINE** — Prevent generic CRUD from changing derived or provider-controlled fields.

82. **MINE** — Give child records their parent's team/ownership scope.

83. **MINE** — Reject cross-team relationships.

84. **MINE** — Require active membership for new member assignments.

85. **MINE** — Require explicit access policies for users outside a record's owning team.

86. **MINE** — Support restricted public projections of private records.

87. **OPEN** — The relationship between policy write=..., scenario by=..., field policies, and multiple overlapping policies is not fully specified.

88. **OPEN** — The exact account recovery method, password policy, session lifetime, and invitation lifetime are not selected.

89. **OPEN** — The boundary between generated team controls and explicit role-management declarations is unresolved.

## Record and mutation semantics

90. **MINE** — Give all records stable implicit IDs.

91. **MINE** — Give all records implicit versions.

92. **MINE** — Give all records implicit creation timestamps.

93. **MINE** — Give all records implicit attribution.

94. **MINE** — Require a current version for client mutations.

95. **MINE** — Reject stale conflicting edits rather than silently overwrite.

96. **MINE** — Give mutations a stable operation identity.

97. **MINE** — Return the saved result for replay of a completed operation.

98. **MINE** — Reject conflicting reuse of an operation identity.

99. **MINE** — Have trusted background sources load current state at the authority.

100. **MINE** — Enforce declared uniqueness in persistent storage.

101. **MINE** — Reject new relationships to archived records.

102. **MINE** — Keep existing references to archived records usable for authorized history.

103. **MINE** — Archive records by default.

104. **MINE** — Allow explicit removal and retention policies to override archival.

105. **MINE** — Use create_fields to distinguish create inputs from update inputs.

106. **MINE** — Use create=none to leave creation to a named scenario.

107. **MINE** — Use snapshot to retain values at a declared point in a workflow.

108. **MINE** — Use freeze to block later edits to declared values.

109. **MINE** — Use history to retain actor/time evidence for meaningful changes.

110. **MINE** — Support immutable record declarations.

111. **OPEN** — Archival as a universal default was my policy choice, not your requirement.

112. **OPEN** — Version checks and operation identities on every mutation may be broader than necessary.

113. **OPEN** — Metadata storage, version granularity, operation-ID generation, replay retention, and history retention are not fully specified.

114. **OPEN** — snapshot, freeze, immutable, immutable_content, immutable_terms, and immutable_amount overlap and may need one canonical form.

## Cloudflare primitives and runtime coordination

115. **MINE** — Expose D1 through the database declaration.

116. **MINE** — Expose R2 through the files declaration.

117. **MINE** — Expose Cloudflare Queues through the queue declaration.

118. **MINE** — Expose Analytics Engine through an analytics declaration.

119. **MINE** — Expose Durable Objects through named binding declarations.

120. **MINE** — Use provisioned deployment bindings rather than infer managed services from workerd alone.

121. **MINE** — Default local mutation scenarios to a D1 transaction.

122. **MINE** — Allow explicit atomic at=D1.

123. **MINE** — Allow explicit atomic at=Authority for a Durable Object transaction.

124. **MINE** — Re-check guards at the authoritative storage location.

125. **MINE** — Commit a primitive's invariant checks and state changes together.

126. **MINE** — Use one authoritative coordinator for a declared reservation resource.

127. **MINE** — Keep D1 mirrors of selected Durable Object state.

128. **MINE** — Allow those D1 mirrors to be eventually consistent.

129. **MINE** — Persist recoverable work to update mirrors after authoritative acceptance.

130. **MINE** — Keep uploads and provider calls outside storage transactions.

131. **MINE** — Preserve pending operations when coordination or provider calls are uncertain.

132. **MINE** — Provide reserve for time intervals and bounded capacity.

133. **MINE** — Provide move that preserves the old reservation on failure.

134. **MINE** — Provide idempotent release.

135. **MINE** — Design queue consumers to tolerate repeated messages.

136. **MINE** — Design queue consumers to tolerate reordered messages.

137. **OPEN** — Explicit D1 mirrors and recoverable cross-service orchestration may expose too much infrastructure in app source.

138. **OPEN** — Consistency guarantees for D1 mutations, replicas, and read sessions remain unspecified.

139. **OPEN** — Scheduling primitives do not yet specify how bindings or Cron/alarm backends are selected.

## Money time notifications and file semantics

140. **MINE** — Store a currency with monetary values.

141. **MINE** — Use deterministic minor-unit rounding.

142. **MINE** — Avoid binary floating-point money totals.

143. **MINE** — Require transaction-time snapshots for monetary values whose configuration can later change.

144. **MINE** — Group unlike currencies rather than implicitly sum them together.

145. **MINE** — Require explicit currency conversion support before combining currencies.

146. **MINE** — Store timed events as UTC instants.

147. **MINE** — Display times in an explicitly configured timezone.

148. **MINE** — Use nonempty half-open intervals [start,end) for timed reservations.

149. **MINE** — Keep date-only and working-calendar arithmetic separate from timed-duration arithmetic.

150. **MINE** — Couple rescheduling with replacement of pending reminders.

151. **MINE** — Persist a workflow's state changes before delivering its notifications.

152. **MINE** — Keep delivery status visible.

153. **MINE** — Use bounded delivery retries.

154. **MINE** — Re-check declared notification guards before dispatch.

155. **MINE** — Suppress obsolete unsent reminders.

156. **MINE** — Define provider-accepted delivery as no longer recallable by the notification primitive.

157. **MINE** — Avoid promising exact-second execution.

158. **MINE** — Avoid promising exactly-once email.

159. **MINE** — Use on for emitted events or committed entry into a named record state.

160. **MINE** — Use at for a scheduled instant.

161. **MINE** — Use every for periodic background work.

162. **MINE** — Tie scheduled notifications to a record revision.

163. **MINE** — Keep provider credentials on the server.

164. **MINE** — Require the payment capability to verify provider results before applying state changes.

165. **MINE** — Match payment account, operation, amount, and currency.

166. **MINE** — Treat browser redirects as insufficient evidence of payment.

167. **MINE** — Treat request timeout as an uncertain result rather than proof of failure.

168. **MINE** — Reconcile uncertain payments using the original operation identity.

169. **MINE** — Give uploads declared MIME-type limits.

170. **MINE** — Give uploads declared byte-size limits.

171. **MINE** — Publish only completed file objects.

172. **MINE** — Support immutable file versions for workflows that depend on retained content.

173. **MINE** — Apply record permissions to file downloads.

174. **MINE** — Declare quotas and retention for high-volume data.

175. **OPEN** — Rounding mode, currency scale, supported currencies, and timezone-data version are not fixed.

176. **OPEN** — Zero-amount behavior for the payment primitive is unresolved.

177. **OPEN** — Generic retry limits, retry schedules, retry horizons, and poison-message policies are not all specified.

178. **OPEN** — Retaining deduplication receipts after raw-data expiry introduces storage and privacy choices not fully resolved.

179. **OPEN** — The distinction between internal events, enum state-entry events, and named scenario completion is not fully standardized.

180. **OPEN** — The delivery record model and the scope of exactly-once logical notification creation still need a precise implementation contract.

## Compiler and capability boundaries

181. **MINE** — Have the compiler understand declared language primitives rather than hard-code application names.

182. **MINE** — Support cross-application connections through declared capability contracts.

183. **MINE** — Resolve adapter endpoints and credentials through deployment configuration.

184. **MINE** — Distinguish browser-safe capability configuration from server credentials.

185. **MINE** — Expose email delivery through a provider-independent capability.

186. **MINE** — Vendor adapters implement only their declared capabilities.

187. **OPEN** — Contract discovery, import syntax, compatibility, and version negotiation remain unspecified.

188. **OPEN** — Mapping declared capabilities to compiler/runtime implementations is unresolved.

189. **OPEN** — The distinction between secret provider credentials and public intake keys must be specified per capability.

## Generated HTML CSS and interaction semantics

190. **MINE** — Make HTMX the default interaction mechanism, strengthening your preference into a draft default.

191. **MINE** — Generate pages through the page primitive.

192. **USER** — Limit presentation to business-app HTML components; the exact customization freedom remains undecided.

193. **MINE** — Generate forms from operation inputs and edit controls from CRUD update fields; explicit field lists express only a subset or different display order.

194. **MINE** — Map canonical presentation declarations to PatternFly components; business views such as boards, calendars, metrics, and charts require defined compositions rather than assumed upstream equivalents.

195. **MINE** — Show only authorized fields and actions.

196. **MINE** — Paginate lists by default.

197. **MINE** — Include loading states.

198. **MINE** — Include empty states.

199. **MINE** — Include error and conflict states.

200. **MINE** — Preserve invalid or unsaved form input.

201. **MINE** — Use accessible forms.

202. **MINE** — Escape user content by default.

203. **MINE** — Generate standard authentication and team-management controls.

204. **MINE** — Use private caching for generated pages containing user-specific data.

205. **OPEN** — Routes, model lookup from path parameters, pagination limits, search behavior, and query indexes need precise definitions.

206. **OPEN** — The bespoke CSS syntax, design tokens, default layout, and HTMX response semantics remain unspecified.

207. **USER** — Make PatternFly components first-class to avoid repeating presentation tokens.

208. **MINE** — Use PatternFly HTML/CSS as the built-in presentation foundation, with no imports, repeated namespaces, or per-page HTMX marker.

209. **OPEN** — The complete supported component catalog, business-view compositions, and any additional rendering dependencies remain to be defined; fetching components and optimizing assets are deferred.

210. **MINE** — Use scope-transparent Card groups, page title attributes, and attached # page descriptions to express visual hierarchy without repeating shared styling.

211. **MINE** — Supply shared app branding, authorized navigation, responsive spacing, typed value formatting, and labeled statuses as presentation defaults.

212. **MINE** — Open forms in a Drawer by default, allow display=inline for frequent inputs, and begin inline edits in read mode.

213. **MINE** — Support contextual collection empty messages and a separate no-match state that clears only user-selected filters; keep nested collections and history reachable in expandable details.

214. **MINE** — Give each model and its canonical CRUD one owning package and reuse them through cross-package references.

215. **MINE** — Compose packages into one app runtime, UI, and MCP interface without introducing separate services or authorization systems.

216. **OPEN** — Explicit package declarations, app composition, and cross-package references still need syntax; file placement must not determine ownership or visibility.

217. **USER** — Default small generated apps to one file and organize larger apps into coherent package files, with folders only when useful and no arbitrary size/count thresholds.

218. **USER** — Keep related models, permissions, workflows, and pages together; make cross-package references explicit and discoverable for agents.

219. **USER** — Use # above a declaration for its first-class description, including visible page supporting text and MCP descriptions; use ## for ordinary code comments excluded from both.

220. **MINE** — Keep descriptions and code comments non-executable; descriptions cannot define or override executable rules, and standard CRUD descriptions need no repeated source descriptions.

221. **USER** — Require an overall application description.

222. **MINE** — Attach the canonical app description with # above app and reuse it as MCP initialization instructions, without repeating it in each tool description.

223. **USER** — Make # the canonical declaration description syntax, including pages, to keep source easy for humans to understand; replace description= metadata with attached descriptions.

## Token repetition audit

Audit date: October 3, 2026. Scope: all 44 `.can` files, comprising 39 business app sources, three shared package files and two reference examples. Before this audit: 315,177 UTF-8 bytes, 4,077 nonempty code lines and 370 description lines. Keyword counts exclude strings and comments. Counts distinguish declarations from ordinary words where a word also names a field or function. These are source measurements, not tokenizer measurements or a benchmark of AI generation.

The copied R2 declaration was a violation of the repetition requirement. Its 10MiB/PDF/PNG/JPEG/plain-text baseline is now defined once in DESIGN, and runtime-reachable `file` declarations imply R2. Required setup is not made acceptable by calling it explicit configuration. Apps declare actual differences, not copies of the baseline. The prior choice to preserve those declarations is superseded and recorded in AGENTS.md.

### Applied reductions

| Repeated source | Before | After | Meaning supplied implicitly |
| --- | ---: | ---: | --- |
| Uniform `files R2 types=... max=10MiB` | 38 | 0 | The versioned file primitive supplies R2 and the same upload limits; authorization remains separate. |
| `context` blocks | 39 | 2 | No block for unchanged defaults. The two remaining contexts declare real named queue/analytics resources. |
| `delete=archive` on CRUD | 5 | 0 | Archive is the existing canonical deletion default. All 66 `delete=none` and six `delete=remove` exceptions remain. |
| `create_fields` identical to `fields` | 5 | 0 | Creation already inherits the update allowlist unless explicitly different. Twenty-seven distinct `create_fields` lists remain. |
| `lock ... when=true` | 53 | 0 | A missing lock predicate means always locked; the 18 conditional locks retain their predicates. |

The corpus is now 311,132 bytes and 4,002 nonempty code lines: 4,045 bytes and 75 code lines removed. A snapshot comparison permits only those listed edits. Policy/guard expressions, `by`/`on`, all 254 operations, 71 locks, 43 example tables, enabled/disabled deletion behavior and descriptions are preserved. Effective file policy is preserved through the new default, and unconditional locking is preserved through its omitted-predicate semantics. No compiler/runtime has executed these rules.

### Remaining structural repetition, ranked by opportunity

Import grouping and required scalar defaults are now adopted by explicit user instructions and specified in DESIGN. The other reductions in this historical table remain proposals; lowercase `then` has been renamed to `do`, not removed. Counts below retain the original audit context. A JEV judgment alone does not adopt a spelling.

| Form | Occurrences before audit | Proposed implicit meaning or canonical reuse | Constraint |
| --- | ---: | --- | --- |
| Required-field `!` | 816 | Bare scalar types are required, matching existing operation parameters. Keep `?`, `=default` and `server` as actual differences. | Eighteen array markers mean required input instead of default `[]`; preserve them. The three JEV answers favored the scalar default but confidence varied substantially. |
| `scenario` and lowercase `then` | 254 each | A typed named declaration inside When is the operation; its ordered indented statements are its body. No second effect wrapper. | Keep explicit caller `by` versus trusted `on`, type checking, source order, atomic rollback, descriptions and attached examples. Uppercase Given/When/Then remains. |
| Individual `use` declarations | 305 | Name the owning package once and enumerate the exact imported symbols, with aliases and binding retained. | Group only within the same consumer package, provider package and deployment binding. No wildcard/global name guessing or provider execution. |
| `role ... in=team` | 67 declarations | Roles already have only the team scope: omit that repeated qualifier. | Scope omission must not grant or assign a role. Owner-managed assignment remains. |
| Root-model `in team` | 46 declarations | A bare stored model defaults to the app's team scope. | Preserve `in Parent` and `in app`; ownership defaults cannot replace read/write policies. |
| `capability ... version=1` | 19 declarations | Pin initial capability version 1; spell only another version. | Keep the version in emitted contracts, compatibility checks and deployment bindings. Do not infer it from a name or negotiate it at runtime. Not separately judged in this JEV round. |
| `limit=N` on loops | 61 | A defined runtime budget could default where equivalent, or proven unique lookups could derive cardinality. | Thirty-three loops assert at most one result, 22 allow 100, one allows 10, five allow 500. A modal value is not evidence of interchangeable meaning; never silently truncate. Further proof is needed before removal. |
| `app ... uses=[...]` | 47 | Adopted: an implicit package uses its existing app identity; multiple small apps compose without wrapper packages. | Do not infer membership from filenames/neighbors. The former collision restriction on multiple implicit `main` packages is superseded; actual route/resource conflicts remain. |
| `export` | 90 declarations | Public-interface membership could eventually eliminate an export modifier only where the exact exported set is already declared canonically. | Current app selection does not specify symbol visibility. Default-exporting everything exposes more names and is not equivalent. No redundant export list was added. |
| `package`, `Given`, `When`, `Then` | 49 named packages; 50 of each section | The small-app form already omits `package`; keep one triple per logical package and shared fixtures per behavior family. | These distinguish ownership, declaration/behavior/presentation and the user's BDD model. Do not remove BDD meaning to reduce keyword counts. |

The adopted grouped-import spelling is `use employee {can_work,staff,test_worker}`. The completed migration yields 167 import groups instead of 305 lines, removing 138 declarations and 2,001 UTF-8 bytes. Single-member brace overhead is included. This is measured source size, not proof of fewer model tokens; DESIGN now specifies the canonical grammar and alias/binding rules. The earlier JEV choices favored grouping, and the later NOUL results were consistently positive; adoption comes from the user's explicit instruction.

For operation syntax, the proposed compression is:

```can
When
 # Complete an open task.
 complete(task:Task) by=members
  require not task.done
  set task {done=true}
```

This would replace the current `scenario` introducer and lowercase `then` effect marker, retaining the enclosing When and the operation's actual conditions/effects. There are 154 standalone lowercase `then` lines and 100 inline ones; removing wrappers could also remove 154 lines and one indentation level. No new workflow layer or step-definition files are involved. All three JEV reviews favored removing both markers. This example is a proposal and must not be copied into current sources as accepted grammar yet.

Required scalar and team ownership/role defaults are now adopted. The canonical forms are `Todo {title:text,done:bool=false}` and `role reviewer`; explicit `in Parent` and `in app` remain. The former team qualifiers are invalid redundant syntax. These defaults never imply `read=members` or `by=members`. The audit counts and earlier JEV results remain historical; the fresh scope review and migration are recorded in the current status and consultation log.

### Frequent syntax that carries dataflow or business meaning

| Word/form | Count before audit | Audit judgment |
| --- | ---: | --- |
| `row` / `parent` | 1,136 / 816 | Keep lexical record/containment references; implicit fields must not bind to the wrong record. Reuse a declared typed predicate only when the relation and context are identical. |
| `and` / `or` | 1,075 / 221 | Keep actual conjunctions/alternatives. A shorter predicate must retain every permission and state condition. |
| `actor` / `event` | 665 / 551 | Keep caller versus verified-source identity explicit; do not infer privilege or business ownership. |
| `as` | 545 lexical occurrences | Query aliases, created records and delivery receipts need precise bindings. Some occurrences are test actor selectors. No implicit global/record fallback. |
| `require` | 428 statements | Keep guards, invariants and page gates. Shared runtime guarantees need no app copy; genuine business checks cannot be removed merely because they recur. |
| `by=` / `on=` | 273 / 65 | Keep user authorization versus source-triggered handlers; never default missing authority to members. |
| `policy` | 249 statements | Keep row/field grants and default denial. Factor identical policies only with explicit scope and preserved grant union; do not infer permissions from CRUD or role names. |
| `where` / `select` | 262 / 44 lexical occurrences | Keep filters/projections, including ownership and freshness. Existing whole-record select and stable-order defaults already cover unchanged cases. |
| `set` / `create` / `send` | 254 / 178 / 110 lexical occurrences | These denote different effects or operation references. Sends are delivery intents, not confirmed business results. No automatic effect chosen from a model/field name. |
| `if` / `else` / `for` | 126 / 58 / 61 statement heads | Keep branching/iteration behavior and failure/unknown handling. Similar status branches do not imply identical provider mapping or compensation. |
| `when=` | 153 before, 100 after | The 53 true lock predicates were redundant. Remaining state/dispatch conditions need preservation. |
| `fields=` / `create_fields=` | 206 / 32 before | Identical allowlists were removed; different allowed inputs control workflow and cannot become every field automatically. |
| `lock` | 71 declarations | Keep immutable evidence. Only its universal true predicate was made implicit. |
| `server=` | 42 attributes | Record creation metadata is already implicit. Explicit action attribution/time may denote a later business moment or trusted source; equivalence must be demonstrated before replacing it. |
| `min=` / `max=` | 56 / 47 attributes before | File maxima were uniform setup and were removed. Domain bounds and normalization are not interchangeable; changing required text to nonblank/trimmed by default needs an app-by-app semantic check. |
| `unique` | 73 lexical occurrences | Keep business uniqueness declarations. Standard record IDs and replay identities are already runtime guarantees. |
| `trim` | 122 lexical occurrences | Some are field normalization and some are explicit expressions. A universal trimming rule can change content or matching semantics; do not infer it from a field name. |
| `return` / `schedule` / `emit` / `call` | 13 / 19 / 22 / 5 lexical occurrences | Preserve result shape, durable timing, declared events and canonical invocation. Their low-frequency markers are not the main waste. |
| `from=deployment...` | 53 imports | Keep installed external boundaries explicit; package grouping may share the binding expression when it is the same. No automatic connection or local provider inclusion. |

The `can_work` pure predicate appears in 271 calls plus its declaration/import references. Location imports repeat on 40 lines, `can_work` imports on 38, test-site imports on 33, and test-worker imports on 30. These are the largest identical dependency lines after setup removal. Grouping imports removes redundant package qualification, while the underlying function remains business-defined. Some checks may share a pure typed predicate; the compiler must not know what an employee/location in these particular apps means. For example, `staff(actor) and (location==null or can_work(actor,location))` cannot lose its staff check merely because `can_work` itself checks staff: the null-location branch would then admit a different caller.

Repeated `role finance` names in different packages are not automatically one role definition: current role identities are package-qualified. Merging them without a declared canonical owner can broaden privileges. Similarly, repeated state enums, charge/result fields and copied commercial values can represent distinct workflow states or immutable evidence. Type/contract reuse is appropriate for an identical schema, but no shared mutable field should replace a committed snapshot.

### Types, presentation and examples

Type words are frequent because they declare real schemas: `text` occurs 700 times, `datetime` 231, `int` 131, `bool` 119, `enum` 80 and `date` 62. `text` also introduces visible UI content. Defaulting all unknown fields to text or guessing types from names would hide validation and break typed integration/MCP behavior. Reuse `Model.field` and named structural contracts where their types/constraints are the same. Requiredness punctuation and team scope offer savings without removing the actual type.

Presentation statement heads include 116 forms, 116 lists, 85 tables, 86 pages, 69 edits and 47 history declarations. Field-appropriate controls, submission feedback, common style, HTMX and page chrome are already implicit; a bare `form operation` and `edit` reuse canonical inputs. Declaring those controls means they are intentionally available in that view. Auto-showing every authorized CRUD action, field or history would change the product, especially for sensitive records. Keep genuinely selected columns/filter/order/title/action choices; omit an attribute only when it is identical to the specified component default. `columns=` occurs 85 times, `filter=` 48 and `search=` 20. A table's complete readable-field default is a possible future reduction, but the current source does not prove these explicit field lists equal such a default.

There are 89 fixture declaration heads and 43 example blocks in the complete corpus (40 blocks in the app drafts). Existing fixtures/schema references already avoid separate BDD step definitions. Keep concrete initial state, actors, stale versions and independently authored expected results. Repeated success/failure rows do not justify deriving expectations from the implementation. The `->` character sequence appears 194 times across example rows/headers and typed signatures; it is not one removable keyword.

Descriptions account for 370 lines. Generated CRUD descriptions already avoid repeated metadata, and the app description supplies shared MCP context. Custom operation/page/package descriptions distinguish effects and intent. Keep meaningful information and remove any literal restatement of a declaration only after checking that no integration/page documentation loses needed semantics. A mandatory description quota or extra documentation layer is not a token-saving mechanism.

### Result and remaining decisions

Uniform setup and default-equivalent attributes are fixed. Grouped explicit imports, required scalar defaults, team ownership/role defaults and app-derived implicit package identity are now adopted. Direct named operations remain a substantial grammar proposal. Capability-version defaults and bounded-loop/cardinality inference need additional specification. Implicit-app composition no longer requires wrapper packages or manifests; its naming, import, deduplication and source-body boundaries are defined in DESIGN.

Three independently reworded JEV reviews agree on the alternatives they selected, but requiredness and the file baseline show strong confidence variation. [Exact evidence](../../design/jev/README.md#repetition-audit) records all choices, probabilities and uncertainty. Agreement does not authorize dropping business conditions or prove the candidate syntax. The subsequent user instruction adopted grouped imports alone. The other larger grammar proposals remain open; this audit introduced no automatic business-rule inference, global imports, generic UI exposure, new build registry or verification framework.

The user then requested using NOUL questions. Three [independent yes/no reviews](../../design/jev/README.md#noul-review-of-open-repetition-proposals) reassessed the open candidates with equivalent evidence and rewritten wording. Returned yes probabilities are: scalar requiredness 0.65/0.84/0.27; team models 0.64/0.49/0.68; team roles 0.48/0.76/0.75; implicit operation declarations 0.61/0.38/0.43; direct bodies 0.59/0.24/0.58; grouped imports 0.78/0.74/0.78. These values are not choice-confidence scores or a correctness benchmark. Grouped imports are the most consistent candidate in these calls; the rest exhibit substantial uncertainty. No averaging/cutoff makes them accepted syntax. At the end of this NOUL review, the proposals remained unadopted; the user subsequently authorized import grouping alone. The assistant wrongly made NOUL a future default; the user's correction is now recorded in AGENTS.md. NOUL, choice and score remain available according to the actual question.

## Draft contract refinements — October 4, 2026

These are language/target decisions, not per-app business policy or implementation. The source packets and nine full consultations are linked in [the evidence index](../../design/jev/README.md#draft-contract-refinements-october-4-2026). Advice was considered alongside source behavior; probabilities were not approval thresholds.

- Resolve lexical bindings before expected enum cases; a type mismatch never changes a token's identity.
- Permit nested authored scopes while protecting active injected context facts; reject duplicate bindings within one scope.
- Evaluate signature defaults left to right using earlier resolved parameters.
- Define the complete checked operand/result/rounding matrix; int/int and duration/duration division produce decimal ratios, with nonempty-literal aggregate narrowing.
- Give every existing builtin a finite signature; restrict plain-template Display interpolation to representations with specified canonical output.
- Resolve BDD override cells against untouched seeded state and reject overlapping/aliased paths.
- Evaluate permission decisions and invariants with bounded owner authority; retain viewer filtering/disclosure rules on outputs.
- Keep ordinary row versions stable during an operation; accepted writes reserve one resulting version, even for no-op writes. Hook-after exposes that reserved version.
- Give authored require uniform business rejection semantics; lifecycle skips remain separate.
- Route recurring D1 work per verified team/app scope; root-bound every remains unsupported pending authoritative coverage and uses explicit schedule.
- Finalize file-valued remote results in the receiving app before successful completion, with delivery-specific attachment provenance.
- Allow optional page-only GET poll; retain explicit source-refresh operations and their authority. Scoped collection polling remains unadopted.
- Extend collection order with one owned-preference default/exception map; do not repeat collection bodies or unchanged enum alternatives.
- Use shared explicit-zone datetime controls, pinned DST resolution, finite typed filters and safe exact-title/name/full-identity record labels.
- Normalize handwritten JavaScript read grants, lock/invariant references, field schemas and import modules; preserve permissions and operation semantics. Shared UI owns daisyUI markup/classes and standard HTMX behavior.

JEV selections disagree on versions, recurring routing, handler rejection, polling scope and saved ordering. Workflow-bundle coherence is .36/.36/.33; frontend coherence .78/.74/.84; static catalog coherence .87/.80/.83. The adopted boundaries follow ordered effects, current BDD expectations, explicit runtime coverage limits and token-efficient defaults, rather than vote counts. Write-intent versions produce no-op audit noise; uniform require marks stale authored checks as failures; page polling rereads more broadly than a scoped collection; an order default intentionally covers future enum values. These costs remain visible.

Compiler/library implementation, browser/runtime measurements and behavioral execution remain deferred. The current refinements do not claim all app requirements are authored or executable.


### Declared-role subject predicates — October 4, 2026

Adopt `declared_role(person)` for checking another account in the current verified team; keep the bare role for literal actor checks. This reuses role declarations and call syntax without a separate role table or dynamic role type. `active_member(person,team)` remains membership-only. Subject checks do not authenticate/impersonate actor or grant record reads. CRM prospective assignment now checks this predicate as well as active location authority.

The three JEV reviews disagreed: role-call/builtin/membership probabilities were .62/.35/.03, .30/.50/.20, and .59/.29/.12; choice confidences .43/.26/.39. Common-authority NOUL values were .87/.65/.46. The builtin alternative makes the declaration operand explicit but still needs special resolution, while the membership overload repeats team and mixes concerns. The role-call choice follows compact source and existing callee resolution, not a majority rule. The disagreement prompted explicit rules for literal actor spelling, inactive members, package identity, no-team contexts and no actor narrowing. Evidence is saved under `design/jev/draft-role-subject-20261004-*`.


### Reviewed CSV forms and trusted links — October 4, 2026

Adopt explicit `import=csv` on the existing canonical mutation form and optional `review=readOperation` for app-owned duplicate semantics. This avoids repeating operation schemas in batch wrappers while keeping intake an explicit app capability. Import uses per-row ordinary transactions and stable identities, never automatic merging or all-or-nothing claims. Standard CSV mechanics/limits are defined once; candidate reads remain ordinary authorized business reads. CRM and Customer now use this contract. Adopt `app_url(path)` against the trusted configured public origin to generate outbound links without repeated domains or another route registry; opaque existing record IDs locate the offer route while its verified-recipient policy authorizes it.

JEV form probabilities were 1.00/.99/.98; batch-scenario .00/.01/.02; automatic .00/.00/.00, confidences .99/.98/.97. CSV-semantics NOUL .95/.86/.93 and trusted-link NOUL .86/.89/.89 remain advice rather than correctness proof. The form proposal was developed more fully than its alternatives; agreement does not remove that framing limitation. Source review additionally pins nullable cells, protected bound inputs, transient upload lifetime, current review authorization and same-batch new-candidate confirmation. Exact requests/results and wording checks use the `draft-import-links-20261004-*` prefix.


### Source projection refresh — October 4, 2026

Adopt explicit page `refresh=Operation` alongside `poll` for bounded active-session canonical POSTs after one successful explicit input submission. The shared trigger has no background service identity, retains no secrets, coalesces outstanding delivery chains, hides stale action handles and cannot refresh itself recursively. GET polling remains unchanged. CanDo uses the existing refresh operation and owner-produced authorized lists/details; optional authenticated source invalidation requires a real installed mapping.

The three JEV distributions split: adapter/session/defer .55/.41/.04, .43/.45/.12 and .36/.60/.04; confidences .33/.16/.40. The current-source automatic-freshness NOUL values were .09/.06/.11. Active-session reuse was selected because it retains actual user authorization and existing source interfaces; it does not supply unattended refresh. This is a requirement-matched scope: CanDo accepts configured polling. Evidence uses `draft-work-refresh-20261004-*` and preserves uncertainty.

## Cumulative billing evidence — October 4, 2026

The invoice-owned `Settlement` is a cumulative snapshot shared by `Billing.settled` and `Billing.reconcile(source)`. It carries the immutable source/invoice/charge total, confirmed collected and refunded totals, separate unresolved collection/refund flags, invoice lifecycle state, observation time and a dedicated monotone ledger revision. Child Attempt updates cannot safely use an unchanged Invoice record version as their ordering key. The owner advances the ledger revision within the same transaction as every relevant monetary or uncertainty change and emits the resulting committed snapshot. A nullable reconciliation result means no current source record; it does not fence a delayed charge. Cancellation therefore retains an owner cancellation fence independently of invoice existence.

Consumers compare original charge amount/currency, reject older ledger revisions and derive admission from cumulative net receipts and unresolved attempts. Invoice issuance does not establish payment; a partial refund is not another original-charge receipt. Source refund submission reports pending until provider evidence confirms its amount. Owner ingress mappings preserve operation kind and verified delivery causation; results are never inferred from a matching business source alone.

Three fresh reviews selected snapshots with probabilities .98/.90/.83 and confidence .98/.84/.74. Alternatives were complete deduplicated delta replay and separate notification/status DTOs. The proposed snapshot was described more fully, a recorded framing limitation; these judgments support a choice but neither prove correctness nor remove bias. The concrete child-version defect and bounded consumer state justify the decision. [Requests, responses and wording check](../../design/jev/draft-billing-evidence-20261004-wording.md) retain the evidence. This is an application-owned interface change using existing constructs.

## Payment consent, cancellation and failure evidence — October 4, 2026

The standard payment contract now makes current customer-bound consent a dispatch responsibility of `collect`, adds `cancel(reference)` without pretending uncertain accepted money is gone, and distinguishes definite transient/action-required/permanent/cancelled failure. Per-attempt revisions preserve observation order. Invoice owns finite retry dates and source-cycle consent; no second eligibility read can make a future payment safe. These are shared interface definitions, not provider implementations.

Three rewritten reviews favor dispatch validation over adding a preflight read with probabilities 1/.99/1, confidence 1/.99/1; NOUL sufficiency judgments remain .82/.85/.69. The decline in the third sufficiency result is retained: cancellation and receipt normalization are real adapter obligations, not guarantees created by spelling the methods. Proposed dispatch semantics were elaborated more fully than the alternative, so unanimity does not establish framing neutrality. [Saved evidence](../../design/jev/draft-payment-boundary-20261004-wording.md).


## CRUD candidate visibility and nested collections — October 4, 2026

CRUD admission receives normalized proposed fields before that write is staged. Queries inspect prior provisional owner state; update scans still contain the previous row. This separates admission from final invariants and prevents create aggregates from inconsistently counting their candidate. The same create/set callback contract applies across desired targets. Add one explicit bounded `flatten` builtin for nested interval projections: one homogeneous layer, stable order, no deduplication or implicit projection change, and failure on any work/size overflow. Existing group/order/duration aggregates express interval measurements after expansion.

Three JEV choices favor prewrite visibility at 1/.97/.88 versus staged 0/.03/.12, with confidence 1/.93/.76. Flatten NOUL values are .66/.63/.46, so the last review does not favor sufficiency. Investigation distinguishes expansion from union measurement: flatten alone does not calculate interval unions; existing grouping/ordered endpoints and duration sums supply that work. The immutable source vocabulary lacked dynamic concatenation, which is the narrow gap addressed. This remains a draft contract, not proof of executable reporting. The developed candidate framing was more detailed than its alternative and is recorded as a limitation. [Requests and results](../../design/jev/draft-query-admission-20261004-wording.md) preserve all evidence.


## Given invariant spelling adoption — 2026-10-04

The user approved `invariant path: expr` as the sole Given invariant declaration spelling, replacing `require path: expr` without an alias. Target paths, the colon, predicate structure, `row` scope and validation behavior are unchanged. `require` remains the execution guard, presentation gate and migration/backfill check; both words remain contextual names. The parser, active specification/examples and authored sources adopt this spelling. The preceding JEV consultations informed the review as advice; adoption comes from the user's explicit approval, and neither classifier agreement nor syntax checks prove executable correctness. Historical proposals and consultation evidence retain their original wording.

## Same-team account fixtures and explicit callers — October 4, 2026

Extend the existing fixture recipe with `fixture name=user {roles=[role]}`; `{}` means an ordinary active current-team member. Each canonical declaration supplies a distinct isolated identity. Select that account with `as=name`; explicit self/other callers and existing role-to-self selectors have deterministic meanings. Grants on user fixtures remain present when another account invokes the operation. Recipes load through the existing input/seed/dependency rules, preserve import identity and never become production account constructors. File-owner recipes may reference these accounts without changing attachment authorization.

Three fresh JEV choices prefer user recipes over header actor maps or deferral: .92/.99/.81, with confidence .88/.99/.72. Actor maps receive .06/.01/.18; their table-local discoverability remains a genuine benefit, while shared fixtures avoid another reusable identity-binding surface. Candidate descriptions were more developed than the alternatives, a framing limitation. See [complete consultation and uncertainty](../../design/jev/fixture-actors-20261004/assessment.md). No score is an approval threshold. ExpenseFlow preserves legacy cases and adds syntax-checked named-caller/noncaller-grant witnesses. Account provisioning and semantic execution remain proposed. Isolated seeded rows do not execute a multi-operation claimant/reviewer/finance journey; shared-state journey authoring remains a separate gap.


## Stored fixture validity and shared-state examples — October 4, 2026

Model fixtures are typed stored snapshots, not client creation requests. Explicit domain `server=` values are allowed, including historical authorship, while runtime ID/version/audit metadata remains generated and all final stored-data/file constraints apply. An invalid setup can never satisfy `error(code)`. A snapshot establishes neither the historical actor's authorization nor execution of prior transitions. Clarify external caller selection as `outsider` with no current-team membership; bare `authenticated` is a production predicate, not a test selector. Exact expected errors follow actual admission and the first failing authored check.

Choose an attached `examples` block with a `do` sequence for shared-state journeys; retain tables for single invocations. Explicit typed canonical calls each select a provisioned identity with `by`, admit and commit independently, and can assert an exact per-call error while retaining earlier commits. Pure bindings and independently written observation arrows remain inside `do`; no direct state/grant patching, production workflow wrapper or copied step handler is added. At least one explicit call must target the enclosing scenario. Typed result bindings cannot invent return values, and stale-version overrides alter only the wire request. Fixed user-fixture grants prevent role selectors from silently changing permissions between calls.

JEV disagreed about notation: attached/package/defer probabilities were .39/.59/.02, .93/.05/.02 and .45/.50/.05, confidence .38/.90/.25. An independent named package journey has real discoverability and body-uniformity benefits. The attached form was chosen for one existing test home and fewer declarations, with an explicit body discriminator, mandatory owning-operation call and no implicit invocation resolving the main ambiguity. This is a design judgment under uncertain advice, not majority voting or a threshold. Stored-snapshot fixture probabilities were .96/.83/.88, confidence .92/.67/.75. [Complete requests, responses, wording checks and investigation](../../design/jev/fixture-journeys-20261004/assessment.md) preserve the disagreement and framing limitations.

The reference ExpenseFlow sequence traces submission, forbidden/stale reviewer attempts, successful review and a rejected repeated review while preserving the committed state. Full Expense business journeys use the same construct through their app owner. The initial parser deliberately remains unchanged and rejects the new sequence body; checking, provisioning and runtime execution are unimplemented. Proposed source/target contracts and manual traces are not executed BDD passes.


## Compiler-derived page admission and shell descriptors — October 4, 2026

Use one generated descriptor per owning page: canonical owner/route, static localized title/description and optional placement exceptions, plus a shared admission callable and renderer. Navigation and direct/partial dispatch reuse admission derived from inherited auth/team context and the source page's own guards. Do not render unrelated pages, infer permission from nonempty lists, or execute action/body queries during discovery. Necessary bounded pure dependencies of a data-sensitive page guard are permitted and remain private; guard-needed bindings are reused by actual rendering at the same checkpoint. Nested groups retain local gates, public catalogs can contain protected actions, and empty permitted views stay reachable. Unavailable checks do not become denial or cached permission.

Three fresh JEV reviews chose derived admission with probabilities .99/.70/.83 and confidence .98/.54/.75. The second assigns .21 to context-only candidate links; the third assigns .16 to requiring data-gated pages to opt out of navigation. Their real benefits are avoiding business reads during discovery and reducing work, while respectively weakening current-eligibility meaning or hiding legitimate destinations. The chosen contract preserves current entry semantics while explicitly allowing only necessary guard reads, with bounds and failure reporting. This is not proof of zero-query or cheap navigation; candidate elaboration remains a framing limitation. [Full facts, independently reworded requests, results and review](../../design/jev/page-discovery-20261004/assessment.md).

No new `.can` navigation syntax, compiler, renderer or library implementation was added. The desired target descriptor replaces path/render-only registries and duplicate renderer metadata/guards through target owners. The illustrative Expense witness and manual CRM/Expense mapping establish the intended contract, not runtime behavior.

## Shared chatbot attachment handoff — October 4, 2026

Reuse the existing browser upload intent/content/finalization flow through one versioned host bridge, advertised as generated MCP metadata. A supporting host transfers actual selected bytes and passes only the finalized opaque reference into the canonical business operation. Registry-derived field/context binding, current principal/team rights and final business checks stay authoritative. Unsupported hosts require the browser handoff or an explicit limitation. No additional `.can` upload lines, binary business tools or per-app schemas are added.

Three fully rewritten JEV consultations assigned the host-flow option .80/.81/.64, runtime tools .02/.03/.03 and browser-only .17/.16/.33, with confidence .70/.72/.46. Browser-only's real benefit is avoiding an extension; its extra handoff explains the reasoned choice of shared host support plus truthful fallback. Agreement does not establish compatibility, security, performance or adoption. [Saved requests/results, wording check and assessment](../../design/jev/mcp-file-handoff-20261004/README.md#source-assessment) retain uncertainty and framing limits. DESIGN §8 pins the concrete bridge contract; implementations remain omitted.


## Associated delivery references — October 4, 2026

Use `delivery(Target)` with existing send/set to associate the runtime-owned current attempt, replacing only duplicated transport mirrors. Explicit business callbacks, frozen outcomes and validated attachments remain. The reference derives its result schema, protects origin/binding authority, fences mutable receipt observations without domain version churn and retains only safe summary evidence beyond sensitive-content expiry. Complete typed test requests provision isolated receipts; they never establish a real send or its guards.

Three rewritten JEV choices prefer typed association .98/.88/.96, field-scoped effect sugar .00/.02/.02 and explicit mirrors .02/.10/.02, confidence .96/.81/.94. Explicit mirrors have real domain-version/retention benefits; retaining independently meaningful business evidence and defining read fencing/summary lifetime addresses those costs without implicit completion hooks. [Full contracts, alternatives, wording checks and uncertainty](../../design/delivery-association-20261004.md). This adopts a draft contract and desired JS helper, not library/compiler execution or measured adoption/performance. App application is tracked separately in MIGRATION.


## Authorized person selection — October 4, 2026

Retain canonical user input/attribution, add optional explicitly readable Employee work names and use an ordinary eligible-candidate read in Expense. Browser/MCP share its operation; names never become identity or permission, private HR fields remain withheld, and submit rechecks actual role/work eligibility. No auth-directory primitive, separate picker schema or automatic extraction of mutation guards is added.

JEV Employee-label/directory/Employee-reference probabilities were .98/.00/.02, .95/.00/.05 and .73/.22/.05, confidence .97/.92/.60. The third directory probability warrants attention: central auth names could reduce maintenance, but current sources define no profile disclosure to reuse. [Saved full consultations and current witness](../../design/person-selection-20261004.md) retain that tradeoff. The optional name avoids fixture boilerplate; Expense adds eight single-call rows and a real deactivation selection sequence. No executed picker, privacy or adoption proof is claimed.


## Status-only associated receipt permissions — October 4, 2026

Grant the exact embedded-value leaf needed by a readable derive, preserving existing dependency checks rather than granting its entire private receipt. Mail explicitly adds notification.status. Value-leaf selectors cannot traverse other records or expose containers/siblings; null traversal and serialization stay scoped. One record/field/selected-property delivery observation preserves provenance and current grant checks, replacing the earlier handle-only helper; partial status objects cannot become handles. Stored ID correlation uses that same locator, while current-send/provisioned-fixture immutable IDs keep their originating authority. Derived enum/bool labels reuse the existing caption/value map, preserving Mail's wording.

JEV disagreed with low confidence: leaf/read/mirror .65/.10/.25, .46/.44/.10 and .38/.54/.08, confidence .47/.18/.32. An explicit authority read is a valid existing alternative, with a different per-item operation/result interaction; mirrors preserve existing permission/version behavior but repeat runtime state. The leaf contract is chosen to preserve the status-only column while eliminating those copies, with its checking/provenance costs stated rather than treated as free. [Full consultations, alternatives and source/JS/BDD boundary](../../design/delivery-leaf-grants-20261004.md). No runtime privacy/serializer/fence pass is claimed.

## Owning CRUD publication exception — October 4, 2026

Keep lifecycle enablement distinct from public publication. Optional `expose=create,update` (or sole `none`) controls one owner's generated interfaces; omitted means all enabled CRUD. Internal calls retain the same registry, admission, deletion lifecycle and history. Explicit excluded public references are errors, not a second endpoint. This addresses unusable direct reasonless delete discovery without claiming an authorization bypass or forcing another product wrapper.

Three JEV requests prefer the allowlist .84/.53/.83, with confidence .75/.29/.75; the middle default alternative .47 is a real near tie. The safe default remains cheaper where intentional public-interface restriction is unnecessary. [Exact Can/JS/BDD witness and saved advice](../../design/canonical-exposure-20261004.md) distinguish canonical invocation tests from unexecuted interface discovery. No compiler or publisher implementation is added.


## Initial delivery fixture attributes — October 4, 2026

Reuse ordinary table selectors to vary the whole status/result/error of a directly named delivery recipe. Freeze its complete request against untouched baseline setup; combine and validate initial attributes, model associations and result-file provenance before provisioning the protected receipt once. No receipt mutation, request/authority patch, descendant selector or sequence-time fixture edit is introduced. Keep separate recipes only for differing requests or independently required attempt identities.

Three fresh JEV consultations chose initial selectors with probabilities .81/.94/.95 and confidence .72/.91/.93. Separate-recipe probabilities .14/.05/.03 and existing-value factoring .04/.01/.02 preserve the competing costs; the first distribution totals .99 and is not normalized. [Complete evidence, exact setup contract and Can/JS witness](../../design/delivery-recipe-overrides-20261004.md). Advice does not prove an implemented planner, file provenance or provider behavior. App normalization is tracked in MIGRATION.


## Shared descriptions and internal reference — October 5, 2026

Keep `#` as the readable multiline description form and add `desc=` as the compact field/parameter form; both populate one checked description slot, with duplicate descriptions on one declaration rejected and the legacy literal `@{desc="..."}` retained as a compatibility spelling. The compiler-owned static value (source, owning source language, ordered variants, location) feeds a deterministic internal Markdown reference via `can docs`, source-language IDE hover and source-string MCP descriptors. The reference renderer reuses the existing `resolveVariant` selection only; there is no second locale engine, translation generation, coverage quota, business execution or inferred authorization. Deferred, not claimed: localized MCP, artifact migration, AI-written guides, automatic translation and public publication.

Three JEV consultations split: optional-shared .54/.19/.88 against source-only .46/.81/.12, confidence .31/.71/.82, with no rationale for the reversal; the smaller first delivery above is Codex reasoning informed by that unstable advice. [Exact requests, responses and assessment](../../design/jev/description-reference-20261005/README.md). Landed behavior is evidenced in `implementation/description-reference-run/evidence/integration.md` (1469-test matrix, all green). Follow-up owned outside this entry: ROOT-BUILD-SKIPS-POSTBUILD — the root `tsc -b` path emits a non-executable `can-platform` bin, so fresh clones built only via the root script still fail `can docs`; needs a lane-07 root-wiring fix.

## Documentation locations and consolidation — October 6, 2026

Keep only `README.md` and `AGENTS.md` as root Markdown files. Move the current requirements, design, grammar, and decision log together into `docs/specification/`, preserving their separate authority and existing section anchors. Move the completed evaluation checklist to [design/evaluation/PLAN.md](../../design/evaluation/PLAN.md), beside its baseline, briefs, reports, and verification. This groups documents by purpose and makes the root a concise entry point; relocation does not change language semantics or turn historical proposals into accepted rules.

The user authorized these five moves and the live reference repairs. The documentation capture reader and local draft-repository links move with them. Frozen evaluation/editor snapshots, final report hashes, captured experiments, and saved consultation requests/results retain their original bytes and historical names; the [migration ledger](../ideal-filetree-plan/finished-product/documentation-review.json) maps old root names to their current owners. Local commits record the root moves, selected topic consolidation, and the separate draft reference repairs. Publication and the complete audit checkpoint remain separate work.

Minimize Markdown by consolidating repeated prose with the same purpose, rather than adding new summary pages or simply archiving files. The [inventory](../ideal-filetree-plan/finished-product/documentation-inventory.json) accounts for 490 tracked Markdown files and three added files at its observation. Consolidated 52 small JEV assessment/correction notes into 25 topic records, removing 27 Markdown files while preserving corrections, uncertainty, adoption, verification limits, and raw JSON evidence. Each complete source block was checked against its original and independently cross-reviewed; 169 request/result JSON files remain byte-identical. Stable section anchors retain old source identities, including both invalid-premise initial Hire-retention advice and its corrected consultation history. Prior planning pages, repeated setup instructions, and superseded execution prose have further owner-gated review tasks. This first pruning pass removed 51 superseded notes, created 24 topic records, and retained one existing README. Further prior-plan/setup/execution pruning remains owner-gated future work; the five root moves alone do not reduce total file count.

Keep decisions in this log, with their choice, rationale, and remaining uncertainty; distinguish proposals from accepted decisions. The [living file-tree plan](../ideal-filetree-plan.md) and its selected machine tree, owners, findings, and task catalog carry the same documentation disposition. Structural coverage and focused independent review do not certify every paragraph for deletion; complete source review and product qualification remain separate gates.

## Completed editor audit retirement — October 6, 2026

Retire `editors/vscode/audit-astra/` from the working tree. Its 187 files include 23 Markdown files and 42,687,533 bytes of completed highlighting audit snapshots, probes and token dumps. No current build, test or installation consumer reads the folder; the active highlighting checker already embeds F1–F8/F10 regressions and the four final survivor corrections. The final historical rerun closed those focused lexical cases, while semantic correctness and visible editor rendering remained outside its scope. Keeping or relocating all working copies adds no current workflow duty.

Preserve the complete original tree in Git revision `e5fa27c3cbe6c00e4ec76ea61005a3f1d3e65faa`, reachable from current history and the observed `origin/main`. A fresh archive extraction reproduced every original path, size and SHA-256 hash; the existing [documentation ledger](../ideal-filetree-plan/finished-product/documentation-review.json) records all 187 recovery identities, and its checker continues enforcing the original protected Markdown hashes against Git bytes. [Audit resolution](../../editors/vscode/AUDIT-RESOLUTION.md#recover-the-historical-audit) keeps historical navigation and recovery instructions. Current regression code remains unchanged. This reduces working-tree files and Markdown; it does not shrink Git history or prove old runners replay against current IDE versions/settings. The broader DOC06 captured-storage proposal remains deferred; this scoped DOC07 lifecycle retirement and the living target tree are reconciled together, with no complete checkpoint advancement.

## CI TS-gate offload to hosted runners — October 6, 2026

Run dependency-ready TypeScript package gates on standard GitHub-hosted runners via `.github/workflows/ts-gates.yml` (`workflow_dispatch` on default main), instead of serializing them behind the single local TS slot. Each run gates an exact committed source SHA per task/profile, executes the recipe in `.github/ci/ts-gate.mjs`, and publishes a verifiable receipt artifact checked by `verify-receipt.mjs` (trusted workflow commit; rejects wrong commit/job/artifact, unsuccessful/skipped commands, bad log hashes). A matching package receipt substitutes for that package's local gate; coordinator-tracked run identity is sourceSHA/profile/taskID/runID/attempt/URL/deadline. The human explicitly requested this build/test offload for the public repository (hosted runners free); authorization covers build/test tooling and WIP snapshot commits for testing — no production deployment, default rollout, or product publication. Limits: TS package gates only (values/state/stdlib/identity/ui/interfaces/work/cloudflare/testkit/workspace profiles); native/Rust, host-specific checks, cross-platform claims, and integration/production-critical/host acceptance stay separately budgeted and evidenced. Bootstrap verified by hosted values run 37477915459 (typecheck 0, build 0, 824 pass/0 fail/1 skip, zero diff) before default-branch publication. Local in-flight commands keep their handles; no gate runs both locally and remotely.

## CI native prerequisite for cloudflare/workspace gates — October 6, 2026

Cold hosted runners lack the `can-preparation` native binary (only `darwin-arm64` is packaged), failing 6 cloudflare Vitest suites (run 37483202041). The gate now installs pinned Rust 1.99.0 and runs an isolated `--locked` debug build into a private target dir before tests; test children receive the binary via `CAN_PREPARATION_BIN`. Hashes recorded in the receipt; verifier enforces presence/success/consistency. Harness 12/12. Other profiles unchanged.


### 2026-10-06 — Consolidate codex/remaining-lane-a-compiler into main

Accepted integration choice: retained compiler proposal/routing records; implementation already integrated. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate audit/input-validation-review into main

Accepted integration choice: retained historical input-validation audit at its original scope. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/remaining-lane-e-interfaces into main

Accepted integration choice: browser assets producer; route mounting and product joins remain incomplete. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/remaining-lane-f-ui into main

Accepted integration choice: browser client and polling; full binder/installed workflow acceptance remains incomplete. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/values-rust-port into main

Accepted integration choice: native exact-values/validation code and bindings; opt-in scaffold, rollout/installed/backend gates remain open. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/remaining-lane-c-runtime into main

Accepted integration choice: history reconciliation; dirty C build graph separately integrated. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/remaining-lane-d-work-providers into main

Accepted integration choice: history reconciliation; unfinished canonical preparation separately checkpointed; human hold retained. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/remaining-lane-b-core-state into main

Accepted integration choice: history reconciliation; preserve newer current prepared-input registry and canonical kernel checkpoint. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate port/artifact-preparation into main

Accepted integration choice: history reconciliation; no additional net source. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/ci-gates/bootstrap-20261006 into main

Accepted integration choice: history reconciliation; preserve current stricter receipts and pinned native prerequisites. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate codex/remaining-lane-g-journeys into main

Accepted integration choice: history reconciliation; retain current draft descendant instead of stale predecessor. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Consolidate origin/codex/remaining-lane-f-ui into main

Accepted integration choice: remote instrumentation history reconciliation; code already cherry-picked and current browser implementation retained. Preserve all commit ancestry through a merge, retain newer main on historical overlapping patches, and keep authored/source intent and unfinished gates visible. Structural changes since checkpoint are recorded in `docs/ideal-filetree-plan/consolidation-20261006.json`; the complete checkpoint is unchanged because source closure is incomplete. This is repository consolidation, not programme acceptance or worker resumption.


### 2026-10-06 — Refresh consolidation accountability without advancing source acceptance

Accepted maintenance choice: refresh the canonical living structural catalog and all accumulated checkpoint deltas at the final consolidated source pin, preserving prior hashes/review pins, documentation retirements, original requirements and dependency/cutover gates. Retain unfinished B extraction, D preparation with human HOLD, values opt-in/native/backend gates and E/F browser joins as incomplete work. Compiler proposal records remain proposals. The nested draft keeps its documentation-repair descendant. Rationale: branch ancestry, generated output and local verification cannot certify exhaustive source/control-path/test-expectation review or installed workflow acceptance. `FP.SOURCE-CLOSURE` remains open; the complete checkpoint stays `8249342`. Exact source/merge provenance and evidence limits are in [the canonical consolidation review](../ideal-filetree-plan/finished-product/consolidation-review.json); root verification results remain separately scope-pinned.

### 2026-10-06 — Reconcile the remaining work from the three old plans

Accepted planning choice: maintain one [remaining-work index](../../implementation/REMAINING-WORK.md) and namespaced ledger for all 323 existing challenge/description/port/finished-product/documentation identities plus ten original gate/handoff/review identities. Map repeated manifests, remaining-lane slices, app duties and historical structural packets to their owners rather than adding duplicate tasks. Preserve the original contracts, acceptance, prerequisite qualifications and defining-owner scope. Credit completion only at its evidenced scope; missing consumer, installed-host, whole-workflow and independent-review acceptance stays open. The source basis is consolidated main `7fd8c6bf4717feeffc70b46819377b74b353e117`, with product verification separately pinned to `fdb059c634c32c83760f35dd9175f49d9821762d`.

Rationale: the old execution ticks and overlapping plans no longer provide one reliable view of the remaining programme after consolidation. The snapshot distinguishes required, accepted-conditional and deferred work and retains D’s explicit preparation-port HOLD. It does not resume Muse, create assignments, select native defaults, amend product contracts or advance the complete checkpoint. Uncertainty remains attached to unproved production/consumer/resource/host gates and source-only observations; their named owner tasks carry the remaining evidence. This reconciliation ran planning checks, not new product builds or tests.

### 2026-10-06 — Declared package boundaries and proposed Bun/Turborepo orchestration

**USER boundary requirement:** internal package consumption must be declared in the consuming manifest; sibling source/file imports must not bypass package ownership. **PROPOSAL (MINE):** retain the existing Bun workspace, repair its dependency/API boundaries first, then introduce pinned Turborepo orchestration after validating the resulting graph. This discussion does not implement or approve a tooling cutover.

The root already pins Bun 1.4.2 and manually orders builds for its 13 TypeScript workspace packages. A read-only TypeScript AST scan found 165 literal relative cross-package imports/exports in 115 non-test `src` files, of which 163 target contracts source; computed imports are outside that count. Examples include `ui/src/client.ts:16` consuming contracts with no UI dependency declaration, `files/src/scenarios.ts:21` consuming services, and `work/src/kernel/commands.ts:40` consuming state types. Cloudflare also loads state `dist` internals through computed specifiers, and loads identity at runtime while declaring it only as a development dependency. Broad TypeScript roots accommodate cross-owner compilation; stale explicit values/state includes refer to a nonexistent root contracts path. The state-to-work source loader is a checkout/development fallback, not evidence that every installed runtime unconditionally loads work source.

Proposed boundary contract: TypeScript consumers declare internal `workspace:*` dependencies and import exported package entry points or intentionally exported subpaths. Test-only helpers get a deliberate testing API/manifest owner. Remove sibling `src`/`dist` reaches, cross-owner compilation and source-path aliases that bypass exports. Inspect dynamic loaders as well as static imports. Resolve the potential work/state cycle through the owning shared contract or injected interface before scheduling dependencies. Package export maps and manifest declarations are required even when tooling can resolve an undeclared checkout file.

[Turborepo 2.11](https://turborepo.dev/blog/2-11) provides experimental native Cargo, uv and `go.work` discovery; [its experimental boundaries command](https://turborepo.dev/docs/reference/boundaries) checks out-of-package and undeclared-package imports. Validate that command against our TypeScript, tests and dynamic-load cases before making it the enforcement gate, supplementing coverage where necessary. Preserve native manifest ownership: Cargo.toml for Rust, go.mod/go.work for Go and pyproject.toml for Python packages; package.json belongs to JavaScript packages and deliberate task wrappers. This checkout has separate Rust projects, a private nested values workspace and Python scripts; no Go module or uv workspace was found. Native discovery must be tested against these actual boundaries before enabling it; wrappers are an available transition, not a requirement to give every native crate an npm identity.

Cutover evidence remains proposed: verify the task graph and ordering, clean builds, installed-package consumption without sibling checkout files, cache restoration and invalidation after upstream changes, and existing package/integration/native checks. Declare generated JS, declarations, browser assets and Wasm/glue outputs together with lockfiles, toolchain versions, target/features and relevant environment inputs; retain release stamping/verification and host-dependent test semantics rather than assuming all tasks are cacheable. Turbo schedules each toolchain; Wasm remains a separate supported target and host contract. Python commonly runs through a Wasm-built interpreter such as [Pyodide](https://pyodide.org/en/stable/), with [restricted host APIs](https://docs.python.org/3/library/intro.html#webassembly-platforms); orchestration does not establish universal Wasm compatibility or change existing opt-in backends.

[Three independently rewritten JEV consultations](../../design/jev/turborepo-package-boundaries-20261006/README.md) compared boundary repair with existing orchestration, Turbo with wrappers, and Turbo with native discovery. They selected unresolved/existing/existing with substantially different distributions and confidence. This supports investigating boundaries before cutover, not a stable endorsement of a particular runner. The proposed Turbo target follows the user's mixed-toolchain direction and its scheduling/caching fit; acceptance remains contingent on the concrete graph and artifact checks above. Only manifests, source/configuration and official documentation were inspected in this discussion; no product build, installation, boundary command or migration was run. Existing unfinished acceptance gates and the living-plan checkpoint are unchanged.

### 2026-10-06 — Proposed four-lane allocation of remaining Rust ports

**PROPOSAL (planning only):** use four [Rust-port ownership queues](../../implementation/RUST-PORT-LANES.md): exact values/shared values assembly, owned validation, work transitions/global delivery, and retained native preparation. This is an allocation overlay of the existing 230 source identities, preserving completed credit, 166 required open records and conditional/deferred gates. It changes no original acceptance or implementation authorization. Exact values and validation share one semantics core; R1 applies common crate/binding assembly requests from R2. R3 is the single global manifests/bundle/release writer, with `W06.runtimehandoff` transferring its completed runtime source to R2 before final durable verification. Common evidence gates are assigned inside these queues rather than adding a fifth implementation lane.

Rationale: four coherent port outcomes can progress on disjoint owned files, while small explicit assembly/delivery/runtime handoffs preserve the actual shared seams. Independent reviewers offered both work-owned and preparation-owned global delivery; the proposal chooses work-owned delivery so D's existing preparation HOLD cannot unnecessarily park ready values/work distribution. The held preparation and native-release tasks remain held. Lane counts are work/gate records, not equal effort; released workers may assist the larger validation queue through explicit file ownership transfers. Whole-call economics, binary/installed consumers and compatible retirement remain unproved at their named gates. Implementation, worker launch and runtime/topology changes remain deferred; the complete living-plan checkpoint is unchanged.

### 2026-10-06 — Prioritize the package-boundary and Turbo implementation plan

**USER:** focus on this infrastructure first and prepare an implementation plan, determining whether further research is needed. **Accepted planning choice:** use the [focused implementation plan](../../implementation/PACKAGE-BOUNDARIES-AND-TURBO.md) as the next priority. Source evidence is sufficient to define execution now; bound the remaining native-discovery, enforcement, observer-direction and cache questions as early implementation gates. Implementation and tooling cutover have not started.

Further read-only TypeScript symbol review establishes that all 904 named direct production contracts imports resolve through the current contracts root to the same declarations; tests, wildcards and computed loads were outside that comparison. Worker vendoring needs a contracts mapping before runtime import cutover. Files/services/work need selective package entry points/build outputs. Preserve injected receipt observer precedence and absent-module-only checkout fallback behavior while replacing file access; the missing worker-safe observer stays with its original T25/T26 qualification scope. Preserve standalone compiler Cargo ownership under C04.graph, committed opt-in values glue staging, compiler Git-commit version identity, executable modes, incremental/output consistency, existing native test receipts and uncached release verification.

Rationale: explicit repair slices and acceptance checks keep this work moving without guessing native discovery support or concealing incomplete product behavior. The plan maps into existing C04/asset/installed/receipt obligations and adds scoped Turbo infrastructure checks; it does not rewrite original acceptance or task counts. Shared writes are serialized and independent producer work follows released APIs. Prior JEV sequence uncertainty remains recorded; no new difficult owner/API decision is accepted solely by this plan. No product builds, installs or experiments ran during planning; the preparation HOLD, stopped implementation sessions and complete file-tree checkpoint remain unchanged.

Independent plan review corrected producer-output ordering, required package-resolved distribution/asset discovery instead of sibling checkout scans, and made baseline failure/coverage policy explicit. Re-review found no remaining planning blocker; local-link, eight-slice dependency-order, ledger-identity and navigation checks pass. These are planning results, not proof that the proposed distribution API, native discovery or cache behavior is implemented.

### 2026-10-06 — Verify Turbo native discovery and boundary coverage

**USER:** execute the native-discovery and boundary-checker probes. **Verified interpretation:** pin Turbo 2.11.7 initially, preserve current native ownership through explicit command adapters, and supplement Turbo boundaries with ownership/loading and compiler/runtime export checks. [The probe report](../../implementation/package-boundaries-probe/README.md) retains fixtures, exact commands/results, installer lock, binary/schema hashes, source preservation and independent review. This implements two B01 subgates, not the package migration or complete B01 baseline.

Both 2.11.7 and 2.11.0 discover only the 13 JS owners in the actual no-root-Cargo topology. A named repository-root virtual Cargo workspace control discovers crates and their dependency edges; removing its root manifest removes native discovery. Dual JS/Cargo directories have separate task identities and identical names collide. Independent cold-fixture replay confirms a TS-only filter can avoid Cargo metadata while native filtering requires it. Native automatic discovery therefore does not currently replace orchestration for Can's standalone/nested projects; C04.graph's no-compiler-workspace and private values ownership constraints remain. Synthetic Go discovery/build edges work; Python names are discovered through fallback but installed uv 0.5.9 rejects required metadata/interpreter options and caching is disabled. No native command/build/cache compatibility is claimed from those lists/dry runs.

All 24 isolated boundary cases completed. Static undeclared imports, sibling src/dist, aliases, type-only declarations/reexports, literal dynamic imports and package test violations are detected. Type queries, nonliteral dynamic imports, producer filesystem/URL reads and root tooling pass; a declared but unexported subpath passes Turbo and is rejected separately by Bun runtime. The actual checkout boundary run exits 1 with 566 diagnostics (509 outside-package, 57 undeclared) across 612 files in 13 packages, including tests. Site triage, deliberate negatives and root runner ownership remain distinct from defect counts.

Rationale: these measured gaps select the plan's existing fallback without flattening native ownership or trusting a partial scanner as complete enforcement. The B02 checker must cover root consumers and unsupported forms, and producer distribution must be resolved through intentional exported APIs. SHA-256 checks and independent review confirm 946 tracked product/configuration files unchanged. Product manifests/source/lock/build/CI, native backend defaults, preparation HOLD, original C04/C05/installed acceptance and the complete living-plan checkpoint remain unchanged. Full baseline builds, native/Wasm execution, installed asset and cache restoration/invalidation proofs are still future gates.

### 2026-10-06 — Repair the declared package graph before Turbo cutover

**USER / accepted and implemented:** repair dependencies, exports, producer builds and cycles for the 13 Bun TypeScript workspace owners. Consumers use declared `workspace:*` relationships and intentional exports; each producer emits its own `dist` sources/tests/assets. Files/services/work now have emitting builds and public entry points. Contracts remains the shared leaf; runtime contracts imports retain owning declarations, including the exact values subpath for its type-star surface. Runtime identity belongs in Cloudflare dependencies.

**Accepted ownership:** work consumes state; state has no work dependency, including development/test backedges. Move work-dependent receipt/fanout proofs into work and consumer-dependent contracts assertions into their consumers. Work exposes its real receipt API. The optional observer module stays state-owned and absent: injection still wins, only the exact missing observer permits the Node/development work fallback, and deployed missing-observer behavior still refuses loudly. Cloudflare owns local row isolation beside its local runtime; testkit reexports that implementation, and the platform CLI uses it directly. This removes the hidden CLI/testkit cycle while retaining snapshot/boot behavior and the existing zero-row execution limitation.

**Accepted distribution:** packages expose small `./distribution` metadata modules with producer-owned URLs; bundlers resolve package exports and those URLs, preserving sorted staging, links, text/binary integrity and opt-in generated values bindings. Remove the duplicated contracts source mirror. Export committed conformance JSON explicitly as a test asset. Native manifests, ordinary/explicit Wasm builds, backend defaults, compiler ownership and preparation HOLD retain their prior boundaries.

**Verified:** [repair report and raw evidence](../../implementation/package-boundary-repair/README.md): all 13 builds from deleted outputs/incremental metadata, frozen Bun install, root/e2e typechecks, zero Turbo 2.11.7 diagnostics (631 files), zero supplemental guard violations (671 files), 12 guard negatives, 597 root tests, 265 emitted Cloudflare tests, owning package suites, installed 13-package API/Worker/WASM/CLI checks and release stamp/manifest verification. Independent review found and prompted corrections to receipt index mapping and the hidden CLI cycle, then reported no remaining concrete P1/P2. Contextual runtime expressions remain listed by the guard; static zero is not a universal filesystem/loading proof. Unchanged services cancellation assertions fail under Node 26 but pass under Node 24, including unchanged baseline comparison.

Rationale: manifests, exported distribution and acyclic ownership make the current build concrete before orchestration changes. Bun still orders builds explicitly. Turbo native discovery/caching, full browser/native/host release qualification and original C04/C05/T25/T26/installed gates remain separately open. No merge, release publication, preparation resume, target-tree reallocation or complete living-plan checkpoint advancement occurred.

### 2026-10-06 — Resolve installed Worker assets through owning packages

**USER / accepted and implemented:** Worker bundling resolves installed packages and assets without sibling checkout paths. Resolve the serving main through `@canlang/cloudflare/worker/main` and producer entries with ESM import conditions. Keep `repoRoot` as an optional ignored compatibility field; remove its use from the preparation bundling caller. Export the small producer resolver and asset-gathering APIs deliberately.

**Accepted asset shape:** explicit `valuesWasm` selection stages real committed bindings/glue/WASM, while `browser` selection exposes UI scripts/CSS as separate resource bytes and content types. Package-owned distribution URLs locate both inventories. Verify the finite manifests, declaration/runtime byte lengths and hashes before returning assets; reject directory escapes. Rewrite binding implementation imports to the owning values vendor modules. Selection does not initialize a backend, expand artifact import admission or fabricate missing work assets.

**Accepted writer behavior:** preserve the ordinary JS bundle/hash and existing mixed asset contract. The asset-aware writer adds a separate resource digest/manifest; browser resources never become Worker ES modules. Validate the full layout, both digests and existing filesystem entries before writing, rejecting symlink redirects and file/directory conflicts. Canonical output parents permit containment checks without filesystem reads above a restricted consumer root.

**Verified:** [implementation and evidence](../../implementation/installed-worker-assets/README.md): 636 root tests, 39 final focused asset tests, typechecks, zero supplemental boundary violations and 12 guard regressions. A cloudflare-only direct tarball consumer has Node checkout reads denied, builds/writes deterministic installed assets, boots production workerd/D1 with the expected authentication 401 and executes selected CompiledWasm through the real glue/backend (ABI 1, add-int result 3). Missing/corrupt WASM and CSS reject. Independent review found an output symlink escape, corrected and reproduced as rejection, then found no remaining P1/P2.

Rationale: owning exports and verified resource bytes make the installed build independent of repository layout while preserving explicit backend selection. Node permissions do not govern Bun/workerd subprocess reads; resolved installed entries and emitted bytes are checked separately. Browser serving/acceptance, native release/hosts, missing observer/work delivery and Turbo cache qualification remain open at their original scope. The preparation HOLD and complete checkpoint are unchanged; no merge or publication occurred.

### 2026-10-06 — Introduce Turbo scheduling with verified local TS caching

**USER:** introduce Turbo scheduling and prove cache correctness. **ACCEPTED implementation:** pin Turbo 2.11.7 with Bun 1.4.2; schedule the 13 TS producers from declared package relationships; cache only their ordinary emitting builds in a worktree-local cache. Public commands verify the executing host, Node and Bun identities and pass them into strict task hashes. Preserve native ownership through explicit uncached Cargo/Wasm/Python adapters rather than enabling discovery against the previously unsupported layout. No Go owner is invented; the editor retains its separate build.

Each cached producer depends on an uncached cleanup task. A reproduced A → B → cached A rollback left B-only files under Turbo's ordinary extraction; cleaning owned emissions and incremental state before restoration fixes it. Preserve values `dist/catalog.json` and Cloudflare's packaged preparation binary/manifest filenames under their separate owners; exclude those files from TS archives while including compiled TS preparation code. Tests/typechecks, native generation, catalog generation and release stamp → manifest → verification always execute. Aggregate tests preserve sequential suite execution; normal builds permit four concurrent tasks. CI reproducibility disables both cache reads and writes, and release packaging invokes the validation chain after restoration.

**Verified:** [scheduling report and raw evidence](../../implementation/turbo-scheduling/README.md), including a frozen isolated install, 17 actual cache phases, 2,242 files restored with exact SHA-256/size/modes, genuine upstream compilation and uncached equality, no-manual-clean rollback/deletion, separate-output exclusion, CLI mode `0755`, and failing-producer blocking. Independent review compares all 1,177 snapshot files against current working bytes and the isolated workspace. Nine additional dry hash probes cover lock/shared config/browser/WASM/tool-host/environment identities; they do not execute alternate tools or hosts. Native compiler build/tests execute uncached, preserving its Git-embedded identity policy.

Rationale: bounded artifact ownership and observed restoration/invalidation justify the requested TS cutover. Keep actual root dependency declarations even where Turbo's root internal-dependency hash causes conservative invalidation: the tested leaf API edit/deletion gives one miss and 12 hits, while adding its source module or changing browser CSS/committed WASM bytes invalidates all 13. This is fixture-specific evidence, not a universal selectivity or performance claim. Remote caching, native cache qualification, full browser/editor/host releases and original product acceptance remain open. The preparation HOLD and complete living-plan checkpoint stay unchanged; no merge or publication occurred.

### 2026-10-06 — Complete CI, release artifacts and scoped migration acceptance

**USER / accepted implementation:** finish the CI/release/documentation cutover and independent acceptance. Explicitly select Bun's isolated linker in `bunfig.toml` and hash that policy in Turbo. Standardize CI on Node 24, Bun 1.4.2, TypeScript 5.9.3 and the existing pinned Rust 1.99.0 action/toolchain. Integration runs every retained owning package/runtime suite and the root suite, generates the catalog before its fixture, and builds an existing private locked preparation debug binary solely as a test prerequisite. Browser CI builds its explicit uncached compiler prerequisite and watches all relevant package/tool inputs. Native generation remains explicit, locked and uncached.

**Accepted receipt contract:** runner and verifier share a finite ordered command plan for each existing profile. Success requires all planned identities, frozen installation, producer builds, checks and positive executed test counts; unique authenticated logs must match the source/tool facts and recomputed counts. Missing/reordered commands, changed arguments/working directory/environment, skipped or failing tests and incomplete native facts reject. This closes the demonstrated acceptance of arbitrary incomplete command lists while retaining the existing hosted job/run/attempt/artifact identity checks.

**Accepted release artifact contract:** `release` remains build/validation; `release:pack` additionally packs all 13 workspace owners after uncached validation. The five-tarball set omitted private runtime dependencies. Include private owners as local artifacts with unchanged private flags, check every rewritten internal version, and record SHA-256, sizes and runtime closures in `output/release-artifacts/manifest.json`. No registry publication or native-release/adoption qualification follows. Exact payload tarballs are installed in an outside-checkout isolated Cloudflare-only consumer for Worker/asset verification.

**Accepted installed-type scope:** check all 150 intentional typed exports from 13 actual tarballs with strict NodeNext and `skipLibCheck: false`, canonical installed ownership, denied checkout reads and declared consumer tooling. Fail Can/consumer declaration diagnostics and undeclared owned imports; missing/corrupt declaration controls must fail the same gate and restoration must recover baseline. All 797 diagnostics in pinned Miniflare 4.20260730.0 declarations remain visible and exclude a whole-program strict-library success claim. Vendor repair remains separate; no patch or dependency change hides it.

Rationale: explicit dependency isolation, complete artifact closure and authenticated required-command coverage repair the concrete review gaps without changing product semantics or ownership. [Final local evidence and independent reviews](../../implementation/turbo-scheduling/evidence/final-acceptance/README.md) retain actual command results, source pins and remaining limits. Hosted workflow execution, full browser journeys, VSIX packaging, native/Wasm regeneration, alternate-host releases and original product gates remain unqualified here. The preparation HOLD and complete checkpoint are unchanged; no merge or publication occurred.

### 2026-10-06 — Commit the accepted changes in dependency-ordered steps

**USER / accepted:** commit all pending work in layers and steps, including needed ignore rules. Keep package ownership, emitting manifests and Turbo scheduling together because package builds/checks depend directly on the shared runner. Follow with the optional installed Worker asset API, CI/release acceptance gates, the separately proposed remaining-work/Rust-port plans, and developer documentation with raw acceptance evidence. Split the optional asset changes through the index; preserve the final reviewed working bytes.

The pending `.turbo/` and `/output/release-artifacts/` rules cover new generated outputs; existing rules cover Node/Rust/package/editor/browser outputs. Raw proof records and finished posters remain intentional versioned artifacts. This is a local commit series, not a merge or publication; the preparation HOLD and complete file-tree checkpoint remain unchanged. Earlier acceptance pins continue to identify their tested working-byte snapshot and base revision.

### 2026-10-06 — Let Codex orchestrate four local Muse Rust-port coordinators

**USER / accepted execution architecture; implementation remains deferred:** Codex is the global orchestrator, independent reviewer and sole main integrator. Four Muse Contributor/MAX instances will use separate worktrees and one 2×2 tmux window; each coordinates its own native subagents. Codex drives them directly and supervises every 25 minutes. The user's instruction overrides the Muse skill's default global coordinator hierarchy. Future local task-sized commits are authorized early and often; remote publication is separate. No instance, worktree, native goal/timer or product work is started by this planning decision.

**PROPOSED operating policy:** use the [saved execution plan](../../implementation/RUST-PORT-EXECUTION-PLAN.md) and finite dependency-first packets rather than equal package task counts. R1 owns common values assembly; R3 owns global delivery source; Codex integrates reviewed releases. Lend R4 temporal/state/validation prerequisites while preparation remains human-held. Start with two disjoint coding children per Muse where supported and two bounded heavy local commands across the verified 10-CPU/16-GiB host; calibrate from actual command capacity and task duration. Coordinators alone Git-mutate their worktrees. Frozen exact-commit receipts, independent invariant review and actual input/writer release gate cross-lane joins.

Rationale: direct Codex control removes the former peer/coordinator message dependency; short releases, ready local backlogs and borrowed critical prerequisites reduce avoidable waiting without duplicating the arithmetic/validation core or serializing all coding behind builds. Current package/Turbo/installed-asset/CI machinery must be reused and qualified against the original gates. The ledger's 166 required open port records are an older assessment, not a claim that newer infrastructure leaves every status unchanged.

Remaining uncertainty: equal work hours and minimum wall time are not measured. A supported Muse-to-Codex completion wake is unverified; the 25-minute root cadence can add up to 25 minutes plus review at each serial handoff. Automatic process-held command capacity, native subagent/timer limits and hosted exact-source CI publication require startup verification or explicit authority as applicable. Preparation/native-release HOLD, conditional/deferred routes, TS compatibility/default-adoption gates, other unfinished programme duties and the complete living-plan checkpoint remain unchanged. The matching supervisor is prepared paused; planning is not an implementation release.

### 2026-10-06 — Remove local Muse schedules and shorten the proposed Codex interval

**USER / accepted correction:** no local Muse scheduling; Codex provides the sole scheduled supervision. This supersedes the previous plan's five-minute Muse timers and local periodic child-roster checks, including timer setup as a startup gate. Four Muse instances still execute finite Codex-assigned packets and may delegate within them to native subagents. Actual delivered child/command results and bounded execution waits remain ordinary execution; they must not become background polling or recurring idle wakes. Codex owns cross-packet selection, priority and reassignment.

**PROPOSED / configured paused:** shorten the Codex supervisor from 25 to 15 minutes, as raised by the human. The scheduled interval is 40% shorter; under uniformly distributed completion times the expected wait for the next check falls from 12.5 to 7.5 minutes. This is a cadence calculation, not measured wall-time performance or an exact latency guarantee. An earlier completion-triggered Codex wake remains unverified. The execution plan, setup/GO templates and machine contracts reflect no local recurring jobs; startup depends on identity/goal/capability ACK, not a native timer. Planning, preparation HOLD and independent acceptance remain unchanged; no runtime is launched or resumed.

### 2026-10-06 — Audit library reuse before further package porting

**USER / requested planning review:** check handwritten TS/Rust in all packages before continuing implementation. **PROPOSED:** prefer maintained standard mechanisms under small Can adapters for ECMAScript float text (`ryu-js`), existing serde string escaping, import/source-map handling, CSV grammar, identity byte codecs/cookie grammar, qualified host secret comparison and native cancellation fan-in. [Audit findings and evidence](../research/package-library-audit-20261006/README.md) pin source `309644a6881909d8dba32560bc6711f67e00a7ab`, inspect current primary library documentation and map relevant findings to existing tasks without advancing acceptance.

Rationale: remove duplicated general-purpose mechanics while preserving exact bytes, rejection/error order, authority, host closure and rollback. Native bigint/num-bigint, WebCrypto/sha2, MCP SDK, bundlers and filesystem primitives already provide libraries. Keep Can numeric policy, schema/provenance, lossless JS transport, state fences and work decisions. Do not adopt calendar/ICU/stable-hash/SDK replacements without their documented compatibility gates; smaller source alone does not demonstrate smaller total complexity.

Uncertainty: source inspection is not runtime equivalence, performance or a supply-chain audit. Static malformed-hex and unwired Rust float-cast findings need future negative controls; no live auth bypass or deployed Rust failure is established. Dependency versions, host behavior, installed/native/Wasm consumers and any semantic/migration choices remain unqualified. No source, dependency, lockfile, runtime, canonical task status or complete file-tree checkpoint is changed; implementation and preparation/native-release remain held.

**PROPOSED sequencing refinement:** use the [27-unit library adoption sequence](../research/package-library-audit-20261006/adoption-sequence.md) as a namespaced amendment to the existing task/packet map. Refresh source/contract scope, then interleave independent values/work helper changes, import/map leaves and explicitly owned identity/CSV/service slices. Values and work qualification are separate joins; import/map composition has its own installed consumer proof. Keep R2's critical validation work and R4's borrowed prerequisites rather than assign a new fifth lane. Source-ready work remains behind W04.4 actual assembly, surrogate/truncation domains remain visible, and diagnostic fallback metadata/invoke ownership must match the transformed code. Review/integrate each released slice rather than wait for all library investigations. CSV shared ownership and consequential host/persisted-byte choices are future decision gates; native preparation stays held. The sequence supplies proposed dependencies and acceptance, not measured hours, live assignments, changed original task counts or an implementation release.

### 2026-10-06 — Refine existing workerd deployment handoffs and acceptance

**USER / accepted planning scope:** refine the challenge, Rust-port and ideal-filetree plans for workerd deployment. Preserve their existing task identities and requirements; connect them through a finite original-app artifact/serving qualification packet. The [living plan](../ideal-filetree-plan.md#workerd-deployment-refinement-2026-10-06), [challenge packet](../../implementation/CHALLENGE-AUDIT-PLAN.md#proposed-workerd-deployment-execution-and-handoff) and [Rust delivery qualifications](../../implementation/RUST-PORT-LANES.md#workerd-delivery-readiness-after-the-build-migration) now credit the migration committed through `309644a6881909d8dba32560bc6711f67e00a7ab` at its independent local acceptance scope. Historical task/status/count/source pins stay intact; old blanket package-migration-not-started wording is superseded. Actual work-kernel consumer dependency requests, native/host and product parents remain open.

**PROPOSED execution contract:** freeze the host/binding/compatibility profile, exact source/compiler/catalog/archive/module/WASM/resource hashes, serving URL/import closure, owner releases and independent positive/negative observations. Qualify the written installed artifact with the unchanged CanDo pilot and its full required workflow, keeping file/receipt/provider extensions scoped to actual consumers. Serving integration and Rust/WASM adoption have separate named gates; existing T21, Q4, C04 and W05/W06 evidence must retain its original scope.

Observed integration gaps give the refinement concrete boundaries: production preparation still uses the plain bundle builder/writer; browser output keys have no established public URLs; the shell has no asset references; `startBrowserClient` is exported without automatic invocation. Current installed verification compares written bytes but boots an in-memory map and an independent values probe. The owning packets must implement browser initialization, artifact reload/serving and a prepare-only installed CLI qualification recipe before making complete deployment claims.

Remaining design gates: the target-host asset/binding provisioners and route order relative to activation/auth, plus the four recorded identity shared-fence questions. This planning round selects no provider or identity mechanism and performs no new JEV consultation; existing advice awaits owner reconciliation. No product implementation/build/test, worker/supervisor activation, native HOLD release, merge/publication or complete checkpoint advance occurs. Independent review and planning-only link/source/ledger-preservation checks validate the refinement.


### 2026-10-06 — Compiler library replacement investigation

**USER / scope:** investigate handwritten compiler machinery that should use libraries. The [scoped audit](../research/compiler-library-audit-20261006/README.md) and saved probes pin compiler baseline `309644a6881909d8dba32560bc6711f67e00a7ab`; no compiler implementation or dependency was changed.

**PROPOSED:** adopt focused standard libraries for JSON transport/typed serialization (`serde`/`serde_json`), HTTP URL parsing (`url`), locale parsing qualified against the owning runtime (`icu_locale_core` candidate), SHA-256 (`sha2`), temporary-file ownership (`tempfile`), LSP wire shapes (`lsp-types`) and source-map codecs (`sourcemap`). First remove redundant string decoding by consuming the lexer-owned payload. Retain Can grammar/recovery, semantic and authority passes, exact wire policies, evaluation order and lowering. CLI metadata, graph algorithms, ICU syntax and temporal reuse remain separately bounded candidates; Rowan/Salsa/JS-AST migrations require their own evidence.

Rationale: probes reproduce valid escape corruption in emitted JS, Unicode URL panic and malformed-host/port admission, locale/runtime divergence, malformed LSP acceptance and fmt mode widening. Libraries address standard mechanisms while policy/admission/version/metadata behavior remains in explicit Can adapters. A blanket serde Value or lsp-server substitution would lose current representation/bounds and is not selected.

Remaining uncertainty: no dependency integration, footprint/performance comparison, cross-platform file policy or original Can source-map consumer coordinate contract was qualified. The private values-core compiler boundary remains deferred under L-F03. Three equivalent JEV choice consultations selected targeted/custom/targeted with confidences .83/.40/.93; all exact probabilities and the wording disagreement investigation are preserved, without consensus or approval claims. Baseline verification passed 89 library and 45 integration tests; reproducers expose uncovered behavior. The living file-tree checkpoint remains unchanged because no merge or complete reconciliation occurred.

### 2026-10-06 — Sequence bounded compiler library replacement passes

**USER / requested planning detail; PROPOSED execution:** use the [pass sequence](../research/compiler-library-audit-20261006/implementation-passes.md) to release immediate string, LSP admission, URL/locale and formatting-permission repairs independently. Replace hashes and file ownership through small adapters; establish typed JSON output conventions before input-parser replacement; qualify LSP DTOs/URIs and source-map consumers separately. CLI, ICU, temporal, graph and position mechanisms each require their own adopt/retain/defer result. The numbered passes express priority and actual dependencies, not a whole-program serial barrier.

Rationale: reproduced correctness failures deserve early releases, while serializer/parser representation and consumer contracts need explicit compatibility evidence. Assign one writer per shared compiler file and one dependency integrator; independent vectors and reviews can overlap. A finite compiler ledger can cross-reference existing T35/A3, T15 and real consumer acceptance without reopening historical completion or treating compiler source-map codecs as FP.SOURCE-MAPPINGS provider work. Preserve the package Rust-port plan's compiler exclusion, R1–R4 allocation and preparation/native HOLD.

Remaining uncertainty: packet sizes are qualitative; no implementation duration, workload performance, dependency footprint or alternate-host parity has been measured. Source-map coordinate policy, locale canonicalization and file metadata policy remain bounded implementation gates. This round records a proposal and performs documentation/source preservation checks; it changes no compiler source, manifest, dependency, canonical task status or complete living checkpoint and reruns no product tests. Existing JEV strategy advice remains split; new consequential policy choices require their own verified-context consultation.

### 2026-10-06 — Use economical Codex subagents and commit compiler packets early

**USER / accepted operating policy; planning scope:** use Codex subagents for the compiler pass sequence, with economical task-specific model and reasoning choices, and commit early and often. Start clear bookkeeping at Luna low, bounded known-contract work at Luna medium, narrow technical changes at Sol low and ordinary substantive implementation/review at Sol medium. Record the reason before escalating a packet for unresolved cross-file semantics. Use focused context and available worker slots; the root retains independent acceptance and sole Git integration.

Rationale: finite packets, released interfaces and exclusive writers reduce context/retry costs without choosing weak reviewers for uncertain contracts. Save this audit/planning baseline in a scoped local commit; commit checked regression-and-repair packets and serializer families separately during future implementation. Stage matching decisions/evidence with each packet while preserving unrelated pending plans. [The sequence's operating policy](../research/compiler-library-audit-20261006/implementation-passes.md#economical-codex-delegation-and-commit-cadence) records concrete dispatch defaults and commit boundaries.

Remaining uncertainty: economical model selection is a policy, not measured execution cost or duration. Current dispatcher availability and actual packet outcomes govern escalation. This instruction changes the compiler execution plan and authorizes scoped local commits; it starts no compiler implementation, package Rust-port worker, merge, publication or complete living-plan checkpoint advance.

### 2026-10-07 — Economical Codex workers for package and Rust adoption

**USER / accepted operating policy; planning only:** replace the proposed Muse worker topology with economical task-specific Codex subagents, and commit coherent slices early and often. Luna low/medium handles clear routine packets; Sol low/medium handles technical changes and ordinary review; justify escalation for uncertain cross-file semantics. Codex retains exact-file allocation, independent acceptance and sole Git mutation in shared checkouts/main integration. Four responsibility queues compete within actual dispatcher capacity; currently four total slots includes the root, leaving three concurrent subagents. No Muse/tmux setup, peer-handshake mesh, local timers or blanket MAX defaults are required.

Rationale: finite packets and focused context reduce coordination overhead while preserving original contracts and ownership. Commit the scoped planning baseline locally now; future checked implementation releases get separate early commits. This instruction does not start product implementation, release native preparation, activate the paused supervisor, authorize publication or advance the living-plan checkpoint. The [execution policy](../../implementation/RUST-PORT-EXECUTION-PLAN.md) and [adoption sequence](../research/package-library-audit-20261006/adoption-sequence.md) carry this refinement. Model cost/latency savings remain unmeasured; select from actual available capabilities and observed outcomes.

### 2026-10-07 — Publish one ordered package-port operator checklist

**PROPOSAL / dispatch clarification:** use the [start-here sequence](../../implementation/RUST-PORT-START-HERE.md) to finish scope/contracts/packet planning before release, then schedule numeric corrections alongside validation/state unblockers and actual work assembly. Fill released slots with parallel import/map work, followed by installed consumers and explicitly selected adapter packets. Review and commit every finite release throughout. Borrowed V01.3 remains its original task identity; four queues do not imply four active workers.

Rationale: one operator checklist makes the next assignment and acceptance output visible while preserving the full original DAG and exact writers. Current readiness is still a preflight requirement; this checklist grants no implementation, preparation, publication or checkpoint-advance authority. Packet metadata now routes all shared-checkout Git operations to Codex instead of retaining obsolete local coordinator flags.

### 2026-10-07 — Establish bounded compiler contracts and regression witnesses

**USER / accepted preparation scope; completed at that scope:** execute Pass 0 of the compiler library sequence. The [packet ledger, compatibility matrix and witnesses](../research/compiler-library-audit-20261006/pass0/README.md) trace live caller/owner boundaries, assign exclusive defining writers, pin fresh compiler/catalog/current built values/consumer inputs and separate established behavior from demonstrated defects and unresolved gates. Local packet labels do not allocate canonical task statuses or release package Rust-port workers.

**Established contracts:** consume lexer-owned decoded strings; keep ordinary authored HTTP(S) value admission distinct from trusted app origins; distinguish authored decimal scale from canonical runtime wire re-encoding; preserve fixed diagnostic key order/source bytes and current Can source-map byte-column profile for the verified runtime path. Fresh public values API, parser/framing, source-map producer/independent decoder/consumer, hash and filesystem observations are preserved. String emission corruption and regular-file mode widening remain unfixed. Independent review prompted exact-scalar assertions and execution-source hashes before receipt closure.

**PROPOSED implementation gates remain local:** invalid LSP ID/envelope correlation/error order/params, JSON duplicates/depth/error compatibility, complete compile-time locale aliases, file-link/new-output/metadata/Linux behavior and browser/editor source columns. No consequential unresolved alternative is selected here; three verified-context JEV requests remain required when choosing one. The earlier split strategy advice does not approve these policies. C01IR is ready for an independently checked repair and early commit without waiting for unrelated gates.

Verification scope: fresh locked lib+binary, outcome probes and source/fixture/link/pin checks on the declared macOS/Node/ICU/Rust profile; candidate dependencies, full suites, installed artifacts, browser navigation and alternate-host parity remain unqualified. No compiler/runtime source, manifest, dependency, historical acceptance status, merge/publication or complete living-plan checkpoint is changed. Scoped local commits preserve other pending plans and decision entries.

### 2026-10-07 — Verify compiler model allocation against official guidance

**USER / requested verification; PROPOSED task-specific starting settings:** the generic per-pass reminders reused an existing economical selection policy; they were not individual online task assessments. Search and fetch current official model-selection, Codex models/credit pricing, API model/pricing and reasoning guidance. The [dated allocation](../research/compiler-library-audit-20261006/model-allocation-20261007.md) now covers all 16 compiler packets, each optional comparison and final execution/review; each Pass 1–10 reminder names the relevant starts. Use Sol low for narrow released string/hash and diagnostic/docs adapters, Sol medium for ordinary protocol/validator/serializer work and Sol high upfront for C06's interacting raw lexemes, duplicates/order/accessors and parse-time limits. Assign routine inventory/defined fixtures/receipt work to Luna low/medium; retain substantive independent review with Sol.

Rationale: official guidance supports workload-based selection and representative evaluation, but publishes no best-model result for Can's packets. Codex's general Luna High suggestion is disclosed; low/medium here are deliberate hypotheses for explicitly scoped routine work under the local skill. Codex credit rates and API prices remain distinct from included subscription usage. Escalation follows concrete compatibility evidence and the task's actual uncertainty, with measured acceptance/retries/review informing later choices.

Remaining uncertainty: no per-packet model comparison, implementation trial, total token cost, runtime or programme saving is established. The allocation is independently reviewed planning guidance, not a product acceptance result or implementation-gate release. Keep existing JEV policy gates, compiler/package ownership, exclusive writers and scoped early commits; no product source, dependency, package plan, historical task status or living checkpoint changes.

### 2026-10-07 — compiler source strings use the lexer-owned payload

Accepted implementation (C01IR/C01A): IR literals/static metadata and the eight analysis decoder uses now consume the decoded String token value retained by the CST. Remove the two secondary JSON-body decoders and decoder-only helpers; retain source-aware lexing and existing JSON-input/output ownership. No dependency, grammar or package change is needed.

Invalid source has no decoded value. String-consuming checks recover locally without inventing empty keys/statuses or hiding valid sibling declarations, variants and payloads; authored empty strings and explicit-null variants remain distinct. The lexer’s E1006 messages and byte spans are preserved. Independent review rejected changing recursive module-wide error detection because that would suppress valid siblings. These changes apply the existing source/error contract and do not select a new admission/library policy.

Evidence: [Pass 1 receipt](../research/compiler-library-audit-20261006/pass1/README.md), fixed code point/JS witnesses, full-analysis recovery regressions and production CLI emission against the actual catalog followed by real UI metadata and public testkit closure execution. Full compiler suite passed (915 at its recorded snapshot), final affected suites/checks and Clippy passed. All 88 remaining formatting differences exactly match the baseline. IR was committed early as `9bb5bbd`; the completion commit records final evidence. Economical dispatch used Sol low for IR; the dispatcher’s thread limit prevented the intended second worker, so analysis stayed with the coordinator and review reused an inherited worker whose model is not exposed.

Remaining scope: Linux/installed-runtime and full application operation execution are unqualified; the existing built stdlib lacks the emitted gated-entry `require` export. Direct inline quoted locale-key IR eligibility is a pre-existing C03L gap. The separately compiled metadata/test artifacts qualify this pass’s source values without selecting those policies. No merge/checkpoint advancement is claimed.

### 2026-10-07 — compiler LSP admission preserves legal IDs and lifecycle

**Accepted implementation policy (C02):** strictly decode complete framed bodies as UTF-8 before JSON parsing; invalid bytes/JSON return one null-ID `-32700` error without dispatch. Admit object envelopes with version `"2.0"` and string method, reject duplicate decoded reserved envelope members, and preserve absent parameters separately from explicit null. Request IDs are strings or exact mathematically integral signed-32-bit values; retain original numeric spellings, including negative zero and integral exponent/fraction forms. Explicit null and illegal ID kinds/ranges receive null-correlated `-32600`, never notification dispatch. Other malformed envelopes correlate only a unique admitted ID.

Choose primitive params as structural `-32600` failures, including malformed absent-ID envelopes. Admitted notifications receive no response for method errors. Shutdown/exit accept omitted, null or empty-object params to preserve actual editor/Rust callers. Validate mandatory fields and consumed types for supported methods, accepting unknown extensions/capabilities; initialize validates before Ready. Envelope admission precedes lifecycle, then availability/parameters. Drop document notifications before initialize and after shutdown; a valid exit keeps the existing status distinction. Required document-version admission rejects malformed missing/non-integral/out-of-range versions instead of fallback/clamping; admitted ordering, full-sync selection and stale publication are unchanged.

Rationale and uncertainty: [three verified-context JEV choice consultations](../research/compiler-library-audit-20261006/pass2/consultation/assessment.md) agree on five boundaries, but split 2–1 with low confidence on numeric spelling and primitive params. Sol high investigation supports the value interpretation and identifies exact zero/underflow/range witnesses; the params-only response distinction remains an explicit project interpretation, not a uniquely mandated standard result. Advice is not regression evidence. [The frozen contract](../research/compiler-library-audit-20261006/pass2/contract.md) records actual caller closure, compatibility classifications and separate framing gates.

Verification is recorded in the [Pass 2 receipt](../research/compiler-library-audit-20261006/pass2/README.md). Strict UTF-8 was checked and committed early as `bf4b0ca`; admission/review uses economical Sol medium, with Sol high confined to unresolved protocol research. Shared JSON accessors, numeric rendering/depth, 64 MiB framing bound, dependencies and packages remain unchanged. Header charset/duplicate-length/budgets/recovery, full optional LSP schemas, typed DTO/framework adoption and alternate-host qualification remain separate work. No merge or living-plan checkpoint advance is claimed.

### 2026-10-07 — compiler ordinary URLs use a qualified parser

**Accepted implementation (C03U):** replace handwritten URL authority/scheme validation and its unsafe byte-prefix helper with `url = 2.5.8`, defaults disabled, `std` enabled. Parse without a base, admit HTTP(S) schemes and retain the authored decoded string. This applies the existing values owner contract, including credentials and parser-accepted whitespace/backslashes; trusted `app_url` origin restrictions remain separate. Invalid literals produce E3001 with existing source anchors rather than a Unicode panic or false admission. Human parser error details may change.

The [Pass 3 receipt](../research/compiler-library-audit-20261006/pass3/README.md) pins the 37-package registry lock/features/license/MSRV profile, actual public API outcomes and compiler/catalog/runtime inputs. All 29 independent cases pass both analysis routes and the macOS release CLI; 15 admitted defaults retain authored values through production-emitted JavaScript imported with actual UI/values packages. Full compiler suite: 948 passed; Clippy passed; the same 88 baseline formatting hunks remain. macOS release footprint increases 182,176 bytes (9.5%); same-image Linux release footprint increases 188,248 bytes (7.0%). Linux x86_64 release, 97 library tests, both 29-case admission routes and all 29 release CLI outcomes also pass in a pinned local container under emulation; no private sources were uploaded to the rejected remote destination. Application-operation execution, installed artifacts and universal future Unicode-data equivalence are not claimed.

**Failed candidate / retained gate (C03L):** full `icu_locale_core::Locale = 2.3.0` with `alloc` fails four admitted long-language cases and seven owning canonical identities, including discarded duplicate transform-field data. Two independently executed qualifications and a final bare-package replay agree. Keep the current locale heuristic unchanged and explicitly incomplete; do not release this candidate or create an alias table. ICU core's transitive presence in IDNA is not locale adoption.

The [finite next locale packet](../research/compiler-library-audit-20261006/pass3/locale/independent-review.md) must qualify grammar and data-backed canonical identity across scalar/context/source/message callers and emit quoted locale keys through the actual descriptor API. Native ICU and compatibility adapters remain proposals, with their host/size/data costs unresolved. No new locale policy was selected, so retaining the user-defined failed-candidate gate required no JEV consultation; consequential future alternatives still require verified-context equivalent triples. Preserve the existing pass sequence and proceed with independent packets. Sol medium handled qualification, the sole URL writer, production regression and independent review; Sol high was confined to the demonstrated locale conflict. Early URL commit: `f3612ea`. No package edits, merge or living-plan checkpoint advancement by this compiler work.

### 2026-10-07 — compiler file replacement owns staging and preserves modes

**Accepted implementation (C04F):** replace the fmt/docs predictable PID/sequence temporary pathname with destination-local owned `tempfile = 3.27.0` staging, defaults disabled and `getrandom` enabled. Write through its open handle, restore captured regular-file permissions after writing, then persist. The reproduced `0600` source widening to `0644` is repaired. Both callers use one path; error mappings, parse-before-write, stdin/check behavior and ordered partial progress remain.

Preserve deliberate requested-entry replacement: changed symlinks become regular files while their targets retain bytes; changed hardlinks detach only the requested name. Equal-output fmt, including repeated operands/aliases already completed earlier in the invocation, remains a no-op. New docs outputs use ordinary `0666 & !umask`; existing targets keep captured modes. Parent-directory permissions govern readonly replacement. Reject detected destination changes and stale fmt bytes; missing outputs use noclobber. Metadata observation starts at writer entry, after initial read/render, and the final check-to-persist race remains. No owner/ACL/xattr/timestamp/inode preservation, all-operands transaction, sync or crash-durability claim.

[Three verified-context JEV consultations](../research/compiler-library-audit-20261006/pass4/consultation/assessment.md) agree on five choices, with low-confidence symlink advice and a low-confidence 2–1 split on new-output privacy. Investigation preserves the released ordinary-creation workflow and link policy; advice is not an acceptance oracle. The [file contract and receipt](../research/compiler-library-audit-20261006/pass4/files/README.md) classify each boundary and pin dependency/features/source/tool/OS/artifact evidence.

Independent file-only macOS aarch64 and pinned local Linux x86_64 emulation releases qualify nine actual CLI witnesses; Linux additionally passes eight controlled failure/concurrency tests, including same-byte/mode/mtime inode substitution and symlink-target mode change. Private `0600`, readonly and umask cases pass both hosts. Linux establishes/preserves `04750`; macOS cannot establish that fixture and explicitly leaves that subcase unqualified. Actual docs CLI/catalog plus an explicit renderer stub qualify writing, not installed rendering. Added closure: 13 locked packages, maximum added declared Rust 1.85, project Rust 1.99 executed. Release footprint grows 16,768 bytes (0.80%) on macOS and 22,440 (0.78%) on same-image Linux. Independent read-only review finds no blocking issue under this policy.

The requested Sol-medium writer was blocked by the dispatcher thread limit, so root completed it; an existing inherited-model reviewer supplied independent review. Hashing has separate acceptance and must not delay this repair. No package edits, merge or living-plan checkpoint advancement by this compiler packet.

### 2026-10-07 — compiler SHA-256 delegates to a qualified primitive

**Accepted implementation (C04H):** retain `source::sha256_hex(&[u8]) -> String` and delegate internally to `sha2 = 0.10.9`, defaults disabled. Exact input bytes, lowercase 64-character hex, source identities, sorted/null-framed docs revisions, canonical migration directive bytes and stale-fix comparisons remain. Remove the handwritten padding/compression implementation only; no hash defect is claimed.

The [hash receipt](../research/compiler-library-audit-20261006/pass4/hash/README.md) saves 16 independent Python/hashlib answers passed by the old implementation and actual adapter, with fixed permanent vectors for arbitrary bytes, UTF-8, LF/CRLF, padding boundaries and million-byte input. All six source-module tests pass on macOS aarch64 and pinned local Linux x86_64 emulation with Rust 1.99. Five focused downstream targets pass 102 tests; the combined compiler snapshot passes 967 and Clippy. Sol low owns implementation and bounded independent review; no escalation or new protocol policy is selected.

Qualify the hash-only 47-package lock/profile against the prior 37, with asm/oid/compress/std/force-soft off and no extra hex dependency. All added licenses offer MIT/Apache-compatible choices. The selected cached 0.10.9 branch is independently qualified, not latest: 0.11.0 is published and remains unqualified here. Advertised crate MSRV 1.41 is not a proven closure minimum; the maximum added declared version is libc 1.65 with other declarations absent. Only project Rust 1.99 is executed. Backend hardware dispatch coverage remains bounded to the recorded hosts.

Representative release footprint is compared before acceptance with matching isolated `unknown` Git identity and existing stripped opt-level-z/LTO/one-codegen-unit/unwind settings: macOS grows 16 bytes (0.0008%); same-image Linux grows 5,376 (0.187%). No throughput, installed-runtime or universal size improvement is claimed. File permissions had independent acceptance and landed first as `80868ad`; shared libc/cfg-if mean this subsequent hash integration adds eight unique locked packages to that file-only lock. No package edits, merge or living-plan checkpoint advancement by this compiler packet.

### 2026-10-07 — compiler typed JSON output starts with diagnostics

**Accepted implementation (C05D/shared):** Serde borrowed DTOs preserve the complete diagnostic field order, explicit arrays/flags/counts, UTF-8 and compact bytes. Pin serde 1.0.229 (std/derive) and serde_json 1.0.151 (std/raw_value), defaults disabled. A two-case Formatter preserves established backspace/form-feed Unicode escape spelling; the library owns string scanning, including the retained public push_json_str adapter. Input parsing, ordered/raw numeric representation, duplicate/accessor/depth policy and protocol admission remain unchanged.

Generic serialization returns errors; existing closed String adapters treat impossible failures as internal tool errors. Three independently worded verified-context JEV requests select compiler-owned, syntax-qualified raw fragments for later families. RawValue accepts lone escaped surrogates, so it is not a Unicode validator and does not replace source/input admission. No valid production caller requires malformed encoded literals. See the [consultation assessment](../research/compiler-library-audit-20261006/pass5/consultation/assessment.md) for alternatives, saved responses and limits.

Independent full-byte witnesses and real check/lint/fmt subprocesses pass 12 tests with fixed expectations and actual supported flags/catalog profiles. Diagnostic sorting/text and authoring tests also passed in the initial boundary review; the diagnostic contracts package is a type mirror, not an executable validator. The [diagnostic receipt](../research/compiler-library-audit-20261006/pass5/diagnostics/README.md) records initial witness corrections and dependency metadata/features; integrated host/footprint acceptance follows with subsequent families. Sol low owns this frozen conversion; Sol medium supplies independent review, with root as sole shared/Cargo/CLI integrator. No packages changes, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed JSON references

**Accepted implementation (C05R):** Typed ReferenceModel and nested reference values retain explicit camelCase keys and field order. catalogVersion and missing translation text remain explicit null; other absent options omit, while empty/false values remain. Defaults, constraints, examples and types remain authored source strings. Public to_json compatibility adapters use the existing parser on serialized output; production to_json_string serializes directly. Extraction, portable identity and hashing are unchanged.

Sol low writer; Sol medium independent and consumer review. Three fixed full-byte fixtures plus 29 extraction tests pass. Two integrated actual consumer tests pass without skips: fresh docs CLI launches actual built can-platform, localization/empty/null fallback/default spelling pass, and extracted typed JSON reaches the public reference Markdown renderer. The same test file also qualifies the policy family separately. See the [family contract and receipt](../research/compiler-library-audit-20261006/pass5/families/references.md) for scope and boundaries. Input admission stays unchanged; no package edits, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed JSON policy

**Accepted implementation (C05P-policy):** Typed records and a small layout-only Serde Formatter preserve root/row/nested indentation, inline arrays/objects, key order, omissions and verbatim predicates/source. The serializer retains one newline and the CLI retains its existing second newline. Extraction/authorization decisions remain unchanged. HTML embedding stays UI-owned.

Sol medium writer/review. Four fixed complete layout/CLI fixtures plus two unit tests pass. Fresh CLI output passes actual UI policyDumpSections and policyPage with independent role/model/invariant/operation/source expectations and HTML escaping; no skip occurred. See the [family contract and receipt](../research/compiler-library-audit-20261006/pass5/families/policy.md) for scope and boundaries. Input admission stays unchanged; no package edits, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed JSON explain

**Accepted implementation (C05P-explain):** Borrowed six-field ordered DTOs preserve compact code/title/severity/explanation/example_valid/example_invalid, empty strings and controls, lowercase severity, no serializer newline and one CLI newline. Catalog entries and text rendering are unchanged.

Sol medium writer/review. Three fixed/full CLI fixtures plus three unit tests pass. Known E1001 runs through the fresh actual binary; independent fixed output is the oracle. See the [family contract and receipt](../research/compiler-library-audit-20261006/pass5/families/explain.md) for scope and boundaries. Input admission stays unchanged; no package edits, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed JSON fixes

**Accepted implementation (C05P-fixes):** Typed fix/rejection DTOs preserve ordered fields, all variants, source hashes/spans, caller list order, empty replacements and controls. CLI lint --fix extends DiagnosticResult with a typed flattened envelope and final fixes field; no byte-string splicing remains. Without --fix, fixes is absent; with --fix an empty list remains present. Collection/application/stale/overlap rules and one CLI newline remain.

Sol medium writer/review; root CLI integration. Four fixed fixtures and the new hermetic empty-fix real binary witness pass. Existing b3_s4 four tests pass, including actual deterministic nonempty fix JSON and real LSP stale edit/codeAction lifecycle; 29 lint tests passed in focused writer qualification. See the [family contract and receipt](../research/compiler-library-audit-20261006/pass5/families/fixes.md) for scope and boundaries. Input admission stays unchanged; no package edits, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed JSON descriptors

**Accepted implementation (C05M-descriptors):** Typed Serialize implementations preserve descriptor tags/keys, source order, omit-vs-present-empty options, array false, exact i128/decimal/duration/money minor string values and authored decimal scale. Object literal members remain ordered including duplicates. Only compiler-owned encoded literal defaults use syntax-qualified RawValue. The released shared quote adapter replaces the final private string loop; expressions/identifiers/evaluation/HTML are separate.

Sol medium writer and review. Six independent byte fixtures pass; existing focused MCP/codegen cases pass. Actual unmodified CLI modules run model defaults/message metadata and generated testkit setup/observe closures for six independently specified decoded control/Unicode cases. Production decimal default lowering currently rejects with existing E6008, so wire-scale fixtures do not claim production decimal execution. See the [family contract and receipt](../research/compiler-library-audit-20261006/pass5/families/descriptors.md) for scope and boundaries. Input admission stays unchanged; no package edits, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed JSON artifact

**Accepted implementation (C05A):** Borrowed typed artifact/module/callable/migration DTOs preserve key order, explicit arrays, omitted directives vs present empty directives, source identities, JS text and no serializer newline. Operations/models serialize directly as typed slices, avoiding reparsing/double serialization. SourceMap remains a syntax-qualified compiler-owned raw adapter; coordinates and codecs remain C08 work.

Sol medium writer/review. Two full independent byte fixtures and the actual fresh binary artifact consumer pass. Actual Cloudflare parseArtifactText/loadArtifactFile/assertCompiledIdentity verify source hashes, identities, maps, ordered models/operations/types, integer-string/control/bool defaults and omitted nullable defaults. Existing b1_join/b3_migrate (11 tests) pass. Real decimal default lowering E6008 is an existing limitation; authored scale remains qualified by fixed artifact bytes. See the [family contract and receipt](../research/compiler-library-audit-20261006/pass5/families/artifact.md) for scope and boundaries. Input admission stays unchanged; no package edits, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed JSON bdd

**Accepted implementation (C05M-BDD):** Private string quoting delegates to the common library adapter. Executable BDD functions, object-literal tables, recipes, sequence evaluation and suite separation retain their existing owners and byte output. This is string-value serialization, not a JS AST/identifier or operation execution migration.

Sol medium writer/review. Two full generated suite/shell fixtures and a fixed private all-controls/Unicode helper witness pass. Twenty scoped existing generated recipe/table/sequence/separation cases pass. Six actual fresh CLI fixtures run unmodified generated suites through public testkit loading/setup/stash/observation; operations are not executed. See the [family contract and receipt](../research/compiler-library-audit-20261006/pass5/families/bdd.md) for scope and boundaries. Input admission stays unchanged; no package edits, merge or living-plan checkpoint advancement by this packet.

### 2026-10-07 — compiler typed output qualification closes Pass5

**Accepted integration:** eight finite diagnostic/descriptor/artifact/reference/policy/explain/fix/BDD families now use typed Serde output and one library-owned byte-compatible string policy. Keep exact domain number strings/authored decimal scale, key order, omission/null distinctions, layouts/newlines and established input/protocol/coordinate ownership. Retain only live public adapters; remaining structural Json rendering and SourceMap encoding belong to C06/C07/C08. The [Pass5 receipt](../research/compiler-library-audit-20261006/pass5/README.md) records packet writers, actual caller closures, independent expectations, saved JEV advice/limits and exact compiler/catalog/built runtime pins. No built-runtime drift occurred across native checks; another agent's package source and commits remain independent.

Native full compiler suite passes 1,005 tests; 13 affected tests pass after equivalent lint/format polish, and all-target Clippy with -D warnings passes. Actual fresh CLI artifacts load through Cloudflare; references render through built can-platform/public interfaces; policy reaches real UI; emitted defaults/metadata/BDD closures execute through public testkit. Operations/production decimal defaults are not claimed. One existing macOS mode4750 subcase remains unqualified. Formatting has 83 pre-existing hunks versus88, zero added. Local pinned Linux x86_64 emulation passes109 library and30 typed/CLI tests, with three package consumers explicitly skipped in its compiler-only profile and native-qualified separately.

All62 archives match the lock (58 ->62), with four added entries and explicit std/derive/raw_value features; licenses and declared MSRVs are saved. Rust1.99 is executed, not a closure minimum claim. Matching stripped unknown-Git releases grow33,328 bytes/1.574% on macOS and41,752/1.437% on Linux; accept this bounded maintenance cost without speed/universal-size claims. Two unexplained exit137 Linux attempts precede the successful final run; no Docker settings/service changes or private uploads. Sol low owns frozen diagnostics/references, Sol medium other writers/review/profile, root shared integration. No escalation, merge or living-plan checkpoint advancement.

**Separate proposed follow-up:** investigate the current catalog/decimal literal lowering E6008 boundary before claiming production decimal defaults. Independent wire fixtures establish scale preservation; this existing lowering limitation does not authorize a broader implementation or replace the remaining audit plan.

## 2026-10-07 — Freeze catalog/LSP input-engine compatibility (Pass6 preparation)

**Accepted contract (C06):** preserve ordered decoded duplicate pairs, first lookup, arbitrary legal numeric lexemes and lexical i64 access separately from exact signed-i32 LSP IDs. Keep strict byte/Unicode admission, complete-document grammar, existing unknown/reserved duplicate policies, value-entry depth0..64 including an empty terminal container, and the inclusive64MiB pre-allocation body limit. Preserve catalog E6003/E6004 source anchors and fixed LSP error mapping. The [released finite contract](../research/compiler-library-audit-20261006/pass6/CONTRACT.md) names writers, classification and pinned witnesses. Ten independent baseline tests pass, including unchanged isolated producer, authored/built catalog equality and actual runtime/loader/fresh CLI with no skip.

**Proposal under qualification:** replace grammar with a small bounded Serde visitor/cursor adapter using existing pinned features, with an owned native ParseError reason and explicit zero-based byte/error-detail changes. Ordered/raw compatibility views and structural output rendering stay. The [three JEV consultations and investigation](../research/compiler-library-audit-20261006/pass6/consultation/assessment.md) split2–1 on both engine/error policy, with material uncertainty; the prototype relies on pinned reader behavior and measures about2x parser time. Actual consumer/cost qualification and independent review must precede acceptance. Retaining the proven bounded parser is the explicit fallback, not a newly observed defect claim. Sol high owns engine compatibility; routine witnesses use Sol low. No packages edits, merge or living-plan checkpoint advancement by this preparation.

## 2026-10-07 — Replace catalog/LSP JSON input grammar (Pass6 engine)

**Accepted implementation (C06):** pinned Serde owns JSON grammar and Unicode decoding. A bounded reader/seed/visitor preserves ordered decoded duplicates, first lookup, arbitrary exact number text and original value-entry depth semantics. Numeric-only IgnoredAny delegates primitive grammar without floats, whole-subtree bypass or private-marker interpretation. Dependencies/features remain unchanged. Keep the small compatibility view and structural output renderer; no handwritten JSON grammar remains. Reader lookahead and seed-origin assumptions require upgrade requalification.

ParseError now owns native reason text (String) with the original display envelope and zero-based UTF-8 failure/EOF point. This is an intentional public Rust field-type and diagnostic-detail change, with no current production field readers/constructors; external source consumers are unqualified. The [40-case classified error matrix](../research/compiler-library-audit-20261006/pass6/error-compatibility.json) preserves actual catalog E6003/origin/primary and fixed LSP -32700/null mapping. Independent review found and resolved nested offset drift by capturing the first failure before library cleanup. Depth rejection prevents further value/tree construction; cleanup can scan whitespace/lookahead, so66-byte bracket proof is not a universal consumption cap.

Sol high implementation and clean-room review, Sol low routine catalog/producer/measurement and Sol medium LSP process witnesses. Native full suite passes1,026 tests; final equivalent lint polish passes5 private tests and39 actual caller tests plus all-target Clippy. The [review](../research/compiler-library-audit-20261006/pass6/review.md) records evidence and limits. Root integration/host/cost receipt follows; preliminary costs favor this small adapter over unqualified two-pass rebuilding, with retaining the proven bounded parser fairly considered and no newly observed parser-defect claim. No packages changes, merge or living-plan checkpoint advancement.

## 2026-10-07 — Qualify JSON input engine host/cost integration (Pass6 closure)

**Accepted integration:** all 101 snapshot/live compiler inputs and owning catalog/runtime pins match; dependencies/features unchanged. Native full 1,026 tests, final 5 private/39 actual caller tests and all-target Clippy pass. Scoped formatting passes with 83 legacy hunks/zero added. Pinned local offline Linux Rust 1.99 x86_64 profile passes 153 harness cases, with 2 explicit missing-package skips (151 executed); actual source/built catalog, unchanged producer/export checks and runtime seam execute natively without skip. See the [Pass6 receipt](../research/compiler-library-audit-20261006/pass6/README.md) for exact tools/sources/errors/profile limits.

Accept measured maintenance/cost trade-off: real catalog parsing 60.7→81.5 µs; representative mixed input ~1.45× parser time; fresh CLI median 3.030→3.045 ms is only this fixture, not broad latency proof. Release footprint macOS+16,608B/0.77%, Linux+13,000B/0.44%. Small library adapter186 lines replaces292 grammar/UTF-8 lines, preserves actual obligations and avoids unqualified two-pass rebuilding; retaining the proven bounded parser was fairly compared, with no newly observed old-parser defect. Native error details/public reason field and pinned lookahead/cleanup limitations are explicit. No packages edits, merge or living-plan checkpoint advancement.

## 2026-10-07 — Freeze typed LSP output/URI boundary (Pass7 preparation)

**Accepted contract (C07):** release eight actual output families with pinned lsp-types0.97.0/defaults-off, shared compact serialization and unchanged input/framing/raw IDs. Source.LineIndex remains sole UTF16 owner; callbacks/snapshots stay. Preserve coordinate/location order needed by the actual editor, lists/omissions/values; classify capability/diagnostic member-order differences as semantic. Correct edit identifiers to current open i32 versions and explicit null only for unopened targets. No live symbols endpoint exists; no new capability or lsp-server adoption. [Finite contracts and writers](../research/compiler-library-audit-20261006/pass7/CONTRACT.md).

**Accepted boundary policy:** standard DTOs use spelling-preserving Uri; small typed fallback views retain any existing accepted String the crate cannot express, including raw Unicode/malformed percent. Never tighten admission, normalize keys, drop results or panic during output conversion. Only explicit case-insensitive file:// forms derive native display paths, using checked authority and exact UTF8/no NUL or authored-string fallback. Non-file/file:/relative identities remain verbatim. Native query/fragment removal and library dot handling are classified metadata policy; no filesystem/import loading is added. Three independently worded verified-context [JEV consultations](../research/compiler-library-audit-20261006/pass7/consultation/assessment.md) agree, with residual uncertainty on uniform String views; advice is not the oracle.

**Implementation qualification in progress:** Sol medium DTO/witness/review/profile workers, root sole Cargo/URI/shared-decision integrator. Four added packages only, no upgrades; library types/feature licenses/checksums and matched macOS/Linux footprint still need final integration receipt. New output tests specify independent values/spans/versions and actual framing, while existing admission/lifecycle/editor seams remain required. Windows/external backend/client capability negotiation are not expanded. No packages changes, merge or living-plan checkpoint advancement.

## 2026-10-07 — Implement typed LSP output and URI projection (Pass7)

**Accepted implementation (C07):** eight live wire families now use lsp-types positions/ranges/enums/capabilities/diagnostics/edits/actions and direct typed Serde serialization. Keep narrow raw semantic-token vector and exceptional String-URI projections; RawValue appears only for exact admitted response IDs. Required open edit versions now follow current documents, unopened target versions are explicit null. Public analysis DTOs, source coordinates, stale queues, input/framing/errors/lifecycle stay. The public URI display adapter delegates to released url native conversion; non-file/unconvertible identities remain exact and the hex/lossy loop is retired.

Sol medium independent review found no concrete issues;29 LSP unit checks,3 actual framed sessions and10 additional unusual-URI process probes pass. Native full1,034 tests and39 unchanged real editor checks pass; final test-only Clippy polish is equivalent and3 sessions pass again. All-target Clippy passes. Scoped formatting passes; whole-tree debt remains83 hunks with0 added. [Review](../research/compiler-library-audit-20261006/pass7/review.md) and [verification](../research/compiler-library-audit-20261006/pass7/verification/README.md) record evidence. Multi-file/unopened versions are unit-qualified because production edits are same-file. Windows/client negotiation/external backends remain explicit limits. Root host/dependency cost receipt follows; measured matched release grows50,000B on macOS and65,400B on Linux. No packages edits, merge or living-plan checkpoint advancement.

## 2026-10-07 — Qualify typed LSP output host/dependency integration (Pass7 closure)

**Accepted integration (C07):** [Pass7 receipt](../research/compiler-library-audit-20261006/pass7/README.md) closes the finite output/URI packet. Native full suite passes 1,034 tests; three real framed sessions independently check 61 frames and current edit versions, Unicode/CRLF positions and opaque identities. The unchanged Node editor conformance harness passes 39 checks through the real binary; no GUI execution claim. Independent Sol medium review finds no issues. Clippy passes, scoped formatting passes and 83 legacy formatting hunks remain with zero additions.

All 106 final snapshot/live inputs match. Pinned offline local Linux x86_64 qualifies 97 harness entries with two explicit missing-catalog skips (95 executed bodies), including actual output/admission/URI/IDE behavior. Missing compile-time fixture setup was corrected and all five integration targets rerun. Four checksummed packages are added, no upgrades; lsp-types defaults/proposed stay off. Transitive serde/JSON default aliases expand to existing std, without new numeric/order/format features. Accept measured matched release growth of 50,000 B/2.31% macOS and 65,400 B/2.21% Linux for this typed schema/version/URI maintenance improvement, without a speed claim. Windows, external backends and broader client negotiation remain unqualified. Current transport is retained; conditional lsp-server adoption is not a required completion item. No packages edits, merge or living-plan checkpoint advancement.

## 2026-10-07 — Freeze source-map byte-coordinate/codec contracts (Pass8 preparation)

**Accepted contract (C08):** retain original Can byte columns and source LineIndex CRLF behavior. Exact current producer plus independent decoder and actual current Cloudflare lookup/invoke/report agree: point after é😀 is byte6 and reported Can column7. LSP is a separate UTF16 path and consumes no maps; browser/host original-column navigation remains unqualified. No demonstrated mismatch warrants coordinate-policy change or JEV escalation. [Finite contracts and consumer decision](../research/compiler-library-audit-20261006/pass8/CONTRACT.md).

**Implementation qualification in progress:** pinned sourcemap9.3.2/defaults-off owns standard encoding and numeric decoding; explicit library IDs preserve repeated-path source snapshots and first-appearance names. Typed map fields/order/contents/control bytes and meaningful unmapped rows remain. Public test-only row/delta view can remain; narrow guards contain observed invalid alphabet/high-bit corruption in the candidate primitive without recreating numeric decoding. Library-map JSON projection costs temporary metadata/mappings bytes once per build and requires measurement; source text stays in the final typed map; artifact borrows typed map directly, retiring rendered RawValue embedding. Sol medium writers/review/profile, root sole dependency/shared-decision integrator. Cargo66→93 has27 additions, no upgrades; final host/cost/witness receipt still required. No packages changes, merge or living-plan checkpoint advancement.

## 2026-10-07 — Replace compiler source-map codec (Pass8 implementation)

**Accepted implementation (C08):** sourcemap9.3.2/defaults-off owns standard map encoding and numeric VLQ parsing. Source/name registrations use actual returned IDs; private collision-free source keys preserve repeated authored paths and immutable contents, then public paths are restored. Retain original byte columns, source-owned CRLF conversion and generated vector indexes/column0. Missing SourceIds become meaningful one-field unmapped segments instead of bogus out-of-array attribution. Borrowed typed map serialization preserves fields/order/contents/null/control bytes and retires artifact RawValue embedding. The library's encoded-mappings-only projection costs one temporary metadata/mappings serialization; intermediary source contents are omitted while final public contents remain exact.

The public decoder has only test callers; retain its row/order/empty/1-4-5-field compatibility view, delegate numeric decoding and guard observed library invalid-alphabet/high-bit corruption with envelope checks and checked deltas. No handwritten numeric codec remains. Sol medium independent review finds no actionable findings. Native full1,040 tests in49 harnesses and all-target Clippy pass; final actual consumer regression passes again without skip. Independent arithmetic decoding, ten byte/CRLF positions, repeated snapshots/names and empty/unmapped cases reach actual current artifact/Cloudflare/testkit consumers. A synthetic emitted invocation reports coordinate.can:1:7; a separate fresh CLI artifact has24 mapped rows with fixed source ownership anchors. Neither witness implies deployed/browser original-column navigation. See the [review](../research/compiler-library-audit-20261006/pass8/review.md) and [native verification](../research/compiler-library-audit-20261006/pass8/verification/README.md).

Scoped formatting passes with83 legacy hunks and0 additions. Matched native release grows33,392B/1.506%; fixed compile median6.550→6.598ms preserves exact artifact bytes and55 independently decoded points, without a general speed claim. Linux host/dependency closure follows. Root reclaimed only completed incremental output after process/open-file checks, preserving sources/Git/shared caches/results. No packages edits, coordinate-policy escalation, merge or living-plan checkpoint advancement.

## 2026-10-07 — Qualify source-map host/dependency integration (Pass8 closure)

**Accepted integration (C08):** the [Pass8 receipt](../research/compiler-library-audit-20261006/pass8/README.md) closes the finite codec/typed-map packet. Actual current artifact/Cloudflare/testkit consumers and independent arithmetic decoding qualify original byte columns, Unicode/CRLF, snapshot/name identities and empty/unmapped behavior; browser/GUI/host-remapped/deployed workerd positions stay explicitly unqualified. No demonstrated coordinate conflict warrants JEV escalation. Source spans and LSP UTF16 ownership are unchanged.

Native full1,040 tests/all-target Clippy pass, independent Sol medium review finds no issues, and all109 final snapshot/live inputs match. Pinned offline local Linux x86_64 passes129 harness entries/127 bodies, with2actual catalog skips,9explicit Node/package codegen exclusions verified individually against native passes, and the mandatory actual source-consumer test qualified natively. Preserve missing-image/stale-index/fixture-runtime failures and successful retries; exact public pinned-image restoration and local cache/fixture repair change no service settings or product behavior.

Cargo adds27 registry packages without upgrades:66→93 registry/67→94 total including compiler;15active on both tested hosts,12inactive target-only. sourcemap9.3.2 defaults/features/ram_bundle stay off. Checksums/licenses/declared MSRVs are saved; inactive js-sys packaged manifest is not inspected. Rust1.99 executes, without a minimum-version claim. Accept matched release growth33,392B/1.506% native and51,768B/1.711% Linux; fixed actual CLI median6.550→6.598ms retains exact artifact bytes/55independently decoded points and makes no general speed claim. Existing targets are reused; completed default incremental output alone was reclaimed after process/open-file checks, with final free space 28.79GB and unique results/shared caches retained. Sol medium packet ownership and root integration require no escalation. No packages edits, merge or living-plan checkpoint advancement.

## 2026-10-07 — Release remaining mechanism comparison packets (Pass9 preparation)

**Accepted evaluation scope (C09):** release five separate read-only CLI/completion, ICU, temporal, graph and position/path packets with exact defining files, exclusive output writers and pinned current inputs. [Bounded packets](../research/compiler-library-audit-20261006/pass9/PACKETS.md) require actual owner/compiler outcomes, independent expectations and preservation/cost evidence before adoption. Retain small custom mechanisms when a library adapter is not simpler. Ordinary/integer-number/cardinal/ordinal ICU parity executes first; newly demonstrated defects enter a finite correctness queue immediately, with a separately released repair writer before edits. Private temporal core linkage remains L-F03-gated. No framework default selects a CLI, position or language policy.

**Proposed candidates under qualification:** clap/clap_complete, FormatJS parse-core, bounded time/shared-core temporal reuse, iterative graph routine/petgraph SCCs, and line-index/path adapters. No dependency or production implementation is selected by this preparation. Candidate-specific Sol medium/ICU high/position low follow the researched allocation and rechecked official model documentation; any escalation requires evidence. Root owns integration/commits/Cargo/shared decisions, workers own only their comparison receipts. Package agent work and architecture projects remain separate; existing caches/targets are reused with storage checks. No merge or living-plan checkpoint advancement.

## 2026-10-07 — Promote executed ICU/completion defects (Pass9 correctness queue)

**Accepted bounded repair contract (C09I-1):** execute eight actual compiler/current public-owner ICU type cases before parser substitution. DESIGN9.1 and owner agree that ordinary number/cardinal accept int|decimal, while integer-number/ordinal require int. Compiler wrongly rejects decimal ordinary number with E5007 and accepts decimal ordinal. Release only examples.rs argument-style/type distinction plus focused check tests; preserve grammar, E5007/source anchors and other type/disclosure owners. This is existing policy repair, requiring no new JEV choice. Library adoption and remaining scanner boundaries stay separate.

**Promoted correctness queue (C09C/C09I-next):** actual shell probes demonstrate missing lint --fix, flag suggestions after -- and a Zsh shell-operand index failure with a working format positive control. ICU comparison also exposes additional syntax/disclosure/depth observations requiring per-boundary owner/spec classification before production release. The [finite queue](../research/compiler-library-audit-20261006/pass9/correctness/QUEUE.md) records exact potential writers and acceptance; do not fold these into a full CLI/parser rewrite or wait for all candidate comparisons. No package or Cargo edits, merge or living-plan checkpoint advancement by this packet.

## 2026-10-07 — Release completion and position/path correctness repairs (Pass9)

**Accepted bounded contracts (C09C/P09):** retain current CLI/index/path mechanisms while repairing executed bugs. The [completion packet](../research/compiler-library-audit-20261006/pass9/correctness/completion-CONTRACT.md) fixes missing lint --fix, actual Bash/Zsh terminator handling and actual Zsh shell-operand position, with exact value-token/embedding/passthrough controls. Fish engine is absent; its declaration/embedding is qualified separately and no unexecuted Fish terminator fix is claimed. The [position packet](../research/compiler-library-audit-20261006/pass9/correctness/position-CONTRACT.md) fixes bare-CR inverse conversion and retained-parent cancellation without adopting a second index or path-clean root-clamping policy. Medium escalation independently confirms all27current vectors and finite proposals after low-worker actual conflicts.

Graph comparison additionally demonstrates nondeterministic E3005 witnesses/spans across identical runs; stable origin selection needs a verified-context consultation before its own writer release. ICU has11syntax mismatch vector rows:10owner-profile correction rows grouped across6mechanisms and1unresolved top-level#question, distinct from2numeric type defects. These exact finite follow-ups are recorded without folding them into library or architecture migrations. Sol low owns released routine edits, medium review/root integration; no package/dependency changes, merge or living-plan checkpoint advancement.

## 2026-10-07 — Align compiler ICU numeric admission (Pass9 C09I-1)

**Accepted repair:** ordinary number accepts int/decimal, integer style accepts int, cardinal plural accepts int/decimal and ordinal accepts int, as accepted DESIGN9.1 and the actual public owner require. Parse and validate number style before numeric admissibility; classify the first E5007 reason change when both fail as intentional, while preserving E5007 and authored literal byte anchors. The bounded scanner remains; this changes neither syntax policy nor runtime decimal lowering.

Sol low implements the frozen packet and Sol medium independently reviews it. Four focused permanent ICU tests pass, including eight fixed combinations through source and translated routes, unsupported styles and escaped-name spans. Eight fixtures pass through the fresh real CLI with fixed expected exits/codes. [Repair evidence](../research/compiler-library-audit-20261006/pass9/correctness/icu-types/repair-receipt.md) and [independent review](../research/compiler-library-audit-20261006/pass9/review/substantive-review.md) distinguish executed type admission from untested description/production-decimal execution. Other syntax observations have separate finite queued packets; no parser adoption or broad rewrite is selected. No packages changes, merge or living-plan checkpoint advancement.

## 2026-10-07 — Retain separately qualified remaining mechanisms (Pass9 comparisons)

**Accepted evaluation result:** retain the current CLI grammar/completion ownership, bounded ICU scanner, temporal checks and position/path mechanisms. Defer graph routine/petgraph adoption until a complete compatibility adapter and actual compiler/editor workload measurements establish benefit. Candidate-specific comparisons retain balanced alternatives and independent outcomes:60 CLI process cases plus11 characterizations;8 ICU type/50 structure/six rendering vectors through public source/built owners;43 owner/compiler temporal vectors and a43-case executed time adapter;512 graphs times2 origin orders through SCC prefilter plus retained DFS;27 executed position/path vectors and a matching line-index adapter. See the [five bounded packets](../research/compiler-library-audit-20261006/pass9/PACKETS.md), lane assessments and independent reviews.

Retention does not certify every existing behavior. ICU explicit type defects are repaired; ten further measured syntax rows form six finite correction proposals. Completion and position defects have separate reviewed implementation packets. Actual call-cycle witnesses are nondeterministic; stable origin ordering remains pending consultation release, separately from any graph algorithm migration. Outside-plural ICU pound policy likewise remains unresolved. Automatic approval review rejected sending the specific saved verified-context JEV payload despite general authorization; specific human approval has been requested and no requests sent. Broader relative-root absolute-external wording and missing-suffix symlink identity remain separate unreleased path policies.

FormatJS0.3.1 source/API fails exact-selector/parse-time depth/profile gates and was not built/run; hypothetical parse-core remains proposed. clap/clap_complete4.6.7 is an executed prototype whose defaults change help precedence and exact thin tails; a full preservation adapter is unimplemented. time0.3.55 needs spelling/year/leap/all-fraction/post-offset guards and production diagnostics; private temporal linkage needs L-F03. petgraph0.8.3 synthetic gains on long chains coexist with slower independent-cycle cases; they are not measured compiler benefit. line-index0.1.2 retains policy glue and whole-index construction for inverse calls; path-clean1.0.1 clamps rooted parents differently. No candidate dependency enters compiler Cargo. Sol allocations follow researched per-candidate low/medium/high levels, with positions raised low→medium for executed CR/root conflicts; no architectural Rowan/Salsa/JS-printer project, package edits, merge or living-plan checkpoint advancement.

## 2026-10-07 — Repair completion and position/path contract defects (Pass9 C09C/P09)

**Accepted implementation:** embedded Bash/Zsh completions admit lint-only --fix, distinguish true separators from consumed split flag values, preserve file-only tails for all five thin commands, and complete Zsh's shell operand through the actual subcommand context. Fish receives lint-only declaration/embedding coverage; its engine is absent and its terminator behavior is unqualified. Source-owned forward positions stay: inverse IDE conversion strips CR only before LF, so bare EOF/internal CR counts normally; lexical docs normalization never cancels a retained parent component. Existing Unix literal parents above root are preserved, without choosing a new rooted-clamp/absolute-external/symlink policy. No dependencies or second coordinate policy.

Sol low owns each frozen implementation and Sol medium independently reviews. Review exposed the preexisting Bash thin format-domain gap; root corrected dispatch order and added all-five-command actual Bash/Zsh cases. Fresh required-engine suite passes2tests; independent position/path review passes10focused cases and accepts raw diffs. See [completion evidence](../research/compiler-library-audit-20261006/pass9/correctness/completions/RECEIPT.md), [position evidence](../research/compiler-library-audit-20261006/pass9/correctness/positions/RECEIPT.md) and [independent review](../research/compiler-library-audit-20261006/pass9/review/completion-position-review.md). Root full-suite/host integration follows; no unexecuted-host claim, packages edits, merge or living-plan checkpoint advancement.

## 2026-10-07 — Close Pass9 comparison and released-repair qualification

**Accepted integration:** all five remaining-mechanism comparisons close with retention/defer results, not mandatory library adoption. Three frozen correctness boundaries—ICU numeric admission, completion tails/separators/shell operands, and inverse positions/lexical parents—are implemented and independently reviewed. [Final receipt](../research/compiler-library-audit-20261006/pass9/README.md) records exact comparisons, outcome witnesses, writers/models, host/source/runtime limits and finite next packets. The ten additional ICU syntax rows remain six bounded correction proposals; stable cycle origins and top-level pound remain specifically approval-gated JEV policy packets, with no requests sent or choices selected. Broader relative-root/symlink identity and architecture migrations remain separate.

Native1,048harness cases/50harnesses and all-target Clippy pass; actual required Bash/Zsh completion engines execute, while Fish is declaration/embedding only. Pinned offline Linux executes68ICU/IDE/docs bodies without in-body skips;157unrelated entries are deliberately filtered. All112snapshot inputs and final owning values/catalog/DESIGN pins match, with six intended source/script changes from starting pins and no unexplained drift. Cargo/dependencies are unchanged. Package-dependent native suites use the live checkout rather than a whole-package hermetic snapshot; concurrent package/shared-plan edits are neither staged nor reset. Changed Rust formatting passes;83legacy hunks occur only in13source files byte-identical to Pass8. Raw evidence whitespace is intentionally preserved.

Existing shared native/Linux targets and caches are reused, one job/incremental off. Final read-only process/open-file checks find no build process or open target PID;26.46GiBfree, no further cleanup. Preserve all unique original snapshots/results. Local artwork/copy are unpublished supporting output and not regression evidence. No merge, living-plan checkpoint advancement, clean-build/release-size/general-speed claim or new broad architecture plan.

## 2026-10-07 — Qualify final compiler substitutions and retirement (Pass10)

**Accepted compiler integration:** the [final Pass10 receipt](../research/compiler-library-audit-20261006/pass10/README.md) closes the selected core utility programme at its declared boundaries: lexer-decoded strings, strict LSP admission, qualified ordinary URLs, SHA2, owned tempfiles, typed Serde output/bounded input, typed LSP/URI projections and source-map codec. Independent Sol medium final/caller reviews find no blocking issue, orphan private core engine or unused direct dependency. Retain live source-aware lexing, ordered/raw JSON/error views, file/protocol/URI/coordinate policy and test-facing guards; speculative deletion would remove supported caller behavior. Locale replacement failed its full owner profile; conditional mechanisms and finite ICU/graph/path queues retain their separate results, prerequisites and policy uncertainty.

Required final public recipes execute locked Cargo tests (1,048 passed in 50 harnesses), whole-compiler fmt, all-target Clippy with warnings denied and build. A narrow no-capture replay explicitly executes actual catalog, string/testkit, owner URL and source-map seams. The separately pinned production release passes direct CLI/LSP and current/fresh-installed artifact/emitted-handler/testkit consumers; 13 exact tarballs and 2,268 installed file bytes are verified with checkout reads denied. Unchanged original CanDo plus shared owners still reports its three adjudicated E3001/E3010 blockers. T37, FP.QUALIFY and FP.INSTALLED-RELEASE retain complete original acceptance; warm installed selected seams do not complete cold/full CLI/Worker/browser/persistence or every-host producer closure.

Accept the measured programme footprint cost against equivalent original/final unknown-Git snapshots: +332,320 B/17.32% native macOS arm64, +393,368 B/14.65% local pinned offline Linux x86_64. Rust1.99/profile and seven direct dependency versions/features are pinned; Cargo files are unchanged since Pass8. Explicit-success retries qualify artifacts after preserved invalid timing pipelines/incomplete status receipts. Existing caches make build times warm observations; the fixed CLI median7.953→7.931ms preserves semantic artifacts/55 independently decoded points without a general speed claim. Full native offline metadata is unavailable for an uncached inactive target package; filtered metadata and active host feature trees remain qualified. Windows/native-Linux hardware/browser original-column navigation, ownership/ACL/crash durability and lowerMSRV are not newly claimed.

Luna low/medium performs checks/profile receipts and Sol medium owns substantive/consumer review, escalating the latter after concrete invented inventory paths. All114 final inputs match freeze except the compiler README;47 release and18 consumer input pins match. Formatting clears83 inherited hunks mechanically. README/pass/task references describe actual accepted and unresolved scope. Concurrent package/shared-plan work is neither staged nor reset. No merge, publication or living-filetree checkpoint advancement occurs; a merge handler must reconcile all accumulated plan changes under AGENTS.md. Graph origin and outside-plural pound JEV choices remain unselected: specific payload transmission was rejected by automatic approval review and awaits requested human approval; no requests were sent.

## 2026-10-07 — Write the editor extension README for end users

**Accepted documentation decision:** the editor extension README explains installation, everyday editing features, compiler setup, settings, updates, and troubleshooting. Separate the full extension's compiler-backed tools from the syntax-only package, and describe colors as theme-dependent. Remove internal client/build rationale, audit receipts, local IDE state, and historical version notes from this entry point; implementation and review details remain in their owning source and existing supporting documents.

This follows the user's explicit audience correction. Feature and configuration claims are checked against the extension manifest and client, and artifact names against the release workflow. No extension behavior, packaging, or installed IDE state changes; installation and GUI behavior are not newly exercised by this documentation edit.

## 2026-10-07 — Require production reduction and consolidate LSP projections

**Accepted user requirement:** compiler library substitutions must reduce the complete production implementation/adaptor closure at equivalent supported outcomes. Tests/evidence, lockfile and binary growth are separate; correctness/retirement alone does not close simplification. Measure gross removal/addition/net and actual declarations/control flow, without minification, relocation or weakening contracts. Reconsider adapters as complicated as their predecessors. The [bounded reduction ledger](../research/compiler-library-audit-20261006/production-reduction/README.md) preserves Pass10's frozen correctness evidence while recording the unmet aggregate reduction objective and finite assessments.

**Accepted first implementation (R01):** one authored String-URI projection replaces private Standard/Compatible LSP envelope branches. Remove three URI parses, four serializer enums, duplicate workspace mapping and action dispatch:235→184 production lines,7064→5029B,94removed/43added; existing inline fixtures unchanged. Keep library Range/Position/Diagnostic/TextEdit/CodeAction base/kind and other server DTOs. This supersedes the historical Pass7 standard/exceptional implementation choice, deliberately reducing full outer-DTO coverage in favor of the previously considered simpler projection under the user's clarified goal. Wire URI identity, versions/nulls, ordering/omissions, IDs and protocol/value policies do not change; no new difficult public policy is selected.

Sol medium writes the bounded file and independently reviews actual callers/library schema. Three existing unit checks pass;62process/IDE/admission tests and whole compilerfmt/all-target lockedClippy-Dwarnings pass. All98 review inputs stay unchanged during verification. Concurrent sibling-analysis/test/editor/decision edits are preserved, explicitly pinned and not staged as this packet. Programme's frozen implementation was+22lines; applying only R01 gives−29, which remains insufficient aggregate simplification evidence. JSON coupling, duplicated metadata projections and test-only helper obligations need separate bounded assessments; no blanket rollback, new dependencies, package edit, new host/release claim, product completion, merge or living checkpoint advancement.


## 2026-10-07 — Preserve independent diagnostics and restore Cursor updates

**Accepted implementation:** recover analysis at the declaration level so a malformed declaration, import, or misplaced body line does not hide valid siblings' unresolved-name and type errors. An invalid app header still cannot reserve an owner identity: the parser wraps its complete failed header attempt in an Error node, preserving lossless syntax and diagnostic spans. Existing malformed-expression guards continue to suppress dependent cascades. This repairs diagnostic coverage without changing language admission rules.

The editor extension uses the public `registerCodeActionsProvider` API; the previous singular spelling threw during activation before document/configuration listeners were registered, leaving initial diagnostics stale after edits. Start `can lsp` in the active Can document's local workspace folder, falling back to the first local folder or inherited process directory, so workspace-relative catalog discovery works. Regression coverage uses an explicit public API mock, exercises listener registration and diagnostic clearing, and rejects the previous activation typo.

Cursor's installed syntax-only extension was replaced with the full local version 0.1.13, and its compiler setting points to this checkout's executable. Actual Cursor activation succeeds; an open temporary file publishes zero diagnostics, then E1200/E3002/E2001 after an invalid edit, then zero after correction, with Problems counts moving by exactly three and matching protocol versions 1/2/3. Temporary tracing and the test file are removed. The locked compiler suite passes 1,054 tests across 50 harnesses; whole-compiler formatting, all-target Clippy with warnings denied, 11 extension startup checks, and the existing LSP capability checks pass. Installed client bytes match the compiled source. Cross-file analysis and per-document catalog switching are not expanded by this repair. No merge or living-plan checkpoint advancement.

## 2026-10-07 — Correct compiler production-line measurement

**Accepted evidence correction:** the earlier compiler aggregate measurement incorrectly treated all source after a first inline test module as tests. `migrate_check.rs` contains 480 later production lines; qualified `cli.rs` contains 159 production lines between two test modules. Blank separators also explain two lines. Excluding only complete top-level `#[cfg(test)]` item spans gives original 69,119 production lines, qualified 69,300 (+181), and R01 69,249 (+130 from original). The preceding decision's +22/−29 aggregate figures are superseded; its independently qualified 51-line LSP reduction and correctness evidence remain valid.

The [corrected ledger](../research/compiler-library-audit-20261006/production-reduction/README.md) and pinned interval receipt separate implementation, tests, Cargo metadata and documentation. A temporary lexical boundary scan supplied the inventory; root replayed every file's interval arithmetic and an economical independent reviewer checked sums and mixed-module exceptions. These are gross physical lines including comments/blanks, not executable LOC or a complexity proof. No maintained Rust scanner, compiler behavior, dependency, package, merge or living-plan checkpoint change is introduced.

## 2026-10-07 — Prepare a compiler correctness, ownership and simplicity audit

**Accepted preparation scope:** respond to the user's request for comprehensive compiler audit steps, preserving qualified utility repairs while treating production simplification as a separate unmet requirement. The [proposed procedure](../research/compiler-library-audit-20261006/compiler-correctness-simplicity-audit.md) uses one compact responsibility/workflow/finding ledger, finite slices, economical workers, independent coverage challenge and implementable packets. Its planning exit is Step 15; Step 16 describes downstream implementation/release, without launching it or creating a second living plan.

**Proposed execution:** verify evidence and inputs, map real workflows and semantic ownership, challenge accidental compatibility, compare complete library closures, review frontend/analysis/lowering/output/transformations/editor/failure/resource boundaries, strengthen independent oracles and assess dependency/architecture costs. Simplification must meet a declared complete-closure production target and retire owned mechanisms; track the compiler/programme aggregate separately. Necessary correctness growth is an explicit tradeoff, not credited as production reduction. No API, language/protocol policy, library rollback or architectural migration is selected by this procedure.

Sol medium independently reviews and accepts after six bounded corrections; economical count review and root interval replay correct the earlier aggregate evidence. Root spot-checks concrete JSON/source-map/header/IR leads, verifies all sixteen allocation reminders and local procedure links, and confirms tracked compiler/package inputs remain unchanged from `6b8784cb8d06b7de9acc6cf9c435b7f3f954b930`. Full audit, compiler builds/tests, product acceptance and new host behavior are not executed or claimed. Preserve other-owner recovery/editor/package work and recorded unresolved policy/product prerequisites. No merge or living-plan checkpoint advancement.

## 2026-10-07 — Establish the compiler audit baseline and classify prior evidence

**Accepted Step 1 execution:** freeze compiler source at `1fd07722090fe70228a6b661e3c6e136275ca84b`; concurrent package-documentation commit `851352d5` has identical compiler contents. The [baseline packet](../research/compiler-library-audit-20261006/baseline-verification/README.md) pins all107compiler paths, exact dependency/features/lock/native tool identities, source/emitted catalog and13runtime package source/manifest/dist inputs. Original checkout archives rehash successfully; current added Cloudflare/UI exports and identity imports remain distinct from historical packaged inputs.

Correct current gross source production is69,255lines, with3,529inline-test lines and33,040integration-test/fixture lines separately classified. Build/completion implementation, Cargo and documentation are separate. Compared with original, source production is+136: previously corrected programme/R01+130 plus later recovery repair+6. The simplification objective remains unmet. Exact item intervals preserve production after test modules; counts do not measure executable complexity.

Fresh locked offline native debug build and five-target no-capture replay exit0: six tests pass with real catalog/string/testkit/URL/source-map bodies and no skips; two BDD checks qualify bytes only. Source/input capture records107/138stable pins. The decoder executes from the fixture's supported existing Bun cache, correcting the initial top-level-path inference. Sol medium independently reproduces inventory/stream/tool/dist/archive/export facts and accepts bounded scope; per-run temporal maps were not retained, so that reconstruction limit remains explicit. Root's separately dated post observation matches139available recorded hashes before the executed-status documentation annotation.

The ledger preserves historical Pass10 successes, invalid/incomplete profiling attempts and old source counts with their correction. Earlier review is bounded sampling, not a new full audit. Latest owner raw logs corroborate1,054/50harness passes but lack invocation/execution pin closure; reported editor/startup/fmt claims are not independently raw-qualified by this packet. No new whole-suite, installed/original-app, release/cold-build/browser/Worker or other-host acceptance, compiler/package implementation, new policy/API, merge or living checkpoint advancement. Economical Luna medium inventory and Sol low earlier/owner receipt review complement substantive Sol medium review. Commit input/replay pins early, then the ledger/decision; preserve concurrent package work.

## 2026-10-07 — Map the compiler responsibility coverage

**Accepted Step 2 inventory:** retain one [current compiler coverage ledger](../research/compiler-library-audit-20261006/responsibility-map/README.md) as supporting evidence for the existing living plan. All 107 tracked paths match the Step 1 source hashes at `1fd07722090fe70228a6b661e3c6e136275ca84b`: 41 source files,52 test/fixture paths and14 support/config/documentation paths. Whole files are partitioned into 544 current duty bands, including 327 source bands,94 bands in seven test files over 1,000 lines, and 24 bands in mixed authoring/IDE suites. These are current responsibility slices, not selected file moves.

Named Rust declarations/reexports remain distinct from supported consumer contracts: 648 indexed sites include 612 classified externally reachable,22 restricted and14 private-module sites; fields/variants/trait callbacks stay attached to their owner. A fresh Sol medium reviewer checked all 168 indexed inherent public methods and caught the crate-private `ExprCtx::bare` owner, alongside recipe/completion/helper omissions. Final delta review accepts corrected paths, bands, anchors, exact root recipes and fixture consumers. The ledger indexes 24 interfaces and 31 supporting file pins; package/editor owners remain external. Luna low inventory and Sol medium boundary/challenge work needed no escalation.

**Remaining audit scope:** workflow tracing, every semantic branch, public preconditions/contract obligations, test adequacy/oracles and profile/consumer execution remain open. Structural coverage is not correctness; no tests/builds were run in Step 2. Existing Step 1 receipts retain their bounded qualification and product prerequisites. Ignored target output and OS metadata are explicitly excluded. Root commits the map before final review annotations; compiler/package implementation and dependencies stay unchanged. No new language/protocol/API policy, architectural allocation, merge or living-plan checkpoint advancement.

## 2026-10-07 — Trace compiler user workflows through actual consumers

**Accepted Step 3 evidence scope:** extend the single [compiler coverage ledger](../research/compiler-library-audit-20261006/responsibility-map/workflows.md) with 18 workflow routes covering all 15 named CLI commands, public module families, generated-suite and editor joins, and five platform forwarding paths. Preserve source/catalog/checked/emission authority, actual endpoints, valid/malformed/incomplete/failed branches, and named tests versus executed witnesses separately. Compiler inputs still match `1fd07722090fe70228a6b661e3c6e136275ca84b`; concurrent package documentation commits do not alter them. No compiler/package implementation or dependency changes are made.

Fresh locked offline native debug replay reports 209 passes across 15 harnesses with one body skip: this host did not retain mode `4750`. The actual artifact loader, Markdown renderer and policy UI bodies execute; stub renderer/file tests retain narrower bridge/write scope, and decimal wire fixtures do not certify unsupported production literal lowering. Separate 2,784-file before/after maps match. The declared extension recipe compiles current TypeScript and passes 11 mocked startup checks; 39 capability checks use the actual compiler process. Actual built-platform forwarding probes qualify help/errors, staged entry URLs, structural build metadata, inactive activation exit0 and bare deploy refusal2. Initial nonexistent `prod` fixture environment failures and corrected `local` probes both remain captured. Hand-authored fixtures, source/dist pins and command success do not imply compiler-produced app, generated rows, installed-release, GUI, remote deployment or other-host acceptance.

**Observed boundaries for later contract/semantic review:** `run` stages/reports without handler invocation; CLI `test` boots/snapshots/disposes but reports `executed:0`; `build` validates release/structure without bundling; `activate` reports `active:false` with normal exit0. Deploy can emit an activation-labelled sidecar error, partially persist ordered writes, or report failed apply with exit0. The actual VS Code client ignores edit and diagnostic versions despite server guards. Public checking/report/lint callers own provenance and error/completeness gates; lint application trusts a supplied hash while IDE application hashes actual text. Docs child termination/capture and replacement preflight remain unqualified beyond bounded witnesses. These observations select no new exit, language, filesystem or protocol policy and authorize no adjacent repair by themselves.

Sol medium workers trace technical families and cross-review each other's routes; Luna low supplies editor facts, with root and Sol medium review. Sol medium independently challenges root forwarding and the final evidence/integration delta. Root checks 107 unchanged paths/544 bands, 322 workflow source anchors, 85 current source-trace pins and raw receipt integrity, then records accepted scope. Every public semantic branch, original-app/T37/FP-QUALIFY/installed-release prerequisites, test adequacy and complete-closure library simplification remain later audit work. Commit the trace/evidence checkpoint before final review/status annotations. Preserve concurrent package ownership; no merge or living-plan checkpoint advancement.


## 2026-10-07 — Challenge compiler compatibility authority

**Accepted Step 4 evidence scope:** extend the single [compiler coverage ledger](../research/compiler-library-audit-20261006/responsibility-map/compatibility.md) with 83 bounded requirements, all 26 previously recorded claim groups, all 16 core packets and 18 workflow routes. The input-collection head is `7870143465cf3d73e68339a6aa8d82109bd58397`, including the concurrent package-documentation commit; compiler source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`. Pin 82 supporting source/contract/specification inputs, keeping this shared decisions file's observed prefix separate from the new append. Requirements identify actual declarations/callers, authority, consumer minimum, retained details and proposed simplification implications. This challenges known families, not every semantic branch or all 648 indexed API declarations.

**Classification:** exact scalar values/string wire representations, source/revision/hash identities, authored URI routing, coordinate units, evaluation order, schema/null/omission distinctions and deliberate file policy have owning requirements. Equivalent object order/escapes/layout and broad ordered/raw carriers include weaker migration justifications. Current explicit public reference/fix order and formatter literal/newline promises remain binding; named-field parsing does not waive them. Existing accepted migration guards also remain binding until an explicit owning revision. Test-only repository use of the public map decoder or legacy notification helper is not external nonusage proof; live success/error helpers remain accounted for. No deletion or policy relaxation is authorized by classification.

Independent review corrects docs replacement scope: only fmt skips equal-output replacement; docs still replaces its requested entry. It identifies ICU profile admission in examples.rs separately from types.rs slot collection, distinguishes live UTF16 LSP from public byte conversion, and adds public migration-check admission separately from digest encoding. Known locale mismatches are not preservation targets. Host timezone data, locale alias qualification, path conflicts, graph/pound policy and incomplete platform product receipts retain their dependent gaps. Previous JEV approval blocks are not reopened; no new consequential alternative is selected.

**Proposed next inspection:** Steps 5–6 should compare complete representation/library caller closures against these classified minima, quantify adapter/control-flow/production costs and release any required public-support revision explicitly. No individual dependency/API/rollback is chosen here. Production reduction remains unmet; audit documentation is separate from production implementation.

Sol 6.1 medium traces technical families and independently cross-reviews them, root's family and the integrated artifact; Luna 6 low extracts prior claims and drafts navigation. Root applies corrections and validates all 107 unchanged compiler paths, prior workflow/interface pins, current compatibility pins and crosswalk joins. Final review accepts bounded scope after four integration corrections. No new builds/tests/runtime/GUI/remote execution, source/dependency/API/policy change, merge or living-plan checkpoint advancement. Commit the first classification packet early, then accepted review/status/decision; preserve the package owner's work.


## 2026-10-07 — Map compiler representations and their source/catalog authority

**Accepted Step 5 evidence scope:** extend the single [compiler coverage ledger](../research/compiler-library-audit-20261006/responsibility-map/representations.md) with 35 stage/boundary duties, eight selected carrier groups and all 18 existing workflow joins. Source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`; collection head `2e8db234` is distinct from later package documentation commits. Pin 37 supporting source/contract inputs and preserve the shared decisions prefix before this append. The map identifies source/token/CST, resolution/type/effect/example, IR/JS/BDD, descriptor/artifact/map and report/editor/actual consumer owners. It is not every type field, semantic branch or complete runtime closure.

**Observed facts:** CheckedProgram retains declaration/type/effect/example tables but not complete per-use resolution/binding or expression trees. Editor analysis repeats parse/check/resolve; IR reparses registered DB sources and rebuilds name/member/type/argument decisions; docs/lint reparse their source sets. Some conversions intentionally supply target/context/wire information absent upstream. Analysis builtin selection uses shape/specificity, whereas IR named argument order selects first matching arity; current-catalog/effectful counterexamples remain unproved. Migration predecessor/directive admission runs only during IR emission, not twice. Typed default fragment/RawValue and public docs serialize/parse compatibility views are concrete later integration leads. Runtime descriptor validation/interim tables, emitted policy transcription and testkit recipe/row reconstruction are actual consuming boundaries, not automatically duplicate compiler work. No workload/cost/production-reduction claim follows from observed repetition.

**Executed provenance witnesses:** after a fresh locked/offline native library build, eight public-API emission cases use complete clean CatalogAnalyzer results and production EmitOptions. A foreign database with matching IDs/spans changes OLD to NEW without mismatch rejection; swapped source numbering retains old identities while exchanging One/Two default values. Changed catalog effects add awaiting, including a major7 catalog while artifact requirement minimum remains0 from the old checked label; same-version changed catalog content also changes emission. Coherent controls pass. Same-database append preserves the original SourceId bytes and emits OLD while including both registered revisions. Reversed caller file order changes module allocation without diagnostics. These deliberately mixed public inputs demonstrate unsealed coherence and ordering preconditions, not ordinary CLI stale output. The actual CLI retains one db/program/result/catalog cohort and gates errors; private snapshots borrow and construct their inputs together. Docs has an explicit analyzed-source/success precondition. Exact low-level source/catalog support or enforcement remains a later choice.

The initial ordering fixture used invalid package-body grammar; exit101 after six successful cases is retained with its source/logs. Corrected app fixtures pass eight cases. Initial fresh build output is transcribed; later raw build verification occurs after probes and confirms unchanged library/input hashes, not a pre-probe rebuild. All108 compiler/catalog probe pins match; exact artifact field association has independent assertions. No generated JavaScript execution, full suite, GUI, installed/original application, other-host or performance qualification.

Sol 6.1 medium traces and independently cross-reviews technical families, root provenance and the integrated map; Luna6 low indexes selected carriers/workflows. Root corrects declared-field versus wire-projection names, exact anchors, rule ownership and scope annotations, then validates current paths/pins/joins/evidence. Final review accepts bounded scope after four minor integration corrections. **Proposed next work:** settle source/catalog cohort and checked binding publication before sharing/caching results, then compare complete library/conversion closures under Step4's current contracts. No individual representation merger, API/hash seal, dependency, cache or new policy is selected; source/package implementation remains unchanged. Preserve other-owner documentation; no merge or living-plan checkpoint advancement.


## 2026-10-07 — Review complete compiler library closures and retirement budgets

**Accepted Step 6 scope:** extend the single [compiler coverage ledger](../research/compiler-library-audit-20261006/responsibility-map/integrations.md) across all seven direct dependency pins and 22 engine/consumer-family results, with 49 supporting file pins. Compiler source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`; collection head `e9524b39` and initial audit commit `39d9f45` are separate. Linked internal/public/CLI/editor closures, recursive emitter/typechecking routes, Serde callbacks and named first consumer bodies are accounted for; arbitrary external Rust callers and full downstream package workflows remain open. Union383 source units/25 source files/15,841 physical lines includes necessary domain/caller context, not dependency overhead or removable code.

**Reviewed results:** 15 retain, six defer, one bounded simplify; no unqualified replacement. Retain thin SHA2/URL/file policy and typed output/domain DTOs. BDD may consolidate its duplicate private quote helper under a complete-closure net-deletion gate. Reopen JSON one-byte reader/error/numeric coupling, public docs views, policy layout, encoded literal/default text, source-map projection and public compatibility helpers only through their named support/value/byte/host owner gates. Current public nonuse is not deletion authority. Always-String URI wrappers are necessary current identity policy; artifact maps borrow typed SourceMap with zero RawValue map joins. Collision-free source registration depends on pinned builder behavior, despite public method calls. No private encoder, blanket Value conversion, library/backend type merger, API deletion or revised contract is selected.

Conditional targets name complete predecessor mechanisms and replacements: input reader net40, docs13views/helper44bodylines, policy142gross/net120, default parse1→0/net10, map extraction16inclusivephysical/net>=1, public map decoder85productionlines, legacy envelope builders29currentlines, descriptor methods plus models_json12helpers41bodylines, fix wrappers9 and position carriers18. These are planning acceptance budgets, not candidate measurements or additive savings. Shared/fallback/API support code stays inside each closure; an unsupported or more costly substitute must be revised or retained. Public helper removal and policy changes remain proposals, with consequential alternatives requiring later verified-context JEV consultation. Existing failed candidates/L-F03 and prior blocked transmissions are unchanged.

**Reduction remains unmet:** published counter/catalogue/delta replay and independent arithmetic confirm original69,119/current69,255 production lines:2067removed/2203added/net+136. Whole-source changes include correctness and other-owner duties, not solely adapters. The initial delta assertion failure from same-text production/test membership is retained; corrected replay reconciles both snapshots. A test-only decoder move could reduce production while deleting zero repository lines. No Step6 implementation reduction is credited.

Sol high handles uncertain shared JSON compatibility; Sol medium independently reviews technical families/root/integration; Luna medium extracts/replays factual inventory/counts. Final review accepts bounded scope after caller/body/typed-join/helper-count corrections and all499pin references reconcile. No compiler build/tests/generated-JS/package/GUI/installed-product or performance experiment in this step; previous executed witnesses retain their own pins/scope. Source/dependency/API/contract policy unchanged, concurrent package documentation preserved; no merge or living-plan checkpoint advancement.


## 2026-10-07 — Audit finite compiler syntax and independent recovery

**Accepted Step 7 evidence scope:** extend the single [compiler coverage ledger](../research/compiler-library-audit-20261006/responsibility-map/syntax.md) with 27 syntax-stage families, eight open finding/repair packets and a finite registry. All 186 full normative EBNF productions, 119 SyntaxKinds, 4 NodeDetails, 68 catalog words, 75 HeaderKind rule lines and 21 custom key-form records have explicit source owners and stage limits. Full production continuation ranges, actual import resolution owners and custom header scopes were corrected in independent review. Source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`; collection HEAD `f3dd798c` and early audit commit `b2f22749` are separate. This is a complete finite source/form map, not every grammar branch or semantic/value/context cross-product independently executed.

**Demonstrated open correctness findings:** the landed resolver/header recovery fix remains valid but effects still applies recursive owner/File vetoes. A malformed policy sibling suppresses intact secret-return E4011 and redundant-actor E4020, including a second valid module in the same file. Dropped valid policy tables fabricate E4004; the initial prediction that no-policy E4004 also vanished was falsified and corrected. Types source-tag precollection drops valid `source="fr"`, losing real fr-repetition E3016 and fabricating en-repetition E3016. Valid tab caption/children and structured preference order disappear with CLI compile exit 0; Corpus with an unknown model also disappears without checking or emission refusal. Judgment compile fails E6006; decimal and unsupported factory paths remain explicit emission refusals. Unclosed delimiters/unterminated string within an open schema swallow later declarations/module while preserving bytes; synchronization is a separate policy boundary under normative depth-zero joining.

**Executed evidence:** fresh locked/offline native library/binary build, 330 passes across eight harnesses plus 15 syntax-inline passes, no reported SKIP, and all six actual compiler/testkit decoded-string witnesses. Forty initial cases plus ten added controls qualify public parse/real CatalogAnalyzer/clean-result production emission. All 49 valid-UTF8 cases retain byte coverage; the invalid byte case is lex_bytes E1002 and actual CLI E7002/exit 2 stderr. Sixteen CLI calls corroborate stage/error/semantic-loss outcomes. Fresh 54-file corpus projection: 54 covered, 52 parse-clean, 2 check-clean, one emit-clean ExpenseFlow; TeamTasks has two E6008. Corpus JS does not execute and full corpus artifacts are not retained. Original 94 pre-execution assertions preserve 13 mismatches across eight cases; 76 later independent outcome checks retain 7 defect mismatches. Post-observation expected rejection/value checks are labeled as later, not retroactively claimed initial oracles. The initial byte capture assumed JSON stdout for early tool error; raw CLI output and capture correction are saved. All 107 compiler, catalog/corpus and 550 recorded installed-runtime pins reconcile; runtime dist/source build parity is not asserted. macOS arm64 only; no whole suite, GUI, installed/original app, performance or new package build qualification.

**Proposed dependent work:** R01 effects local recovery and R02 valid-header metadata can proceed independently of delimiter or new-language decisions. R03 Tab/R04 structured order require one serialized IR writer and actual UI consumer outcomes. R05 corpus/judgment and R07 finite UI profiles require released language/producer/consumer ownership; R06 synchronization needs verified-context JEV for consequential alternatives before implementation. R08 promotes independent outcomes with each repair and reconciles prototype-only prose/stage guarantees. Existing compatibility and complete-closure production-reduction requirements remain binding; no large secondary recovery/compatibility engine is proposed. No particular new support policy/API/backend/parser/library is selected.

Sol 6.1 medium traces forms/recovery and independently challenges source/raw/CLI results; Luna 6 medium inventories and validates mechanical facts. No escalation or model-cost benchmark. Root executes witnesses, integrates the common ledger/decisions and commits only compiler evidence, preserving package-owner work. Finite structural/stage mapping and bounded execution/review are accepted; whole semantic/oracle/resource/host/product and later audit steps remain open. No compiler/package/test/dependency implementation, grammar/API/policy change, merge or living-plan checkpoint advance. Whole production remains 69,255 versus original 69,119 (+136), with zero Step 7 production change.


## 2026-10-07 — compiler audit Step 8: bounded semantic findings

**Accepted audit evidence, not implementation or policy selection.** [Semantic audit](../research/compiler-library-audit-20261006/responsibility-map/semantics.md) maps 44 finite duties with named resolution/type/effect/permission/value owners and independent review. Current locked source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`; fresh native evidence has 440 selected passes, 73 retained public API fixtures, 12 graph process repeats, 70 actual public-owner calls, eight real CLI calls and two emitted pure-format executions. Exact retained input/hash/command results distinguish current source, installed dist and controlled producer variants.

Order-dependent nullable-array admission, omitted derive query scope and named/positional runtime format failures are concrete compiler repair inputs. Existing G09-1 nondeterministic witnesses are reproduced; distinct upstream/edge/multiplicity policies remain binding pending their own release. Full `(file,start,end,code,message)` dedup identity is accounted for. UI descriptor ownership differs from values descriptor ownership; the inferred generated URL-param rejection was rejected by owner trace and executed controls. Incorrect initial E3005/significant-digit expectations are recorded as audit oracle corrections, not defects.

**Proposed follow-up, separately gated:** repair array joins and derive dependencies using one authoritative checked fact; qualify format overload bindings/options and the compiler/stdlib/values signature seam before retiring reconstruction. DESIGN1085 proposes context-aware lowering while the installed facade is two-argument; the runtime mismatch selects no API change. Resolve email floor, formatter temporal partition, pinned timezone data and presentation carrier/profile discrepancies with their owners. Consequential new choices require verified-context JEV; prior rejected transmissions and existing locale/ICU/temporal/graph gates are retained. Package implementation remains with package owners. Trial overload facts, unknown nominals, general authority scalar/default dependencies, bytes capability and complete generated/app/resource/oracle behavior retain explicit unqualified scope.

No compiler source/test/dependency, package implementation, new API/policy, merge or living-plan checkpoint changes. Three Sol medium semantic lanes/cross-reviews plus Luna medium receipt review reuse the researched economical allocation; no escalation or measured model-cost claim. The finite audit does not complete Steps 9–16, T37 or installed-release parents.

## 2026-10-07 — Audit compiler outputs and source transformations

**Accepted bounded Step 10 evidence:** extend the existing [compiler coverage ledger](../research/compiler-library-audit-20261006/responsibility-map/outputs.md) with 35 finite duties (15 serializer families, 13 transformations, seven coordinate/identity boundaries), five repair/qualification packets and source/execution joins. Compiler source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`; collection HEAD `0edfde19` and early commit `eb5ca8d` are distinct. Libraries and adapters have their actual caller/consumer boundaries; exact scalar spellings, omission/null, array/order, authored URI and original Can byte coordinates remain distinct obligations. Byte guards supported only by current adapter promises are not automatically permanent product requirements.

**Demonstrated findings and gates:** legal Can parameters `class`, `await`, `default` and `c` pass real checking/compilation but emitted modules fail Node syntax checks; `c` collides with the injected context binding, so a reserved-word-only patch is insufficient. Same-key/severity public diagnostics differing only in tags retain insertion order despite documented full byte determinism; no actual CLI producer is shown. Actual `can docs` reaches the installed public renderer, where inline/table defaults mishandle backticks, pipes and literal backslashes under official CommonMark/GFM rules; compiler JSON preserves those values and the renderer remains package-owned. Safe unreachable-statement removal also deletes its attached explanatory comment; comment ownership/preservation is unresolved separately from runtime meaning. Native mode `4750`, other hosts, browser source-map navigation, full runtime Decimal literal emission and client edit application remain qualification gates.

**Executed evidence:** fresh locked/offline native library/binary build and Cargo-reported observer libraries; 113 harness passes in 18 integration suites plus three selected unit families, zero harness failures/ignored, one reported `4750` fixture branch skip. Sixty-one distinct public format/fix inputs include 54 corpus files; 52 clean corpus files preserve recursive CST topology, exact token spelling and decoded strings, while two known malformed drafts are refused. Actual CLI checks cover no-write check mode, malformed multi-operand admission, equal-output inode preservation and fix-report-only behavior. Eighteen compiler CLI calls and five emitted-module syntax checks are captured. Nineteen independent forward byte/human/UTF16 and 32 inverse vectors qualify coordinate clamping; actual framed LSP, artifact/docs/policy/source-map consumers and six production emitted-string/testkit vectors execute at native scope. Later verification has 377 checks, 367 passes, ten nonpassing outcomes classified as defects or gates rather than ten equivalent compiler defects.

**Proposed repair sequence:** OUT-R01 uses one scope-aware resolved identity-to-JS binding policy, preserving authored property/wire names and source attribution; no new AST framework is selected. OUT-R02 qualifies or narrows the unsupported public tie-order promise before adding machinery. OUT-R03 belongs to interfaces docs; no package implementation is authorized. OUT-R04 releases attached-comment ownership with verified-context JEV if choosing consequential new policy. OUT-R05 retains consumer/host/profile gates without blocking independent binding correctness. Shared defining files have one serialized writer; small released checks may use cheaper workers. Sol 6.1 medium performs serializer source review and independent challenge, root executes/integrates remaining slices after the agent-thread limit prevents more delegation; no model escalation or cost benchmark.

Observer/review errors are preserved separately: one audit-only compilation omitted a required argument; a reviewer compared different source/projection hash domains and retracted a false collision warning (the original 61 IDs were unique); defensive path-ID rerun and tags-only ordering control are explicit. No Markdown parser/GUI, full suite/release/footprint, installed/original app or universal semantic/runtime attribution claim. No compiler/package/dependency/policy/API implementation, merge or living-plan checkpoint change. Step 9 and Steps 11 onward remain proposed.

### 2026-10-07 — Compiler audit Step 11: editor state and lifecycle (executed planning scope)

**Accepted audit scope:** 17 finite server duties and 14 actual-client/consumer duties extend the existing compiler responsibility ledger to 537 rows. Source/caller review, currentness, versions/options, close/shutdown/disconnect, catalog/workspace boundaries and source history are joined to exact witnesses. This records current behavior and proposals, not implementation or a new support/API/framework choice. The canonical living plan/checkpoint remains unchanged; no merge occurred.

**Observed correctness gaps:** freshly compiled unmodified client/provider modules driven by actual server frames install delayed diagnostics for older and closed documents, discard a version1 rename fence after document version2, and pass LSP completion kinds 7/6/14 into host kinds 6/5/13. A cancelled hover provider still offers a result; the synchronous server ignoring cancellation is a separate permissible profile. Real supported-option sessions ignore `includeDeclaration:false` and emit `documentChanges` with absent capability support. Bad-source close has no server empty publication; bundled local deletion masks ordinary close but cannot reject late frames. No GUI rendering or actual edit application is claimed.

**Support/resource boundaries:** joint CLI import/export checking succeeds while opening the same two files in LSP produces E2005 and no cross-file definition; each editor snapshot analyzes one source. One catalog is captured from process environment/cwd, used across roots and unchanged by watched/configuration/folder notifications; a fresh process sees mutation. Long-session RealAnalysis callbacks retain 96 source revisions/791031 text bytes; 32 equal-text live changes reuse them; close/reopen adds source 97/799271. Source shows historical parse/lint with current checked facts, not historical typechecking. Queue drains; no RSS leak, exhaustion, isolated cost benchmark or workload benefit is measured. Public batched close/reopen with version1 duplicates new-byte analyses and public shutdown pumping publishes queued work; normal stdio drains each frame, so this is not asynchronous old-byte publication evidence.

**Executed evidence:** fresh locked/offline native library/binary build and Cargo-reported public observer; six selected integration suites 99 passes plus 29 LSP unit passes, zero failures/ignored, 97 unit exclusions. Existing startup test 11 mock passes. Seventeen actual server processes comprise 11 process sessions, two option sessions and four real children under actual client/provider modules with selectively strict host stand-ins; two clean CLI controls precede semantic comparisons. Cooperative stop/deactivate, pending client delivery on death and manual restart/current-document replay execute. Nine client observations, 129 RealAnalysis callbacks, 245 later control/receipt checks and independent server/client/process reviews are saved under the linked editor report. Rust 1.99.0/aarch64-apple-darwin, Node 24.21.0 and installed TypeScript 5.9.3 are pinned. Compiler/editor/catalog inputs stay unchanged and production line reduction is not claimed.

**Proposed sequence:** ED-R01 client diagnostic currentness; ED-R02 versioned edits/provider cancellation; ED-R03 completion host identity; ED-R04 server close publication; ED-R05 supported reference/edit options; ED-R06 session source/history ownership; ED-R07 workspace/cross-file/catalog supported closure; ED-R08 public queue epochs/shutdown; ED-R09 remaining handshake/host/race qualification. Each names exact defining writers; common files release sequentially. Existing-contract repairs need no new policy; consequential new ownership/workspace choices require verified-context JEV before selection. No framework is adopted automatically, and complete production caller/state retirement remains the simplification metric. Economical reused Sol 6.1 medium source/review workers and root execution/integration required no escalation.

**Corrections/limits:** first initializer and cross-file fixture were malformed; dependent results and the observer's own retention unwrap panic are excluded, with scripts/streams preserved. Intermediate Python indentation failed before execution. Client review corrected invocation order and narrowed stand-in/death claims. Handshake errors/timeouts/races, stubborn child and failed writes, parent/signal termination, GUI/apply, representative resource workloads, other hosts, full final release and installed/original application acceptance remain open. Step 9 and Steps 12 onward remain proposed. No compiler/editor/package production change, merge or checkpoint advancement.

**Evidence:** [Step 11 report](../research/compiler-library-audit-20261006/responsibility-map/editor.md), [packet registry](../research/compiler-library-audit-20261006/responsibility-map/editor-evidence/registry.json), [receipt verification](../research/compiler-library-audit-20261006/responsibility-map/editor-evidence/outcome-verification.json).

## 2026-10-07 — Package integration dispositions (planning only)

**Reviewed audit evidence and method:** [76 nonadditive disposition records](../research/package-library-audit-20261006/integration-dispositions/README.md) cover 27 audited library families and 49 existing duplicate/boundary candidates at package source 780ab04c. Three Sol 6.1 high assessments plus a finite Sol 6.1 high opposing review preserve exact source/caller/contract and retirement limits. Replacement-only acceptance requires strictly less readable production implementation and implementation plus maintained declarations across the full affected owner/caller closure; added correctness/capability has a separate scope/budget. Moves, compression, generated/test deletions and overlapping gross envelopes earn no production saving.

**Proposed choices, not adopted implementation or behavior:** retain seven bounded library/platform seams; simplify the existing ryu wrapper; consolidate copied build/catalog ownership; select one Work-private strict UTF16 plus pinned percent-encoding 2.3.2 candidate; retain 17 substantial or currently better-fitting existing families. The 49 subsidiary choices retain transaction/public/error/evaluation owners around equal private leaf consolidations. Decimal/carrier and compensated import/map closures are not labeled thin merely because primitives are delegated. Public/test-only helpers and observed function/getter/date/error quirks do not automatically establish perpetual product policy.

**JEV and uncertainty:** three independently worded [requests/responses and investigation](../research/package-library-audit-20261006/integration-dispositions/jev/README.md) split URI strategy library/shared/library (probabilities .63/.52/.92; confidence .45/.28/.88). Verified source, not voting, selects qualification of the library candidate: preserve exact persisted bytes, component-call order, leaf URIError fields and target/resource closure; count temporary UTF8/encoded/U16 copies and all helper/type/import/dependency costs before retiring three loops. Shared existing mechanics are a fallback candidate only if qualification fails, never a second permanent route. Locale retain/retain/retain advice carries probabilities .92/.70/.61 and confidence .88/.55/.41. Exact-string Intl remains conditional on an explicit output contract and real caller/host/data gates; known locale fidelity/data obligations stay open. Earlier raw-map candidate advice and finite installed Node/workerd diagnostics retain their actual scope, without a repeat question or new refusal profile.

**Limits and retirement:** all future exact reduction counts remain unknown and no new policy/API/profile/library/backend/default/TS retirement or runtime acceptance is claimed. [Decision record](../research/package-library-audit-20261006/integration-dispositions/decision-record.md) separates future locale, map, cookie-order, persisted JSON and public/backend transitions. Existing security/lifecycle/correctness queues, pending critical Astra review, native preparation HOLD, compiler ownership, T08/T26 and original installed/durable/app gates remain. No package/compiler production change, product build/test/install, active task completion, merge, living checkpoint advancement or publication occurred.

## 2026-10-07 — Compiler failure/resource/host audit Step 12 (planning only)

**Accepted evidence and method:** [44 finite duties and seven proposed packets](../research/compiler-library-audit-20261006/responsibility-map/failure.md) join the existing responsibility ledger. The unchanged compiler tree is db66f796, last source change4ecd991a; d412296 is the original observation head, not source identity. Initial read-only recovery verifies114 current input pins; final integration separately verifies original Git contents for concurrent live repairs and reports drift. All86 resource and82 filesystem raw hashes match without rerunning behavior. Original native-debug resource43commands/42observations and filesystem41commands/21observations remain pinned. Files17 harness passes include one native4750body skip; direct4750fixtures also fail establishment. Independent admission/resource/filesystem reviews retain their bounded scope.

**Demonstrated findings:** legal flat arithmetic2124B/1024terms parses/checks clean but compile abortsSIGABRT;4172B/2048 and6076B/3000 parse clean but check/compile abort. Five stderr streams report stack overflow with no timeout. Parser-frame expression depth does not bound structural left-associative/postfix height; normal parse and tree drop survive all six fixtures. Exact analysis/IR/JS/clone/drop attribution and portable thresholds remain unknown. The executable unwind contract does not catch aborts; allocation exhaustion is unexecuted. JSON/catalog ladders through declared finite ranges survive, not a new crash finding.

**Accepted policy retained:** current C04F requested-entry replacement, regular modes, equal fmt noop, parse-before-write, ordered partial progress, trusted parent and explicit nonCAS/nondurability limits remain. Actual Git/Cargo env consumers stay current for ordinary/packed/gitfile fixtures: stale metadata hypothesis is falsified in that profile; missing watched paths cause unnecessary repeated rebuilds. Reuse ED-R06 retained-history evidence without inferring RSS leak/OOM or historical full typechecking.

**Proposed sequence:** FAIL-R01 localize/repair accepted flat-expression stack failure before structural redesign; FAIL-R02 qualify unwind README/comments; FAIL-R03 define supported header/body/lifecycle qualification before cap/behavior changes; FAIL-R04 remove missing-path watcher work with current-commit controls; FAIL-R05 qualify renderer/output lifecycle; FAIL-R06 release representability/width duties separately by owner; FAIL-R07 reuse session-history and host gates. Exact potential writer/test files and acceptance are in the registry. No new depth/header/global size limit, ownership API, parser/library/arena substitution, panic strategy or dependency is selected. Consequential refusal/support changes require verified-context JEV after localized evidence and balanced alternatives.

**Corrections/limits:** first observer failed E0308 from a wrong byte/string API call and executed nothing; source/streams remain. Earlier structural-depth inference is corrected; catalog matcher is unexercised because the mutated builtin is unused. Observer source/rlib/compile pins remain but its deleted executable has no SHA. Lexical1792hazard candidates are not reachability or bug proof. Core/time controls are not heap/output/RSS sandbox or benchmark. Exact crash stage, release/otherhost/workload profiles,4750native special bits, renderer timeout/reap, public carrier preconditions, whole semantics/oracles, installed/original app and GUI acceptance remain open. No production/package/dependency/policy implementation, merge or checkpoint advancement occurs.

**Evidence:** [registry](../research/compiler-library-audit-20261006/responsibility-map/failure-evidence/registry.json), [validation](../research/compiler-library-audit-20261006/responsibility-map/failure-evidence/validation.json), [independent resource review](../research/compiler-library-audit-20261006/responsibility-map/failure-evidence/review-resources.md), [file review](../research/compiler-library-audit-20261006/responsibility-map/failure-evidence/review-files.md).


## 2026-10-07 — Resume released compiler repairs: type inference and owner metadata

**Accepted existing-contract repairs:** SEM-R01 preserves a nullable peer when joining equal array element types, independent of authored order. Contextual arrays and arrays inferred into locals both reject a nonnullable argument; established narrowing still admits both orders. SYN-R02 reads valid module header source metadata despite an unrelated malformed body, while malformed headers retain local suppression through parser/resolver identity. No new nullable-element type syntax, locale policy or general union inference is introduced.

**Verification:** the nullable regression failed against the predecessor's fixed-first case. The complete b4_check suite passes281 tests including exact rejection anchors, local/contextual paths, narrowing positives, app/package source variants and invalid-header controls. Independent source review found no blocker. Captured historical nullable-array rejection is E3001; the old audit packet's E3005 expectation was mistaken. Production types.rs grows one net physical line; this is correctness growth, not library simplification. No merge or living-plan checkpoint advancement.


## 2026-10-07 — Retire duplicate BDD string quoting

**Accepted simplification:** BDD and production JS use the existing shared JSON string quote owner. Remove private bdd::js_string rather than leave a wrapper/fallback; narrow shared visibility to the codegen module. Complete two-owner production closure removes six lines and adds one import line (net−5), exceeding the declared at-least-three-line retirement target. This is a bounded achieved saving, not completion of the programme's aggregate reduction goal.

**Verification:** both independent fixed-byte control/Unicode unit tests, two typed BDD tests and all six real compiler/testkit string witnesses pass. Source review confirms equivalent escaping and error invariant; no new dependencies or wire/recipe identity policy. No GUI, installed-release or whole-app conclusion; no merge/checkpoint advancement.


## 2026-10-07 — Package dependency-ordered repair queue (planning only)

**Accepted planning method, proposed repairs:** the [reviewed queue](../research/package-library-audit-20261006/repair-queue/README.md) preserves all original task IDs/statuses/prerequisites and narrow evidence. Forty-eight finite packet labels refine existing work (20 ready recipes, 27 blocked, one human-held programme); 76 disposition records and crosswalk/acceptance/duty aliases are nonadditive. Each packet names exact source files, local blockers, deletions, unknown future reduction and actual caller/negative qualification. Exact-file handoffs serialize conflicts only; library/owner policy is not globally frozen.

**Review and uncertainty:** Luna 6 medium extracted records; Sol 6.1 high prepared technical packets and independently challenged raw requirements versus the proposal. Seven queue defects were corrected and reread, with no unresolved finding within bounded planning accountability/metadata. Twenty-seven metadata/source checks pass; no product checks ran. Accountability for 333 identities/114 duties/316 responsibilities/400 contracts is not semantic completeness, security/runtime/adoption or installed acceptance. All future production reductions remain unmeasured; replacement-only candidates must strictly reduce both readable implementation and implementation plus maintained declarations across the complete changed closure, or retain the current mechanism. Correctness/capability receives a separate budget.

**Owners and preserved gates:** [owner reconciliation](../ideal-filetree-plan/package-repair-queue-refresh.json) retains package boundaries and compiler-agent source/docs/tests, without claiming live leases/ACKs. Interfaces premature replay-age guards, not already-correct canonical State L3, are the IP07 repair sites. Native preparation stays held; critical Astra review stays approval-pending. Original T08/T26, actual durable/browser/app/installed/native and TS-retirement gates remain. Existing JEV advice is retained; consequential new choices still require verified-context JEV3/owner release. No implementation, product execution, false parent completion, merge, checkpoint advance, scheduling or publication is authorized by this queue.


## 2026-10-07 — Make promised diagnostic output ordering total

**Accepted existing output contract:** OUT-R02 preserves the existing file/start/end/code/message sort prefix, then compares severity, ordered related span/message sequences and ordered tags. This fulfills finish's already documented insertion-independent byte promise for publicly constructed diagnostics. Related/tag order within a diagnostic remains authored. finish, emission and editor analysis share one comparator; retire their duplicate sort closures. The separately documented public analysis/check file/start/code key remains unchanged, as does first-pass deduplication policy.

**Verification:** eight foundation and one typed CLI diagnostic tests pass, including independently ordered ties, insertion rotations/reversals, text/JSON and idempotence. Independent review finds every serialized diagnostic field covered without allocations or subfield normalization; selected real-server tests exercise the shared editor owner. The complete three-owner sort closure removes15 net production physical lines, while adding necessary tie correctness. No actual CLI tags-only producer is claimed, and no new public sorting/API policy is selected.


## 2026-10-07 — Repair effects recovery and recurring derive dependencies

**Accepted existing-contract repairs:** SYN-R01 removes file/module recursive error vetoes while retaining local malformed-declaration/expression and invalid-header suppression. Valid sibling policy/message tables and independent E4011/E4020 survive, without invented E4004. SEM-R02 reuses the existing callable model/call maps to record bound derived-function bodies and queries, then follows those identities through the existing visited recurring-handler scope traversal alongside scenario/CRUD calls. No new scope policy or default/server-initializer dependency model.

**Verification:** all46 effects tests pass, including full check_program orchestration, six recovery positions, local suppression, exact spans, direct/grouped/nested and scenario-to-derived queries, homogeneous/unused negatives and invalid cycle termination. Root independently reviews exact source/test closure. Formatting and diff checks pass. Production grows43 physical lines; necessary correctness growth earns no library simplification credit. No merge/checkpoint advancement.


## 2026-10-07 — LSP lifecycle, edit negotiation and mutation-target identity (accepted)

**Choice.** Keep queued diagnostic work bound to the existing immutable SourceId plus client version; close removes that URI's work and emits a typed empty diagnostic set, and shutdown/exit prevent later publication. Honor `includeDeclaration=false` by excluding exact definition locations. Negotiate versioned `documentChanges` only when advertised, otherwise emit ordered `changes` with authored URI strings. Capture `set`/`delete` target-head bindings during the owning resolver traversal, and let reference/rename queries consume those facts before later locals can shadow the name.

**Rationale and verification.** These repair existing supported outcomes without a new workspace, snapshot, backend trait or state engine. Native LSP unit checks and35 IDE plus8 actual-process typed-output tests pass. A clean Unicode-comment/CRLF source receives all four declaration/read/set/delete rename edits with exact UTF16 ranges and rechecks clean through a fresh compiler process; shadowing, selectors and unresolved targets have negative controls. Close/reopen, reused versions, unrelated queued URIs, shutdown and absent/false/true edit capability profiles retain explicit tests.

**Limits.** The plain carrier has no document-version field by protocol design. Cross-file support, retained-history resource policy and real GUI application remain separate qualification/ownership gates. The changes are correctness work; their complete production closure grows101 physical lines and makes no aggregate simplification claim.


## 2026-10-07 — Executable panic boundary wording (accepted)

**Choice.** Qualify the compiler README and forced-fault observer comment: E7005/exit2 covers unwinding executable panics, while aborts such as stack overflow bypass that handler, and public library callers retain their own boundary.

**Rationale and limits.** Step12 retained actual legal-input stack aborts, so the previous universal internal-fault/no-Rust-trace statement was false. This documentation correction does not repair those aborts or introduce a resource limit, dependency or support policy. The ordinary forced-unwind executable regression remains the owning witness; stage localization and iterative-consumer design are tracked separately.


## 2026-10-07 — Injective generated bindings and canonical callable registry (accepted)

**Choice.** Generate disjoint UTF8-hex implementation identities for lexical declarations, canonical module symbols, operations, UI factories, pages and owning module paths. Resolve authored expression names through balanced lexical scopes; preserve ambient context and generated temporaries. Keep property/wire/source/canonical identities authored, including computed own `__proto__` keys. Registry members and operation handlers use canonical callable identities consistently across scenario, CRUD, derive and derive-field emitters; actual consumers follow recorded artifact export/member/module paths.

**Rationale.** Lossy sanitization admitted reserved/context/import collisions, local registry keys overwrote distinct package callables, and lowercased paths merged legal case-distinct module owners. The shared identity codec replaces the sanitizer, collision retry allocator, local CRUD-name reconstruction and path lowercasing. Independent review also reproduced hook-local binding leakage into generated CRUD; each hook now owns a balanced scope.

**Verification and limits.** Two permanent executable tests pass independently: clean production CLI artifacts run reserved/context/query/shadowing and cross-package callable/CRUD/derive-field cases; actual Cloudflare loader, assembler and dispatcher use their unchanged metadata paths. Hook-to-CRUD create/update/delete executes after the regression fails on the pre-fix implementation. Separate public-IR tests execute Unicode identifiers, imports, lambdas and temporary collisions because current source admission does not support every constructed-IR form. The117 codegen goldens passed before the final hook-only scope repair; full final integration qualification is recorded in the resumed release receipt. Host stdlib seams assert identity/order, not full application semantics. The closure grows45 production physical lines: required correctness work, not an aggregate line reduction.


## 2026-10-07 — Editor revision ownership, cancellation and host enums (accepted)

**Choice.** One live document-owner map joins host document identity/version with a monotonic wire version, including reopen. Diagnostics and all seven providers use that owner for revision/lifetime admission. Cancellation retires pending responses and sends the standard cancellation notification; conversion runs only for the still-live captured revision. Versioned edit targets retain their wire version until this check, and the client advertises `documentChanges`. Translate LSP completion ordinals through actual host enum members; correct the ambient host enum declarations.

**Rationale and verification.** Delayed diagnostics/results, closed/reopened buffers, dropped edit versions and mistaken enum equality violated supported editor behavior. The single shared owner replaces unchecked per-provider conversion; no second state registry is introduced. Independent source review and isolated compilation accepted the closure. Final strict TypeScript compilation,11 startup checks,39 actual-server protocol checks and five currentness groups pass against a fresh compiler. All seven providers cover pre-cancel/no-send and stale/live-cancel/no-conversion. Exact offered Unicode/CRLF edits apply in a strict host stand-in; mutation-target completeness is qualified separately by clean-source LSP/query regressions.

**Limits and measurement.** Bundled server diagnostics have versions; unversioned publications are outside this repaired profile. Plain protocol edits retain their separate live-target fallback. Actual GUI/application, arbitrary cross-file support and startup policy remain unqualified. The production TypeScript closure grows111 physical lines (182 added,71 removed), necessary correctness work rather than a reduction.


## 2026-10-07 — Economical package repair delegation (planning only)

**Accepted allocation policy; proposed dispatch settings:** use the least expensive supported reliable model/effort for each finite packet, including retries and required review. [Per-packet settings](../research/package-library-audit-20261006/repair-queue/model-allocation.md) separate coding, independent local review and specified records/fixtures across all 48 packets. The 20 ready recipes select Luna medium 4, Sol low 5, Sol medium 10 and Sol high 1. Sol high remains assigned to actual unresolved ABI/authority/lifecycle/resource/installed joins; Astra is reserved for existing required critical or evidenced consequential stages. Model and effort are rechecked at dispatch, with compact context and concrete escalation rather than broad repeated prompts.

**Evidence and limits:** official model-selection, reasoning and pricing guidance informed the choices; this is a risk-informed starting allocation, not measured model performance or a savings forecast. Independent Sol medium metadata review corrected the review-only final packet's escalation and then verified all 48 settings. Thirty-seven metadata/source checks pass. Ordinary local review does not satisfy approval-pending or required critical Astra gates; matching-source scope can reuse accepted evidence without duplicate reviews.

**Preserved scope:** the technical queue projection is unchanged. Task identities/status/prerequisites/files/acceptance, held native preparation, foreign compiler ownership and living filetree checkpoint stay intact. This applies only to future delegated packets; no product execution, timer, paid model experiment, backend cutover, publication or implementation authorization.


## 2026-10-07 — Generated fixture identity and causal binding scope (accepted)

**Choice.** Reuse the JS identity codec for BDD recipe declarations/references and canonical suite paths, preserving authored computed fixture keys/dependency object identity. Retire the separate BDD sanitizer. Pass one existing `scopeFacade(bound)` through all five causal-sequence closure positions while private Map writes and invocation/error/order control stay unchanged.

**Rationale and verification.** A clean `fixture class` compiled successfully but its test module could not import. A clean sequence's emitted `b.class` read received undefined from the bare Map. A permanent production CLI/actual testkit body now passes eleven recipe-name vectors, dependent recipe identity, independently specified three-owner case/dot-path scopes and values, progressive lets/calls/assertions and a separate public Map-method/outcome-reference control. Independent replay accepted the closure. Fresh supported producer builds and testkit typecheck succeed after restoring exact locked dependencies;36 existing package tests and the final1070-pass compiler suite pass. The standard wrapper's earlier cleanup/failure, partial emits and invalid `by=caller` source extension are retained separately, not credited.

**Limits and measurement.** The invocation port/disposal remain stand-ins; current `as` stores CallOutcome, rather than proving returned payload propagation. Request-bearing sequence execution and full worker/application/other-host profiles remain separate gates. No caller admission or IR/property schema changes. BDD production removes9 lines net; shared helper visibility is net0 and testkit sequence source adds3, for **−6** across the complete changed production closure. The programme's aggregate reduction goal remains unachieved.


## 2026-10-07 — Resumed compiler audit and released qualification (accepted)

**Choice.** Close the finite lowering, failure, oracle, dependency/cost and independent-priority review at its declared scope, and qualify only the explicitly released existing-contract repairs. Keep historical source/range/receipt pins unchanged and append current disposition/execution joins to the same coverage ledger. No new framework, dependency upgrade, cache, public support retirement, global resource limit or application deployment is selected.

**Rationale and verification.** The interrupted task left missing failure evidence and current-versus-historical status ambiguity. The [resumption journal](../research/compiler-library-audit-20261006/resumption/README.md) joins 44 recovered failure duties, 11 lowering duties/eight follow-ups, twelve oracle/dependency/cost/architecture follow-ups and the independent 30-finding/ten-candidate/later 19-record challenge. Records with shared owners are not independent implementation wins. Reproduced hook leakage and BDD fixture/sequence defects gained owning repairs and independent actual consumer witnesses. Final compiler verification reports 1,070 passed/zero failed or ignored in 52 result blocks, one explicit mode-4750 body skip, formatting and Clippy with warnings denied; editor strict compilation/11 startup/39 protocol/five currentness groups and 36 testkit checks retain their separate source/body profiles. Later BDD test-only oracle strengthening was independently replayed without inventing a new full-suite total. The wrapper cleanup/failure, partial emits, invalid caller-admission extension and invalid cost observer are retained/excluded; exact locked dependencies were restored without manifest/lock changes before successful producer/consumer qualification.

**Measurement and remaining uncertainty.** The published physical counter gives compiler 69,255→69,416 (+161 this round; +297 versus original 69,119), editor TypeScript +111 and testkit sequence source +3. Quote/comparator/BDD-testkit complete closures remove 26 lines, while necessary correctness growth prevents aggregate reduction. Matched no-Git native stripped z/LTO binaries grow 32 bytes; warm fixed CLI/persistent LSP observations are bounded workloads, not causal speed/cache claims. Every branch, public source/catalog cohort, owner/value/UI/format/graph/docs, retained-history/workspace and original installed/full worker/GUI/otherhost obligations remain explicit. FAIL-R04 remains a ready existing-mechanism candidate rather than an implemented repair. This task performs no merge or living-plan checkpoint advance.

## 2026-10-07 — Flat-expression stack investigation direction (proposal)

**Advice and evidence.** Fresh final-source native-debug public stage observers complete at 64/512, abort in JS emission at 1024, typing at 2048 and resolution at 3000. Direct lower_expr aborts at 1024 after construction while clone/normal destruction controls succeed; the 512-term emitted sum executes through actual stdlib. The final matched native release binary checks and compiles 1024/2048/3000 successfully in all six controls. Exact internal helper attribution and portable support limits remain unproved.

Three independently worded equivalent, verified-context JEV choices favor investigating iterative complete-consumer work before introducing structural admission or stack-support limits, with confidence 0.49/0.94/0.86 and probability 0.66/0.96/0.91. [All requests/responses](../research/compiler-library-audit-20261006/resumption/README.md#failure-localization-and-design-advice) retain the first wording's lower confidence. The chosen direction agrees; complete consumer closure, qualification effort and other hosts remain uncertain. Treat this as advice: no new language limit, parser/arena redesign or production writer release follows. FAIL-R01 remains an unresolved native-debug valid-source defect.


## 2026-10-07 — Delegate Values special numeric text to pinned formatter (accepted)

Use existing ryu-js1.0.3 Buffer::format for the String channel, removing duplicate zero/NaN/infinity branches. Its all-f64 category behavior matches the old owner; the JSON channel and structured errors are unchanged. Complete changed production closure removes 13 readable and 13 total production/declaration lines, independently measured.

Three native corpus checks cover 10,213 numbers and 131 owning caller observations; source-current private Node qualification passes 2/2. The old wire donor drift is reconciled by exact core extraction normalization and fresh equal observations, without rewriting historical evidence. Independent source/raw-witness review accepts this narrow reduction, not full wire-domain, Wasm, installed, durable or backend adoption. [Current evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/numeric-independent-review.json) retains source hashes and original residual gates.


## 2026-10-07 — Remove Work numeric forwarding and special cases (accepted)

Work String delegates all f64 categories to existing pinned ryu-js1.0.3 Buffer::format; its JSON nonfinite guard stays unchanged. Seven private forwarding functions become direct import aliases, preserving leaf carriers, argument evaluation, faults and identity builders. Independent full-closure measurement removes 33 readable code lines and 36 total production/declaration lines.

Seventy-three registered tests, 171 leaf tests and 10,213 current V8 comparisons pass, with an original observer explicitly unexecuted. Independent source review checks all-f64 category equivalence and actual native caller witnesses. This is the numeric reduction scope only: public installed routing, Wasm, durable consumers and original producer/transport/backend gates remain separate. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/work-numeric-result.json) preserves exact commands and limits.


## 2026-10-07 — One private appearance picker for ten renderers (accepted)

Move the ten byte-equivalent private option pickers into UI's internal appearance-props owner. Each caller keeps the same composition point and appearance admission owner, including two getter reads for a defined property and tone/size/variant/orientation order. Public entrypoints and package exports stay unchanged.

Independent source/emitted comparison, getter and sentinel controls, and all 496 selected renderer tests pass against private source-current output with the actual package dependencies. Readable production decreases by 221 lines. Even charging the two new private generated declaration lines, the complete measured closure decreases by 219; public declaration bytes remain equal. This is extraction acceptance, not broader browser/app/backend qualification. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/ui-appearance-independent-review.json) records hashes, tests and boundaries.


## 2026-10-07 — Share environment Promise caching inside worker boundary (accepted)

Keep the shared private keyedPromise primitive inside worker/main.ts: the proposed separate file would violate the existing static-runtime-import boundary. Two WeakMaps and policy accessors remain separate. Exact Promise identity, immediate factory execution and synchronous throw, rejection retry, and identity-guarded old-rejection eviction are preserved without deferred factory invocation or a new loader.

Independent source review, package noEmit check, unchanged public declarations, all 17 worker/main-boundary tests and direct actual-accessor/assembly rejection controls pass. Readable production decreases by three lines; the two-line physical reduction and unchanged generated declaration bytes also establish a strictly smaller complete source closure. This is the cache primitive scope, not full installed/deployment/backend acceptance. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/keyed-promise-independent-review.json) preserves inferred types, source pins and residual gates.


## 2026-10-07 — One acyclic Gregorian leaf owner (accepted)

Values kinds and temporal owners share their exact pure daysInMonth/isLeapYear bodies through internal/gregorian.ts. Invalid dates/year/month and original Date.UTC profile remain with callers; the helper imports neither owner, so no kinds/temporal cycle is introduced. Public owner declaration bytes remain unchanged.

Independent baseline/current comparison, direct centuries/leap/invalid/endpoint/calendar controls and all 48 selected kinds/temporal tests pass. Readable production decreases by 22 lines; after charging two private generated declaration lines, the measured closure decreases by 20. This accepts private leaf consolidation, not global host/timezone/locale, Wasm or backend adoption. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/gregorian-independent-review.json) retains exact source hashes and limits.


## 2026-10-07 — Remaining compiler model and reasoning assignments (planning only)

**Accepted allocation policy; proposed dispatch settings.** Give every remaining compiler reference explicit work and independent-review model/effort settings. The [current allocation](../research/compiler-library-audit-20261006/resumption/model-allocation.md) covers all 67 existing references: 50 remaining, continuing-checklist or qualification joins and 17 completed bounded receipts with no new dispatch. Four conceptual owner lanes organize work; overlapping references share released outcomes and exact-file writers rather than multiplying implementations. Direct tooling, compact context, cheaper fixed recipes and frozen leaves, matching-scope evidence reuse and concrete escalation keep dispatch focused.

**Rationale and verification.** The historical C-series settings did not individually cover the later failure, lowering, oracle, dependency, cost, architecture and integration references. The new metadata view joins their canonical ledger dispositions and prerequisites without creating task identities or changing acceptance. Independent Sol 6.1 medium review accepts the bounded allocation; reference, phase, supported-pair and local-file metadata checks pass. High-effort work and reviews have specific ownership, policy, lifecycle or evaluation uncertainties rather than routine default escalation.

**Uncertainty and scope.** Recheck availability, source/profile inputs, released file leases and existing owner/JEV/support gates at dispatch. No implementation, source qualification, policy/API decision, broader application acceptance, merge or living-plan checkpoint advance follows from this allocation.


## 2026-10-07 — One Work UTF16 JSON appender, separate leaf carriers (accepted)

Rows, receipt and linkage share their exact existing UTF16 JSON append body through decisions/utf16_json.rs. Recovery retains its allocating facade and delegates append mechanics. Keep independent Value/U16/Error domains and URI refusal; no universal graph/value bridge or lossy Rust-string conversion is introduced. Cargo registers the private helper.

Independent source comparison and freshly regenerated V8 data cover all 65,536 raw units and 1,048,576 valid pairs (1,114,112 cases). Fresh registered 73 and selected 247 native decision tests pass, with original observer exclusions retained. Actual payload/diagnostic and persisted-ID callers remain equivalent, including lone-unit and malformed-URI controls. Complete readable closure removes 97 lines; physical production/declaration closure removes 102. This is native quote-owner acceptance, not public installed routing, Wasm or broader delivery/backend qualification. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/work-quote-independent-review.json) preserves hashes, recipes and limits.


## 2026-10-07 — Preserve own data keys through form parsing and coercion (accepted)

Define enumerable, writable, configurable own properties on the existing ordinary output objects in form/filter parsing and form JSON coercion. Declared `__proto__`, `constructor` and `toString` remain data; unknown keys, authentication, action handles and invocation admission retain their original owners. Both parser and coercion changes are necessary: parser-only preserves the key but old coercion changes its local output prototype; coercion-only cannot recover a dropped parser key.

Independent baseline/mutation controls and 42 relevant source-current tests pass through the real HTTP handler, including zero-invocation refusal controls. Public declarations are unchanged. This is a correctness repair with two added production lines, separately budgeted; no production reduction is claimed. Collection-query evidence is helper-only because no production caller exists. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/form-own-keys-independent-review.json) retains exact pins and narrow limits.


## 2026-10-07 — Share UI error digestion without duplicating declarations (accepted)

CSV and browser export delegate their identical digest mechanics to internal/business-errors.ts. The two existing public interfaces and wrapper declarations remain byte-identical, retaining declaration merging. The private helper infers its unchanged result rather than adding another maintained interface or owner import cycle. Public wrappers keep their original names and return contracts.

Independent current-source compilation, 41 selected caller tests and getter/exception-order controls pass. Readable production decreases from 450 to 428; charging the private declaration increases, the complete measured closure decreases from 583 to 571 (12 lines). Prior alias/private-interface candidates are superseded. [Final evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/business-errors-independent-review-final.json) preserves hashes and limits; CSV grammar, authority, provider policy and wider UI qualification remain separate.


## 2026-10-07 — One private Values violation appender (accepted)

Schema and wire retain their collector types, path aliases and traversal owners while sharing the identical pushViolation leaf through internal/violations.ts. Preserve receiver-bound ctx.violations.push, copied/frozen paths, field omission and ordered construction; no generic validation pipeline or backend conversion is introduced.

Independent 254 selected tests, seven baseline/current public-caller comparisons and receiver/getter/iterator/exception controls pass. Public owner declarations are byte-identical. Readable production decreases by 16 lines; charging four private declaration lines, complete measured closure decreases by 12. Emitted bytes increase slightly, so no byte-saving claim is made. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/violations-independent-review.json) preserves source pins and original backend limits.


## 2026-10-07 — Share private prepared binding entries (accepted)

HTTP and ordinary MCP prepared plans share the exact deferralFor/toBindingEntry mechanics through internal/prepared-binding.ts. Existing PreparedDeferral/PreparedBindingEntry declarations stay at the HTTP owner, and the helper's type-only import creates no runtime cycle. Framing, mismatch errors and plan construction remain with each caller.

Independent 16 selected caller/construction tests and scoped typecheck pass; getter, enum copy/freeze, exception identity and mismatch-before-shape order match baseline. Public declaration bytes and interface augmentation remain unchanged. Readable production decreases by 15 lines; charging three private declaration lines, complete measured closure decreases by 12. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/prepared-binding-independent-review.json) preserves exact pins. SDK provenance, sealed handles and broader prepared/backend/CSV acceptance remain separate.


## 2026-10-07 — Share object-body and Bearer lexical leaves (accepted)

Interfaces CSV/export/uploads share the identical parseObjectBody mechanics, and MCP/uploads share the identical bearerToken leaf, through internal/input-admission.ts. Distinct authorization/admission policies, handler positions, IdentityError versus ordinary errors, uploads availability and response statuses remain local. No authentication policy or provider activation changes.

Independent strict baseline/current emits, 103 existing and 105 current actual-caller tests, and 43 independently observed header/body/error/refusal controls match. All four public declarations remain byte-identical. Readable production decreases by 28 lines; charging two new private declaration lines, complete closure decreases by 26. The 33-line test addition is separately reported maintenance cost, not production-saving credit. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/input-admission-independent-review.json) preserves exact pins and original security/installed/parent limits.


## 2026-10-07 — Include current source tests and owning numeric resources (accepted narrow repair)

Identity's default unit recipe also selects emitted src tests, adding the two authentication suites exactly once. Work's emit recipe stages only its original numeric-text oracle and JSON capture at the paths expected by the emitted contract test. No fixture/oracle regeneration, assertion weakening or native observer substitution.

Fresh private executions of the actual build/unit scripts pass 92 Identity and 464 Work tests without skips. Root independently verifies the 12 previously omitted Identity tests and 74 Work numeric tests, exact source/staged resource hashes, and refusal when the numeric fixture is missing. [Discovery](../../implementation/package-maintenance-repair/runs/codex-go-20261007/test-discovery-independent-review.json), [producer](../../implementation/package-maintenance-repair/runs/codex-go-20261007/test-discovery-repaired-result.json) and [root checks](../../implementation/package-maintenance-repair/runs/codex-go-20261007/test-discovery-root-review.json) keep source pins and limits. This is test-recipe correctness with separate maintenance cost, not production reduction, full installed/native qualification or parent closure. Values string lookup/provenance and the original native differential gate remain open.


## 2026-10-07 — Share matching UI draft-value leaves (accepted)

Controls and forms share eight identical private draft/value functions through internal/draft-values.ts. Their differing datetime exception wrappers stay local, as do field/form composition, numeric/array/file dispatch and the original Date.UTC year profile. The helper uses a type-only FormFieldDef import; public declarations and owner responsibilities remain unchanged.

Independent fresh compilation, 183 existing real caller tests and 502 independently written differential cases per variant match complete HTML, faults, getters and fallback order. Readable production decreases by 121 lines; after nine private declaration lines, complete measured closure decreases by 112 and 2,667 bytes. No new maintained test or generated-code saving is counted. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/ui-draft-independent-review.json) retains pins and limits. Acceptance covers current TypeScript/server-rendered consumers, with broader browser/backend/installed gates still open.


## 2026-10-07 — Approved finite critical source review, joined acceptance still open

The human approved the exact prepared 187 KB source payload and OpenAI destination for one read-only Astra high review. The supported subagent completed that frozen-source review; the earlier rejected CLI attempt remains historical evidence and was not bypassed. [Scope and approval](../../implementation/package-maintenance-repair/runs/codex-go-20261007/critical-review-request/scope.json) and [findings](../../implementation/package-maintenance-repair/runs/codex-go-20261007/critical-security-review.json) preserve the hash, exact selected ranges, model and limitations.

Eight findings separate source-level credential/recovery/owner races from conditional public exposure and omitted canonical projection, replay, storage/owner and revocation joins. Root is checking actual source-current consumers and counterevidence before choosing repairs or contracts. Advice is not whole-package security acceptance, a new topology/policy decision, or closure of the original credential/durable/compiled gates. Required mechanical work proceeds independently on released files.


## 2026-10-07 — Share exact State leaves, retain backend authority (accepted mechanical scope)

D1 and Durable Object storage share identical private SQL/query/row-codec leaves through storage/sqlite-codecs.ts; mutation, migration and grants share exact own-path/freeze leaves through internal/own-data.ts. Existing backend transactions, authority, first-error order and public owner declarations remain local and unchanged. Internal row aliases preserve both original structural member profiles.

Independent source/remainder/type/declaration proof, 111 actual private SQLite backend tests, 41 owner/query controls and five differential controls pass. Readable production decreases by 367 lines; complete declaration-charged closure decreases by 238. Private DO worker import provenance and fixture-only module-root adaptations are verified; failed harness logs remain recorded. [Evidence](../../implementation/package-maintenance-repair/runs/codex-go-20261007/state-private-independent-review.json) retains limits, including no independent full typecheck rebuild. The original inherited constructor/toString metadata lookup defect stays open under TECH-S01-own-key; no whole original State/security/durable/backend programme acceptance is claimed.

The [source-current security join](../../implementation/package-maintenance-repair/runs/codex-go-20261007/security-joins.json) also disproves the old readiness assumption that retained replay already enforces current authority/projection. Interfaces replay-age removal therefore waits for that concrete canonical repair. The emitted-policy, memory-store, arbitrary-result provenance and actual installed/owner-binding gaps remain explicit; no new topology or projection contract is silently chosen.

## 2026-10-07 — Git-resolved compiler build metadata watches (accepted)

Watch Git-resolved HEAD, symbolic-ref and packed-ref paths; for an absent loose ref, watch its nearest existing parent. This preserves current short commit/unknown output without a new dependency and removes the observed unchanged-build churn. Twelve supplied controls and sixteen independently authored native Cargo/Git fixture checks pass, covering ordinary/packed/detached/linked/separate-Git/unborn/no-Git layouts and branch/commit movement. [Independent evidence](../../implementation/compiler-completion/build-metadata/independent-review.json) pins the source. FAIL-R04 is complete at this native scope; UTF-8 paths and the files refs backend were exercised, while other hosts/reftable and later Git availability remain unqualified.

## 2026-10-07 — Renderer handoff ownership and finite duplex I/O (accepted)

Drain renderer stdout/stderr while sending its reference model; close input before waiting and terminate/reap the owned child after a failed handoff or wait. Actual early input closure left a child alive, and finite startup stderr deadlocked the previous sequential handoff. E7004 and partial-output refusal remain unchanged. Eighteen focused CLI tests, eight actual CLI controls and independent exact cleanup/duplex probes pass; [source-pinned evidence](../../implementation/compiler-completion/renderer-lifecycle/independent-review.json) retains earlier failures. This closes the narrow handoff/duplex defects within FAIL-R05; generic time/capture policy, descendants and other-host qualification remain open.

## 2026-10-07 — Editor startup and shutdown ownership (accepted)

Admit document traffic only after successful initialization; retire failed/dead startup and bound initialization cleanup to ten seconds. Keep one active client during overlapping restarts, cancel requests immediately on stop, observe cooperative exit, and retain the existing two-second shutdown phases with forced termination. Failed writes retire transport and document ownership, so unsent revisions cannot remain current. Strict TypeScript, fourteen controlled lifecycle groups, six actual subprocess groups, eleven startup groups and five actual-can currentness groups pass. [Independent correction review](../../implementation/compiler-completion/editor-lifecycle/independent-review-corrected.json) preserves its two original blocking findings and verifies their fixes. ED-R09 closes at this bounded native/host-callback scope; GUI/other hosts, workspace/catalog and automatic reconnect remain unselected, and forced signal issuance is not a synchronous OS-reaping guarantee.

## 2026-10-07 — Ordered flat-expression consumer traversal (accepted)

Use explicit ordered work stacks for binary resolution, context-sensitive typing/narrowing, IR decoding and JS traversal; emit long binary trees with guarded temporary statements while retaining compact short output. The internal 64-depth switch chooses output shape and rejects no source. Preserve association/precedence, expected typing, lazy RHS, once/source order, checked arithmetic at each node, recovery and unsupported-child behavior. Three independently worded JEV choices advised long-only statement emission; 421 focused tests and 23 supervised observations cover native debug stages through 3000 terms, real stdlib arithmetic, clone/drop/logical controls and six release controls. [Independent actual-source review](../../implementation/compiler-completion/flat-stack/review.md) additionally checks overflow identity, nullable/enum expectations, lazy awaited operands, control escaping/scopes and owning-declaration maps. FAIL-R01 closes at this bounded native/emitted-consumer scope, without a universal depth/resource guarantee. Arbitrary inter-task async continuation, full scenario facade/application and other hosts remain open. Review also retained concrete existing short enum/member and membership-order gaps under SEM-R08/S9-Q02; they are not hidden by this closure.

## 2026-10-07 — Preserve explanatory comments during dead-statement removal (accepted)

Preserve ## source lines, line endings, indentation and sibling bytes when removing unreachable executable statements; refuse destructive Description metadata edits. Thirty-two lint tests, thirty authoring tests and six independently literal-expected probes pass. The initial E1126 invalid-description fixture expectation and existing public collect_fixes E1003 tab behavior are retained separately; this does not claim universal malformed-input refusal. [Independent evidence](../../implementation/compiler-completion/comment-preservation/independent-review.md).

## 2026-10-07 — Fallible executable panic reporting (accepted)

Use fallible stderr writing in the panic hook so stderr failure does not abort a caught unwind. Actual anonymous EPIPE and owned child file-limit EFBIG reproduce the previous SIGABRT; repaired cases preserve exit2 and ordinary E7005. Three new plus eleven existing executable tests and twenty-one finite native controls pass, with independent baseline/current witnesses. BrokenPipe retains normal0/10/2 and thin child outcomes. Unestablished wait/read failures, arbitrary blocking/descendants, other hosts and universal timeout/capture policy remain open. [Independent evidence](../../implementation/compiler-completion/process-boundaries/independent-review/review.md).

## 2026-10-07 — Owning enum claims and source-ordered membership (accepted)

Lower enum values through owning resolved-case facts while preserving resolver-owned lexical binding facts for real parameters/locals. Compact membership evaluates LHS then RHS once through ordered call arguments, preserving awaits and lazy grouping without an extra Promise. One hundred seventeen codegen tests and six actual flat/runtime tests pass; independent compiled-module probes cover colliding/reserved/builtin case names, dynamic nullable parameters, expected scalar/array arguments, exact failures and lazy/awaited order. This closes the two concrete enum/member and compact membership joins; broader SEM-R08/S9-Q02 obligations and actual scenario facade/application qualification remain open. [Independent evidence](../../implementation/compiler-completion/enum-membership/review.md).


### Package repair: own SQLite metadata lookup (accepted narrow correctness)

Guard the private metadata table with `Object.hasOwn`; legitimate declared data fields such as `constructor`, `toString`, and `__proto__` keep the existing JSON lookup rather than inheriting an object member as SQL. Real metadata precedence, bound values, ordering and invalid-name refusal remain unchanged. Independent actual local D1/workerd DO checks pass 28 controls; the producer records 18 passing backend tests and 627 unchanged-profile comparisons. This one-expression correctness fix claims no production reduction and does not close owner isolation, confidentiality, replay, deployment or complete query acceptance. [Exact-source review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/state-own-key-independent-review.json). No merge or complete living-filetree checkpoint advance.


### Package repair: private controlled HTTP leaves (accepted narrow reduction)

Four Node harness owners share only the unchanged bounded body reader, and three use the same raw-string/JSON reply leaf. Provider admission, cancellation/reconcile lifecycle, the media JSON-only writer and scenario/playback error boundaries remain local. Independent source/current callback, localhost and scenario/playback controls preserve getter/effect/first-error order; 121 provider/scenario/private tests pass. Parsed-token counting corrects scanner trivia inflation: readable production shrinks by 87 and the complete owner/helper declaration-charged closure by 84. The existing Node UTF-8 byte ceiling and playback character ceiling deliberately remain distinct; no uniform service policy or installed/lifecycle/security acceptance is implied. [Exact-source review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/service-leaves-independent-review.json). No merge or complete filetree checkpoint advance.


### Package repair: single private CSV/export canonical JSON leaf (accepted narrow reduction)

CSV review and export descriptor hashing consume one unchanged recursive canonical string leaf. Independent three-way edge cases and actual hash/descriptor consumers preserve byte, getter/evaluation and error behavior; owner/public declarations remain equal. Readable production shrinks by seven lines and complete owner/helper declaration-charged closure by six; scanner trivia-inflated absolute totals are corrected in the review, not credited. Existing non-injective/unsupported canonical profiles and the actual CSV declared `__proto__` input loss remain explicit DEL-C01/DEL-C02 residuals; this extraction makes no canonical-protocol redesign or broad integrity acceptance. [Exact-source review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/canonical-json-independent-review.json). No merge or complete checkpoint advance.


## 2026-10-07 — Explicit application state machines (proposal)

**Observed gap.** Can already expresses business lifecycles through enum fields, guarded scenarios and ordered `set` effects. ExpenseFlow owns its initial state at `Expense.status`, but source-state checks, target assignments and locks live in separate declarations ([example](../../examples/ExpenseFlow.can)). The inspected compiler syntax has no dedicated application machine/transition construct. Existing state and work runtime code supplies mutation admission, provisional state, fenced commits, history, receipts, outbox and scheduling; this inspection does not establish complete application execution.

**Proposed direction.** Explore an opt-in lifecycle on a stored model field, with transition edges owned by existing canonical scenarios or verified trusted handlers. Derive graph/tooling metadata from those declarations and enforce the lifecycle through the existing compiler and state authority. Keep operation parameters, `by`, business guards, inline examples, record versions and durable effects with their current owners. A transition would have an explicit position within `do`: source validation and state change occur there against ordered provisional state, and later failure rolls back the whole operation. Ordinary CRUD, `set`, hooks and other writers must not bypass an opted-in lifecycle; creation and migrations require their own explicit contracts. This is a design sketch, not accepted grammar or an implemented effect.

**Alternatives and advice.** Better enum/scenario conventions plus graph analysis preserve current simplicity, but cannot promise a complete graph for arbitrary conditions and assignments. A reusable named machine type provides central graph reuse, but must integrate existing operation identity, schemas and authority without copying them. Three independently worded equivalent JEV choice requests select the model-bound direction with probabilities **0.65/0.47/0.43** and confidence **0.53/0.29/0.24**. Existing idioms retain **0.21/0.38/0.28** probability and deferral **0.11/0.03/0.23**. The responses supply no rationale; wording review found no fact reversal, and the variation remains unresolved uncertainty rather than a robust architectural verdict. [Requests, responses and assessment](../../design/jev/state-machines-20261007/assessment.json) preserve the evidence. Advice supports investigation only.

**Remaining design work.** Decide field opt-in and graph reuse, typed source/target sets, branch/repeated-transition semantics, creation/fixture/import/migration rules, error ordering, graph evolution and every mutation path. Preserve edge-to-operation/site associations: identical source/target pairs can have different permissions and inputs. Provisional field reads through aliases, queries and nested calls must agree; runtime protected-field enforcement, hook transition eligibility and per-transition versus final-state history need explicit contracts. A failed transition rolls back earlier staged effects too; nothing is externally delivered before commit. Replayed requests, competing decisions and late timers/completions need concrete witnesses, including leaving and reentering the same state; a state-name check alone does not establish occurrence freshness. Terminal lifecycle state does not automatically freeze other fields or alter deletion/retention. UI availability must remain advisory, permission-filtered and rechecked by the server. Nested/parallel/history states, automatic entry/exit effects, eventless cascades and standalone in-memory machine reuse remain open scope, not assumed unnecessary. [SCXML](https://www.w3.org/TR/scxml/) and [Stately transitions](https://stately.ai/docs/transitions) provide reference semantics, not selected dependencies.

**Verification and scope.** Source/specification inspection and request/response JSON checks only. No compiler/runtime implementation, grammar adoption, app migration or behavioral test execution. A fair next design comparison needs complete before/after witnesses for simple approval and an existing durable workflow, with their permissions, failure outcomes and authoring costs retained. No merge or living-filetree checkpoint advance.


## 2026-10-07 — Stored field machines and reactive state views (accepted)

**Choice.** Add `machine` to a stored nonnullable scalar enum with a constant initial default, and `transition record.field source -> target` at an explicit ordered `do` position. Derive graph edges from existing canonical mutating scenarios/trusted handlers and protect the field through the state mutation owner. Keep parameters, permission/business guards, versions, fixtures, locks, invariants and retention with their existing owners. Ordinary create/CRUD/set/hook writes cannot bypass the lifecycle. Valid migration snapshots preserve their state; invalid retained states prevent activation.

**Rationale and alternatives.** This meets the user's request without a parallel scheduler or duplicate action schemas. Named reusable machines would add graph reuse but need new binding/identity rules; conventions retain the smaller grammar but cannot declare/enforce a complete graph for arbitrary assignments. Reuse presentation `require row.status==case` plus the existing page `poll=` spelling for state-driven views. Wire authorized partial refresh, one HTTP-owned shell, projected field bindings, query/team preservation, per-control edit preservation, fresh action metadata and visibility/back-navigation lifetimes. The initial proposal above remains the historical advice stage; this entry records implementation acceptance at the verified scope.

**Advice.** Three fresh independently worded equivalent JEV choice requests select the field approach with probability **0.93/0.92/0.93** and confidence **0.91/0.89/0.91**. They provide no rationale. Requests compare equal workflow outcomes and explicitly disclose runtime/producer joins still being qualified at consultation time. The earlier direction variation remains historical uncertainty, and stronger reported confidence is not behavioral evidence. [Detailed requests, replies and assessment](../../design/jev/state-machines-20261007/detailed-assessment.json) retain the raw material, initial sandbox network failure and successful preauthorized consultation.

**Implementation boundaries.** Compiler output gates machines with `state.machines@1` and generated scenario parameter binding with `state.parameters@1`; the host checks actual state-producer machine support rather than inferring it from unchanged contract v1. Record aliases observe provisional domain fields while their admitted version remains stable; net owner commit reserves one version and retains ordered history. Source/edge validation does not infer freshness after a leave/reenter cycle. Terminal state does not automatically freeze unrelated fields or block deletion. Flat stored machines are implemented; reusable named/hierarchical/parallel/history machines and implicit callbacks/cascades remain proposals. The generation example is a lifecycle viewer, not a provider-backed image application. Existing general generated form/action lowering and asynchronous delivery need their separate complete-workflow qualification. Full generated hook/lock/invariant wiring and per-hook version observations remain unqualified: canonical seam version normalization happens after pipeline rule evaluation. Protected machine fields are still enforced by that pipeline.

**Verification.** Focused compiler tests run freshly emitted modules through the real Cloudflare artifact loader/assembler, canonical creation/admission/staging/commit/replay/conflict/rollback and the actual UI factories/shell. State pipeline/CRUD/hook/migration tests cover protected-write and incompatible-snapshot controls. Browser Happy DOM tests drive native bootstrap, authorized partial fetch, state change, field edits/focus and fresh control metadata, context/query/navigation/visibility/logout and back-cache lifetimes. Full compiler, producer type builds and focused consumer suite results are recorded alongside the implementation before integration. No complete original-app/native-release claim or full living-filetree checkpoint advance follows from these scoped tests.


## 2026-10-07 — State-machine merge coverage and owner handback (accepted scoped bookkeeping)

Integrate the two tested feature commits on released main `b055ca61` through `65f43dc8`, preserving all other agents' unfinished edits and shared decision notes. New lifecycle source/graph, transition authority, generated invocation and reactive view duties stay with their existing compiler/contracts/state/Cloudflare/interfaces/UI owners; new exact leaves join the current selected tree without replacing gated predecessor splits or authorizing retirement. `SM.CORE` and `SM.VIEW` are complete only at their recorded verification scope; `SM.QUALIFY` remains an explicit `FP.FULL` dependency.

Register every accumulated checkpoint delta and history-touched path in the [current ledger](../ideal-filetree-plan/state-machines-20261007.json): 5656 net deltas, 5695 historical paths, 613 commits; 4150 inherited current changed inputs remain without an allocation in the prior selected input ledger. This is fresh feature review plus truthful accumulated registration, not exhaustive semantic or target reconciliation. Existing byte-scoped evidence, uncertainty, active leases and original acceptance clauses remain. Complete source/target review and installed/native/provider/full generated application gates remain open; checkpoint `8249342707d3280e88e39e8c911b7e457828f31f` does not advance. [Integration checks](../../implementation/state-machines/integration-verification.json) pin the full compiler source and final presentation controls. This bookkeeping requires no recursive self-update and dispatches no future implementation lane.


### Package repair: Values owning string-contract discovery and current provenance (accepted narrow recipe)

The string contract locates its original owning fixture/oracle from both source and emitted test locations. The fixture refreshes only source donor inventory/hashes after already integrated ownership, validation, backend refusal and private-leaf work; all93 strings,23 callers, controls, route and limits, corruption assertions, semantic observations and frozen builtin bytes remain unchanged. Independent source2/2 and private emitted2/2 controls pass; missing fixture/oracle and stale or altered donor provenance refuse. No source metadata is ignored to obtain a pass. [Exact review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/values-discovery-independent-review.json). VERIFY-TV01 retains original native/installed/whole-Value qualification and UTF16/truncation residuals; no production reduction, backend default or whole profile acceptance is claimed. No merge or complete checkpoint advance.


### Package repair: owner-validated secrecy and exact read selectors (accepted finite implementation direction)

The scoped human-approved JEV trio completed once each; all advise existing engine-local metadata and a canonical-host exposure join, with widely varying confidence and near-indifferent replies. Source/wording comparison retains uncertainty rather than treating agreement as acceptance. [Advice and bounded release](../../implementation/package-maintenance-repair/runs/codex-go-20261007/security-contract/disposition.md). Preserve owning typed-secret facts beside State's existing validated loader attachments and reconcile exact rule-specific selectors at the canonical host. Defining canonical/values field schemas stay unchanged; attachment/provenance checks are charged correctness work, with later formalization open. Server ownership does not imply secrecy, no-policy stays zero grants and known selectors cannot silently widen. The future public mutation/replay mapper remains an investigation direction gated on trusted result dependencies, explicit raw/public APIs and old-receipt/current-authority proof; no guessed object projection or blanket result null is released. Compiler/contracts ownership and full runtime/security acceptance remain open.


### Package repair: shared TypeScript preparation build phases (accepted narrow reduction)

Preparation delegates to the already defining deploy build/catalog functions through compatibility aliases; the host imports the defining catalog function directly. Exact bodies and remaining executable host behavior are unchanged. Aliases share function identity and the defining names, with preserved arity and bidirectional public type compatibility; declaration byte identity is not claimed. Complete four-source/three-declaration closure shrinks136 readable production and139 total readable lines (213 physical,8847 UTF8 bytes), independently including aliases/imports/types. [Source-current extraction review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/delivery-build-independent-review.json). Independent seven owner calls and ten isolated negative phases pass. Older ten phase/five CLI controls retain their frozen dependency configuration: two producer entries and33 vendor files differ at end review, so current full assembly/installed release is unproved. Both owners retain the existing pre-try entry-write temporary-directory leak as a DEL-D03 lifecycle residual. Actual receipt observer, DD009 fresh/stale emit/pack and human-held native preparation remain open. No broad phase/native/backend acceptance or complete checkpoint advance.


### Package repair: CSV selected rows execute in original source order (accepted finite correction)

After unchanged selection and authority admission, commit walks original review rows and resolves each selected operation ID by index. Caller-supplied selection order no longer changes invocation/effect or row-result order; each callback finishes before the next and a thrown source-first callback stops later demand. Independent mounted sparse/reversed selection, pending callback, tamper and original empty-batch refusal controls distinguish the baseline's two order failures from current3/3; producer six new and23 existing checks retain their exact private profile. Public declarations and all source outside the final loop are unchanged. [Exact review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/csv-order-independent-review.json). Original shared presentation type diagnostics are retained; strict current-source contract checks pass without a foreign distribution fix. Correctness growth is separate from replacement reduction. Existing CSV own-key loss, grammar/admission, consent integrity and current replay-authority gates remain open; no installed/durable/browser or whole parent acceptance. No merge or complete checkpoint advance.


### Package repair: every fanout checkpoint needs its own terminal outcome (accepted finite correction)

The child join validates forward record coverage first, then refuses each checkpoint whose own fanout has no terminal outcome. A terminal outcome for fanout A no longer authorizes an unrelated checkpoint B. Existing duplicate/empty insert, ordinary batch, nonterminal, completed-superset and cursor-only maintenance behavior stays intact. Independent64 three-fanout combinations close12 baseline wrong acceptances; twelve actual port-to-memory/D1/DO controls prove zero store effects on refusal, one-revision joined effects and late primary-key failure rollback in actual SQLite transactions. Stale-version preflight is separately identified and is not used as the sole transaction rollback evidence. [Exact review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/fanout-converse-independent-review.json). Producer13/13 and strict source compilation retain their private source-pinned profile. Correctness growth is separately budgeted; declarations differ only in the explanatory same-fanout comment. GAP-L01 scheduler pagination, GAP-L03 fresh admitted facts and original compiled/durable/installed/restart joins remain open. No universal concurrent/cross-store or parent closure, merge or complete checkpoint advance.


## 2026-10-07 — Finite LSP frame admission (accepted)

Use a 64 KiB aggregate header budget, counting separator bytes, while retaining the 64 MiB body ceiling. Grow retained storage fallibly and geometrically as bytes arrive; equal parsed duplicate lengths preserve unambiguous compatibility and conflicting lengths refuse. Close malformed framing/non-EOF input failures with exit 1; preserve clean/torn EOF lifecycle and complete-body JSON/UTF-8 parse-error continuation. These are local support choices, with existing reader extensions retained inside the budget.

Three verified-context JEV requests agree on the resource and duplicate choices; lifecycle advice is low-confidence 2-to-1 between failure and lifecycle closure. Failure exit was selected to expose transport refusal; no resynchronization boundary is known. Independent review accepted 11 reader tests and seven rebuilt real-process controls alongside 32 original stdio and 30 LSP unit tests. The review-driven header improvement reduces one-byte requests from 65,515 to 11. Full 64 MiB materialization/RSS/slow-peer/liveGUI/other-host profiles remain open. [Decision and uncertainty](../../implementation/compiler-completion/frame-admission/decision.md); [independent acceptance](../../implementation/compiler-completion/frame-admission/independent-review/report.md).


## 2026-10-07 — Compiler release input inventory (accepted bounded, release qualification open)

Retain the pinned dependency/toolchain choices and inventory the two currently advertised release targets separately from all 93 registry lock entries. Available 88 archives match their lock checksums; 142 recognized packaged license/notice files and native activated features are recorded. Independent review corrected 107 filename omissions and misleading historical build attribution. The first failed metadata/test diagnoses lack raw receipts and remain unverified; corrected records and originals are preserved.

Five archives and Linux activated-feature/final-source optimized-build qualifications remain missing; release notices and dependency-closure MSRV are not established. This inventory enables those release checks without declaring distribution approval, unexecuted-target support or a lower toolchain floor. [Corrected inventory and reproduction](../../implementation/compiler-completion/release-inventory/README.md); [independent acceptance](../../implementation/compiler-completion/release-inventory/independent-review/corrected-report.md).


### Package repair: streaming URI library leaf (accepted finite replacement)

Work's three registered URI component callers now use pinned percent-encoding2.3.2 with defaults disabled through one strict raw-UTF16 streaming leaf. Owner-local errors, preconditions and public bindings stay local. Independent source-current review proves100 fewer readable lines and1506 fewer non-whitespace bytes in OUR maintained production/types/module/manifest/lock closure. New upstream320 source lines, license/update/deployed burden is separate, not free or our vendored code. Exhaustive single-unit equivalence and170 registered caller/helper controls are reused with exact source proof; fresh independent caller/error controls pass. All21 measured allocation profiles are no worse than the old scanners; the rejected temporary-String regression remains raw evidence. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/uri-library-independent-review.json). Local source commit bf075707 does not qualify the dead-stripped Wasm ABI, installed/native consumers, backend adoption/rollback or whole-Work gates. No merge or complete checkpoint advance.

### Package repair: declared CSV names remain own data (accepted finite correction)

CSV row mapping defines declared keys as own enumerable writable/configurable data on an ordinary object. A declared __proto__ column no longer disappears or collapses distinct rows/digests. Independent actual prepared and mounted HTTP callers preserve source order, boolean/empty behavior, throw/demand identity and inherited-setter refusal; altered own-key cells invalidate original consent before effects. Baseline0/5 and current5/5 plus29 unchanged regression checks support this bounded correction; strict source-current contract checks pass and public declaration bytes stay equal. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/csv-own-data-independent-review.json). Correctness growth is separate from replacement savings. Parent CSV grammar/resource/authority/integrity, current replay projection, installed/durable/browser and whole backend joins remain open. No merge or complete checkpoint advance.


## 2026-10-07 — Checked facts retain their exact input owners (accepted bounded)

**Choice.** Retain private source/catalog identity handles, exact checked source selection and check-time source count. Validate them before public emit or direct IR construction, returning E6011 for a foreign owner or invalid selection. Moves, immutable source appends and Catalog clones preserve identity; reconstructing identical bytes requires rechecking. IR lowers only checked source IDs while artifact/map inventories retain supplied database metadata.

**Rationale and uncertainty.** This closes accidental cross-input fact reuse without snapshot copies, public authority fields or content-hash shortcuts. Three equivalent JEV requests favor owner tokens; the third probability is near its snapshot alternative, so advice is not proof. Public table mutation remains caller responsibility. Making CheckedProgram's association private intentionally closes external struct-literal construction; shipped repository callers use the checker. Independent review found and root repaired the remaining b4_examples caller that discarded its checked DB. Ten distinct controls, eight expected privacy compile failures, retained 21 bodies, two actual CLI controls and all 25 example tests pass. [Exact review](../../implementation/compiler-completion/checked-cohort/independent-review/review.md) and the 1,130-test integrated baseline qualify this scope. Session/history retention and broader architecture reuse remain open.


## 2026-10-07 — Recover same-column boundaries in EOF-unclosed joins (accepted bounded)

**Choice.** Replay only the final suffix proved to contain EOF-unclosed openers through the ordinary layout scanner. Reset at same/dedented code or Description boundaries only while a marked unclosed opener remains active. Retain balanced subjoins, original prefix, comment ownership, diagnostics and exact CST bytes. A set and active count avoid repeated delimiter-stack scans.

**Rationale and uncertainty.** This recovers independent declarations without a keyword classifier, second parser or unconditional indentation reset. Three equivalent JEV requests favor late fallback, as advice. Six permanent regressions, 54 syntax tests, 26 controls, five balanced baseline equivalences and seven distinct independent controls pass, including Unicode/CRLF, descriptions, nested scenarios and a finite 4096-opener layout case. [Exact review](../../implementation/compiler-completion/delimiter-recovery/independent-review/report.md). Accidentally balanced malformed input, deeper independent-looking declarations and ambiguous continuation intent remain outside the selected recovery. The original stale producer-runtime failure is retained; a real producer refresh subsequently passes the actual compiled lifecycle body.


## 2026-10-07 — Static-call cycle witnesses follow checked symbol order (accepted bounded)

**Choice.** Sort static-call caller origins by ascending SymbolId before the existing authored-adjacency DFS. Preserve closing spans, callable filtering, global vertex-set deduplication and other graph algorithms. Determinism applies to fixed supplied source/declaration order; file permutations may change the preferred witness.

**Rationale and uncertainty.** A two-line owning correction removes accidental HashMap origin order without a new canonical-path policy or graph library. Three equivalent JEV requests favor index order, as advice. Eleven permanent tests include 24 fresh process controls: formerly variable upstream/overlap witnesses become stable. Independent branch/symbol-allocation/file-order cases qualify the rule, and other public graph tuples/raw multisets stay unchanged. [Exact review](../../implementation/compiler-completion/cycle-witness/independent-review/ASSESSMENT.md). The unrelated checked-cohort example failure was preserved and repaired by its owner; full native baseline and strict Clippy subsequently pass. No exhaustive graph or deployment claim.


## 2026-10-07 — Email admission shares the public scalar-string floor (accepted bounded)

**Choice.** For Unicode scalar strings, require exactly one interior ASCII @ and reject exactly U+0000..0020,007F,00A0,1680,2000..200A,2028,2029,202F,205F,3000,FEFF. Preserve authored text. Do not add dotted-domain, label/TLD, normalization, DNS or deliverability conditions. U+0085/C1 and U+200B remain admissible; JS lone-surrogates are outside this comparison.

**Rationale and uncertainty.** Public encode/decode share this existing values-wire owner; compiler domain reconstruction produced 14 false rejects and 19 false accepts in 113 independently classified cases. Balanced alternatives considered changing all owners to Unicode property rejection or dotted ASCII domains; both require caller migration without solving deliverability. Three equivalent JEV requests now select the public floor with confidence 1,1,.98, without rationale. Human approval explicitly resolved the two exact payload disclosure rejections; original failures remain, and advice does not substitute for source/runtime evidence. [Policy and approval receipts](../../implementation/compiler-completion/email-admission/selected-contract-proposal.md). The focused leaf repair passes all 113 compiler cases, both public codec directions and 29 real emitted metadata-module imports; Independent medium review passes145 fresh cases and verifies604 corrected freeze hashes. Review corrected the original UI-consumer overclaim: imports execute generated metadata modules and public values only, and the narrowed witness rerun passes without skip. Application/auth/DNS/other-host qualification is separate.


### Package repair: configured provider byte limits and cancel identity (accepted finite correction)

SystemOne compares its existing maxRequestBytes against UTF8 bytes of the unchanged serialized body, retaining null-disabled behavior. ComfyUI refuses a missing/empty delivery identity before cancellation effects, after existing job validation; valid best-effort provider outcomes remain unchanged. Independent actual exported adapters and HTTP boundary prove16 controls with Node Buffer byte oracles, compared with seven baseline failures. Exact-source producer nine focused controls and36 original localhost tests qualify unchanged behavior; strict before/current checks pass and public declarations stay byte-equal. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/services-selected-independent-review.json). Four added readable production lines are correctness budget, not replacement savings. Post-serialization counting is not a preallocation bound; no new threshold, truncation, generic serializer, provider recovery policy, installed/durable or whole services acceptance. No merge or complete checkpoint advance.


### Package repair: entry-write cleanup and OAuth one-use outcome (accepted finite contracts)

Cloudflare's two defining bundle builders attempt owned scratch cleanup when entry creation fails, preserving the original write exception even if cleanup also throws. Existing process error mapping and output cleanup remain unchanged. Different root review retains the rejected candidate and passes all 16 unchanged decisive caller controls after repair; production grows by 18 lines as a separate correctness budget, with equal public declarations. A failed filesystem cleanup may still leave scratch. Existing full-bundle distribution admission refusal and broader installed/process/resource gates remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/entry-cleanup-independent-review.json).

For the selected OAuth one-use correction, the existing consume port returns an explicit `consumed` or `unavailable` outcome. Only exact `consumed` permits minting; a legacy void or ambiguous backend result is never treated as success. The declared D1 profile admits numeric `result.meta.changes` of zero or one and refuses malformed results. Consumption remains before minting, including original mint exception identity and spent-code behavior. This is a scoped port migration, not a new transaction wrapper or rollback protocol. Source qualification is in progress; the proposed whole identity/state commit fence, concurrent last-owner guarantees, revocation and public-result/replay obligations remain open. No merge or complete filetree checkpoint advance.


### Package repair: one-use OAuth conditional winner (accepted narrow correctness)

Identity's existing consume port and Cloudflare mirror now return `consumed` or `unavailable`; exchange mints only for the exact winner. D1 retains the same conditional UPDATE and reads only definitive numeric `meta.changes` zero/one; memory performs its check and replacement without an await. Legacy void or ambiguous outcomes refuse rather than mint. Consumption still precedes minting: a mint exception retains its original identity and the code stays spent. Existing backends and the test SQLite adapter are migrated to the explicit outcome contract without a wrapper or rollback/replay protocol.

Different root review independently forces eight memory and four real Miniflare D1 callers past pre-read, observing one grant and exact generic losers; malformed outcomes and failure ordering pass 17 observations. Author strict source/test checks, 26 local controls and actual environment-assembly D1 evidence complement this narrow review. The old owners' double-mint witness is retained. Whole identity/state J2, recovery, concurrent owner guards, revocation, installed-worker and public-result/replay gates remain open. [Exact-source review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/oauth-consume-independent-review.json). Required correctness is separately budgeted; no merge or complete filetree checkpoint advance.


### Package repair: typed secrecy and exact canonical read facts (accepted narrow correctness)

State's validated engine-local metadata retains explicit secret tags without changing shared canonical field shapes. Canonical intake admits one fixed set of own data facts, compares normalized policy/selector contents directly, and requires exact public-rule selector coverage. Accessor metadata is unsupported at this carrier seam; it cannot change the identity between admission and transcription. Genuine omitted selectors still include ordinary actor/time fields and exclude secrets; absence caused by malformed normalization is refused.

Independent root local review passes 28 metadata/consumer observations and four State metadata tests after retaining the two rejected candidate histories. Actual ordinary canonical name-only reads stay narrow. The final worker was stopped by a tool content check after its private compile and 31 tests had completed; root separately verified frozen source and recorded-command cessation, without claiming worker completion or restarting it. This is repository-memory/augmented historical-artifact acceptance. Fresh compiler emission, installed/durable hosts, first-success/replay public result projection and trusted result dependency/authority remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/secret-metadata-independent-review.json). Correctness growth earns no replacement reduction credit; no merge or complete checkpoint advance.


### Package repair: line-comment loadability terminators (accepted narrow correctness)

The existing TypeScript deployment preflight recognizes all ECMAScript line-comment terminators: LF, CR, LS and PS. Executable unwrapped CommonJS after CR/LS/PS can no longer be hidden by a preceding comment. Quoted/commented tokens, approved bundler wrapper and stdlib guard handling remain unchanged; UTF16 offsets and first-issue priority are preserved. Different-author review passes 39 selected controls, including trusted Node ESM corroboration, with unchanged declarations. The old source passes 12 and fails nine of the same 21 regression controls. Production line count stays equal and grows by 74 bytes as correctness, not reduction. General syntax/binding/helper-provenance, trusted artifact namespace and installed/native diagnostic gates remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/loadability-terminators-independent-review.json). No parser/library adoption, merge or complete filetree checkpoint advance.

## 2026-10-07 — Editor owns only current live source revisions (accepted bounded)

**Choice.** Replace the private synchronous Server source owner after distinct text/live membership changes with exactly one immutable source per live URI. Prune queued work by URI/version/old ID before atomic current-document/FIFO remap; preserve latest-live path aliases and identical-text fast paths. Keep standalone SourceDb immutable and append-only. Lint/fixes parse only the checked selection, preserving duplicate IDs and existing returned diagnostic sorting.

**Rationale and uncertainty.** Callbacks borrow the current DB; no public Server DB retention lease exists. This avoids a second source storage/reclamation API or an arbitrary history threshold. Three equivalent JEV requests favor broader alternatives inconsistently at low confidence; their disagreement and missing rationale remain explicit. Root accepts copying/hashing proportional to all live text under the declared boundary, without claiming optimal latency or RSS. Independent82 focused tests and1800 transitions/800 callback views qualify queues, alias association, same-version edits/reverts, close/reopen/shutdown and held standalone IDs. Archived-library replay reproduces current1/3 live-source observations from author49/36 baselines. [Exact review](../../implementation/compiler-completion/session-history/independent-review/review.md). Lint retains its valid-at-check owning-DB caller boundary rather than adding codegen cohort admission. Native4750, broader host/GUI/cross-file/performance qualification remain open. The later integrated authoring test correctly expects one queued current version after distinct changes, rather than three historical jobs; all exact version3 publication/exclusion assertions remain. Thirty authoring checks and a [narrow independent oracle review](../../implementation/compiler-completion/integration-after-bindings/queue-oracle-independent-review/assessment.md) pass; raw failed expectations are retained.

## 2026-10-07 — Retain supported docs JSON compatibility views (accepted retention)

Retain thirteen public Json view methods and their existing shared serialization/parse bridge:39+5 target body lines, zero production deletion or mechanism retirement. The real CLI already uses typed direct serialization; moving/condensing public wrappers does not retire their API or the roundtrip. No qualified public-compatible44-net replacement exists among the evaluated choices, and unknown external support is not waived by repository nonuse. Thirty extraction,three wire,two consumer tests and a later18-test CLI join pass at recorded inputs; the initial concurrent-source build failure is retained. [Independent review](../../implementation/compiler-completion/retained-support-review/report.md). Other ARCH-02 families and complete application/installed/host profiles remain separate.

## 2026-10-07 — Retain qualified source-map codec and public decoder (accepted distinct retentions)

Retain the16-line complete library-map encoding/projection extraction with zero deletion credit. Pinned sourcemap9.3.2 exposes numeric VLQ generation, but complete mappings only through writer/dataURL; exact probes reject private encoder, nonexistent getter and Serialize alternatives. A new numeric-segment traversal would replace the full map engine, rather than safely retire the named mechanism within the>=1-net gate.

Separately retain the85-declaration-line public signed ordered-row decoder and its guard/delta helpers. A test-only move breaks public support and does not delete repository code; the library's unsigned sorted full-map view is not this carrier. Independent finite API/decoder controls pass, with no production/dependency change or sum of hypothetical savings. [Exact decisions and review](../../implementation/compiler-completion/retained-support-review/report.md). Each zero means no justified retirement at the evaluated scope, not a universal impossibility or complete ARCH-02/host claim.

## 2026-10-07 — Localized formatting uses the executable handler context (accepted design; implementation pending)

Select immutable formatter inputs on the actual HandlerContext, populated by the checked selected-app metadata and admitted team timezone. Shared derives already forward this context. Preserve the public two-argument formatter, exact numeric/temporal carriers and text/locale provenance; UTC follows a null team, while missing qualified scope/unsupported generated requirements fail explicitly. Viewer locale and a shared package cannot choose deployment default.

Three equivalent minimal abstract JEV requests favor this boundary with probabilities.95/.92/.95 and confidences.93/.88/.92, without rationale. The verified trace shows canonical admitted context is a different object; adding only its field would leave forwarding absent, while factory binding migrates every loader. [Balanced choices and exact advice](../../implementation/compiler-completion/selected-calls/format-context-policy/decision.md). Implementation still requires composition conflict/default-after-fold facts, source-derived metadata/identity consistency with deployment and receipts, canonical/direct/occurrence constructors, descriptor adaptation and compatibility admission. Active foreign runtime source, installed require/hasRole exports and checked UI caption/descriptor transport remain explicit prerequisites; no localized runtime completion is claimed.

## 2026-10-07 — Call lowering consumes winning checked bindings (accepted bounded)

Checked call facts retain the winning overload or resolved declaration and source-order supplied expressions with declaration slots. IR consumes these facts; reordered inputs capture once synchronously, defaults run in declaration order from their owning declaration, explicit null suppresses omission defaults and imported aliases retain private owner visibility. Plain formatting calls the actual public two-argument facade with winning slots. [Independent HIGH review](../../implementation/compiler-completion/selected-calls/independent-review/report.md) accepts the frozen phase, including ten distinct actual CLI/Node controls and focused regression receipts. Commit3403dc71 preserves the phase. Localized format context/descriptor/provenance remains open. Partial test-only goldens honestly pin absent BDD facts; the later complete-production b1_join failure demonstrates a real resolver/type publication gap that must be fixed without weakening its gates. No complete SEM-R03/S9-Q01 or integrated-suite credit is granted.

## 2026-10-07 — Retain the strict public JSON reader contract (accepted retention)

Retain serde_json1.0.151 with std/raw_value and the current origin-aware reader. The supported upstream surface lacks an in-flight public cursor, RawValue defers strict Unicode/depth failures, and arbitrary_precision normalizes original negative-zero/exponent lexemes. Ordered duplicates, first-match access, raw number text and exact native error precedence/offset remain public support requirements. No qualified whole-closure replacement retires the targeted reader mechanisms with at least40 net lines under those contracts. [Independent HIGH review](../../implementation/compiler-completion/json-reader/independent-review/review.json) accepts bounded RETAIN0 after eight isolated commands and28 reproduced tests. The generic decoded Event collision claim was narrowed: actual visitor string modes differ. Zero source/dependency changes and zero deletion or retirement credit; full current catalog/server and broader DEP scope remain open.


### Package repair: table row disposal on unexpected failure (accepted narrow correctness)

The defining Testkit table runner attempts its owned RowScope disposal once when execution or comparison unexpectedly rejects, then preserves the exact original thrown value even if disposal also rejects. Normal disposal-error formatting, scope-creation failure and duplicate-index preflight keep their existing behavior. Different-author current tests pass18/18; baseline passes10 and fails eight. Eight fresh exported-runner controls cover throwing outcome getters and actual comparator ownKeys, exact Symbol/undefined identity and absence of the next row. Strict checks and declarations remain equal. Readable production grows nine lines as correctness, with no replacement saving. A rejecting disposer is attempted, not certified to release resources. The interrupted isolation command130 remains unqualified; wider durable/source-loader/installed/native lifecycle and evidence cleanup remain open. No merge or complete filetree checkpoint advance. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/table-disposal-independent-review.json).


### Package repair: S256 issuance digest length (accepted narrow correctness)

The existing S256-only issuer accepts exactly43 base64url symbols, the unpadded encoding length of its32-byte SHA256 digest. This deliberately corrects44..128 challenge admission; it is not a universal RFC challenge grammar. Matching verifier UTF8 behavior, noncanonical43-symbol acceptance, consumption, revocation and browser-origin logic remain unchanged. Different-author source-current review passes41tests versus four intended baseline failures, plus fresh actual mounted register/authorize/token controls and independent WebCrypto vectors. Strict checks pass and40 source declarations are byte identical. Readable owner199lines/declarations45stay equal, so no replacement reduction is claimed. Persisted/installed/native and wider authentication/security/current-authority duties remain open. No merge or complete filetree checkpoint advance. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/pkce-issuance-independent-review.json).


### Package repair: owned JSON derivative contract (accepted finite correction, implementation pending)

Select one stable frozen parsed value/record with a private byte snapshot and defensive bytes accessor. The demonstrated reader/value/record aliases can make stored derivatives disagree. No local production caller was found; the exported subpath leaves external compatibility uncertain. Fresh value copies lose the explicitly tested stable value identity and reparse repeatedly; unchanged aliases are viable only as trusted issuance and cannot support immutable content authority. Three independently worded, human-approved JEV calls prefer stable_frozen with confidence0.69/0.52/0.8; they supply no rationale and are advice, not acceptance.

The selected correction adds iterative ownership-only traversal, input copying and per-byte-access copies, changing the previous no-traversal/mutation/byte-identity and reflection behavior explicitly. Preserve native JSON.parse content/order/duplicate/__proto__/-0/overflow/UTF16/deep/scalar semantics, default decoder behavior and delegated reader limits/errors. Do not add a depth cap, semantic validator, generic graph clone, new library or adopt(unknown). Required correctness has its own measured budget, not a production reduction claim. Genuine factory/default/prepared-plan, consumer and installed gates remain open. [Contract](../../implementation/package-maintenance-repair/runs/codex-go-20261007/owned-content-contract.json). No merge or complete filetree checkpoint advance.


### Package repair: fanout continuation and fresh admitted effects (accepted narrow correctness)

The defining Cloudflare scheduler releases stale claims from the actual continuation cursor. Guard snapshots reload at demand, and each retry passes its one State-admitted record matched by parameter/model/id into the existing effect builder. Missing/error/deleted and transient lifecycle races retain the established pin/retry paths, original guard/snapshot exception identity and finite page/drive/State-retry bounds. Different-author source-snapshot review passes18fresh controls versus3baseline, plus25maintained controls versus9baseline; production strict checks pass.

The reachable FanoutStateProducers callback type narrows unknown to the admitted-ref structural view: declarations are NOT byte equal. Broad unknown-accepting callbacks remain assignable and actual State AdmittedCall fits; direct arbitrary {} or unknown invocations now fail typing and the runtime refuses missing/ambiguous child refs. This view does not authenticate a producer. Production grows2202bytes/50token-bearing lines as correctness, not replacement reduction. Actual memory admission/effects and cursor evidence do not close mounted/source-compiled/durable/startup/installed/T26 duties, and copied historical prerequisite distributions remain a qualification limit. Metadata prefix is byte equal. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/fanout-freshness-independent-review.json). No merge or complete filetree checkpoint advance.


### Package repair: immutable finalized byte count (accepted narrow correctness)

The Files finalizer requires actual staged byte length, received count and declared size to agree before digest/mint/storage effects, using the existing conflict outcome. Four independent real FS/persisted-copy metadata disagreements refuse before any publication; nine original effect/order profiles are unchanged. Strict checks pass and nine declarations are byte equal; the guard adds four production lines as correctness. Foreign/expiry/retry/digest and repeated-finalized reference behavior retain their established first-error order.

Frozen append-crash/reopen/retry evidence shows why digest agreement alone allowed size1 metadata for two bytes. This guard retains mismatched staging/completed metadata; it does not heal progress, add retry identity or recover finalization phases. A separate actual-completion size correction is now active and will update the crash test's earlier false-completion expectation under an exact handoff and renewed joint review. Historical negative evidence stays retained. Production durable/mounted bindings, journal/atomicity/lifetime and whole file journeys remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/finalized-size-independent-review.json). No merge or complete checkpoint advance.


### Package repair: owned JSON content isolation (accepted narrow correctness)

The released contract now snapshots reader bytes, iteratively freezes parser-created containers and publishes stable frozen record/value identities with defensive byte copies. Independent actual parser/real capped-reader controls preserve errors, caps, cancellation/release, content/order/duplicates/__proto__/-0/Infinity/UTF16/BOM/decoder behavior and deep/wide inputs. Current21tests pass versus three intended baseline failures; emitted/strict checks pass. Fresh3000derivative reads retain identity without reparse; retained buffers, subarrays/DataViews/set/transfer and record/nested writes cannot alter the owned representations.

Public signatures/types stay equal; ownership comments and intentional mutation/byte-access/reflection behavior change. Readable production61→84 and declarations21→21, with90declaration-comment bytes added, are required correctness growth. Actual in-place ownership work is measured, not credited as a performance/replacement benefit: O(containers+edges) traversal, B-byte snapshot and B-copy per bytes access. No depth threshold or generic graph clone is introduced. No local production caller/genuine prepared-plan success/default-provenance/installed/security acceptance follows. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/owned-content-independent-review.json). No merge or complete checkpoint advance.


### Package repair: completion and finalization byte agreement (accepted narrow correctness)

The existing upload owner now refuses actual bytes beyond its declared/policy size through its established oversized cleanup; short stored content stays partial without healing metadata. Earlier owner, expiry, state and recorded-count branches keep their order; equal valid content, missing staging, MIME/digest and original read/remove/put failures keep their outcomes. The finalizer's independently committed agreement guard remains unchanged. Different-author joined source review passes 42 tests, three existing FS journeys and 22 fresh boundary/error controls; strict checks pass and all 11 source declarations are byte equal.

An actual FS append crash before copied metadata persistence, reopen and retry produces four bytes for declared/count two. The old completion falsely published a digest before the finalizer refused; current completion rejects and removes staging, with later finalization partial and zero file publication. The historical negative proof remains frozen. Ten readable completion lines are correctness growth, not replacement reduction. Cleanup errors preserve their original identity without an atomicity promise. Chunk identity, retry/recovery, phases, attachment lifetime and production durable/provider/mounted bindings remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/completion-size-independent-review.json). No merge or complete checkpoint advance.


### Package repair: bound streaming cancellation wait (accepted narrow correctness)

The Services HTTP stream owner normally awaits best-effort reader cancellation, but its existing combined deadline/caller abort bounds that wait. It then releases the reader and any temporary abort listener without replacing the original outcome or failure. No timer, threshold, parsing/retry/provider policy or public signature is added. Normal EOF, normal waiting, cap priority, caller Error/undefined/Symbol, UTF8/NDJSON and the existing final/late-frame race retain their behavior.

Independent local actual HTTP/Ollama Response/ReadableStream checks cover 44 paired witnesses; current focused tests pass 21/21 versus 13/21 before, strict full source/test emits pass, and 18 declaration signatures are unchanged. The former unresolved cancellation promise could leave done() pending after the existing deadline. Fourteen net implementation lines and 181 test lines are correctness growth, not replacement reduction. Physical provider cleanup may still be pending; broader safe projection, real effects/security, recovery correlation and mounted/installed duties remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/service-stream-independent-review.json). No merge or complete checkpoint advance.


### Package repair: synchronous browser ownership cleanup (accepted narrow correctness)

The browser owner detaches acquired resources and its live registry before releasing them, attempts every supported synchronous disposer once, and reports the exact first failure including undefined/Symbol. Acquisition rollback preserves the original failure despite cleanup failure. Native observer/listener/core order, ordinary stop/restart and rescan ownership remain local. A synchronously throwing fetch port removes its abort listener before rejection delivery. No public API or asynchronous disposal protocol is added.

Independent actual HappyDOM/timer/AbortController checks pass 18 fresh tests versus zero before and 103 maintained tests versus 72 before; strict checks pass and bootstrap/polling declarations are byte equal. Runtime grows 2,129 bytes/47 nonblank lines and new maintained proof adds 241 nonblank lines: correctness growth, not library-reduction credit. A failing external disposer can still retain physical resources. Chromium, full rebuilt dependency/installed/deployed runtime, raw Window visibility/typing and external HTMX/can:settled producer duties remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/browser-lifecycle-independent-review.json). No merge or complete checkpoint advance.


### Package repair: enforce tagged-record transport hygiene (accepted narrow correctness)

The defining Values conformance transport enforces its already documented unique-key rule before operation guards. A per-record standard HashSet borrows decoded keys; the existing ordered value vector and left-to-right key/value/argument error order remain intact. Duplicate malformed transport now refuses rather than selecting the first tuple value or repeating first-value violations. Empty, special and non-normalized Unicode keys remain distinct ordinary data; no scalar semantic, ABI, module, manifest, dependency or public declaration changes.

Independent native source review passes 18 tests versus 13 before, including five fresh counterfactual tests and seven existing numeric/escape/transport controls. Readable production grows five lines; transient per-record hash/capacity/random-state overhead is explicit and unmeasured, with no new budget threshold or replacement benefit claimed. Root's initial JSON/text test error and shared Cargo counterfactual artifact reuse are retained and excluded; accepted evidence uses distinct before/current targets. This does not repair native SchemaError projection, select a production codec/profile, join lossless UTF16 or prove Wasm/installed/backend/retirement/all69 acceptance. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/record-hygiene-independent-review.json). No merge or complete checkpoint advance.

### Package repair: genuine Values prepared owner prerequisite (retained refusal, proposal inputs)

Current source has no production Values descriptor-to-owner/revision registration join. The real CSV prepared HTTP helper is a separate Interfaces metadata binding. ARTIFACT_VERSION denotes format compatibility and must not be stamped as exact source ownership; factory lineage and arbitrary registry scope strings do not grant artifact authority. Retain missing-provenance refusal while obtaining the actual producer/canonical consumer mapping. Canonical Decimal/Date defaults and bounds expose prospective plain-copier incompatibility, but genuine registration currently fails earlier; no executed partial-publication/security claim follows.

Owner-aware normalization, trusted wrapper and existing-owner method remain proposals with explicit canonical-value copy/retain, publication, sequence and lifetime questions. Three balanced requests are prepared but unsent until there is a material current consumer decision; completed owned-JSON consultations are not repeated. [Factual prerequisite](../../implementation/package-maintenance-repair/runs/codex-go-20261007/prepared-owner-prerequisite.json) preserves source pins and uncertainty. No new authority/API, backend adoption or broad parent completion.

## 2026-10-07 — Synchronous generated guards share one acyclic producer (accepted bounded)

Move the original synchronous require/hasRole bodies to the supported @canlang/state/effects/guards subpath, with a readonly structural handler carrier. Cloudflare retains verbatim compatibility exports and stdlib assembles the same function objects, through existing acyclic dependencies. This preserves exact truthiness, error/getter order, defined-subject refusal and current callers. The separate asynchronous API is @canlang/state/policy/roles; state root exports MembershipReader as a type, not hasRole. Original abstract JEV wording is preserved and [corrected precisely](../../implementation/compiler-completion/runtime-export-join/precision-correction.json). Three advisory choices favor the state subpath with confidence.70/.97/.95 and no rationale; concrete source/build/runtime evidence determines acceptance.

[Independent review](../../implementation/compiler-completion/runtime-export-join/independent-review/assessment.md) accepts the six-file closure:130 equivalent body controls,8 leaf tests, public binding/type compatibility,28 matching pins and acyclic genuine build/typecheck receipts. Actual unchanged generated mutation artifacts execute through canonical memory admission/invocation: member commit, handler rule_failed rejection/replay, anonymous denial and held-identity live removal. Admission denial is reevaluated before execution; after restored membership the same previously admission-denied operation ID may commit. Immediate repeat is not a permanently stored denial receipt. Canonical read-scenario restriction, two legacy model-policy fixture failures, subject-role lookup, durable/deployed/full-app profiles remain open. Commitb7e18b9b also moves the current selected-call regression into compiler fixtures, while retaining historical missing-export probe evidence unchanged.

## 2026-10-08 — Literal Card and transient Tabs use actual UI contracts (accepted bounded)

Literal Card headers reuse the existing caption decoder. Transient unbound Tabs assemble the actual public factory items with separate caption and ordinal machine value, eager authored-depth-first children and entire-item gates. Parent IDs identify authored sites and encode every enclosing row occurrence independently of captions. [Independent review](../../implementation/compiler-completion/ui-ownership/independent-review/review.md) accepts finite actual static rendering plus emitted nested-row/async and namespace protocol controls at commitc718517a. Three JEV choices favor ordinals but confidence1/.74/.33 and explicit-key probability.43 in the third request preserve material uncertainty about future edit-stable workflows. Authorized repeated-query runtime, bound enum/exhaustiveness/versioned immediate preference save, structured ordering and generic factory profiles remain open; this does not accept all UI syntax or full application execution.

## 2026-10-08 — Markdown code spans preserve authored text (accepted bounded)

Use a fence longer than authored backtick runs and standard edge padding for ordinary inline code, retaining literal backslashes. Empty and pipe-bearing table values use entity-safe inline code HTML because a single escaped pipe still breaks odd authored backslash runs in the verified GFM parser. Only six table helper arguments change. [Independent review](../../implementation/compiler-completion/markdown-owner/independent-review/review.md) accepts the complete caller family and distinct parsed-consumer cases at commitdb57c379, with58unitchecks/freshownerbuild/typecheck and preserved default/source/prose/locale/anchors/fences. Qualification is marked17GFM/happy-dom single-line DOM text with inline HTML, not every parser, pixels or exact multiline behavior. Actual compiler docs CLI followup correctly expects one literal backslash in raw Rust; unchanged JS/typed extractor assertions denote that same value. Both real CLI/policy consumers pass after the [independently checked oracle correction](../../implementation/compiler-completion/markdown-owner/independent-review/cli-followup/qualification.md).

## 2026-10-08 — BDD execution transport and helper closure (proposal; consultation pending)

Checked BDD call/type publication passes original production join gates without weakening them, but [independent execution](../../implementation/compiler-completion/bdd-facts/independent-review/assessment.md) exposes free result/plain action inputs and an undefined imported derive helper. Zero emission diagnostics does not close those workflows. The [proposed complete owner join](../../implementation/compiler-completion/bdd-facts/consumer-policy/proposal.md) requires checked name provenance, actual declared payload/input inspection, payload-only as captures, request/typed assertion/fresh-read owners and isolated checked helper closure. Real canonical mutation retains business payloads; current consumer mappers discard them, and general read-scenario serving is separately absent. No carrier/helper composition policy or implementation is accepted yet. Three balanced specific TypeSafe requests are saved; automatic approval review rejected external egress until explicit payload/destination approval, which root requested. Root continues unrelated authorized work without retrying or bypassing that restriction.

## 2026-10-08 — Immutable asset tables retain owned byte content (accepted bounded)

Keep ownership inside the existing Interfaces `createAssetTable` constructor. Native Uint8Array copying owns admitted Buffer/subclass inputs; the documented frozen lookup returns frozen rows with defensive byte copies and shared frozen cache policy. The existing request handler and dynamic provider protocol remain unchanged, including response copies and exact key/MIME/cache/body/error behavior. No adapter, library, mount, ETag or public signature is added.

Independent source-current review passes35tests versus21before, including14 fresh controls. Five strict public signatures match; runtime source grows224bytes/two lines and emitted runtime230bytes, with103declaration documentation bytes. Copies/row allocations are required correctness cost, not replacement savings. Request normalizes some encoded dot paths before lookup in both versions; no universal raw-path refusal is claimed. The previously frozen bundle prerequisite is not reused after its source changed. Production mount/browser/export/print/installed/security and original parent gates remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/asset-ownership-independent-review.json). No merge or complete checkpoint advance.

## 2026-10-08 — Failed prepared registration publishes no defaults (accepted bounded)

The existing Values registry stages copied defaults in one local Map and publishes them only after constructing the complete immutable plan. Copying, validation/getter/error order, consumed sequences, successful stable identity and existing release retention stay unchanged. Failed construction no longer leaves reachable defaults without a live plan. No new producer authority, hook, scalar representation, branding, budget or lifecycle API is introduced.

Independent private-source qualification passes13fresh tests versus2before and51maintained tests versus46before; strict builds pass and the public plan declaration is byte identical. Genuine factory output is used with the explicitly existing integrator-private hook substitution, so this does not prove the missing production owner association. Runtime grows206bytes/three physical lines plus a transient staging Map; new145-line maintained proof is separate correctness cost. Decimal copying, default lifetime and actual serving/backend adoption remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/prepared-registration-independent-review.json). No merge or complete checkpoint advance.


## 2026-10-08 — Preflight every text-bundle output before effects (accepted bounded)

The defining Cloudflare text writer reuses its existing package-output guard for sorted admitted module keys and bundle.json before mkdir or any write. The same lexical checks retain their order; present symlink ancestors, roots and selected targets now refuse before altering earlier or outside files. Successful bytes, manifest order, returned paths and public declarations remain unchanged. No new guard framework or filesystem policy is added.

Different-author review exercises44 paired real-FS rows and30 maintained controls (17before); seven declarations are byte identical and strict builds pass. The seven-source runtime closure grows184bytes/three lines, with a separate143-line proof: correctness cost, not library savings. This verifies existing-state preflight, not replacement races or atomic publication. Direct mixed binary-only targets and bundle.mixed.json, host plan/toml sidecars, actual installed/native/deployment and parent gates remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/text-output-containment-independent-review.json). Native preparation remains on human HOLD. No merge or complete checkpoint advance.

## 2026-10-08 — BDD expressions publish owning checked facts (accepted bounded; execution open)

Publish BDD call and expression type facts through the existing resolver/type checker, covering table inputs/observations/expected cells and ordered sequence expressions. Preserve the common header fixture namespace, original diagnostic ownership, production join gates, winning selected-call/default rules and private helper restrictions. Commit96fd4b4b is accepted only for this [independently reviewed publication component](../../implementation/compiler-completion/bdd-facts/independent-review/assessment.md). Actual callbacks still lack result/plain-input transport and reachable helper definitions; forward names retain the permissive runner profile. These execution outcomes remain open under the separately proposed consumer join. The frozen binary/evidence retains its original source pins; later edits do not inherit its qualification.

## 2026-10-08 — Runtime tests own exclusive temporary directories (accepted test correction)

Use the existing tempfile dependency to give each flat-expression runtime test an exclusively created TempDir and automatic owned cleanup. Timestamp directory names can collide on this host, while create_dir_all allows sharing; the particular pair behind the historical missing-file failure was not logged. Commita33cdba5 preserves all original compiler/Node controls, deadlines and assertions. All six focused tests pass without body skips, and [independent review](../../implementation/compiler-completion/integration-after-bindings/after-bdd-ui/flat-runtime-triage/independent-review/qualification.md) verifies body preservation and the library's exclusive ownership. This accepts the test isolation repair, not a complete production or whole-suite claim.

## 2026-10-08 — Public code fragments refuse unrepresentable endpoints (accepted bounded)

Before lex_fragment tokenizes, convert the UTF-8 byte length to u32 and check its addition to the supplied base. Exact endpoints at MAX and empty fragments at MAX remain valid. An inadmissible whole fragment appends one E1008 error at the base point and returns no tokens, preserving existing caller diagnostics. This routine API admission choice preserves exact spans rather than losing coordinates. Both description callers already recover after new diagnostics. Commit42b7200b includes the API/catalog explanation and genuine public API explain examples. The [high independent review](../../implementation/compiler-completion/representability/independent-review/review.md) accepts finite native debug/release controls and unchanged fitting behavior. Actual source lengths/counts beyond u32, standalone decoder and other offset APIs remain separate FAIL-R06 obligations; no global source-size limit or full closure is claimed.

## 2026-10-08 — Date and datetime have distinct ICU requirements (accepted bounded)

Keep civil date separate from datetime in the named-message ICU classifier. Date formatting accepts either; time formatting requires datetime, matching both actual public formatter owners and preserving E5007/type-before-style precedence. Commit9a84d6f7 makes no midnight conversion or timezone membership decision. Source, translated and nested templates share the same checked parameter map. The existing mixed date/time test uses a datetime fixture; new actual public checker controls preserve date/date support and exact date/time refusal spans. [Independent Medium review](../../implementation/compiler-completion/temporal-values/independent-review/qualification.md) accepts the three-file change and42focusedpassingchecks. Anonymous descriptors retain structural-only checking; low-year UI validation, tagged carrier compatibility, Decimal literal emission, timezone data ownership and generated sink qualification remain open.

## 2026-10-08 — Retain public descriptor and fix fragments (accepted retention)

Retain the twelve public JS fragment helpers and three fix string wrappers. They preserve supported entrypoints while forwarding into live typed serializers; repository nonuse does not authorize API removal. Commita590a1ea records the [independently accepted finite disposition](../../implementation/compiler-completion/public-fragment-support/independent-review/qualification.md), complete current caller surface and matching source inputs. The conditional target remains fifteen entrypoints/fifty body lines; preserving those interfaces supplies zero justified retirement or net deletion. Reused current descriptor/fix/empty-lint controls remain distinct from unexecuted direct-wrapper and wider consumer outcomes. No runtime, size or performance improvement is credited; a future owner-approved API revision can reopen removal.

## 2026-10-08 — Qualify the integrated native compiler after bounded repairs (accepted profile)

The [current integrated receipt](../../implementation/compiler-completion/integration-after-bindings/after-bdd-ui/profile-accounting/admission-temporal.json) records the actual locked/offline full suite and strict all-target Clippy, both exit0. Sixty-five summaries report1,146passed/zero failed/ignored; one optional mode4750body skipped because this host did not retain its fixture bits. All117compilerinputs and1,770declared package manifests/dist inputs match before/after discovery and hashes. Git HEAD changed during execution and is separately recorded; tested file inputs remained stable. Failed earlier attempts and historical qualification stay separate. This is finite native/actual-consumer evidence, not complete BDD/application/GUI/deployment/support closure or automatic qualification of future source.

## 2026-10-08 — Empty named message signatures still cover placeholders (accepted bounded)

Make the private descriptor coverage contract explicit: None preserves structural-only callers, while Some(signature) requires each placeholder to name a declared parameter even when the signature is empty. Only phase2_message supplies the named signature; all four other verified callers retain None. The existing placeholder scanner, quoting, source/translation spans and diagnostic ownership remain unchanged. Commitbc2b7d05 is [independently accepted](../../implementation/compiler-completion/message-slot-coverage/independent-review/qualification.md) with six public regressions and29focusedpassingchecks. The catalog formatting fixture now uses genuinely static wording, preserving its full clean/overload assertions. Anonymous postfix binding remains an existing E3005 implementation gap; it is preserved as failed-probe evidence and receives no completion credit. This closes the discovered named-message checker defect without adding a canonical task identity or closing broader SEM-R03/S9 owner outcomes.


## 2026-10-08 — Preflight selected mixed-bundle physical outputs (accepted bounded)

The existing mixed writer applies the same defining package-output guard to sorted text keys, sorted binary keys and both mixed writer manifests after snapshot, layout and aggregate-digest validation and before text/mkdir/write. No new guard framework or host policy is introduced. Successful bytes, paths, manifest/declarations and earlier layout/digest/constructor errors stay unchanged.

Different-author review passes47 maintained checks versus39before and38 paired real-FS observations; seven public declarations match. Runtime grows206bytes/two lines and a separate138-line proof; correctness cost, not replacement savings. Review also reproduces a preexisting selected parent/child file conflict that can partially write before EEXIST, so this does not close planned layout/atomic/race/sidecar/installed/native gates. Repair that conflict with the defining existing layout mechanism in a separate finite slice. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/mixed-output-containment-independent-review.json). Native preparation remains on human HOLD; no merge or complete checkpoint advance.

## 2026-10-08 — Preserve checked nullable singular references (accepted bounded)

State preserves the existing `.can` `T?` rule: an omitted nullable reference defaults to null on creation, an explicit null is legal, and omission during update retains the previous value. The artifact already declares this distinction; the loader now copies its own explicit singular-reference association into immutable engine-local metadata. Current admission and its prepared validator consume the same association. Pipeline reference checking permits null only for the exact owning top-level field with explicit nullable metadata. Non-null version/target checks and the existing evaluation order remain intact.

This correction keeps the frozen public descriptor and `state-generated/v1` profile. It adds no Values producer authority or generic default policy. Reference arrays, nested nullability, typed scalar hydration and other context/default semantics retain their own gates.

Private State compilation and seven owning suites pass 97/97. Different-author review passes 29 focused tests, 21 metadata/before-current/parity observations and 17 actual unchanged-artifact canonical invocation/D1 observations, including persisted null, clear/restore, resolved-default ownership, replay and same-directory reopen. The identity store in these controls is a memory test store; this is local persisted D1 evidence. The initial fixture and read-expectation failures are retained with their corrections. The independently reproduced preexisting void result difference (`undefined` initially, `null` on persisted replay) remains open, as do typed integer carriers/import surfaces, complete original applications, hooks/locks/invariants, source selectors/secrecy, installed identity and owner storage routing. Task 9 and parent F1 are not closed.

Evidence: [bounded repair and tests](../../implementation/capability-roadmap-20261008/nullable-ref-repair/REPORT.md), [independent review](../../implementation/capability-roadmap-20261008/nullable-ref-repair-review.md), and [source contract](../../implementation/capability-roadmap-20261008/nullable-ref-contract-review.md). No merge or complete living-plan checkpoint advance is claimed.

## 2026-10-08 — Refuse planned file/ancestor output conflicts before effects (accepted bounded)

The defining Mixed writer now shares Package's existing ancestry check after aggregate digest validation and before physical preflight or text output. Package retains its prior validation point and manifest policy. Internal collision identity removes a trailing slash only for this check; raw names, successful bytes/paths, attach construction and standalone native failure behavior stay unchanged. Ordinary Mixed bundle.resources.json remains legal. No new public layer or guard policy is introduced.

Different-author review exercises336 independent ancestry cases (168 current conflicts refuse without effects),12 exact thrown-identity cases,78 paired raw checks and32 edge checks;38 maintained checks pass versus nine baseline controls/29 exposed failures. Original strict options and all seven public declarations match. Runtime adds466bytes/eight net lines; the new163-line proof and transient collision Set are separate correctness cost, not replacement savings. Host sidecars, child bounds/URL lifetime, general atomic publication/races, installed/full DEL-D03 and human-held native preparation remain open. [Review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/planned-output-collision-independent-review.json). No merge or complete checkpoint advance.

## 2026-10-08 — Exact Decimal expressions use the existing constructor (accepted bounded)

Use the genuine public stdlib parseDecimal constructor for dotted literals and checked contextual integral Decimal literals. Preserve source spelling and scale rather than converting through Number or normalized wire encoding. Genuine integer/duration lowering, public IR and artifact-default representation remain unchanged. Unary negation continues through the existing Decimal helper; unsupported unary plus and scenario action-reference diagnostics remain explicit.

The independently reviewed leaf is committed at0134ebb0. Its permanent source/runner live in compiler/tests/fixtures/decimal-runtime. Worker117codegen tests and2real Node runtime tests pass; fresh relocated fixtures plus descriptor/artifact checks pass10tests with no skips. A formatting-only golden assertion correction passes its exact1test and strict all-target Clippy; reviewed before/after pins remain distinct. The runtime covers exact38/18limits, contextual and nullable integer carriers, nested values, generated callable/default metadata, source scale, actual binding carriers and artifact-wire consumers with create/null/update distinctions.

Direct native metadata supplied to the wire-schema API still rejects; this does not alone prove an owning production bug, and no production native-default admission, UI formatting, platform authorization, backend or full SEM-R06/S9-Q05/SYN-R08 closure is claimed. The artifact adapter is explicitly a qualification consumer. Evidence: implementation/compiler-completion/temporal-values/decimal-materialization/independent-review/REVIEW.md. No new backend, authored builtin, bridge retirement, merge or living-plan checkpoint advance.

## 2026-10-08 — Retain public LSP builders and source position carriers (accepted distinct retentions)

Retain the current public response_ok/response_err/notification builders and TextPos/LspRange source-domain carriers with their protocol adapter. Resolve integration:legacy-lsp-render-builders and integration:lsp-duplicate-position-carriers as distinct existing-support retentions:29and18declaration lines remain; zero net production deletion and zero mechanisms retired.

Public hand-built Json preserves ordered duplicate members and unchecked raw numeric/ID values beyond admitted typed protocol routes. A validated typed replacement changes that contract. Position callbacks own source UTF16/CRLF/clamping and authored URI identity; a library alias or URI normalization needs an explicit public support revision. No equivalent qualifying retirement was identified at the present contract.

Independent Medium review verifies counts, full raw caller search including the Observed backend, selected source/dependency pins, and exact current JSON/source/diagnostic/transport direct controls. Historical40body records retain their actual scope; editor include_str fixtures are outside the old118compiler manifest, so the historical whole-suite result proves no complete frozen external-fixture closure. Current controls preserve literal bytes and source conversion; arbitrary external callers, migrations and future dependency changes remain unqualified. Evidence: implementation/compiler-completion/lsp-support/independent-review/review.md. No source/API/host/merge/checkpoint change.

## 2026-10-08 — Retain the public encoded artifact default carrier (accepted retention)

Retain JsFieldDefault::Literal(String), its public helpers and the RawValue serialization bridge. Resolve integration:default-json-string-bridge as current-support retention with zero net production deletion and zero bridge sites retired. Its conditional10-line retirement target remains unmet; no new public representation is selected.

The private literal tree preserves exact scalar strings, source Decimal scale, ordered duplicate members, arrays and null. Replacing the public String constructor/helpers changes support; compatibility routes or another typed variant retain the mechanism while adding representation cost. One static RawValue parse site remains, invoked per literal serialization; machine initial-state parsing is another dependency inside any future replacement closure. Malformed externally constructed literals return a Serde error, while the infallible to_json wrapper panics through its existing expectation. That distinction remains explicit rather than being reported as fail-safe public behavior.

Independent High review verifies current source/callers, unchanged representation segments, six fresh typed descriptor and two artifact tests plus two Decimal runtime tests. Server-over-default precedence is separate current source and the117-codegen-test receipt, rather than a new descriptor assertion. Native metadata-to-wire-schema rejection establishes a precondition boundary without proving production default admission; artifact adapters, full default/platform execution, arbitrary external users and performance remain unqualified. Evidence: implementation/compiler-completion/default-representation/independent-review/review.md.

## 2026-10-08 — Bound overload-trial conclusions to actual consumers (accepted qualification)

Thirteen legal-source public check_program controls against the unchanged installed producer catalog pass their specified outcomes:10clean and3diagnostic cases. No successful-program winning-type corruption was reproduced. Wrong-fold local_instant calls publish contextual timezone facts without a selected call, but no owning contract violation, wrong diagnostic/hover/IR or executed runtime outcome was demonstrated.

Keep SEM-R08 open. A future isolation repair needs an admissible producer with genuinely competing validated literal shapes and its owning consumer expectation, or an explicit failed-call fact contract. Static shared writes alone do not release a semantic rewrite. Current source/catalog/export pins and the failed initial timezone-shape expectation remain saved in implementation/compiler-completion/overload-trials/report.md. No compiler edit or new selection policy is chosen.

## 2026-10-08 — Refresh native compiler qualification after Decimal lowering (accepted profile)

The source snapshot at0134ebb0 passes the locked/offline whole compiler suite:1,154passed,0failed,0ignored;66binaryruns,67result summaries including doc tests,65nonzero and2empty. Strict all-target Clippy passes for matching accepted source/dependency scope. Independently replayed accounting verifies121compiler inputs,1,770package dist/manifest files and5external Can fixture files unchanged with no discovery drift. Shared Git HEAD changes are recorded separately from source pins.

The sandboxed suite retains one explicit mode4750body skip. Its unchanged exact permission-retention test separately passes outside the filesystem sandbox with no skipped mode, including original4750and format/output/entry-cleanup assertions. That execution expands the named native permission qualification without inflating the whole-suite count. Earlier failed and historical receipts remain preserved.

Evidence: implementation/compiler-completion/integration-after-bindings/after-decimal-materialization/profile-accounting/final-run.json and session-history/native-mode-qualification/receipt.json. These finite native bodies retain their test-context, memory, artifact-adapter and public-owner preconditions. They establish no complete application/browser/deployed/platform/default/producer-graph outcome. The goal remains active with37of67recorded references finished and30remaining; no merge or living-filetree checkpoint advance.

## 2026-10-08 — Expose existing generated pure value peers (accepted bounded)

Cloudflare's defining stdlib directly reexports Values int64, datetime and compareInstant. This preserves exact function/error/value identity instead of introducing wrappers or changing the owning facade. Four focused controls and independent actual preload verify the relay. The public Values barrel has initializers; no zero-effects or backend acceptance follows.

The existing suite remains12passing/eight failing before and after; the actual compatibility runtime keeps seven positives and one integer-default-string refusal. Original invocation executable attribution remains limited to recorded process.version24; the independently pinned Node24 preload does not retroactively supply it. Typed hydration/persistence, void replay, full context/authority, current compiler/installed/native and parent task9/F1 remain open. [Root review](../../implementation/package-maintenance-repair/runs/codex-go-20261007/runtime-pure-helpers-root-integration.json). This is required binding capability, not replacement-only savings; no merge or complete checkpoint advance.
