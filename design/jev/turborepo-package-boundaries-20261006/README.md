# Build orchestration and package boundaries: JEV advice

Design consultation dated 2026-10-06. This directory contains three freshly rewritten, semantically equivalent choice requests and the complete request/response evidence from `tools/jev.py`. All calls succeeded, using returned model `jev-1.13.0`; no retries or failures occurred. Advice is not an accepted architecture decision or implementation authorization.

## Evidence supplied

The coordinator's repository audit reports Bun 1.4.2, 13 TypeScript package manifests under `packages/*`, manually ordered root builds, and 165 literal relative cross-package import/export edges in 115 non-test source files (163 targeting contracts source). Tests and dynamic imports are outside that scan. Actual dependency omissions include services/files/state/ui/values/work. Broad roots and imports admit sibling sources; values/state `../../contracts/src` include entries instead resolve to nonexistent root paths. These details distinguish actual coupling from a misleading config path.

Additional audited runtime cases: cloudflare accesses state/dist internals dynamically without declaring state; runtime identity is only a devDependency. State's work-loader has a computed TS-source development/checkout fallback reachable by cloudflare invocation. Work also imports state command types. Declaring both edges mechanically creates a cycle; a shared contract or injected interface needs examination. This is not evidence that the checkout fallback is the default production backend.

Directly read for this consultation: root package.json, compiler/Cargo.toml, packages/values/Cargo.toml, packages/work-kernel/Cargo.toml, packages/cloudflare/preparation/Cargo.toml, tools/README.md and tools/jev.py. Native inventory supplied by the coordinator includes the compiler CLI, private values semantics/bindings workspace, work-kernel crate, cloudflare preparation process and loader-smoke Rust tests. Python uses stdlib tooling/tests without pyproject/uv workspace; no Go implementation or manifest was discovered. Go is intended future scope. Existing optional WASM behavior remains unchanged.

Official references checked by the coordinator, with release/Bun pages also reopened during this consultation:

- [Turborepo 2.11 release, September 18, 2026](https://turborepo.dev/blog/2-11): experimental Cargo, uv and go.work discovery connects languages in a shared task graph; support is subject to change.
- [Turborepo boundaries](https://turborepo.dev/docs/reference/boundaries): experimental checking of outside-package imports and undeclared dependencies. Reopening through this agent's web tool returned an unsupported Markdown content-type error; the coordinator's verification supplies this fact.
- [Bun workspaces](https://bun.sh/docs/pm/workspaces): local consumers can declare internal dependencies with `workspace:*`.

These references establish advertised capabilities, not proof of this repository's nested/standalone native discovery, correct toolchain/cache inputs, artifact recovery or comprehensive test/dynamic-load enforcement.

## Common quality bar and alternatives

Every alternative repairs TypeScript dependencies with `workspace:*`, uses exported public package entrypoints, excludes sibling src/dist reads and alias bypasses, and validates tests plus dynamic loads. Native declarations retain ownership of native dependency edges. Command adapters do not imply an npm package per native crate. All alternatives preserve complete workflows and backend defaults.

- **A:** Repair boundaries; initially keep Bun/manual orchestration. Smaller concurrent migration, but ordering maintenance continues and shared cache/affected scheduling is deferred.
- **B:** Repair boundaries; add Turbo via package.json tasks and selective native/tool adapters. Conventional scheduling/caching, but explicit cross-toolchain tasks, adapter upkeep and cache-input configuration remain.
- **C:** Repair boundaries; introduce experimental native Turbo discovery, proving mixed/nested workspace, toolchain and artifact behavior before cutover. More native declaration reuse where supported, but additional compatibility and validation work.
- **unresolved:** Preserve uncertainty if the supplied evidence cannot justify a delivery choice.

## Returned distributions

| Round | Selected | Confidence | A | B | C | unresolved |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | unresolved | 0.25 | 0.41 | 0.09 | 0.05 | 0.45 |
| 2 | A | 0.24 | 0.43 | 0.23 | 0.05 | 0.29 |
| 3 | A | 0.79 | 0.85 | 0.08 | 0.02 | 0.05 |

The API confidence is recorded separately from each choice probability. No probability was rounded to a decision. Each evidence file preserves the full response, model and usage. There is no explanatory rationale in these typed API responses.

## Disagreement and independent assessment

A and unresolved exchange first place in rounds 1 and 2; round 3 gives A much more weight. A changes by 0.44 and unresolved by 0.40 across equivalent prompts. B ranges 0.08–0.23, and C is consistently low at 0.02–0.05. The requests were compared for facts, invariant quality target, alternative scope and criteria: all carry the same constraints, lack of repository-specific measurements, cycle caveat and pre-cutover proof for C. Variants differ in emphasis and wording, not intended outcomes. In particular, unresolved criteria use different strength of phrasing; this could affect selection, but the responses provide no causal evidence. Independence here means independently written prompts and separate calls, not independent models or statistically calibrated samples. Averaging or majority vote would hide this uncertainty.

My assessment: boundary repair is justified by observed ownership gaps regardless of orchestrator. Favor **A as the first cutover**, while preparing a bounded Turbo experiment independently: measure a correct declaration graph, native adapter/discovery behavior, clean builds and artifact cache restoration before making it responsible for release/test workflows. **B can reasonably follow** if the experiment demonstrates useful scheduling or caching with small adapters; **C should remain conditional** on exact native layout support. This is sequencing advice rather than opposition to Turbo or a claim that manual orchestration scales indefinitely. The strongest common evidence is that an inaccurate graph must be repaired before graph-based scheduling can be trusted.

The supplied evidence does not measure current build cost or Turbo benefit and does not demonstrate native workspace handling. The advice therefore cannot establish performance gains, final implementation scope, or the best long-term orchestration choice. All files are proposals/evidence only; no source, manifest, DECISIONS or backend change was made here.
