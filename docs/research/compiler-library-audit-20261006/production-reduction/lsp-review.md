# Independent bounded LSP production-reduction review

Verdict: accept the bounded `compiler/src/lsp/output.rs` refactor. No blocking compatibility or implementation-reduction issue found. Reviewed against baseline `f889e44f`, the Pass 7 contract, current server callers, installed `lsp-types 0.97.0` schema/serde declarations, and existing independent process/IDE/admission witnesses. Historical acceptance and writer conclusions were not used as the oracle.

Frozen reviewed output SHA-256: `8b9a350c847dcc326007ca08108fc8a986cb5f0089b2438a22a8b04f33ee0a0b`.

## Actual reduction and ownership

The production prefix before `#[cfg(test)]` falls from 235 to 184 lines (217 to 166 nonblank lines), and 7,064 to 5,029 UTF-8 bytes. Line-sequence diff: 94 gross removed, 43 gross added, 51 net removed. The full output-file diff has those same gross counts; its inline test suffix is byte-identical to the baseline. This deletes three URI parse sites, four Standard/Compatible serializer enums, workspace-wide URI validation/zip/OneOf conversion, and the action dispatch between workspace branches. It adds one String-URI representation for each formerly split shape. There is no relocated production logic, packed-line formatting, test relocation, new serializer, or replacement escaping machinery.

This deliberately relinquishes complete library ownership of URI-bearing outer envelopes: Location, diagnostic publication params, versioned document identifiers, document/workspace edits, and the action edit projection now use small serde structs. It retains `lsp::Range`/Position, `lsp::Diagnostic`, `lsp::TextEdit`, and a flattened `lsp::CodeAction` base including typed kind and omission rules. The unchanged server still uses library initialization/capabilities, hover, completion, severity and numeric/string enums, semantic legend/constants. This is a narrower adoption claim than Pass 7's Standard-URI DTO row, and must be recorded as a superseding accepted decision rather than claimed to fulfill that historical full-DTO policy literally.

## Compatibility reasoning

- Every wire URI now moves/copies the original server String directly; there is no parse, canonicalization, rejection, filter or panic path. This covers Unicode, malformed percent escapes, empty and relative strings as well as ordinary URIs. Server admission, document lookup, backend URI routing and native/display URI conversion remain unchanged.
- Location field order remains uri/range. Range and Position still serialize through library types, preserving start/end and line/character order. Diagnostics remain uri/diagnostics/version and always construct Some(current version). Their lack of None omission differs from the library schema only for an unreachable constructor state; the private fields and sole constructor enforce Some.
- Document identifiers retain a required version field without serde skipping. Rename constructs Some(current i32), including negative values; closed code-action targets receive None and serialize explicit null. Workspace documentChanges and edits remain present, including an empty rename edit list.
- Action grouping remains the same vector-based first-seen grouping, preserves each file's edit order and evaluates the version callback once per distinct file in that order. Empty actions return before grouping/version calls and omit edit via Option::is_none. Nonempty actions always include the projected workspace edit.
- The flattened library CodeAction base is constructed with title/kind and Default for all other fields, including edit=None. Inspection of the library serde declarations confirms that this base emits no edit key; the outer Option supplies the only edit key. There is no duplicate-member or reordered currently emitted action field. Future construction that populates the base edit would need review, but current control flow cannot do that.
- Response RawValue ID construction, envelope member order, shared compact formatter and raw semantic-token vector are unchanged. Capabilities, absence of a live symbols endpoint, completion mappings and UTF-16 Source.LineIndex ownership remain outside this change.

## Verification and limits

Independently ran the unfiltered integration targets in the existing target directory with `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_NET_OFFLINE=true`:

```text
cargo test --locked --manifest-path compiler/Cargo.toml --test lsp_typed_output --test lsp_admission --test ide
```

All 62 tests passed: 4 real-process typed-output witnesses, 26 admission/lifecycle/framing witnesses and 32 IDE/server witnesses. The process suite exercises CRLF/supplementary UTF-16, every released output family, version 7→8, percent-case-distinct identities, non-file/remote URIs, Unicode/bad-percent identities, edit routing and publication. Existing unchanged inline output tests additionally specify empty/relative URI projections, multi-file first-seen edits, closed-target null, empty action omission/rename edits, raw numeric ID spelling, controls and incomplete semantic vectors; they were source-inspected in this review, not independently rerun here.

The worktree already contained concurrent dirty `compiler/src/analysis/resolve.rs`, `compiler/tests/analysis.rs`, and `compiler/tests/lsp_typed_output.rs`. They were preserved, not attributed to this output refactor. Verification pins 98 files spanning all compiler Rust source/tests/build script, Cargo manifests/lock, shipped completion files and editor source fixtures/consumer. Before/after SHA-256 pins found zero changed inputs during execution. The passing result qualifies the pinned current worktree, not a clean-baseline run or isolated causal attribution to output.rs. Log and machine-readable result: [verification/test.log](verification/test.log), [verification/results.json](verification/results.json), [before pins](verification/inputs-before.json), [after pins](verification/inputs-after.json).

Native macOS checks only; no new Windows, external backend or broad capability-negotiation qualification. No package/manifests/Git mutations performed by this reviewer. Formatting/Clippy and final integration receipt remain root-owned.
