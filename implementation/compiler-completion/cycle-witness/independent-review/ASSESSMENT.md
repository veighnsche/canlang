# SEM-R07 independent high review

Accepted within the declared fixed-input static-call witness scope. No actionable blocker found. This review independently read the source/diff and graph/review-authority scope before considering the author's acceptance summary. It does not accept a common graph policy or permutation-invariant orientation.

## Frozen scope and source conclusion

All seven `acceptance.json::writer_freeze` hashes match live files. Every path in both frozen snapshot manifests matches its actual snapshot bytes. Comparing the manifests and actual types sources finds exactly one preexisting source difference, `src/analysis/types.rs`, and one new test, `tests/cycle_witness.rs`. The types diff is precisely mutable origins plus ascending `SymbolId.0` sorting and two explanatory comments. Existing state-machine and enum implementation bytes outside this hunk are preserved. The source baseline includes the newer integrated features; historical audit source hashes are not asserted to equal this baseline.

`check_program` builds trees in supplied file order; resolve indexes modules/declarations through ordered tree/section children and allocates IDs by appending to the symbol vector, with nested/generated symbols interleaved. `phase2` visits ordered trees and bodies; `record_call_edge` appends occurrences to a vector. `check_cycles` appends those occurrences to each caller's adjacency vector in that same order. The new sorted origin vector is unique by map key, so equal sort keys cannot introduce a tie. The remaining HashMap accesses are keyed lookups; `visited` and `reported` HashSets affect membership only, never iteration. Stack order, visited-on-push, path cloning, closing-edge span attachment, and sorted path-vertex-set dedup are unchanged. This supplies a source-level deterministic traversal argument for fixed resolved input/edge vector, reinforced by finite compiler observations. It is not an exhaustive theorem for all upstream compiler passes or malformed inputs.

The decision fairly trades optional permutation stability for a small fixed-input repair. The three retained independently worded choice requests present equivalent alternatives and verified bounds, and all responses advise index order. Their confidence of 1.0 is advice, not proof. No JEV request was sent during this review.

## Independent oracle and execution

`probe.rs` fixes exact handwritten messages and call-occurrence anchors rather than reproducing a graph walker. Three fresh runs passed each case:

- Forward diamond: `b -> d -> a -> b` at 55..56, `a -> c -> d -> a` at 197..198.
- Reversed authored branches: `c -> d -> a -> c` at 55..56, `a -> b -> d -> a` at 197..198. This exposes adjacency/visited ordering rather than only checking public source sorting.
- Interleaved parameter/generated CRUD symbols: z has ID 2 and a ID 8; witness remains `z -> a -> z` at 173..174 despite lexical name order. Related diagnostics remain empty.

Three independently compiled observer-process runs passed the frozen exact upstream `a -> b -> a` at 141..142 and overlap `a -> b -> a` at 111..112 plus `a -> c -> a` at 154..155. One targeted pinned test passed both supplied file orders with distinct and duplicate source paths. File/declaration permutations deliberately may change witness orientation; source display paths do not choose it.

The reviewer independently rechecked all retained 24-before/24-after records: before has 2 upstream and 4 overlap result sets; after has 1 each. Composition, ownership, fixture and derive controls preserve ordered public tuples and raw multisets across all 48 processes, including composition duplicate multiplicity. Raw fixture/derive order is deliberately not required to be deterministic. Source and test inspection also preserve upstream exclusion, independent/self/duplicate-closing vertex-set dedup, CRUD/capability leaves, rejection of trusted-handler edges, standalone derive graph separation and fixture seed order. The focused suite has 11 passed in the retained frozen receipt; it was not redundantly rerun with another 24-process group.

Commands and process receipts are recorded in `verification.json`. The handwritten probe was compiled with:

```sh
rustc --edition=2024 implementation/compiler-completion/cycle-witness/independent-review/probe.rs --extern canlang_compiler=/private/tmp/canlang-cycle-witness-after/target/debug/libcanlang_compiler.rlib -L dependency=/private/tmp/canlang-cycle-witness-after/target/debug/deps -o /private/tmp/canlang-cycle-witness-independent-probe
```

## Limits and ownership

Finite handwritten cases and three fresh runs supplement the author's 24-process corpus; no exhaustive graph enumeration, full-suite rerun, benchmark, runtime/deployment, platform or hermetic source-release claim is made. Fresh probes link the frozen built rlib; source/manifests and retained build receipts are checked, but the library does not embed source hashes. Root owns the whole-compiler integration qualification and the repaired unrelated example caller. No production source, shared documentation, acceptance receipt, or Git state was edited. Review writes are confined to this independent-review directory. No automatic approval refusal occurred in this review.
