# Bounded checked operation result producer

The shared `operations_json` serializer publishes optional `result: {type}`.
Selected checked Scenario declarations publish the closed `int`/`datetime`/`text`/`bool`
scalar profile, one optional array suffix followed by one nullable suffix, or
explicit `void` for declaration-established no-result signatures. Other result
shapes, including specialized string types, money and records, remain absent.
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

The initial bounded producer qualification ran the single focused Cargo check:
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

Literal-default follow-up: the shared checked default classifier now recognizes
only synchronous builtin `datetime` calls with one direct text literal, including
within existing literal arrays/objects. Model and parameter metadata therefore
publish scalar and array defaults; dynamic constructor defaults still refuse
with E6008. Existing constructor validation retains E3001 for invalid literals.
The shared checked datetime parser supplies the instant for canonical UTC
`YYYY-MM-DDTHH:MM:SS.sssZ` wire metadata, rather than copying constructor spelling.
Generated native defaults continue to call the owning datetime constructor.

The affected `operation_results` check passes **2/2** after the default change;
strict library Clippy also passes with `-D warnings`.
Its fresh CLI witnesses cover model and parameter metadata, nullable parameter
defaults, omitted-input metadata, offset normalization across a leap-day boundary,
pre-epoch fractions, supported minimum/maximum instants, invalid calendar input,
and computed-default refusal. Runtime omission/null/default execution remains
the consumer owner's qualification. This bounded follow-up leaves the canonical
completion count at **48/67**.

Text/bool follow-up: checked Scenario results now include `text`, `text?`,
`text[]`, `text[]?`, `bool`, `bool?`, `bool[]` and `bool[]?`. Scenario inputs,
stored/derived model fields and flattened CRUD fields publish optional own
`valueType` only for checked actual text, including its array/nullability suffixes.
Synthetic record/parent inputs and unknown fields have no claim. Update copies
retain the claim while preserving partial/default-free semantics. Bool retains
its unique boolean wire kind without an added claim. Email/url/locale/timezone/
currency/date/user/member/secret and specialized arrays never acquire a text
claim from their collapsed string wire kind. The shared serializers keep actual
artifact and canApp operation descriptors aligned.

The State owner adds the two optional artifact contract properties. Compiler
work adds the corresponding `McpNamedField` type mirror in interfaces ports;
that additive type declaration does not activate consumer admission on its own.
Direct qualification: **2/2** operation_results, **2/2** typed_artifact and **6/6**
typed_descriptors pass, along with strict library Clippy and interfaces TypeScript
checking. The affected codegen run passed 116 checks; its older ExpenseFlow sum
expectation was updated for the now-required money tag and the single corrected
golden passes. Two handcrafted datetime witnesses now use valid constructor
strings and expect canonical wire metadata. The other passing checks were reused.
Runtime text/bool admission/execution qualification belongs to its consumer owner;
broader canonical references remain open, leaving completion at **48/67**.
