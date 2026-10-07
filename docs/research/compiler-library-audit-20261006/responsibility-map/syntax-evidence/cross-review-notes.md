# Independent syntax cross-review

## Independent trace recorded before primary conclusions

Read AGENTS.md, normative GRAMMAR.md, CST kinds and parser recovery; inspected raw cases.json and all 40 case stdout outcomes, analysis driver and direct emitter plus Error/BadToken filters. Primary inventory/forms/recovery conclusions were not read before this trace. No compiler or test changes and no duplicate suite/probe execution.

Independent contracts:

- ASCII names exclude é/emoji while JSON strings/descriptions must retain scalar values. Decoded default witness joins lexer code points, schema artifact value and emitted JS escapes; LF, CRLF and final implicit newline yield the same value. This establishes these concrete spellings, not every string escape or default evaluation ordering.
- Closed known malformed declaration `policy` must preserve subsequent intact derive nodes and E3002 at `1 + true`, E2001 at `nope`. Raw observations satisfy this contract, including CRLF/EOF variants. Bad characters, numeric tails, unknown escapes, lone surrogates, description reference syntax, indentation and mismatched closers also retain these sentinels.
- Unclosed schema/call/list and unterminated string with open schema consume later declarations into one joined logical line/Error. Lossless byte coverage is still true but independent sibling diagnostics are absent, including the following top-level module. Coverage alone does not satisfy recovery.
- A closed malformed Given declaration leaves intact scenario CST/symbols but suppresses E4011 secret return and E4020 role(actor), compared with their controls. Cross-module role(actor) control also disappears. E4004 app-model policy and E5007 ICU sibling survive. This is selective ancestor/global analysis suppression, beyond delimiter joining.
- check_program always invokes resolution/types/effects/examples after parse; complete=true means pass readiness, not every unaffected position checked. has_error scans descendants. effects module collector filters an entire App/Package (effects.rs:1083), types module-source precollection filters App/Package (types.rs:4904), a separate source-only risk. The E4020 cause is the file-root walk_tree_calls gate (effects.rs:3869). These explain missing intact sibling checks and prevent interpreting complete=true as user-goal completion.
- Production CLI behavior is modeled by probe blocking emit on analysis errors; direct emit additionally gates incomplete readiness only and returns artifact plus diagnostics. Valid mystery UI syntax reaches E6008 in emission; decimal literal also reaches E6008 with throwing placeholder. Such observations are explicit unsupported joins, not successful workflow coverage.
- CST enumerates execution, examples (including sequences), UI preference-order and migration nodes. Normative grammar contains historical prototype caveats conflicting with implemented parser productions (e.g. example sequences); inventory must compare actual implementation, not repeat obsolete caveats.

## Challenge results

Primary recovery conclusions agree with the independent raw control comparison. E4011 module-level and E4020 file-level suppression are demonstrated; source-language collection is correctly only a risk. The removed resolver whole-module gate is not a current bug. No implementation/synchronization policy selected.

Primary forms ledger correctly separates finite enumeration from cross-products and identifies corpus/judgment omissions, UI catalog wildcard admission, tab fallback, structured preference-order loss, decimal lowering, and historical prototype boundaries. These latter source-only paths still need exact public artifact probes; no false runtime-completion claim is accepted. Function starts and all 30 forms input SHA pins verified against current source; there were no stale starts or pins.

Corrections requested:

1. Grammar inventory captures first lines only for multiline productions (for example `primary`, `arguments`, `app_composed`, `context_declaration`). Indexing each production name is useful, but inventory-notes claims full production text. Capture continuation lines or explicitly label first-line excerpts.
2. The runner checks required sibling diagnostics and byte coverage but does not require rejection diagnostics for most invalid spellings; a regression accepting `&`, unknown escape or open EOF syntax silently could satisfy some current assertions. Add declared E1xxx admission contracts, or label that rejection was independently inspected only in raw results.
3. `clean` checks parse/analysis cleanliness, not emission diagnostics or preserved semantic values. Add exact schema artifact default/description and generated JS assertions for positive witnesses, or clearly identify manual artifact inspection as their evidence.
4. `forms.json` IMPORT checking anchor is `resolve_given`, which contains no import dispatch; it is an accurate function start but not the owner of import enumeration/export/alias/provider validation. Add Resolver import-resolution anchors. Closed header attribute inventory omits custom scenario/effect/parser-specific keys; its name should identify HeaderKind attr_kind scope.

Acceptable scope: complete finite source index with branch-owner trace and explicitly bounded stage gaps; 40 representative public observations and focused harness receipts; demonstrated sibling suppression findings with control/specific spans; compiler unchanged. This is sufficient to record the audit findings and proposed dependency-ordered repairs. It does not establish the stronger claim that every valid/invalid grammar branch has an independent emitted artifact witness. Full semantic/runtime/post-deploy qualification is intentionally subsequent.


