# Docs compatibility support: RETAIN (bounded ARCH-02)

Decision submitted for root's independent review: retain the current public docs views. This resolves `integration:docs-legacy-views` under the frozen retain-public-support policy; it does not close the other ARCH-02 owners. No production/API/package/Git/shared decision document was edited. Root owns acceptance and shared decision/ledger reconciliation.

## Exact surface and mechanism

`inventory.py` mechanically enumerates the thirteen inherent public `to_json(&self) -> Json` methods in `compiler/src/docs.rs`, pins the scoped source/manifest/contract/consumer/test evidence with SHA-256, and saves the bounded caller search. Run `python3 implementation/compiler-completion/docs-support/inventory.py` from any directory. `inventory.json` contains exact source ranges; the bodies are 3 physical lines each (39), plus private `reference_json` at 1116–1120 (5): **44** total targeted body lines. Comments, surrounding impls and the necessary typed schema are outside that body target. One serialization→parse site serves all thirteen views.

| Public owner | Method range | Existing direct control |
| --- | --- | --- |
| ReferenceModel | 1132–1134 | typed_references empty/populated wire goldens |
| ReferenceOwner | 1139–1141 | typed_references populated adapter parity |
| ReferenceDeclaration | 1146–1148 | typed_references populated parity + contract golden |
| ReferenceField | 1153–1155 | typed_references default access + optional-description golden |
| ReferenceOperationInput | 1160–1162 | typed_references optional-description golden |
| ReferenceOperationResult | 1167–1169 | typed_references optional-description golden |
| ReferenceOperation | 1177–1179 | typed_references optional-description golden |
| ReferenceExample | 1184–1186 | typed_references expected-value access |
| ReferenceDescriptionValue | 1191–1193 | nested populated/description goldens; no distinct direct leaf call |
| ReferenceDescriptionVariant | 1198–1200 | nested null/empty-text goldens; no distinct direct leaf call |
| ReferenceConstraint | 1205–1207 | nested populated detail golden; no distinct direct leaf call |
| ReferenceSourceLocation | 1212–1214 | nested populated/location goldens; no distinct direct leaf call |
| ReferenceAvailability | 1219–1221 | docs::available_shape_conforms_when_constructed explicit ordered Json |

All thirteen call only `reference_json(self)`; that helper calls `json::to_compact_string` then `json::parse`. They are production-compiled public support, exported through `lib.rs::pub mod docs`; unknown external Rust users remain support obligations. The scoped current callers found in repository code are tests; this does not authorize retirement. Four leaf methods lack separate direct invocation controls, but exercise the same helper as the directly called methods and their typed schemas are guarded in nested independent output strings. No fresh mirrored tests were added.

The actual existing typed-output owner is `json.rs::to_compact_string` → `to_string_with_formatter` → serde_json's serializer with `CanCompactFormatter`/`write_compatible_escape`. Docs already reuse it, through both the bridge and `ReferenceModel::to_json_string` (1127–1129). Closed typed structs/enum own camelCase/order/null/omission via serde derives and attributes. `ReferenceDeclarationKind::as_str` is an extraction sorting helper, not a fourteenth public Json view.

## Shipped path, first failures and consumers

Production dispatch's docs arm → `run_docs` → `run_docs_with_platform`: refuse invalid/overwrite output before reading (E7001); input read failure E7002; analyze_owned/finish and analysis errors before extraction, spawn or writes; absent checked program E7001. Successful extraction → **to_json_string**, never the thirteen Json views → locate_platform_bin → render_via_platform → renderer Markdown → optional atomic write (E7007). Spawn/pipe/wait/nonzero/non-UTF8/empty renderer output failures remain E7004; panics are caught by main as E7005. Nothing in this decision changes that evaluation order or failure policy.

`packages/cloudflare/src/cli/platform.ts` routes the docs command to `docs.ts::runDocs`: cap/read stdin → parseReferenceInput (empty/invalid JSON failure) → loadRenderer (missing import/export failure) → public `@canlang/interfaces` renderReferenceMarkdown (invalid-model failure) → stdout. `packages/interfaces/src/index.ts` exports `docs/reference.ts`, whose renderer validates ReferenceModel v1 (`packages/contracts/src/reference.ts`) and delegates locale variant resolution to the existing `@canlang/values` resolver. It does not consume Rust Json compatibility trees. Packages are named first-consumer boundaries, not a new whole-package audit.

