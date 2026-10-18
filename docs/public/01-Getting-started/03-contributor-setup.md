# Optional contributor setup

Build CanLang from source when contributing to its compiler or runtime; application authors can use the complete standalone installation instead.

## Choose the setup for your work

To write and run applications, follow [installation and your first app](02-installation.md):

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

The installer supplies the matching tools, runtime and language catalog. The remaining instructions on this page are optional and intended for contributors changing CanLang itself.

## Build a complete source workspace

Contributor builds require Git, Bun 1.4.2, Node.js 22 or newer and Rust 1.99 or newer. Node 24 is the verified runtime profile. Run these commands in one terminal:

```sh
git clone --recurse-submodules https://github.com/veighnsche/canlang.git
cd canlang
bun install --frozen-lockfile
bun run build
bun run catalog
export CARGO_TARGET_DIR="$PWD/compiler/target"
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=2
bun run build:compiler
cargo build --locked --manifest-path dev-server/Cargo.toml
export PATH="$PWD/compiler/target/debug:$PWD/node_modules/.bin:$PATH"
export CAN_CATALOG="$PWD/packages/values/dist/catalog.json"
export CAN_PLATFORM_BIN="$PWD/packages/cloudflare/dist/cli/platform.js"
export CAN_DEV_BIN="$PWD/compiler/target/debug/can-dev"
export CAN_DEV_RUNTIME_HOST="$PWD/dev-server/host/entry.mjs"
export CAN_HELP_INDEX="$PWD/docs/specification/CONSTRUCT-HELP.md"
can --version
```

These commands build the compiler, runtime packages and catalog together. Keep the absolute catalog and runtime paths when running your contributor toolchain from another application directory. They select your built source outputs instead of the standalone release's bundled tools. Use a fresh terminal without those overrides when returning to the installed release.

For compiler commands accepting a catalog, an explicit `--catalog=PATH` takes precedence over `CAN_CATALOG`. After changing catalog producers, run `bun run catalog` and restart the language server. For editor diagnostics against your source build, set `can.serverPath` to the absolute `compiler/target/debug/can` path.

## Check a contribution

Choose checks for the owner you changed. The existing entry points include:

```sh
bun run typecheck
bun run check:boundaries
bun run test
bun run test:compiler
```

These check CanLang itself; they are not application installation steps. See [developer setup](https://github.com/veighnsche/canlang/blob/main/docs/dev-setup.md) for producer dependencies and scoped validation, and [release assembly](https://github.com/veighnsche/canlang/blob/main/docs/install.md#assemble-a-standalone-release-contributors) when changing distribution packaging.

Return to [local application development](../03-Build-and-operate/01-local-development.md) to check source, open a protected preview and exercise the application's rules. Browser automation remains an optional, separate development installation for both standalone users and contributors.
