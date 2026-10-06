# Pass 2: strict LSP byte and envelope admission

**C02 completed within the frozen byte/envelope contract, October 7, 2026.** Complete frames are decoded strictly as UTF-8; malformed bytes/JSON cannot initialize the real server. The existing JSON parser remains. Supported envelopes now validate version, method, reserved duplicates, ID kind/range and parameter category before dispatch. Mandatory supported method fields validate before state mutation. No dependency, package, editor production source or framing implementation changed.

The independent byte repair was checked and committed early as `bf4b0ca`. The completion commit contains envelope admission, corrected compiler fixtures, permanent process witnesses, accepted policy decisions and this receipt. [Contract and compatibility matrix](contract.md), [verification](verification.json), [witness transfer](witness-transfer.json), and [three JEV consultations](consultation/assessment.md) make its exit finite and reviewable. Pass 0 stays historical; the shared JSON and transport-framework packets remain independently gated.

## Changes and owning consumers

`compiler/src/lsp/transport.rs` retains the existing frame reader/writer and response builders. Its single-production-caller `parse_call` now returns either an admitted call or an error carrying safe correlation. Calls retain `params: Option<Json>`; omission no longer collapses to explicit null. Decoded duplicate `jsonrpc/id/method/params` keys are rejected locally. Unknown extension duplicates and shared first-match lookup remain unchanged.

The LSP-owned exact integer helper admits mathematical integral values in signed-32 range without float rounding or powers/allocation proportional to exponent magnitude. Raw numeric `Json::Num` values are cloned for responses, preserving `-0`, integral fractions and exponent spelling. String IDs preserve decoded value rather than original JSON escape bytes. Shared `Json::as_i64` remains lexical and unchanged.

`compiler/src/lsp/server.rs` strictly decodes framed bodies, maps malformed UTF-8/JSON to one null-ID `-32700` error, and maps invalid envelopes to `-32600` with only a unique admitted ID. Explicit null IDs are invalid requests, distinct from absent-ID notifications. Method validation retains unknown capabilities/extensions and validates required fields and consumed types for the supported methods. It does not implement every ignored optional client schema or diagnostic element schema.

Initialize validates processId/rootUri/capabilities before entering Ready. Requests retain lifecycle-before-method error precedence; valid notifications remain silent, including method errors. Document notifications before initialization and after shutdown are dropped. Shutdown/exit retain omitted/null/empty-object compatibility for actual editor and Rust callers. Malformed mandatory document versions no longer fall back or clamp into accepted updates; admitted version ordering, identical-source reuse, last full snapshot selection, stale diagnostic cancellation and the existing incremental-only limitation remain unchanged.

Caller audit covers the actual VS Code client/providers and capability process probe, the Rust process driver, in-process server/authoring/IDE consumers, and CLI tests. The production editor already supplies mandatory fields. Compiler fixtures now supply required initialize fields, didOpen languageId and references/code-action contexts; no semantic expectations or authored Can fixtures are weakened to accept the repair. The JSON caller closure, supported host, input hashes and compatibility classes are explicit in the linked contract.

## Permanent outcomes and independent evidence

`compiler/tests/lsp_admission.rs` drives the **real `can lsp` executable** with finite byte transcripts, concurrent pipes, a 10-second deadline, capped capture, and timeout kill/reap cleanup. Its 23 tests cover:

- Six malformed UTF-8 classes and malformed JSON, with a successful following initialize proving rejected bytes do not initialize and their frame remains aligned.
- Legal decoded string IDs, signed range boundaries, raw `-0`, integral decimal/exponent spellings, huge-exponent zero, and precision/underflow/range rejection. Illegal/null IDs use null correlation; no illegal ID is echoed.
- Wrong/missing versions and methods, primitive params, scalar/array messages, decoded reserved duplicates, safe correlation, absent-ID versus explicit-null behavior and unknown extensions.
- Required initialize fields and failed-initialize recovery; request errors versus silent method-invalid notifications; preinit/Ready/shutdown precedence; shutdown/exit parameter compatibility, malformed-state nonmutation and EOF/torn-disconnect outcomes.
- Malformed document open/change nonmutation, missing context/newName, coordinate bounds, valid required contexts, and notification suppression outside Ready. Direct server unit assertions additionally pin unchanged document source/version/queue state.