## Additional root controls independently inspected

Read extra-cases.json and ten extra raw public observer outputs after the original trace. Valid app policy control is clean; unrelated malformed policy creates false E4004. source=fr with fr translation correctly yields E3016 in control and loses it with malformed sibling; en control is clean and gains false E3016 after malformed sibling. Thus module-source precollection risk now has a demonstrated control pair.

Tab caption/descendant strings survive in CST and sourcesContent but disappear from generated modules[].js (`tab({context:c})`), with clean parse/check/emission. Structured preference order similarly reaches `order:[]` with no diagnostic. Positive emitted-string assertions must inspect JS only because sourcesContent would falsely satisfy them. Corpus with unresolved owning names receives no parse/check/emit error and disappears from generated declaration output. Judgment reaches a fieldless contract placeholder with E6006, which the production CLI must refuse; do not label its artifact as successful judgment workflow. No extra execution performed by this reviewer.

## Final evidence challenge

Full multiline production retention verified (`primary` range220–222); IMPORT checking anchors now point to actual import resolution; 75HeaderKind rule lines are explicitly scoped and supplemented by21custom-key forms. These three corrections are resolved.

Read verifier source and outcome-verification.json without rerunning it. Required E1 rejection checks derive from lexical/layout grammar and diagnostic catalog; positive exact schema default [8,12,128512], description é😀, JS controls, complete Unicode diagnostic byte spans, error-free emission and JS-only tab strings match independent expectations. All75checks comprise68passes and7intentional defect mismatches. Original pre-execution94assertions comprise81passes/13mismatches across8cases; this is separate from the later verifier. Raw owner prose is preserved exactly in valid-description JS; an exact automated assertion was suggested because current verifier only checks clean emission for that case.

Independently read production CLI check/compile JSON for Tab, PreferenceOrder, Corpus and Judgment: first three return artifacts with the demonstrated semantic losses; Judgment returns E6006 diagnostics and no emitted artifact. Corpus54file projection is explicitly source/check/clean-emission observation with omitted full artifacts/JS and no execution; its diagnostic projection corroborates implementation breadth but does not prove every grammar branch or cross-file closure. Root reported15additionalinline syntaxpasses; this reviewer directly inspected330eight-harness passes, no reported SKIP, and six executed C01codepoint success lines.

Final status: accept the bounded source-form/stage audit evidence and demonstrated findings for ledger integration, retaining all unqualified/runtime/post-deploy boundaries. No production/test implementation changes or repair acceptance implied.

## Integrated delta acceptance

Read shared syntax.md,27family/eightfinding/registry/input/execution ledger additions, syntax-validation.json, shared README/procedure, isolated Step7DECISIONS append, final byte-ingress helper/receipts and15inline syntax test raw output. Later exact raw owner prose check now resolves the suggested assertion gap:76checks/69passes/sevenintentionally retained defect mismatches. Initial94/81/13 across8cases unchanged. SixteenCLI calls include corrected byte-ingress check/compile E7002stderr/exit2, distinct from lexerE1002; initial JSON capture error is transparently retained.

Compared prior ledger against task-startf3dd798c: all358prior rows retained. Changes only scope completion/status_defaults and path syntax_refs/syntax_scope; old workflow/interface/compatibility/representation/integration duties remain intact. DECISIONS239376-byte frozen prefix hashes exactly. Current ledger SHA matches integrated validation receipt. Mechanical806pin/1253bound/118link/noerror receipt has narrow scope and does not imply branch/semantic acceptance.

Finite every-form mapping wording is acceptable because full EBNF alternatives, carriers/catalog/header/custom slots and source-stage owners are explicit; unsupported/deferred distinctions and representative execution limits are equally explicit. Source query limit correction agrees with normative query_tail and parser; downstream IR limit presence does not imply source admission. R01/R02 independent existing-contract repairs, serialized R03/R04IR writer, gatedR05/R07support/profile release, consequentialR06JEVpolicy andR08witness/prose maintenance preserve prior authority and reduction duties. No compiler/grammar/package/contract implementation, merge or checkpoint advance is inferred.

Minor locator correction sent to root: registry `inventory.json#test_witnesses` names no actual key (`witnesses` is correct). This does not change finite coverage or findings. Integrated finite source-stage evidence scope accepted, with all demonstrated defects and later semantic/runtime/product/oracle/host qualification open.

Final locator correction verified: plain inventory.json plus witness_inventory_key=witnesses. Final integrated ledger SHA is `5b359a9f4d44ce0bcdc008cf7fbe7597977bef3f51348c7f005c6ca78d925af5`; regenerated receipt reports no errors and matches bytes. Root consumer runTable bound corrected from246–280to full246–259, actual fileEOF259. Review accepted at the stated bounded source/form/stage scope; no remaining review blocker,76later checks69passes/sevendefect mismatches retained.
