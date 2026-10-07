# S9-Q06 / ARCH-01 selected checked-cohort proposal

Status: selected implementation recommendation, awaiting root production lease. No production or shared-document edits. The source contract is finite input association, not universal checker truth, a cache, or new resolved binding publication.

## Verified boundary

Pinned compiler `530a0b7e`, freshly copied/build offline in a private workspace/target directory. `probe.rs` uses real public `CatalogAnalyzer::analyze_owned`, `check_program`, and `emit` with production options. `probe.stdout`, `probe.stderr`, artifacts, and `probe-exit.json` preserve the successful witness. Actual production CLI control is separately saved as `cli-control.*`. No generated JavaScript executes in these cohort probes.

- Complete clean coherent control emits OLD. Foreign DB with equal IDs/spans emits NEW without error; swapped ID numbering changes association without error. A changed catalog changes awaiting, including an unchanged catalog version label.
- Appending NEW at the same path preserves original SourceId and emits OLD; current artifact and map inventory include both immutable revisions.
- Reversing check-file order allocates modules in caller order. Checking one file of a two-file DB emits selected semantics while inventories include both sources.
- `complete=false` production returns E6005 and empty modules. `test_only` permits coherent incomplete fixtures and currently also permits swapped-cohort input.

## Selected contract

A checked program belongs to one SourceDb instance and one immutable loaded Catalog instance (or None), retaining the exact ordered selected file IDs. Moving either owner is valid. Adding source revisions to that DB is valid; old IDs keep denoting original bytes. Cloning Catalog preserves catalog identity because the entire exposed Catalog is immutable. A newly created foreign DB or freshly loaded Catalog, including content-equivalent ones, must be checked again. This is a deliberately strict instance contract, not hash or content equivalence.

Use private Arc allocation identity handles in SourceDb and Catalog. CheckedProgram clones only these handles, original DB length, and selected IDs. Arc::ptr_eq compares the owners without raw lifetime addresses, nonce allocation/wrap rules, or a global registry. Retaining handles keeps an allocation identity alive across owner moves/drops. No source or catalog semantics are duplicated. Capture source_count when checking and refuse any selected ID outside that original allocation range, so an originally nonexistent forged SourceId cannot gain checked status through later appends.

Both public `emit` and `ir::build` reject mismatched owners/invalid original selections before Cx parsing, using E6011 and empty executable output. `EmitOptions::test_only` bypasses only E6005 incomplete-analysis; it cannot bypass E6011. Cx parses the recorded checked file sequence rather than all DB entries. Artifact/maps retain current complete DB inventory behavior; inventory membership does not claim source semantics were checked. Original source IDs/order remain stable, including nonzero subset IDs. None-to-Some and Some-to-None catalogs mismatch; coherent None retains current missing-catalog capability diagnostics.

`DiagnosticResult.complete` remains an explicit caller-provided pass-completeness gate, and callers must merge analysis/load diagnostics and refuse shipping errors. Program tables and DiagnosticResult fields remain public/editable; provenance does not authenticate their contents or bind diagnostics cryptographically to facts. This limitation is existing public low-level API behavior and must be stated before future binding publication. Publishing additional facts or reuse beyond this input-owner boundary remains unreleased.

## Verified callers and compatibility

`public-callers.txt` saves the complete defining-call inventory for compiler/src and compiler/tests, with `inspection-pins.json` recording inspected owner inputs.

