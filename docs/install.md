# Install `can`

`can` is a single binary for compiler and authoring commands. Platform commands
also require the TypeScript `can-platform` runtime (see below). Two ways to get
the compiler:

## From a release artifact

1. Download your platform's artifact from the `release` workflow run
   (`can-linux-x86_64` or `can-macos-aarch64`): the `can` binary plus its
   `SHA256SUMS-<platform>.txt`.
2. Verify the checksum:
   `shasum -a 256 -c SHA256SUMS-<platform>.txt`
3. Install somewhere on your `PATH`, e.g.:
   `install -m 755 can ~/.local/bin/can`
   (create `~/.local/bin` first if needed and add it to `PATH` in your
   shell rc: `export PATH="$HOME/.local/bin:$PATH"`).
4. Check: `can --version` prints
   `can 0.1.0 (commit <sha>; language 1.0; schema 1)`.

## From source

Needs Rust 1.99+ (see `compiler/Cargo.toml` `rust-version`):

```
git clone https://github.com/veighnsche/canlang.git
cd canlang/compiler
cargo build --release --locked
install -m 755 target/release/can ~/.local/bin/can
```

## Source workspace and release verification

From the repository root, use Bun 1.4.2 and Node.js 22+ (Node 24 is the
verified runtime test profile):

```sh
bun install --frozen-lockfile
bun run build
bun run release
bun run release:pack
```

The build uses the pinned Turbo 2.11.7 graph for all 13 TypeScript producers.
`release` prepares those outputs and runs uncached version, manifest, and
integrity checks without packing or publishing. `release:pack` performs that
preparation and validation, then writes all 13 workspace tarballs, including
private dependencies, to `output/release-artifacts/`. Its manifest records
hashes and internal runtime dependency closure; private flags are preserved.
These are package artifacts only. The
[release workflow](../.github/workflows/release.yml) separately assembles the
Rust binary and editor extension. Neither command publishes packages or
qualifies complete applications or supported native hosts.

`bun run verify:installed-types` checks installed Can declarations and a consumer
fixture from actual tarballs. Its scoped strict Can/consumer gate passes;
797 Miniflare SDK declaration errors remain visible, so whole-program strict
library checking does not pass. See [developer setup](dev-setup.md) for the
verification scope, tests and explicit opt-in native builds.

For a built source checkout, point `CAN_PLATFORM_BIN` at the executable
`packages/cloudflare/dist/cli/platform.js`, or put `node_modules/.bin` on
`PATH`. The public build restores its executable mode.

## Shell completions

```
# bash:  can completions bash >> ~/.bash_completion
# zsh:   can completions zsh > ~/.zsh/completions/_can   (dir on fpath)
# fish:  can completions fish > ~/.config/fish/completions/can.fish
```

Or eval per shell: `eval "$(can completions bash)"`.

## Internal reference (`can docs`)

```
can docs app.can --locale=nl --out generated/reference.nl.md
```

Without `--out`, Markdown goes to stdout; without `--locale`, the
renderer uses the app default locale plus source fallback
(`can docs --help` lists the full contract). Like the other thin
lane-7 entries, `can docs` needs the `can-platform` runtime on `PATH`
(or `CAN_PLATFORM_BIN`); a missing runtime is a truthful `E7004` tool
error, never silent output.

## Environment

- `CAN_CATALOG`: producer catalog path for
  `check`/`compile`/`lint`/`policy` (below `--catalog`, above
  `./can-catalog.json`).
- `CAN_PLATFORM_BIN`: override path to the `can-platform` binary for the
  thin lane-7 entries (`run`/`test`/`build`/`deploy`/`activate`/`docs`).
