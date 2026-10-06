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
