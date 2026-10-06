# Delivery/work library-adoption sequence — planning input

2026-10-06; read-only source and current primary documentation review. Proposed packet labels below are **not canonical task IDs**, assignments, changed statuses or implementation authorization. Native preparation and native-release remain HUMAN HOLD. Absolute source root: `/Users/vince/Projects/canlang/`.

## Status and task crosswalk to preserve

- `implementation/remaining-work/tasks.json:23320`, `:23456`, `:23606`: **ports:W04.1, W04.2, W04.3 are needs_verification**. Their source plans describe branch implementation/vectors ready for integrator registration, not assembled Cargo/ABI acceptance. Reuse the historically recorded standalone 242-test evidence only for its exact source and scope; changing formatters requires corrective/requalification evidence. Do not redispatch all completed history, or claim these open branches complete.
- `implementation/remaining-work/tasks.json:23756`: **ports:W04.4 not_started**. Current `packages/work-kernel/Cargo.toml:9` selects `rust/lib.rs`; `rust/lib.rs:6` exports only VERSION. Adding a dependency without registering the decision modules proves nothing about production decisions.
- LIB-02 maps by exact source paths to W04.1/W04.3. LIB-04 maps to shared delivery tasks and held P05.1, but file overlap does not make import-library adoption already accepted or authorize P work. LIB-05 has no exact original task match: add a bounded delivery extension with explicit ownership and acceptance, rather than fabricate an existing completed task.
- Preserve `C04.asset → C04.2 → C04.ready` and `W02.foundation + C04.asset → C04.graph`. C04.ready is the tiny actual loader proof, not the final work kernel. Requalify affected delivery inputs while crediting accepted package/build/cache/archive slices.
- Preserve `W04.1 + W04.2 + W04.3 + W03.4 → W04.4`; `W04.4 + W03.2 + C04.ready + C04.graph → W05.1`; `W05.1 → W05.2 → C04.work-assets → W05.4 → W05.3`. W05.4 also requires W05.2; C04.work-assets requires C04.graph/C04.ready. Source readiness cannot bypass these joins.
- Preserve `W06.2 → W06.runtimehandoff → V09.1 → W06.3` for `runtime/invoke.ts`. Library diagnostic changes should normally keep that file's public lookup interface stable; any required write needs an explicit lease consistent with this handoff.
- Preserve held `P05.2 → C04.preparation-join → P05.3 → P05.4`, and `P09.1 + C04.graph → C04.native-release`. No second Rust JS lexer, helper/native build or native-release work is proposed for immediate dispatch.

## Bounded packets, in useful order

### D0 — Pin compatibility witnesses and dependency requests

Owner: Codex preflight plus R3 delivery/work assembly, with disjoint leaf researchers. Begin before further handwritten replacements, but do not impose an all-package audit barrier. Freeze actual source/base hashes, credited evidence slices, unresolved gates, pinned candidate version/export/license/features, runner and target. Deliver separate exact requests for work Cargo and Cloudflare TS dependencies, including proposed runtime closure. Current work Cargo has no dependencies; Cloudflare has no direct lexer/MagicString/jridgewell dependency (`packages/cloudflare/package.json`). Upstream main/latest APIs are candidate evidence, not a verified installed release.

Acceptance: every request identifies exact files, owner, library entry point, expected changed bytes, independent witnesses and failure controls. No new app framework, shared Can core, callback authority or native preparation release. Number witnesses, import fixtures, and mapping fixtures can be prepared independently.

### WN1 — Qualify the ECMAScript number-text leaf

Attach as corrective/requalification scope under **W04.1/W04.3**, retaining their original dependencies: W04.1 needs W02.2/W03.1/C03.ready; W04.3 needs W02.4/W03.1/C03.ready. Lease separate files to leaf owners:

