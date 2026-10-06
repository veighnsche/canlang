# Package-boundary repair evidence

Implemented 2026-10-06 against `7fd8c6bf4717feeffc70b46819377b74b353e117` plus local planning changes. This is an uncommitted repair round, with product/runner byte identities in [source-hashes.json](evidence/source-hashes.json). No merge, publication or Turbo orchestration cutover occurred.

## Implemented behavior

All 13 TypeScript owners declare consumed workspace packages using `workspace:*` and expose intentional APIs/assets. Production, tests, conformance tools and root consumers use those exports. TypeScript producers emit their own implementation rather than sibling contracts copies; files, services and work now have emitting builds. Root build order and CI prerequisites follow this graph. Remove source aliases that bypass distribution checks. Builds stage browser assets, fixtures and digest-checked committed values bindings at their new owning paths.

Work depends on state; state has no work backedge. Work-dependent state receipt/fanout integration suites moved into work, and consumer-dependent contracts pins moved to files/work with their assertions retained. Work exports its actual observation/receipt functions. The optional state observer loader owns its relative module lookup: injected observer precedence, exact-absence fallback and broken-module refusal remain intact. The observer itself remains absent and deployed receipt serving still refuses without the qualified/injected implementation.

Cloudflare owns local row isolation beside its local runtime. Testkit reexports that implementation; the CLI uses it directly, removing the hidden Cloudflare→testkit→Cloudflare cycle. CLI `test` still proves boot/snapshot and reports zero rows executed. This repair does not invent an example-row loader.

Producer `./distribution` exports return owning URL locators; Worker/MCP/HTTP assembly resolves exported installed artifacts. Sorted staging and module identities remain deterministic, with contracts imports explicitly rewritten and the redundant `contracts/src` mirror removed. Test/metadata modules stay outside vendor staging. Values exposes its opt-in host/glue/WASM/BUILD assets and committed conformance JSON deliberately. Ordinary values builds still verify/copy committed bindings and do not rebuild Rust or select Wasm.

## Verification

Local tool scope: Bun 1.4.2, Node 24.21.0, TypeScript from the existing Bun lock, macOS arm64. Root build and typecheck passed before edits; their [baseline logs](evidence/baseline-build.log) and [typecheck log](evidence/baseline-typecheck.log) are retained.

| Check | Result / retained evidence |
| --- | --- |
| Delete every producer `dist` and incremental metadata; `bun run build` | All 13 producers pass; [clean-build.log](evidence/clean-build.log). Own dist layout and no stale sibling mirrors verified. |
| `bun install --ignore-scripts --frozen-lockfile` | Pass; [frozen.log](evidence/frozen.log). Lock refreshed for declared relationships/test deps. |
| Root and e2e typechecks with source aliases removed | Pass; [typecheck.log](evidence/typecheck.log), [e2e-typecheck.log](evidence/e2e-typecheck.log). Historical playback exclusion removed. |
| Turbo 2.11.7 boundaries, original external probe config, native flags off | 631 files / 13 packages / no issues; [turbo.log](evidence/turbo.log). Earlier run had 566 diagnostics. Turbo remains external probe tooling. |
| Supplemental `bun run check:boundaries` | 671 JS/TS files / 13 packages / zero violations; [check.log](evidence/check.log), [structured audit](evidence/boundary-audit.json). |
| `bun run test:boundaries` | 12 adversarial fixtures pass; [check-tests.log](evidence/check-tests.log). Covers type queries, const/template/helper loads, aliases, escaped paths, filesystem reads, exports and manifest cycles. |
| Root Vitest suites with existing preparation test binary | 62 files / 597 tests, all pass; [vitest.log](evidence/vitest.log). Nine contracts consumer cases moved into owning suites, retaining their assertions. |
| Emitted Cloudflare tests | 265/265, zero skipped; [cloudflare-tests.log](evidence/cloudflare-tests.log). Includes real D1, DO, receipt, invocation and fanout joins. |
| CI gate/receipt unit tests | 12/12; [ci-tests.log](evidence/ci-tests.log). Existing profiles and native debug prerequisite preserved. |
| Release stamp → manifest → verify | Pass; [release.log](evidence/release.log). CLI executable mode preserved. |
| Independent review | Identified receipt index rewrite and CLI cycle; both fixed. Re-review found no remaining concrete P1/P2. |