Compatibility view output preserves ordered members, raw integer spellings, strings, explicit null and omitted optionals. Serialization is attempted before parsing; existing expects remain `closed reference JSON value must serialize` then `serialized reference JSON must parse`. The model string adapter has its own `closed reference JSON model must serialize` message. Public carriers are constructible; invariant panic behavior is not converted to null/empty fallback. The target's parse bridge retains existing parser/depth behavior; a new direct generic Json serializer would need to qualify that behavior rather than silently bypass it.

## Same-outcome comparison and complete threshold

| Alternative | Public/output/failure obligations | Complete closure and target result |
| --- | --- | --- |
| Retain (selected) | Preserve thirteen inherent methods and typed/ordered output, existing panic/CLI first-failure policy | 39 wrapper + 5 bridge lines remain; helper/import/adapters added=0; deleted=0; **net 0**; thirteen entrypoints and one bridge site remain. No reduction claimed. |
| Move a compatibility bridge into shared JSON owner | Preserve thirteen methods, serde-derived shape, serialize-before-parse and failure text | Concrete like-for-like proposal deletes5 here and adds5 in json.rs; callers must redirect paths/imports and existing bridges are not Json-returning equivalents. Wrapper39 remain. Even granting zero path/import overhead, **net0**, not44; one roundtrip still remains. Moving owner does not retire support/mechanism. |
| Replace bridge with direct typed→Json serializer | Must retain thirteen inherent methods and match ordered tree/raw values plus first-error/depth/panic policy | Only5 target lines could be displaced while wrapper39 remain; all serializer callbacks/error/depth/adapters/imports would count as added production. Even an impossible zero-line replacement saves at most5 body lines, below44. Existing text serializer does not supply this tree API; no new serializer is implemented or qualified. |
| Remove thirteen views and bridge | Typed CLI path could remain byte-identical | Deletes44 target lines before surrounding/import cleanup, but removes thirteen supported public entrypoints and test consumers. Fails frozen public support gate; no qualified saving. |

The conditional target retires **thirteen entrypoints plus the bridge** and saves44 net production lines across the complete replacement closure, not merely docs.rs. A macro or minified wrapper can reduce physical text without retiring those supported entrypoints; it does not satisfy this mechanism target. Broader serde schema deletion would remove the live typed docs owner and is outside the candidate. No alternative qualifies; **RETAIN is resolved**, not an indefinite support-policy defer. No independently justified smaller correctness issue was found.

## Validation and limits

Commands/logs are local evidence, not a matched release freeze while other writers work. Existing tests are reused:

- `cargo test --manifest-path compiler/Cargo.toml --test typed_references --test docs --test typed_reference_policy_consumers -- --nocapture`: exit0; docs30 + typed wire3 + consumer2 passed. Both consumer bodies emitted their PASS marker; actual docs CLI/extracted typed JSON entered the built public Markdown renderer (Node and built-package prerequisites executed, no skip). The other consumer is policy and is not credited as docs qualification.
- `cargo test --manifest-path compiler/Cargo.toml --lib cli::tests -- --nocapture`: exit101 before tests: concurrent Typer source work produced E0308/E0599 compile errors (raw stderr retained). No CLI-module tests are credited to this attempt. The existing module is bounded docs wiring; its hermetic scripts are orchestration/error-ordering controls rather than actual-renderer oracles. Root can rerun after the concurrent source settles.

Independent expected strings qualify omission/null/order/escaping/default spellings; owner/declaration serialize→parse equality is adapter parity, not an independent language oracle. Thirty docs extraction tests qualify checked-source fields/examples/locale/path/determinism. The actual renderer consumer qualifies bounded Markdown locale/default/null/presence behavior; no full original application, installed CLI, browser/editor, every malformed platform input, every external Rust consumer, other target/host, performance, or universal runtime claim follows. No full suite, framework, package changes, model pricing or JEV consultation was needed for this frozen retain decision.


Root follow-up: after the selected-call owner held a stable compile gate, the same narrow CLI module filter passes18/18. `root-cli-receipt.json` records the command/raw hash. The initial transient-source build failure remains; the independent retention review is still separate.