- `packages/work-kernel/decisions/rows.rs:231`, `receipt.rs:209`, `linkage.rs:210`, `recovery.rs:1253`.
- Existing direct witnesses: `decisions/rows.rs:6841` js_num_matches_v8; `:6873` json_escape_matches_v8. TS donor evidence: `conformance/rows.test.ts:223`, `receipt.test.ts:106`, `recovery.test.ts:97`, `linkage.test.ts:54`; immutable `conformance/fixtures/rows/` and `fixtures/receipts/{receipt,recovery,linkage}.json`.

Replace only number formatting with a work-owned thin adapter over ryu-js. A proposed shared adapter path must be assigned by the work integrator; avoid casually reaching into values internals or duplicating a formatting engine. Existing files describe standalone rustc/no-dependency testability (`rows.rs:5`): explicitly update the harness/registration contract when introducing a crate dependency, rather than claim old standalone commands still test the new code.

Acceptance: independent JS String(number) versus Rust on fixed boundaries and seeded f64 bits, including ±0, subnormals, ±1e20, fixed/scientific boundaries 1e-6/1e21, finite extremes, NaN and ±Infinity. Freeze exact diagnostic bytes; the source's integral i64 cast at rows.rs:245 and equivalent receipt/linkage casts must not saturate 1e20 into the wrong text. Preserve f64 transport bits, including -0. Keep JSON nonfinite→null separate from String-number NaN/Infinity; retain lossless UTF-16 escaping and Can policy/ordered faults. Existing TS tests alone do not execute Rust. Do not recapture old fixtures to conceal a mismatch.

### WN2 — Assemble and prove the actual crate

Integrate WN1 into **W04.4**, not a substitute gate. The designated work assembly owner alone changes `packages/work-kernel/Cargo.toml`, `Cargo.lock`, actual `rust/lib.rs` root and/or deliberately reconciled proposed `decisions/lib.rs`, plus `evidence/implementation/work-transitions/handoffs/native-conformance.json`. Resolve the existing-versus-planned crate root explicitly. All original W04.4 dependencies remain required; unchanged W04.2 still needs its branch review.

Acceptance: all decision modules and formatter actually compile under the selected root; the same immutable fixtures drive prepared TS and native outputs. Original locked Cargo test/fmt/clippy gates and host-authority import/features review apply. Wrong numeric messages must fail the differential harness. Assert no storage/network/time/RNG/security authority, UTF-16 loss, order change or materialization demand change. The library's no_std suitability does not certify this assembled crate or Wasm target.

### DI1 — Shared host-side import records and edit adapter

New finite R3 delivery extension related to **C04.asset/C04.graph**, with a small leased pure adapter (proposed path, e.g. `packages/cloudflare/src/deploy/module-imports.ts`) and fixtures. R3 joins its use in actual shared files:

- `packages/cloudflare/src/deploy/bundle.ts:373` regexes, `:381` collection, `:400` validation, `:425` artifact rewrite, `:454` runtime rewrite, `:498` vendor rewrite, `:906` link records, `:931` link checks.
- `packages/cloudflare/src/runtime/modules.ts:69`, `:77`, `:90`, `:106`; this module is Node-side staging despite its directory name.
- Existing tests: `test/modules.test.ts:63,96,107`; `test/deploy-bundle.test.ts:224,302,314,332,373,488,503,665,676,702`.

Normalize selected es-module-lexer records into a stable Can adapter and edit original UTF-16 spans with MagicString. Keep the public sync `buildDeployBundle` at bundle.ts:972: choose and qualify a compatible synchronous host entry or explicit preinitialized design. Current upstream offers JS/asm.js exports, but selected-version availability and startup must be checked. Do not accidentally ship host lexer/Wasmtime-style compilation into workerd. Preserve current approved producer/path rules and deterministic module/key/hash behavior, while documenting corrected false matches and newly detected imports as explicit behavior changes.

Acceptance: comments, regex literals, escaped specifiers, multiline/brace/star reexports, literal dynamic imports with attributes, nested template substitutions, non-BMP prefixes, quote preservation, same-line length-changing edits, and multiple invalid imports. Old collection groups from/import()/side-effect forms rather than pure lexical order: consciously freeze the intended first-fault order. Separate import.meta, literal, computed and glob imports; a truthy specifier must not silently admit current full-build glob records. Preserve no-partial-files validation in modules.ts:163–166. Lexer is not complete JS validation or free-variable/CJS analysis.

