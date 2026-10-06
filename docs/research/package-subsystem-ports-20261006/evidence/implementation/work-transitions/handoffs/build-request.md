# W02.1 — Build/bun.lock request to the shared graph owner (C04.graph)

From: work-transitions W02.1 (session 01a10fab-cc9d-7331).
Head at authoring: `2071631`. No shared manifest, platform
global, or consumer file was edited by W02.1; the changes below
are requested, not made.

## New package

`packages/work-kernel/` (`@canlang/work-kernel`, release `0.1.0`,
publishable, MIT): `package.json`, `tsconfig.json`, `Cargo.toml`,
`Cargo.lock`, `src/index.ts` (neutral entry: `WORK_KERNEL_VERSION`
only), `rust/lib.rs` (neutral root: version const only).

- Type graph: contracts-only. Sole runtime-resolution
  dependency is `@canlang/contracts 0.1.0` (publishable; no
  unpublished private workspace runtime dependency).
- Exports: package root only (`.` → `./dist/src/index.js`,
  types `./dist/src/index.d.ts`); pure JS/backend exports and
  conformance roots arrive with W02.2–W02.4 modules.
- Layout: TS under `src/`, Rust under `rust/` (avoids the
  cargo `src/lib.rs` default colliding with the TS root);
  `dist/` (tsc `rootDir: "."`) and `target/` are ignored build
  output.

## Verified locally (not yet in shared order)

- `tsc --noEmit -p tsconfig.json` → exit 0
- `tsc -p tsconfig.json` → exit 0; `dist/src/index.js` loads,
  `WORK_KERNEL_VERSION === '0.1.0'`
- `cargo check --offline` → exit 0
- `cargo build --target wasm32-unknown-unknown --release
  --offline` → exit 0 (skeleton `canlang_work_kernel.wasm`,
  296 bytes)

## Requested shared-graph changes (owner: C04.graph)

1. Register `@canlang/work-kernel` in the root build order
   after `@canlang/contracts` (its only dependency).
2. Update `bun.lock` for the new workspace member (root
   `workspaces` already globs `packages/*`; no root
   `package.json` edit expected, but confirm).
3. Confirm the `build:wasm` script convention
   (`cargo build --manifest-path Cargo.toml --target
   wasm32-unknown-unknown --release`)
   matches the delivery/binary toolchain C04 will pin
   (rustc/cargo versions, `wasm32-unknown-unknown` std
   availability in CI).
4. No consumer manifest changes requested: no state/
   Cloudflare/stdlib/testkit join until W05/W06 evidence.

## Out of scope for this request

Semantic modules (`rows`, `retry`, `every`, `lifecycle`,
`receipt`, `recovery`, `linkage`) and conformance suites
arrive in W02.2–W02.4, which wait on the W01 gate owner
reviews. ABI facts/bindings arrive in W03+.