Owning producer checks also passed: contracts 71 before consumer-pin relocation (nine assertions retained in files/work), values 873, stdlib 4, UI 935, identity 68, interfaces 504, work-kernel 371, state 821, services 146, files 82 plus relocated policy case, work 827 plus eight relocated progress cases. Values differential smoke passed 3,309 observations, with real installed bootstrap/hash validation. Four e2e vendor-loader specs and the existing CI gate tests passed; the real handbuilt fixture loader staged 67 modules. Full browser journeys, compiler/Rust suites and held native-release/host rollout were not run by this round.

Services' unchanged cancellation/socket assertion fails under Node 26.10.0 in both baseline and repaired emitted/source comparisons; all 146 pass under explicit Node 24.21.0. Cwd-dependent executable selection explained the initial difference. No provider behavior was changed to hide it; this report does not qualify Node 26 or the full host matrix.

## Installed consumption

[Installed summary](evidence/installed-summary.txt), [detailed evidence](evidence/installed-evidence.json), [tarball pins](evidence/installed-pack-log.json) and [probe source](evidence/installed-verify.mjs) retain the result. Scratch-only overrides mapped the thirteen unpublished `@canlang/*` versions to their local tarballs; Bun's packed manifests retained normal version-substituted dependencies. The initial registry 404 and successful override install were kept in `/private/tmp/canlang-installed-verification/`.

A consumer outside the checkout, with production dependencies and lifecycle scripts disabled:

- Imports all thirteen packed package roots; exported files have no checkout symlinks/paths. All 1,110 source-map source entries remain within their owning installed package.
- Builds the real Worker deployment twice with a scratch project root: 152 modules, identical bytes/digest, MCP/HTTP markers, vendor dependencies, link checks and workerd scan pass.
- Resolves values' exported Wasm and BUILD assets, verifies every digest, loads the ABI and computes integer `1 + 2 = 3` through the installed host bootstrap.
- Runs five installed receipt-seam tests and four installed D1/workerd tests, including the missing deployed observer's loud refusal.
- Boots installed `can-platform test`, then boots again with a Node resolver hook forbidding every testkit import. Both succeed and honestly report zero executed rows.

These qualify the repaired installed package joins. They do not close the missing observer, native work binding, parity/economics, preparation HOLD, full installed release or supported-host acceptance gates.

## Guard scope and next step

The supplemental guard checks manifest versions/cycles, existing export targets, TypeScript resolution, static imports/exports/types, bounded constant/helper expressions and statically recognizable paths in packages and root tests/tools/scripts/CI JavaScript. It runs after producer builds because exported artifacts must exist. Integration CI and the workspace receipt profile run it and its negative fixtures.

`--audit` / `--json` retain 381 runtime/context expressions, including 20 module loads. Arbitrary runtime paths, generated module strings, shell/YAML/Rust and native command semantics remain outside AST proof. Caller-owned artifact/Can inputs and release compiler-version reads have distinct ownership; they are not blanket sibling-source exceptions. The real runtime/package probes cover affected producer joins, while review and existing owning tests remain necessary.

Bun still orders producer builds explicitly. The B02–B06 repair deliverables are implemented for this TS graph; Turbo task/cache qualification (B07), the complete mixed-toolchain command inventory and broader rollout (B08) remain next work under the [implementation plan](../PACKAGE-BOUNDARIES-AND-TURBO.md). Original ledger identities/counts and the living file-tree checkpoint remain unchanged.
