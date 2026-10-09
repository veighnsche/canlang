# DEP-02 actual current attributed failure

The focused permanent test `compiler/tests/map_attribution.rs::production_failure_reaches_node_source_maps` passes: **1 passed, 0 failed, 0 ignored**, with Node **24.21.0**. [Final raw result](check.stdout) and [consumer result](check.stderr) are retained. The actual compiler CLI checks/compiles the unchanged [source fixture](failure.can) in production mode against the existing values catalog. Current public Cloudflare `loadArtifactFile` and `assembleModules` stage its modules, using the real installed stdlib and UI exports. The assembler leaves the loaded compiler artifact unchanged. Its ordinary emitted pure callable returns `1n` for `9n % 4n`, then raises the real `RangeError: Division by zero` for `9n % 0n`.

Actual `node --enable-source-maps` attributes the emitted failure to the original absolute `.can` identity at **failure.can:4:8**. Independently, Node's `SourceMap` engine decodes both the untouched compiler map and the assembler's staged map to source line 4, byte column 8. Both maps preserve the original source identity and exact `sourcesContent`; the artifact's source hash independently matches the original file bytes. No synthetic throwing module, test-only emission, injected runtime, mutation of compiler maps or hand-built assembly participates. The TypeScript source-loader hook only resolves existing package source `.js` imports to their `.ts` owners; installed producer imports follow ordinary package resolution.

One bounded build was run: `cargo test --manifest-path compiler/Cargo.toml --locked --offline -j 2 --test map_attribution -- --nocapture` (native debug). Subsequent observer corrections reused its compiled test executable and actual CLI: a runner syntax typo, the mistaken initial column expectation (the existing anchor is the callable name), and path-vs-URL normalization were corrected. A proposed optional `findSourceMap` cache inspection returned undefined under this source-loader profile and was removed; the actual mapped stack and separately decoded raw/staged maps are the retained outcomes. Final direct test execution above passed. No compiler production, package, dependency or public API changes were made; unchanged prerequisites and the already accepted six map controls were not replayed.

## Original finite duty

The original [DEP-02 row](../../../docs/research/compiler-library-audit-20261006/resumption/audit-costs-and-oracles.md) asks for repeated source identity, an independent decoder, actual attributed failures, and a supported public API before extraction replacement, with **retain/defer** selected. Joined with the accepted repeated-path/current map controls and [supported extraction/public decoder retention decision](../map-support/decision.md), this witness supplies its missing current emitted-failure consumer outcome. **The original finite DEP-02 retain/defer duty is complete at this bounded scope.** Extraction remains retained with zero deletion credit; no upgrade or replacement is selected.

Browser navigation, installed/deployed original applications, canonical operation invocation, universal host attribution, huge resource profiles and GUI workflows are not qualified. The original audit assigns those broader actual-application profiles separately to OR-06; they are not an extra DEP-02 completion condition. A future dependency upgrade/extraction replacement must requalify its own supported API and compatibility outcomes.

## S9-Q08 public callable mapper

The same consumer's `--registry-mapped-outcome` mode and
`production_failure_reaches_native_registry_mapped_outcome` pass **1/1**
(0.22s). The unchanged genuine source is compiled and assembled normally;
installed `@canlang/cloudflare/runtime/invoke` invokes its emitted registry
callable once. With Node source-map support disabled, the current runtime
mapper returns the exact error `Division by zero` and original absolute
`failure.can` identity at **4:8**, including `Attribution.remainder` as the
mapped name. The first result (0/1, 0.55s) exposed an omitted expected name;
the existing public `MappedPosition.name` contract determined that observer
correction. Only this affected new case repeated, using the same executable.
The accepted DEP-02 Node/decoder outcomes remain reused.

At the time of the callable-registry result above, canonical
`runScenarioSeam` converted `InvokeResult.error` to a State error and discarded
`mapped`; the read path preserved the throw before State conversion. The
following bounded consumer qualifies the later internal-details hop. It does
not qualify a mapped-location public wire carrier, broader disclosure policy,
original error-object guarantee, deployment or full S9-Q08.

## Canonical State internal attribution hop

`compiler/tests/map_attribution.rs::production_failure_retains_internal_attribution_through_canonical_state`
now passes **1/1 (0.21s)** through the actual production CLI, installed
catalog, refreshed Cloudflare invoke/stdlib assembly and real State Memory.
`invoke.ts` places the existing `outcome.mapped` value into the existing
`StateError.details` for fresh canonical `rule_failed` errors; existing
`engineFailures` are retained. Public code, message, operation ID and
`retryable:false` stay unchanged. A real `Attempt.create` rolls back; its
receipt has no mapped field. Same-ID rejected replay exposes no attribution.
A fresh artifact with raw maps removed, `sourceMaps`/`mapUrls` empty, returns
`details:null`.

The original 0/1 (0.36s) fixture had a missing required `as` binding; the next
0/1 (0.52s) exposed test source-loader setup for a TypeScript parameter
property. Only the fixture was corrected before the installed compiled
consumer. Focused TypeScript no-emit and Rust build results passed and are
reused; no tests/builds are repeated here. This completes only the finite
internal wrapping hop. Held BDD3 returned/as/live/context disclosure and full
replay/public source policy remain separate; no full S9-Q08/OUT-R05 credit is
claimed.