| Caller family | Existing owner behavior | Compatibility under selected contract |
| --- | --- | --- |
| `CatalogAnalyzer::analyze_owned`, `cli::run_compile` | Analyze all DB IDs, return checked program and same moved loaded catalog; merge analysis/load diagnostics; production gate before emit and emission errors before shipping | Existing coherent path retains signatures and behavior; actual CLI baseline receipt passes |
| `check_program` + public `emit` tests and public consumers | Caller retains original DB/catalog or supplies intentionally mixed inputs | Original owner and catalog Clone work; mixed and separately reconstructed equivalent owners now refuse |
| Public `ir::build` consumers (`b3_migrate`, `js_binding_runtime`, `flat_expression_runtime`, codegen cases) | All repository callers pass the checked DB/catalog; direct build has no completeness/result argument | Retains signature and incomplete-IR fixture support; adds independent cohort refusal before parse |
| `Snapshot::analyze` and IDE/LSP queries | Private snapshot borrows original db/catalog and owns program/parse/resolution facts | No signature or lifetime propagation; no parse/resolution caching added |
| `docs::extract_reference` | Public API explicitly requires analyzed source files and successful analysis; CLI passes owned original DB | Existing precondition retained; this packet does not migrate report API or claim enforcement on arbitrary foreign inputs |
| `policy_dump` | Public projection slices caller db/files against checked names/types and is documented total | Existing total projection support retained; no new report API or semantic execution guarantee |
| Lint/fix APIs | Public program+db intake reparses sources and guards edits by exact source hash; history ownership is separately assigned | Map precondition only; no lint edits or competing history mechanism in this packet |
| Raw IR/js/artifact/map adapters | Public constructed carriers can be synthetic and do not imply successful checking | Cohort is checked-program lowering admission only; no production shipping guarantee from raw synthetic carriers |

Adding a private CheckedProgram provenance field prevents external struct literal construction. Repository executable production/tests construct programs through check_program; two saved historical synthetic literals are evidence records (`resumption/flat-stages.rs` and `implementation/compiler-completion/flat-stack/stages.rs`), not shipped callers. Update their recipe only if rerunning them, using check_program on empty input and replacing public fixture tables. No unchecked public constructor is added. Immutable DB/catalog fields stay private, tokens stay crate-private, and no public token forgery path exists.

## Alternatives and JEV advice

Three separately worded equivalent choice requests compare: (1) borrowing originals through CheckedProgram lifetimes, (2) retaining exact source path/text/order plus cloned full Catalog and checking value equality, (3) owner allocation identities. Requests and complete replies are saved as `jev-request-1..3.json` / `jev-response-1..3.json`. Verified observations and required controls were supplied equally; no requested option was presented as implemented.

All three replies choose owner_tokens. Reported confidence: 0.61, 0.61, 0.31. The third probability split is 0.54 owner_tokens versus 0.45 exact_input_record; first two token probabilities are 0.74. These are advice, not proof. No disagreement in selected choice needs a tie-breaking retry, but equivalent-owner compatibility remains a meaningful design uncertainty. Exact snapshots would support new equivalent owners at the expense of retaining/copying source text/catalog and complete equality maintenance. Borrowing has a clear API propagation cost and conflicts with mutable append while checked facts live unless broader sharing is introduced. Owner tokens were selected because existing actual callers retain the owners, appends/clones are important controls, and no verified caller requires equivalent independent substitutes. If that substitution requirement emerges, revise the contract with evidence instead of adding hash-only compatibility or fallback inference.

## Exact implementation lease requested

- `compiler/src/source.rs`: private Arc identity plus crate-private identity borrow; retain append-only storage and public signatures.
- `compiler/src/analysis/catalog.rs`: private Arc identity created once per successful catalog load, preserved by Clone; crate-private identity borrow.
- `compiler/src/analysis/mod.rs`: private cohort field/capture in check_program; documented owner/order contract and read-only selected file accessor.
- New `compiler/src/analysis/cohort.rs`: single private input association/check helper, with E6011 refusal diagnostics.
- `compiler/src/codegen/mod.rs`: preserve completeness gate, add cohort gate, share empty artifact construction for refusal; document test_only scope.
- `compiler/src/codegen/ir.rs`: tiny build entrance guard plus parse-loop restricted to program checked IDs; empty IR helper. No decoding changes.
- New `compiler/tests/checked_cohort.rs`: independent public source/catalog refusal and valid owner controls, direct ir::build, source subsets/order, completeness/test_only, None transitions, Catalog Clone/move/reload, invalid original SourceId then append.

No lease needed for types.rs, js.rs, lint, artifacts/maps, CLI, report APIs, packages, or shared docs. Root owns shared decisions, receipts, navigation and commit integration. Focused validation: new cohort integration test; existing public direct-IR witness targets/codegen admission controls as applicable, actual CLI coherent smoke. No broad retest/audit unless this focused validation exposes a specific regression.