Expected codes, identifier lexemes and outcomes are independently fixed in tests. Process output uses the retained parser/framer as a decoder, so the separate [numeric oracle](numeric-oracle.py) uses **Python Decimal/Fraction exact arithmetic and raw response ID bytes**. It passed **656 cases: 145 admitted, 511 rejected**, through the final binary with no stderr; [result and binary hash](numeric-oracle.json). Permanent tests separately cover huge exponents. The oracle avoids reusing the Rust scan/scale algorithm and never converts numeric IDs to floating point.

The unchanged actual editor capability probe passed every advertised provider against the fresh binary, including its null shutdown/exit parameters; [raw log](editor-capabilities.log). This qualifies the existing Node stdio probe, not a launched VS Code UI session.

[Witness transfer](witness-transfer.json) accounts for all 44 saved Pass 0 LSP/JSON cases: **29 C02 outcomes promoted**, two framing gates still deferred, and 13 shared JSON cases left for C06. Transfers sometimes use stronger input families rather than verbatim saved probe bodies. Bare-LF compatibility and cap+1 rejection are permanent framing unit witnesses. The exact-cap witness proves header admission through a truncated body; it does not claim a complete 64 MiB exchange.

## Checks and limits

- Initial focused LSP units: **23 passed**. Affected authoring/IDE/CLI/process suites: **102 passed**; [logs](affected-suite.log).
- Full locked compiler suite: **945 passed, zero failures**; [raw log](full-suite.log). This snapshot precedes an equivalent Clippy conditional flatten and final bare-LF/additional edge witnesses.
- Final complete library plus real-process admission suites: **97 + 23 = 120 passed**; [raw log](final-lsp.log).
- Final Clippy across all targets with warnings as errors: **passed**; [log](clippy.log). `git diff --check`: **passed**.
- `cargo fmt --check` reports **88 pre-existing hunks**. A fresh `bf4b0ca` baseline has exactly the same normalized differences, with no new or removed hunks; [comparison](fmt-comparison.json). Only changed regions were formatted. Saved logs trim trailing spaces and terminal blank lines; result and diagnostic text is unchanged.

[Baseline](baseline-input-manifest.json) and [final](input-manifest.json) pin compiler, catalog, package manifests/lock, built runtime and inspected editor/probe inputs. The working compiler hashes define the execution snapshot; concurrent planning commits can change build revision metadata without changing these source bytes. No package input drift was observed. Local execution qualifies **macOS arm64, Rust 1.99.0, Node 24.21.0**; Linux/Windows behavior is not newly qualified.

Header charset handling, duplicate/conflicting Content-Length, digit/ASCII rules, header budgets and recovery remain explicitly classified in the contract. In particular, ignored unsupported Content-Type charset is a known separate conformance gap, and current malformed-framing continuation is not represented as safe resynchronization. The inclusive 64 MiB body bound, existing LF extension, JSON depth and clean/torn disconnect behavior are preserved. Typed LSP output, transport framework, complete optional schemas and URI policy remain later work.

## Delegation, decisions and replay

Admission implementation, transport/process witnesses and independent review used **GPT-6.1 Sol medium**, following the researched Pass 2 allocation. **Sol high** was confined to unresolved protocol decisions and investigation of split JEV advice. A Sol-low mechanical-fixture dispatch and attempted worker reuse were rejected by the thread limit; fixture integration stayed with the coordinator. No Astra worker or measured cost-saving claim is made.

Three preauthorized JEV requests agree on five policy gates. Numeric spelling and primitive params split 2–1 with low confidence; primary-spec investigation and remaining uncertainty are recorded in the assessment and DECISIONS.md. Advice selected no dependency API and supplies no test proof. Independent Sol-medium review found no contract violations and proposed uppercase/plus/huge-negative-exponent vectors, now included. Clippy's nested-if finding was corrected without changing admission semantics.

Replay from the repository root:

```sh
cargo test --locked --manifest-path compiler/Cargo.toml --lib --test lsp_admission
cargo test --locked --manifest-path compiler/Cargo.toml
cargo clippy --locked --manifest-path compiler/Cargo.toml --all-targets -- -D warnings
CAN_BIN=/absolute/path/to/fresh/can node editors/vscode/test/lsp-capabilities.cjs
python3 docs/research/compiler-library-audit-20261006/pass2/numeric-oracle.py /absolute/path/to/fresh/can --output /private/tmp/c02-numeric.json
```

The completion is compiler-scoped. No merge occurred, no unrelated package/planning edits are included, and the living file-tree checkpoint is not advanced.
