# Turbo discovery and boundary coverage: verified probe results

Executed 2026-10-06 (Europe/Brussels) against source HEAD `7fd8c6bf4717feeffc70b46819377b74b353e117`. Primary pin: **Turbo 2.11.7**, Bun **1.4.2**, Node **24.21.0**, macOS arm64. Exact installer lock, native binary/schema hashes and all available language-tool versions are in [toolchain.json](evidence/tooling/toolchain.json). Installations and synthetic/native-source copies were isolated under `/private/tmp`; the real repository boundary command used an external scratch configuration. Telemetry and update checking were disabled for the probes.

## Conclusion for the implementation plan

The two requested B01 probes are complete. **Use explicit package/root command adapters for Can's current separate Cargo projects. Use Turbo boundaries as one part of enforcement, supplemented for unsupported import/loading forms and package export resolution.** This is the plan's already-defined fallback after measured incompatibility, not an implementation cutover. Full B01 task/artifact inventory and command-level product baseline, B02's supplemental checker and B07/B08 build/cache/CI qualification remain open.

## Native discovery

| Probe | Verified result |
| --- | --- |
| Actual preserved repository topology, Cargo flag on | 13 JavaScript packages; **zero Rust package identities**. The compiler filter fails as absent. Independent replay without a Cargo wrapper confirms the result. Initial 2.11.0 agrees with primary 2.11.7. |
| Named root virtual Cargo workspace, dependency-free positive control | Native crate identities and app-to-core dependency are discovered. Default commands are locked Cargo commands; unfiltered verification aggregates at the workspace. Root `[workspace.metadata] name` is required. Removing the root manifest removes native discovery. |
| One directory with JS and Cargo owners | Distinct names produce two task identities; identical names fail as duplicates. Turbo does not automatically merge those owners. |
| TS-only filter with unavailable Cargo | Synthetic JS task execution succeeds. An independent fresh-fixture replay proves its dry run calls no Cargo; the native filter then calls metadata and fails as expected. |
| Synthetic Go workspace, local dependencies | Modules and app-to-core build dependency are discovered with Go 1.27.1. Cache warnings remain; no native build/cache restoration was tested. |
| Synthetic Python workspace, installed uv 0.5.9 | Member names are discovered through limited fallback; required metadata/interpreter options fail and task caching is disabled. Proposed check execution remains unverified. The backend-free fixture has no build tasks. |

Cargo's shipped guide requires a repository-root virtual workspace. Our separate compiler, private values workspace, work-kernel and nested preparation/fixture crates do not meet that shape; `ports:C04.graph` also excludes introducing a compiler Cargo workspace. Preserve native manifests and schedule their existing commands through explicit adapters. No fake npm identity is needed for every native crate. Go/Python fixtures are controls, not new Can projects or qualified language execution. Python standard-library scripts retain their existing runners.

[Native raw evidence, fixture sources and reproduction](evidence/native/README.md) preserve setup failures, corrected controls, command envelopes, warnings and tool interception. Bundled version-specific guides/schema are saved under [tooling](evidence/tooling/). No actual Rust/Go/Python native build, Wasm/glue generation, native port change or release qualification ran.

## Boundary checker coverage

All **24 isolated cases** completed on 2.11.7: 13 detected violations and 11 passes, including two positive controls. Raw command exits/stdout/stderr and fixture inputs are in [the case report](evidence/boundaries/RESULTS.md) and [results.json](evidence/boundaries/results.json). No ignore suppressions or CLI crashes occurred.

| Form tested | Result and required action |
| --- | --- |
| Undeclared static imports; sibling source/dist imports; TS aliases into sibling source | Detected. Keep these checks in the eventual enforcement gate. |
| Type-only import/export declarations; reexports; literal dynamic imports; package test violations | Detected for the tested forms. Preserve test ownership explicitly. |
| `import('package').Type` type queries | Passed despite undeclared dependency. Supplemental AST coverage is required. |
| Constant, concatenated or computed dynamic imports | Passed. Constrain producer-loading APIs and check constants/registries plus focused negative tests. |
| Sibling producer filesystem reads and `new URL` paths | Passed. Enforce package-owned distribution/asset APIs, distinguishing local fixtures from producer bypasses. |
| Root scripts/tooling | Both undeclared-package and sibling-source fixtures passed; root files were outside the scanner's workspace coverage. Include root tooling/integration consumers in supplemental enforcement. |
| Declared package, unexported subpath | Passed Turbo boundaries; Bun runtime separately rejected resolution. Compiler/runtime installed-package export checks are necessary. |

This is measured coverage for these fixtures and this pin, not a general proof that all syntax, aliases, asset readers or dynamic evaluation is handled. Negative tests for unsupported forms belong in B02; adding manifest entries alone does not address them.

## Actual checkout baseline and preservation

The real checkout command exited **1**, reporting **612 files in 13 packages and 566 issues**: **509 outside-package imports** and **57 undeclared-package imports**. The parsed diagnostic total matches the CLI total, including wrapped messages. This includes workspace tests; diagnostics still require site/ownership triage, including deliberate test fixtures and root-owned runner consumption. They are not 566 independent product defects and do not include unsupported loading forms or the non-workspace editor/root tooling.

[Raw command and source-preservation result](evidence/repository/result.json), [diagnostic sites](evidence/repository/diagnostics.json), [stdout](evidence/repository/stdout.txt) and [stderr](evidence/repository/stderr.txt) are retained. SHA-256 comparison confirmed **946 tracked product/configuration files unchanged** after the probe; independent review checked their current hashes again. Product manifests, source, lockfile and build/CI configuration were not migrated. The only repository writes are probe evidence and planning/decision navigation.

## Review, limits and next work

[Independent assessment](evidence/review/ASSESSMENT.md), [cold-filter replay](evidence/review/cold-denied-results.json) and [actual package-list replay](evidence/review/actual-ls-pinned.json) remove the warm-metadata/interception confounder for the conclusions above. Fixture expectations, raw outcomes and tool hashes were independently inspected.

Next, finish B01's complete import/task/artifact inventory and command baseline, then implement B02's API/distribution contracts and supplemental checker. Keep experimental native flags off for the currently unsupported Can topology. Revisit discovery only with evidence that a pinned implementation preserves existing ownership. Build ordering, output restoration, cache invalidation, compiler commit stamps, executable modes, installed Worker assets, parity/economics and C04/C05 product acceptance remain unverified. The preparation HOLD and living-plan checkpoint are unchanged.
