# Bounded checked operation result producer

The shared `operations_json` serializer publishes optional `result: {type}`.
Selected checked Scenario declarations publish the closed `int`/`datetime`
scalar profile, one optional array suffix followed by one nullable suffix, or
explicit `void` for declaration-established no-result signatures. Other result
shapes, including text, text arrays, nullable text and bool, remain absent.
Policy reads and generated CRUD
keep absent results. Input schemas, canonical identity, and exclusions retain
their existing selection rules. Metadata does not activate conversion or defaults.

`TypeTable.symbol_results` defines `None` as void. The IR builder also uses `None`
when a declared result table row is missing, with blocking `E6006`. Consequently,
the no-result proof applies to successful checked compilation, not malformed or
manually constructed IR. It does not reinterpret absent legacy artifact metadata
as void. Fresh CLI artifacts are the qualification authority.

Focused source witnesses cover imported owner identity versus aliases and a local
homonym; int, no-result, nullable int, and text; publication exclusion; generated
operations; exact input preservation; and artifact/canApp descriptor equality.
A wrong int result body must fail compilation without operations publication.

Formatting and `git diff --check` passed. Root ran the single focused Cargo check:
13 passed, zero failed across operation_results, mcp_p1, typed_artifact and typed_descriptors.
Actual command:

```sh
CARGO_BUILD_JOBS=2 cargo test --manifest-path compiler/Cargo.toml --locked --offline --test operation_results --test mcp_p1 --test typed_artifact --test typed_descriptors
```

The H1 consumer follow-up extends this existing producer to `int?`, `datetime`,
`datetime?`, `int[]`, `datetime[]`, `int[]?` and `datetime[]?` from checked
`ResolvedType` only. Fresh actual CLI metadata and shared artifact/canApp
serialization pass **2/2** `operation_results` tests. Imported owner identity,
input schemas, unsupported result absence and invalid body refusal remain
checked. Nested arrays and nullable elements refuse with existing grammar
E1213; they are not admitted by a string parser or inferred source signature.
An initial positive fixture mistakenly included those illegal signatures;
they were moved to explicit grammar-refusal controls.

Runtime H1 admission/hydration/default/execution qualification belongs to its
consumer owner. Wider result publication and execution completeness remain open.
