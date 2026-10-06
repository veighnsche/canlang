# Value contracts and caller closure

Preparation date: 2026-10-07. Local packets C03U/C03L are compiler packet labels, not canonical product task statuses. [Input pins](evidence/root/input-manifest.json) record the compiler, catalog, owning source and current built public exports; [export results](evidence/values/export-results.json) execute those exports on Node 24.21.0 / ICU 78.3. These are workspace outputs, not a clean package rebuild or installed tarball qualification.

## URL ownership and live paths

`analysis/types.rs::validated_shape:15368` selects `valid_url:15433`. Two live type routes reach it: contextual string literals in `type_literal:9962–9973`, and literal inhabitation/overload trials in `inhabit_validated:14345–14368`. The same value rule therefore affects field defaults and literal arguments; repair both outcomes and their source anchors. `strip_scheme:15485` is the unsafe prefix helper. Stable rejection uses E3001 through the defining checker path; no new URL-specific diagnostic allocation is needed.

The owning language table is [DESIGN §3](../../../specification/DESIGN.md); the actual wire contract is `packages/values/src/wire.ts::isHttpUrl:479`, `decodeStringlike:491` and the URL encode branch. `decodeValue`/`encodeValue` are exported by the package root. Ordinary URL values are HTTP(S) strings accepted by the host parser and retained verbatim. Credentials, case, parser-accepted backslashes, surrounding whitespace and a space in the path are accepted by the observed owner; treating every such string as a trusted origin would preserve compiler/runtime disagreement.

`packages/values/src/stdlib-pure.ts::parseTrustedOrigin:210` is separate. `app_url:252` calls it after checking the app-relative path. Trusted origins reject credentials and query/fragment, and canonicalize origin/mount prefix for construction. The public API probe exercises the actual `app_url`; this packet changes ordinary value validation, not deployment-origin or path authority policy.

[28 combined URL/locale/origin vectors](witnesses/values.json) have independently authored expectations. All public owner observations match them. Selected compiler failures remain demonstrated by the earlier probes: emoji panic, malformed bracket/port admission and credential rejection. Rust `url` is a proposed parser adapter; full vector parity, feature/version selection and Linux/macOS release closure are implementation qualifications. The compiler retains authored URL strings after admission. URI display/filesystem conversion belongs to C07URI, not C03U.

**C03U contract ready:** existing owner policy, E3001/source span retention and no panics are specified. **Library still unqualified:** no Rust dependency is added or proved equivalent here. A narrowly bounded Unicode panic repair may release while parser qualification proceeds.

## Locale ownership and live paths

`valid_locale:15495` is reached through validated scalar literals as above; directly through message variants (`check_message_value:4406`), explicit context defaults (`phase2_context:5672`) and app/package source attributes (`phase2_owner_attrs:5720`). `collect_module_sources:4909` collects source tags. Quoted tags use `string_literal_value:7769` or `string_leaf_value:7780`. `check_message_value:4414` currently compares lowercase spellings for repeats/duplicates, not full runtime canonical aliases.

Owning APIs are `locale.ts::canonicalLocale:16`, wire locale decode/encode, `icu.ts::makeMessageDescriptor:136` and `locale.ts::resolveVariant:69`. The constructor canonicalizes variant keys and rejects duplicates after canonicalization; locale selection/fallback stays with its owner. Invalid scalar literals use E3001; invalid/repeated message variant tags use E3016. Preserve the checker distinction and source location when changing admission.

The public probe confirms valid extension/private-use tags, invalid duplicate regions/variants, `EN-us → en-US`, `iw → he`, and duplicate canonical message keys. Lowercasing alone cannot identify `iw` and `he` as the same tag. This is known owner behavior; the compiler's complete alias/data policy and the Rust candidate's equivalence remain unqualified. No new alias table is invented here.

**C03L ready:** owner-derived admission/canonicalization vectors and stable diagnostic categories. **C03L gated:** qualify full `icu_locale_core::Locale` versus ECMA-402 admission and the pinned host's aliases; settle compile-time canonical identity for source/variant comparisons. A locale syntax parser is not a full localization runtime. Direct private values-core linkage remains deferred by L-F03.

Existing nearby acceptance: `compiler/tests/analysis.rs::fixture_mime_and_quoted_locale_keys`, `compiler/tests/b4_check.rs` descriptor locale negatives, `packages/values/test/locale.test.ts` canonical duplicate/fallback checks, and the values wire tests. These do not constitute complete Rust candidate acceptance and were not rerun here.

## Exact scalar serialization witness

Public `decodeValue`/`encodeValue` also checked int64 maximum, a large decimal with scale 4, duration and money minor units. Decimal decoding retains coefficient `123456789012345678901200` and scale 4; re-encoding yields `12345678901234567890.12`. Compiler literal transport must retain authored spelling long enough for the owning decoder to construct the intended scale. Canonical runtime wire encoding is a different boundary. No JSON number, JavaScript Number or i64 intermediary may silently replace these exact values.

The defining contracts are `codegen/js.rs::literal_json:428`, `packages/values/src/wire.ts:13–25`, and `decimal.ts::Decimal:64`. C05 output substitutions preserve this distinction; they do not close the separately open FP.COMPILED-DECIMAL arithmetic/lowering duty.
