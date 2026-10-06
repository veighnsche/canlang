# P01/P02 work and delivery source interpretation

Read-only planning at HEAD d855e0a6a222d89d6a3deab03141a29654a585f9 (2026-10-07). No product commands, installs, builds, tests, edits, dispatch or Git mutations. Existing dirty compiler/planning files were preserved. Model: Sol medium for bounded evidence interpretation. Static source presence is not independent acceptance.

## Current source and original status

- Cargo.toml selects work-kernel/rust/lib.rs, whose sole implementation is WORK_KERNEL_VERSION. All seven decisions/*.rs exist but are not registered; decisions/lib.rs does not exist. Cargo dependencies/features are absent. build:wasm merely builds that crate; no wasm-bindgen generation, backend.ts, wasm.rs or loader.ts exists. No current @canlang/work-kernel import found in work/state/cloudflare src. W02 foundation is therefore not assembled work decisions.
- Four work formatting leaves rows.rs:246, receipt.rs:224, linkage.rs:225, recovery.rs:1255 cast integral f64 to i64, creating saturation risk for 1e20. Preserve JSON nonfinite/null separately and carrier/reference semantics. N03 can prepare contracts independently; implementing/reviewing W04 leaves still needs W03.1 accepted facts contract. N06 must change actual Cargo root or explicit path registration, not merely add an unused decisions/lib.rs.
- W03.1 validateVersions/validateCount and W03.2 host-values exist without real production callback/provenance/lifecycle qualification; W03.4 prepared producer/demand/trace join is absent. Source fixes are narrower than W04 or W05 acceptance.
- Current receipt producer has changed from historical work-loader evidence: packages/state/src/receipt/observer-loader.ts dynamically imports intentionally absent ./observer.js; current deploy header explicitly requires injected/worker-safe observer. Former state/{receipt,fanout}/work-loader.ts do not exist although bundle exclusions/comments retain their names. Do not describe historical Node-memory serving bridge as an actual current supported packaged consumer. This is provenance drift, not a new acceptance result.
- C03.ready is pinned toolchain/transport spike scope. C04.asset/1/2 accepted typed binary/smoke mechanisms do not prove kernel ABI, binding generation, installed source or active consumer. C04.ready remains needs_verification and C04.graph partial. C04.preparation-join retains complete producer-export scope despite held/unverified P05.2 dependency: do not reset credited status or infer acceptance of the full held preparation job.

### Unchanged ledger/DAG snapshot

- ports:V09.1: not_started; prerequisites ports:V01.3, ports:V03.3, ports:V02.4, ports:W06.runtimehandoff.
- ports:C04.asset: complete; prerequisites ports:C03.ready.
- ports:C04.1: complete; prerequisites ports:C03.ready.
- ports:C04.2: complete; prerequisites ports:C04.asset, ports:C04.1.
- ports:C04.ready: needs_verification; prerequisites ports:C04.2.
- ports:C04.graph: partial; prerequisites ports:W02.foundation, ports:C04.asset.
- ports:C04.values-assets: partial; prerequisites ports:A07.foundation, ports:C04.graph, ports:C04.ready.
- ports:C04.work-assets: not_started; prerequisites ports:W05.2, ports:C04.graph, ports:C04.ready.
- ports:C04.preparation-join: complete; prerequisites ports:P05.2, ports:C04.asset.
- ports:C04.native-release: held; prerequisites ports:P09.1, ports:C04.graph.
- ports:C04.validation-join: not_started; prerequisites ports:V08.3, ports:C04.values-assets.
- ports:C04.complete: partial; prerequisites ports:C04.ready, ports:C04.graph, ports:C04.values-assets, ports:C04.work-assets, ports:C04.preparation-join, ports:C04.native-release, ports:C04.validation-join, ports:A08, ports:V11, ports:W05, ports:P09, ports:P05.mixed.
- ports:W04.1: needs_verification; prerequisites ports:W02.2, ports:W03.1, ports:C03.ready.
- ports:W04.2: needs_verification; prerequisites ports:W02.3, ports:W03.1, ports:C03.ready.
- ports:W04.3: needs_verification; prerequisites ports:W02.4, ports:W03.1, ports:C03.ready.
- ports:W04.4: not_started; prerequisites ports:W04.1, ports:W04.2, ports:W04.3, ports:W03.4.
- ports:W05.1: not_started; prerequisites ports:W04.4, ports:W03.2, ports:C04.ready, ports:C04.graph.
- ports:W05.2: not_started; prerequisites ports:W05.1.
- ports:W05.3: not_started; prerequisites ports:W05.4, ports:C04.ready.
- ports:W06.1: not_started; prerequisites ports:W05.3, ports:W02.5, ports:W03.4.
- ports:W06.2: not_started; prerequisites ports:W06.1.
- ports:W06.runtimehandoff: not_started; prerequisites ports:W06.2.
- ports:W06.3: not_started; prerequisites ports:W06.runtimehandoff, ports:W05.3, ports:V09.1.
- ports:W05.4: not_started; prerequisites ports:W05.2, ports:C04.work-assets.

Preserve W04.1+2+3+W03.4 → W04.4; W05.1 → W05.2 → C04.work-assets → W05.4 → W05.3; W06.2 → W06.runtimehandoff → V09.1 → W06.3, plus every listed additional prerequisite. invoke.ts is not an opportunistic shared writer lease. P05.2 → C04.preparation-join → P05.3 → P05.4 and P09.1+C04.graph → C04.native-release remain HUMAN HOLD. No D05 proposal releases P source, CLI, helpers or native release.

## Delivery source/callers

- modules.ts assembleModules rewrites imports but writes original mod.map (lines 175–183). deploy/bundle.ts has distinct artifact/runtime/vendor rewriting and ordered refusal/link/loadability guards; buildDeployBundle is synchronous. D02 must cover all selected scanner uses rather than only artifact imports. Pure new import adapter can be disjoint from map adapter; modules.ts and bundle.ts are one integrator’s serialized files.
- sourcemap.ts lookup decodes on each call, chooses greatest preceding segment in stored order, returns raw sources entry, omits invalid optional name while keeping location. No cache currently exists: proposed cache must account for mutable map objects. sourceRoot is absent from public SourceMap shape; library defaults must not normalize raw path/URL source identities. Overflow/negative/unsorted rules need explicit contract decisions, not claims they were guarded.
- invoke.ts:280 uses original mod.map fallback. Composing a .map file alone cannot qualify changed-length import diagnostics. D04 requires a derived staged diagnostic view fed to fallback plus runtime mapping; avoid invoke edit where existing contract permits, otherwise explicit W06 writer handoff and retained V09 dependency.
- PINNED_RUNTIME_FILES includes sourcemap.js but excludes Node modules.ts and deployment tooling. Host lexer/edit-map/composition closure is separate from Worker map decoder closure. Root/consumer manifests, bun.lock, vendor rewrites/inventory, distribution declarations, release manifest/stamp, local-run/testkit belong to R3 global writer. Existing asset mechanism reused only at exact proven scope.

## Finite selected candidate packets (proposal only, no active lease)

| Packet | Exact future owned files | Readiness and exclusions |
|---|---|---|
| Work N01 contract | work-kernel/conformance/numeric-text.contract.test.ts (new), conformance/fixtures/numeric-text.json (new), private evidence | Ready for read-only contract preparation after P02; immutable JS oracle/10k seeded patterns/boundaries, no current canonical status closure. |
| Work N03 adapter | work-kernel/decisions/{rows,receipt,linkage,recovery}.rs; decisions/numeric_text.rs (new); conformance/numeric-text.contract.test.ts by transfer | After released N01 work contract and original W04 prerequisites; package-local Cargo/lock/root request to R3, no values internal dependency; reconcile standalone rustc harness before added Cargo library. |
| Delivery D01 contracts | cloudflare/src/runtime/import-records.contract.test.ts (new); runtime/sourcemap.contract.test.ts (new); private fixtures/evidence | Independently freeze import and map profiles, sync entry, UTF-16, first fault grouping/raw identity. Tests may be authored only after implementation release. |
| D02 import leaf | cloudflare/src/runtime/import-records.ts (new) and import-records.contract.test.ts | After released import contract/version; pure lexer/edit adapter only. modules.ts/bundle.ts integration via R3 separate packet. |
| D03 map leaf | cloudflare/src/runtime/sourcemap.ts and sourcemap.contract.test.ts | After map contract/version; preserve exported decodeMappings/lookup shapes, optional-name semantics, raw source identity. Worker dependency request returns to R3. |
| D04 delivery join | cloudflare/src/runtime/modules.ts; deploy/bundle.ts; finite existing module/bundle diagnostic tests identified at release | After D02+D03; exact global manifests/distribution/release/local-run/testkit adds each need lease. invoke.ts conditional transfer only; no compiler artifacts mutated. |
| Identity encoding I01/I02 | identity/src/sessions/tokens.ts; identity/test/token-codecs.contract.test.ts (new) | Freeze stored PBKDF2 canonical/legacy-tail-bit policy; password verification, issuance, CSRF/PKCE observations. Existing null/false mappings; bearer text hashed without normalization. |
| Identity I03 comparison | identity/src/sessions/tokens.ts; identity/src/accounts/passwords.ts; identity/test/secret-comparison.contract.test.ts (new) | Host contract/version qualification and I02 same-file release. passwords.ts has its own loop and must be selected explicitly. Portable host seam new path only after decision, with global import/manifest lease from R3. |
| Identity cookie I01/I04 | identity/src/sessions/cookies.ts; identity/test/cookie-grammar.contract.test.ts (new) | Independently released cookie grammar profile. First duplicate empty/malformed stops; exact header defaults/order/Domain errors. Optional domain currently concatenated unsanitized, not proved live injection. |
| CSV C01/C02 | ui/src/csv/grammar.ts (new); ui/src/csv/parse.ts; ui/test/csv.test.ts | Owner decision: proposed UI leaf exported subpath or two pinned-option wrappers. No ui→interfaces edge. ui/package.json export/dependency and lock requests R3. |
| CSV C03 authority | interfaces/src/http/csv.ts; interfaces/test/{csv-review,csv-route,csv-join}.test.ts | C02 accepted seam plus original FP gates. Preserve canonicalJson, digest/consent/replay/selection/authority and full-input malformed-vs-limit precedence. Consumer fixtures can be prepared disjointly before seam write. |
| CSV C04 export | interfaces/src/http/export.ts; interfaces/test/export-print.test.ts | Conditional evaluate/retain/adopt; current pageToCsv produces LF plus terminal LF, not presumed CRLF. Keep neutralization before quoting, projections and selection order. Separate release if adopting. |
| Services H01 | services/src/http/client.ts; services/test/http-client.test.ts | Freeze actual Node/Worker AbortSignal.any support and error/reason contract. Current merged.abort() loses source reason; preserving winning reason is an intentional specified correction, not byte-neutral observation. Keep own deadline/timer release and buffered/binary/stream semantics. |
| Services H02 | same H01 files after transfer | Conditional quota investigation. redirect drain uses arrayBuffer and swallows non-timeout/non-caller errors; naïve bounded-reader replacement would swallow HttpBodyLimitError too. Decide error/hop/location order explicitly. |

All allowlists above are proposals; source paths relative to repo root. New test filenames are finite candidates, not existing evidence. One writer per test/source path; shared package metadata/source contracts have explicit serialized leases. N06/W05/W06/C04 assembly packets remain dependency-blocked; their contract/fixture/evidence preparation is independently useful.

## Consumer omissions and scope limits

- Identity real callers: accounts/passwords decoding, oauth PKCE comparison, csrf comparison, registration/recovery/grants/presession issuance, context/selection/revocation bearer-text hashes; Cloudflare grant-route calls parseSessionCookie dynamically. timingSafeEqualHex is publicly exported but no production caller found, so malformed helper bug is not proof of login bypass. Include supported installed identity/grant closure only where verified; Node-only import would break neutral entry.
- UI advisory parseCsvText has exports, Node test/corpus and component catalog, but no actual browser caller found. UI browser build installs bootstrap.js/polling.js and rejects imports outside browser dir; simply exporting grammar does not ship/init client parser. C03 has real interfaces review/commit source and repository route/join tests, but no current Cloudflare CSV mounting found. Outside-checkout Node/workerd/browser closure remains independent gates, not static success.
- Services real source consumers: mail/adapter.ts and judgments/systemone.ts buffered HTTP; media/comfyui.ts buffered+binary; models/ollama.ts buffered+stream. services is not present in current Cloudflare bundle producer inventory; qualify claimed host adapters explicitly rather than assume Worker product service adoption.
- Preserve T08/T26, challenge/product app journeys, W06 atomic claim/child units/restarts/authority, budgets/rollback and original complete scope. Disjoint selected I/C/H mechanics do not release broader product tasks or count as additional canonical IDs.

## Evidence reuse and pins

Existing tests/fixtures and historical reports can be reused as recipe/requirements only at unchanged source scope. No current execution witness or independent review was produced. Historical ledger source hashes and audit baseline differ from live source; exact current hashes below make interpretation reproducible.
- implementation/remaining-work/tasks.json sha256 cd01ebb2276e9bbd362085070b985811543f4bcb1d7ad0d0ac0530d3092bc3f4
- implementation/rust-port-lanes.json sha256 4936af9c418fbf8accb9932e24abb622d11563d776fb271c6dac111615439033
- docs/research/package-library-audit-20261006/adoption-sequence.json sha256 d93dcb00638680b1b861c90ec6a445267942b8ca6f7ca479fb60bc0386ca3a9f
- packages/work-kernel/Cargo.toml sha256 553dbdbb7d912cff34af5641017a27879ce5885f7395cdeb004a5bd9148c0374
- packages/work-kernel/rust/lib.rs sha256 33177d2d67ebc8138a11937f00231436cbabc14d1ea6a9b7449cac10f36c2e98
- packages/cloudflare/src/deploy/bundle.ts sha256 c655fed4ef03d35d39fc52811abc4d41516d2bf8e52fcf4a499d17e8f9057ed1
- packages/cloudflare/src/runtime/modules.ts sha256 f42ff4589751ee275ad48905c6a073fe20b38a9ee49ef147d38e69befda63230
- packages/cloudflare/src/runtime/sourcemap.ts sha256 1455a9344724114863b2438403e08bf0e4db3a08c4ddd68fc1ae99992419c66b
- packages/cloudflare/src/runtime/invoke.ts sha256 bc08e559d905ed285bb7beff9db0d3e43c808a604face535b5305f444ffae15d
- packages/identity/src/sessions/tokens.ts sha256 451ffb75345d3e0f3fc55b240f15d9f0bff6d1cfb5c0e0e746e16437529492c5
- packages/identity/src/accounts/passwords.ts sha256 2d97be90adf82ebf1f1b923086eb3fab72c5153c50ca2b9c9daa45ea8aeb814e
- packages/ui/src/csv/parse.ts sha256 ac598dc24be5e8c9a1049b81ba04d2bb4cfa3bbacd1e40c3b85d837c658dec28
- packages/interfaces/src/http/csv.ts sha256 5d02bca4deab4d9ab08091a967ad944f04a46fe8295093fdb1cd5410fb29fea0
- packages/services/src/http/client.ts sha256 a5629f5e954bbd32daf304af96bb275b3f1e2586af009a65cdf8a9da719b031e
