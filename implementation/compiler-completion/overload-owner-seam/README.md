# SEM-R08 actual-owner seam

Status: the finite rejected-trial literal-fact defect is now qualified and repaired through a successful generated native consumer. The thirteen earlier actual-standard-catalog checks in `../overload-trials/report.md` remain historical and are reused unchanged, including their nonreproduction outcome. The earlier source-mechanics assessment below is superseded for literal writes by the current owning trial buffer. This does not close full SEM-R08.

The owning callable catalog is `packages/values/src/catalog.ts`, emitted at `packages/values/dist/catalog.json`. Direct JSON inspection found 36 builtin entries, zero dotted nominal signatures, and no named signature shape outside the scalar table plus `Team`/`OperationContext` after accounting for the parser's dedicated generic, enum, message, action and invocation forms. `compiler/src/analysis/types.rs:8317` maps the scalar names (including `secret`); `match_named` at line 14661 handles `Team` and `OperationContext` exactly before the lenient fallback. Thus that unknown-name fallback has no concrete current producer nominal argument to test. The other package catalogs describe capability manifests rather than this callable signature envelope; the compiler's standard capability schemas have a separate owning path and do not establish a `match_named` witness.

Helper-only names such as `context`, `CanValue`, `ref` and `bigint` do not change this conclusion. `compiler/src/analysis/catalog.rs:537` assigns helpers an empty overload vector; `Catalog::overloads` at line 1142 exposes builtin overloads only. `compiler/src/analysis/resolve.rs:5079` rejects authored helper calls with E2006. Treating a helper signature as an authored overload would invent a contract.

The 2026-10-09 current installed catalog review (SHA-256 `cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62`) retains that absence. One genuine `NominalOwner` source calls `active_member(person,team)` from a read scenario with `person:user`. The current production CLI and that catalog return exit10, exactly E6007 `builtin 'active_member' is external (owner lane-03): implemented by another lane, unavailable here`, anchored at the call (100..127), with no modules. This verifies the existing owner-availability gate, not unknown nominal matching. No compiler repair, invented signature, new regression packet or old matrix repeat follows; that original SEM-R08 leaf needs a concrete owning nominal contract and remains open.

The existing same-arity trial assessment still applies: validated currency leaves in the two money overloads have the same expectation; format's plain/message arms separate on the first declaration slot; validated timezone calls have single overloads; sum's currency-bearing arm has a distinct arity. At that historical assessment, `call_builtin` matched against pretrial argument types and published the winning selected-call index/slots and enum claims, while `inhabit_validated` recorded literal types directly. Those shared literal writes are now replaced by trial-local writes and winning-trial publication, as qualified below.

The permanent owning regression is `compiler/tests/selected_calls.rs::rejected_currency_overload_preserves_winning_text_argument_facts`. It loads a copy of the installed catalog through public `load_catalog`, changing only `choose`'s signature to a sound Currency subset before its original generic signature. Actual js/effects/availability/owner remain unchanged. One genuine checked source has `chosen():text = choose(true,"USD","not a currency")` and `accepted():currency = choose(true,"USD","GBP")`. Public typed IR/emission and the installed stdlib facade execute both emitted `canApp` derives with `{}` and return `USD` before argument-fact assertions.

Before the repair, the successful generic overload1 published checked-node and typed-IR arguments `[Bool,Currency,Text]`; the accepted narrow overload0 correctly retained `[Bool,Currency,Currency]`. The intended prepatch case failed at the fact assertion after both native results passed (0/1, 0.10s). `Trial.literal_retypes` now buffers validated literal types locally, carries them through successful fork/commit, and flushes only the winning trial. The same case then passed **1/1 (0.10s)** with generic `[Bool,Text,Text]`, narrow facts preserved and both native results unchanged.

The first preparation run (0/1, 0.01s) corrected a new oracle: identity slots legitimately lower to `IrExpr::Call`. The next preparation run (0/1, 0.18s) exposed a missing installed `choose` export; the defining Package owner fixed/released the facade with tsc exit0 before the intended leak run. Only this affected case repeated; prior selected/add_days and standard-catalog matrices remain reused. No wrong native value, IDE error/hover, new API, new catalog producer contract, State/authority or full SEM-R08 completion is claimed. Package owns facade capture; coordinator owns DECISIONS/coverage/index. Unknown nominal matching and alias/scalar provenance/default dependency/bytes/temporal portions remain separately bounded or open.

The finite imported scalar-alias path is now qualified separately by
`compiler/tests/selected_calls.rs::imported_scalar_aliases_preserve_installed_temporal_overloads`
and `compiler/tests/fixtures/scalar-alias-overlaps.can`. With the unchanged
installed Values catalog, source aliases `Calendar.day` and
`Calendar.instant` preserve the declared `date` and `datetime` types through
named arguments to the corresponding `overlaps` arms. Checked facts select
arms 0/1, retain Bool result and source scalar argument types, and preserve
canonical imported identities and slots `[3,1,2,0]`; public IR retains the
bound pure builtin call and source-ordered nested derive arguments. The actual
CLI/generated-module consumer executes both arms against the installed Values
facade: overlap and touching-edge cases return true/false, and record getter
receivers, once/order (`bEnd,aEnd,bStart,aStart`) and original constructor
references are preserved. One isolated case passed **1/1 (0.54s)**; six
unchanged selected-call tests were filtered/reused. This establishes a bounded
consumer outcome, not a prior defect or full alias/scalar-provenance closure.
Unknown dotted nominal matching remains open: current catalog still has zero
dotted nominal signatures; its real `Team` case is the separately recorded
external/static-refusal outcome above. No catalog/API/matcher or authority
change is claimed.