Retain the existing CJS/loadability guard initially (`bundle.ts:724,798,839`; tests at `deploy-bundle.test.ts:722–742`) unless a separate justified parser scope replaces it. es-module-lexer does not prove require/module.exports/free exports absence. Bun producer bundling/catalog derivation remain their current owned mechanisms.

### DM1 — Strict source-map decode and lookup adapter

New finite scope for LIB-05, no exact existing port task. Can proceed independently of DI1 on a lease of `packages/cloudflare/src/runtime/sourcemap.ts:52,62,88,146` and `test/sourcemap.test.ts:80–122`. Preserve exported DecodedSegment/MappedPosition/lookup shapes so invoke's consumer at `runtime/invoke.ts:280` need not change.

Use sourcemap-codec and trace-mapping behind Can compatibility guards. Acceptance: current malformed-character, truncated-value, empty-segment and 1/4/5-field rejection; empty mapping behavior; generated input integer/range rules; GLB lookup; unmapped one-field segments; raw sources/names; optional invalid name behavior; duplicate columns and unsorted segments; mutable input maps and any cache invalidation. Current decoder uses bitwise accumulation and does **not** explicitly reject arithmetic overflow, negative accumulated coordinates or unsorted data. Those stronger rules need a documented policy/witness, not a false claim of preserved existing guards. Library decoding alone does not enforce current malformed-input rejection. Maintain error prefix and actual exposed failure bytes. If a thin admission guard becomes a second full VLQ decoder, stop and compare maintenance benefit before proceeding.

Use raw source-table identity rather than accidentally resolving/normalizing URLs/sourceRoot into different diagnostic names. Trace library sorting/duplicate selection must not silently change Can lookup. Tests `test/sourcemap.test.ts:127,152,168,186,216,233` preserve real invocation mapping and message-only recovery. Invalid optional name index currently omits name rather than forcing null; source index failure returns null.

### DM2 — Compose edit maps through original .can maps

Depends on DI1's accepted edit-map contract and DM1's accepted consumer rules, not on W04.4. Exact R3 integration sites: `runtime/modules.ts:180–183` currently writes rewritten JS and original map; `deploy/bundle.ts:555–556` stages rewritten JS; `:997` renders deployment metadata from the original artifact; `dev/local-run.ts:44,70` appends supplied inline maps. Add MagicString-generated transform maps and remapping composition at host staging.

Acceptance: a length-changing import rewrite before a throwing expression on the same line still points to the original .can line/column in staged Node, local workerd and deployed workerd. Cover multiple edit stages, no-edit byte parity, names/sourcesContent, sourceRoot/URL rules, missing/malformed maps and sourcemapping comments. Repeated builds must produce deterministic output without temporary absolute paths. Preserve authored-source disclosure policy rather than automatically enabling includeContent.

Critical consumer trap: writing a composed `.map` file alone is insufficient. invoke's fallback uses `mod.map` from artifact metadata at invoke.ts:280. Define how the **derived staged diagnostic view** receives composed maps through existing delivery contracts, without silently mutating original compiled-artifact identity/hash/verdict inputs. Both runtime-remapped and Can-fallback diagnostics must consume maps for the actual rewritten JS. Any unavoidable invoke.ts write is separately leased around W06.runtimehandoff, not claimed safe merely because this packet concerns diagnostics.

### DJ1 — Qualify changed TS delivery closure and release evidence

R3 serial integration after DI1/DM1/DM2 and focused manifest requests. Exact existing runtime inventory is `deploy/bundle.ts:122` PINNED_RUNTIME_FILES, including sourcemap.js. External runtime imports added by DM1 must be included in the actual shipped ESM graph through existing bundling/vendor/export mechanisms; installed node_modules on the development host do not resolve bare imports in a Worker map. Keep Node-only import/edit/composition tooling outside that runtime closure. Test missing dependency, forbidden Node builtin, dangling import and corrupt/incomplete asset controls.

