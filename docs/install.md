# Install `can`

`can` is a single binary for compiler and authoring commands. Platform commands
also require the TypeScript `can-platform` runtime (see below). Use the complete standalone distribution for application development.
The compiler-only routes below remain available for compiler consumers:

## Complete standalone installation

The standalone bundle includes the compiler, matching catalog, private Node
runtime, production runtime dependencies, workerd, inline-example tooling
and the Cloudflare deployment CLI. Chrome and Playwright are excluded. Users do not install Rust, Node, Bun
or npm dependencies separately.

The public entry point is prepared for the SodaOS website:

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

**Deployment pending:** this command becomes usable after a standalone GitHub
release is published and the website owner deploys the static installer. The
website serves only the script; it downloads the appropriate archive and SHA-256
checksum from [GitHub Releases](https://github.com/veighnsche/canlang/releases).
The script supports pinned versions with `bash -s -- --version VERSION` after
the pipe. See the [website agent handoff](../implementation/lean-install/website-handoff.md)
for the exact source, publication gates and copy-ready deployment prompt.

From a downloaded standalone artifact set, run:

```sh
sh install-local.sh
```

For the locally assembled artifact in this checkout, the same one-command entry is:

```sh
sh output/install/install-local.sh
```

The helper supplies its adjacent archive and pinned checksum to the installer.
Installation defaults to `~/.can`, configures the shell PATH, and retains the
previous version during upgrades. Open a new terminal afterward. Set
`CAN_INSTALL_DIR` on the command to choose another installation directory.

The macOS arm64 artifact has passed the complete external-app verification. Linux
x64 has an Ubuntu 24.04 CI qualification job but has not been verified locally;
arbitrary Linux distributions are not qualified. Public GitHub Release hosting and a Homebrew tap are not yet published.
Do not present the remote curl command as live until matching release assets exist.

Measured macOS arm64 artifact: **90,087,787 bytes download (85.9 MiB)**;
**260,139,952 bytes installed files (248.1 MiB)**; **277,823,488 allocated bytes
(265.0 MiB on this filesystem)**. Filesystem allocation varies. App data,
package-manager caches and retained older versions are additional.
`output/install/size-report.json` is the generated breakdown. The previous
core used 404.1 MiB on this filesystem; this build is **34.4% smaller**.
Bun is now a contributor build dependency only. Dynamic application bundles use
Node and the same esbuild 0.28.1 already required by Wrangler. The assembler
removes local native symbols from Node/workerd (preserving dynamic exports),
re-signs the modified macOS binaries ad hoc, and verifies their execution.

### Optional browser development tools

Browser automation is a separate opt-in installation, using Can's private Node:

```sh
sh output/install/install-browser-tools.sh
```

The downloaded release artifact set also supplies `install-browser-tools.sh` and
its adjacent `browser-development` manifest/lock. This installer puts Playwright,
Chromium headless shell and ffmpeg under
`~/.local/share/can/development/browser/1.63.0`, outside the production install.
Measured additional files: **225,846,579 bytes (215.4 MiB)**; allocated disk:
**226,373,632 bytes (215.9 MiB)**, excluding package-manager caches. Browser
automation may require OS libraries on Linux; this add-on is verified on macOS arm64.
The installer verifies pinned package SHA-512 values using Node; no Bun or npm
executable is required. Set `CAN_BROWSER_TOOLS_ROOT` to select another separately installed tool root.

Core check/build, inline examples and local preview work without this add-on.
Mandatory browser acceptance reports missing development tools and stays failed
until they are installed; it never silently skips browser checks.
Service credentials and authored browser tests remain application inputs.
Git is needed only for explicitly requested `git:<revision>` rollback.

See [the bounded shipping audit](../implementation/lean-install/README.md) for
retained files, dependency choices, verification and release gates.

## Compiler-only release artifact

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
`PATH`. For `can dev`, use the sibling `CAN_DEV_BIN` override or the installed
`can-dev` bin. The public build restores both executable modes.

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
- `CAN_DEV_BIN`: override path to the `can-dev` JSON session client for
  `can dev`.

## Assemble a standalone release (contributors)

Use the existing source-build prerequisites and Node 24.22.0:

```sh
bun run release:install
bun run verify:install
```

The builder uses the pinned private production tooling lock in
`scripts/distribution` and writes a
platform tarball, checksum, local installer, package inventory and size report to
`output/install/`. Browser installer sidecars are separate; no browser is downloaded
or added to the core archive during assembly. It refuses an existing assembly stage rather than replacing an
unknown output. Move the previous `output/install/can` stage aside before another
assembly. Packaging never publishes a release.

The current local artifact uses integrated source-built production packages;
its manifest records `inputMode: built-checkout`. All 13 package builds and all
18 installed checks pass on macOS arm64, including API-only previews which
provision R2/Durable Objects and a model-free member queue automatically.
The matching release compiler passes the original inline examples. Linux CI
qualification and public release/Homebrew publication remain pending.
