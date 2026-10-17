# Installed Worker packages and assets

Implemented 2026-10-06 against unmerged main `7fd8c6bf4717feeffc70b46819377b74b353e117` and the preceding package-boundary repairs. [Source hashes](evidence/source-hashes.json) pin the tested implementation. This evidence covers package resolution and explicit asset staging, not full native release or browser workflow qualification.

Worker main, MCP and HTTP roots resolve through installed owning exports. ESM producers use import conditions; the source-test loader retains a fallback for packages whose export conditions share one default entry. `repoRoot` is now an optional ignored compatibility input, and the preparation host no longer computes it for bundling. Producer module/asset directories come from declared package distribution exports, with explicit directory injection retained for tests and hosts.

`buildDeployBundleWithAssets(artifact, { verdict, assets: { valuesWasm: true, browser: true } })` stages the committed values bindings/glue/WASM and UI browser resources. Selection is explicit; no asset selection or backend initialization occurs in the ordinary JavaScript path. Values binding imports join the vendored values modules. Both finite producer manifests are checked for exact file sets, byte lengths and SHA-256, including generated declarations. Reads reject producer-directory escapes and symlink cycles.

`writeDeployBundleWithAssets` writes Worker modules and WASM through the mixed writer, then writes browser resource bytes with a separate integrity manifest. Browser JavaScript and CSS remain outside the Worker module map. Resource digests include keys, content types, lengths and byte hashes. The complete output layout, resource digest, mixed digest and existing filesystem entries are validated before writes. Normalized aliases, module/resource collisions, reserved manifests, file/directory conflicts and symlinks reject. Output parents must be canonical; this also supports Node consumers restricted to their own filesystem root.

| Check | Result |
| --- | --- |
| Cloudflare producer build | Pass after final changes |
| Root Vitest with Node 24.21.0 and existing preparation binary | 636 tests, 64 files pass; final guard adjustment additionally covered below |
| Final focused discovery/integration tests | 39 tests pass, including output ancestor symlinks and producer integrity negatives |
| Root and E2E typechecks | Pass after final changes |
| Supplemental package boundary guard | 13 owners, 675 files, zero violations; 474 runtime/context expressions retain audit scope |
| Boundary guard regression fixtures | 12 pass |
| Installed tarball consumer | Pass; only `@canlang/cloudflare` directly declared, dependencies installed from real tarballs |
| Installed production Worker | Real workerd/D1 boot; MCP initialize returns expected authentication 401 |
| Installed selected WASM | Static CompiledWasm import is a `WebAssembly.Module`; real generated glue/backend return ABI 1 and add-int(1,2) = 3 |
| Installed asset negatives | Missing/corrupt WASM and CSS reject; ordinary JavaScript build remains available |
| Independent review | Output symlink escape corrected; original and ancestor repros reject without writes; no remaining P1/P2 findings |

Reproduce from Node 24 or newer with Bun available:

```sh
bun run verify:installed-worker
# After building the producer packages:
node scripts/verify-installed-worker.mjs --skip-build
bunx vitest run packages/cloudflare/test/package-assets.test.ts packages/cloudflare/test/deploy-package-assets.test.ts
bun run check:boundaries
bun run test:boundaries
bun run typecheck
bun run typecheck:e2e
```

The [installed run log](evidence/installed-worker.log) and [structured results](evidence/installed-worker.json) retain producer realpaths, byte hashes, ESM conditional-export selection, authentication response, compiled-module result and negative cases. Node filesystem permissions explicitly deny checkout reads while the consumer builds and writes its inventory. Bun and workerd subprocesses do not inherit that permission model; the harness separately verifies resolved installed producer paths and absence of checkout/sibling paths in emitted runtime bytes. This is narrower than an OS sandbox proving every subprocess filesystem read.

Browser resources are ready for the host's asset-serving integration; this round adds no production browser route or browser acceptance claim. The normal backend remains TypeScript. No missing work-kernel WASM assets are invented, and no optional receipt observer is supplied: injected precedence and missing-observer deployed refusal retain their prior scope. Turbo cutover/cache acceptance, supported-host/native release, preparation HOLD and the complete living-plan checkpoint remain unchanged. No merge or publication occurred.