Existing acceptance sites: `deploy-bundle.test.ts:121,171,206,302,398,424,445,488`; `sourcemap.test.ts:257`; original shared asset/loader/installed gates. Reuse accepted archive tooling and qualify the written artifact outside checkout. No fake reply/in-memory-only map or workspace leakage. Runtime source map external dependencies are JS resources, never textified binary assets.

Runner distinction: Cloudflare's test/* suites are Vitest and included by root `vitest.config.ts:11`; work conformance uses node:test and its package test:unit targets emitted dist/conformance files. Cloudflare test:runtime targets a different emitted **/*.test.js family. Freeze correct affected profiles and positive test counts; do not report a runner that skipped these witnesses. Commands above are future acceptance obligations; none ran in this review.

### WN3 — Continue original actual-work consumer chain

After WN2 and original prerequisites, retain W05.1 pinned Wasm toolchain/glue and one initialized synchronous instance; W05.2 exact hashes/import keys request; C04.work-assets fulfillment; W05.4 outside-checkout package and release manifest proof; W05.3 actual staged workerd success/failure/text-legacy tests. Select backend before evaluation; selected missing/corrupt/ABI/bootstrap errors fail visibly without fallback rerun. Formatter adoption does not close W05, W06 or measurement/adoption decisions.

## Parallelism and shared ownership

R3 remains sole global root/consumer manifest, lock, bundling/local-run/testkit/export/release writer; package-local native manifests remain with the designated work assembly owner. Queue small exact requests early, return accepted hash/export contracts promptly, and perform joins in short finite windows. Disjoint number leaf work, import adapter/fixtures, map adapter/fixtures, W03 facts/traces and W01 baseline evidence may advance as soon as **their own** prerequisites and leases release. No leaf edits bun.lock/global manifests to get ahead; no task waits for every unrelated library evaluation. Code can be drafted against the chosen adapter contract, but executable verification waits for the relevant dependency/assembly release and cannot be called complete in advance.

DI1 and DM1 can run in parallel; DM2 is their necessary serial join. Shared modules.ts/bundle.ts and sourcemap.test.ts edits need one writer or acknowledged transfer. DJ1 is the shared installed closure join. WN1 can run alongside this chain; WN2 still awaits W03.4 and all W04 branches. Avoid changing invoke.ts in these library leaves, or schedule its explicit handoff if required. Record effort as qualitative/uncertain until measured packet completion; library code removal is not evidence that compatibility and delivery proof are cheap.

## Primary documentation and evidence limits

- [ryu-js Buffer API](https://docs.rs/ryu-js/latest/ryu_js/struct.Buffer.html): use the actual formatting API with an explicit nonfinite policy; latest documentation does not certify the selected crate/target.
- [es-module-lexer maintainer README](https://raw.githubusercontent.com/guybedford/es-module-lexer/main/README.md): full/minimal record shapes and JS/Wasm exports differ; decoded literals, dynamic globs and lexer-validation limits require adapter tests.
- [MagicString maintainer README](https://raw.githubusercontent.com/Rich-Harris/magic-string/master/README.md): edits address the original string and generate transform maps; choose mapping resolution for required column accuracy.
- [trace-mapping maintainer README](https://raw.githubusercontent.com/jridgewell/sourcemaps/main/packages/trace-mapping/README.md), [codec VLQ source](https://raw.githubusercontent.com/jridgewell/sourcemaps/main/packages/sourcemap-codec/src/vlq.ts), [remapping maintainer README](https://raw.githubusercontent.com/jridgewell/sourcemaps/main/packages/remapping/README.md): verify selected decoder guards, lookup bias and newest-to-original composition order.

This planning input proposes finite deliverables/acceptance and reads source/status metadata. It proves neither library equivalence nor compiled modules, current installed closure, performance, complete gate acceptance or runtime execution. Preparation/native HOLD stays intact.
