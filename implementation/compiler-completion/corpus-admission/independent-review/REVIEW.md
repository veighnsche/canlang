# Independent Corpus admission review

Outcome: accept the candidate as the bounded explicit-unsupported-admission repair for the original SYN-R05 and S9-Q04 no-loss finding. No blocking implementation defect was found. This acceptance closes the clean silent-disappearance obligation and preserves Judgment's existing E6006 refusal. It does not release checked Corpus/Judgment support, generated interfaces, descriptors, runtime helpers, or application execution.

The reviewed IR is SHA-256 `2a8df2950eb2bf10ec2c81e7af556a2802791961e6a87693eafb1d5709c590f7`; current CLI is `a793809ff67fd5dfd55b822fbbe586dadc41fbc9024f57dc266f6b6329353700`. All 42 candidate Rust implementation pins still match. The before/after manifests differ only at `compiler/src/codegen/ir.rs`. The source change adds direct Corpus-node admission diagnostics to `Cx::build_modules`; it does not alter analysis, contracts, packages, artifact structure, backend lowering, or permissions.

## Owning contract and consultation boundary

This judgment follows both the original requirements and current owners rather than only the worker's framing:

- `responsibility-map/syntax.md` SYN-R05 explicitly permits checked retained ownership **or explicit unsupported admission**, separates support release, and reserves verified-context JEV for consequential new support alternatives. `resumption/lowering-and-execution.md` S9-Q04 gives the same alternatives, says to judge new support alternatives before changing admission, and requires keeping Judgment's E6006 until support is released.
- `DESIGN.md` §8.2 calls these accepted draft contracts, not available implementations. §13.5's `appDefinition.corpora` descriptor and pure helpers are desired output. `design/complex-apps/knowledge.md` labels its JavaScript desired, says no shared implementation is claimed, and records prior consultation disagreement rather than presenting an implemented alternative API.
- `analysis/catalog.rs` B8 and `packages/contracts/src/services.ts` B8 explicitly scope out the derived answer/cancel/reconcile/refresh/status/available and Run/Answer interfaces pending a Corpus-interface decision. KnowledgeRequest/IndexState are value-only schemas, not substitutes for those members. Searches found no packages implementation of `corpora`, `corpusStatus`, or `groundedAvailable` in TypeScript.
- `parse_corpus` owns required six-attribute, unexported Given-leaf grammar. `resolve::index_given` has no Corpus branch; SymbolKind and IrItemKind contain no Corpus owner; CompileArtifact contains no Corpus descriptor. Judgment is separately indexed as a fieldless Contract with deferred derived-member ownership.

E6008 here reports that this declared but unimplemented workflow cannot be emitted. It does not choose a new interface, backend, provider, selector meaning, authorization rule, or even semantic attribute validation. Refusing an existing unsupported owning boundary removes a false compile-success assertion while leaving the draft contract and future supported alternatives open. On this verified context, the repair itself is a routine correctness choice and does not require a new three-request JEV consultation before acceptance. A future supported implementation or revision of the draft language/runtime contract does require that consultation. This review makes no judgment about the coordinator's separate BDD consultation/approval flow.

## Code and evidence review

The gate walks `program.modules`, finds the exact file and App/Package CST span, then inspects direct Section Corpus children. Parser ownership restricts such nodes to Given; strings, comments, unrelated identifiers and nested recovery carriers are not matched. It uses significant child bounds, so indentation/trivia do not enter the primary range. The second Name token is the authored Corpus name, while `m.name` supplies canonical owning module identity. It emits one error per occurrence and retains existing module construction. It introduces no default Unsupported node or empty semantic substitute.

`ir::build` validates the checked source/catalog cohort before creating Cx, and Cx reparses only `checked_files`. Existing shipping authority stays in `run_compile`: error diagnostics produce exit 10 and a diagnostics envelope without artifact fields. Public `emit` intentionally returns the artifact alongside E6008; its documented caller shipping duty remains intact.

The saved actual CLI before records show exit 0 artifacts for legal local, foreign aliased-model and Missing-model Corpus. Candidate records show check exit 0/complete=true with empty diagnostics and compile exit 10/E6008/no artifact for all three. This is explicit emission refusal, not newly checked selectors/model/where/from semantics. Bare missing-attribute Corpus remains E1204. Judgment retains check-clean and compile E6006. Canonical ownership in the package witness is Knowledge.Handbook, not its importing composed app or model alias.

The permanent public-owned-emission test uses real `CatalogAnalyzer::analyze_owned`, bundled values catalog and production EmitOptions. It compares the whole supported sibling artifact envelope after excluding source identities and source maps, which correctly change with inserted source text. Model, callable, module/import/composition, migration and BDD carriers remain equivalent under that scope. The 28/0 focused log covers corpus_admission, b4_resolve, checked_cohort and typed_descriptors. I inspected those tests and results; I did not repeat them or broaden to a full suite. The historical 1162/0 result does not qualify this source change.

## Independent targeted controls

To resolve leads not directly exercised by the three permanent tests, I built only the current library with locked/offline Cargo, selected its Cargo-reported rlib, and compiled the saved public probe against it. Build, commands, stdout/stderr/exits and library/source/catalog pins are retained in this directory.

- Duplicate same-name Corpus leaves remain check-clean but return two E6008s, each at its own exact keyword-through-final-attribute range and Selected.Handbook canonical name. Public emit still returns existing modules alongside those errors. Duplicate names have not become a new resolver error.
- Ordinary text containing `corpus Phantom ...` and a `##` lookalike comment emit cleanly.
- A nonzero selected source emits only its selected module. Corpus in an existing unselected source and in a later immutable append emits no new diagnostic; the already selected module's JavaScript is unchanged.
- Actual CLI duplicate, lookalike, prohibited Corpus body and malformed required-attribute controls pass. Invalid body/attribute cases preserve identical check/compile parser diagnostics and block artifact shipping; the new E6008 is not fabricated during that recovery. Raw calls are in `cli-probes.json`.

The observer initially attempted a Rust equality assertion on IrModule, which lacks PartialEq. That probe compilation failed before execution; the probe was corrected to compare selected module count/name and exact emitted JavaScript across append. No production change followed from this harness correction.

## Closure and remaining limits

SYN-R05's original finite correctness outcome can close as explicit unsupported admission; S9-Q04 can close its no-silent-loss and retained-Judgment-refusal duty on the same bounded result. Do not label that closure implemented Corpus/Judgment support. Keep the supported owner/carrier/interface/runtime workflow as separately proposed or unimplemented work, including unknown model and selector checking, source-policy proof, generated result opacity, indexing and delivery behavior. No universal-support framework or full runtime implementation is prerequisite to this refusal repair.

Only files beneath this independent-review directory were written. No source, decisions, ledger/status, or Git changes were made by this reviewer. Root owns acceptance bookkeeping and any broader source fingerprint/integration checks.
