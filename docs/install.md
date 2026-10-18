# Install `can`

Install the complete standalone distribution for application development. It supplies the `can` compiler, matching catalog, runtime adapters and private runtime together. The compiler-only and source-build routes later in this reference are optional paths for contributors and specialized compiler consumers.

## Complete standalone installation

The standalone bundle includes the compiler, matching catalog, private Node
runtime, production runtime dependencies, workerd, inline-example tooling
and the Cloudflare deployment CLI. Chrome, Chromium and Playwright are excluded. Users do not install Rust, Node, Bun
or npm dependencies separately.

Run the same installation command on either supported platform:

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

The public website serves the byte-identical installer from the qualified [v0.1.1 release](https://github.com/veighnsche/canlang/releases/tag/v0.1.1). It detects macOS Apple Silicon or Linux x86-64 with glibc, resolves one release version, and downloads the matching archive and SHA-256 checksum from that tag. The v0.1.1 Linux bundle requires glibc 2.39 or newer.

The installer configures your shell PATH. Open a new terminal, then run `can --version`. Write and run applications in your own folder; no source checkout, catalog build or runtime overrides are required. Follow the [first application tutorial](public/01-Getting-started/02-installation.md) and [local development guide](public/03-Build-and-operate/01-local-development.md).
The script supports pinned versions with `bash -s -- --version VERSION` after
the pipe. See the [website agent handoff](implementation/lean-install/website-handoff.md)
for the exact source, publication gates and copy-ready deployment prompt.

### Published standalone v0.1.1 — 2026-10-15

Tag `v0.1.1` pins commit `97bb83d925ffb7cb5cfb95494b3fd60626337caa`.
[Preflight](https://github.com/veighnsche/canlang/actions/runs/38799215069) and
[the tagged release workflow](https://github.com/veighnsche/canlang/actions/runs/38800630072) pass. All nine tagged jobs succeed:
both native compiler builds, library packing, editor assembly, both standalone
qualifications, draft publication and both public streamed-install checks.
Publication retains all seven existing assets, including the two separately
optional browser-tool sidecars; `v0.1.0` is preserved unchanged.

Both native qualifications pass all 21 checks: macOS 26.6.2 Apple Silicon and
Ubuntu 24.04.5 x86_64/glibc 2.39. The published Linux native symbols require glibc 2.39
or newer; other distributions and older hosts are not newly qualified.
The core retains private Node 24.22.0 and production runtime dependencies.
Browser automation remains a separate opt-in installation.

| Published platform | Download bytes | Installed regular-file bytes, including checksum marker |
| --- | ---: | ---: |
| macOS arm64 | 89,887,488 | 260,214,870 |
| Linux x64/glibc | 109,357,627 | 347,311,553 |

The workflow verifies all five public core URLs on both hosts:

- [install.sh](https://github.com/veighnsche/canlang/releases/download/v0.1.1/install.sh)
- [macOS archive](https://github.com/veighnsche/canlang/releases/download/v0.1.1/can-0.1.1-darwin-arm64.tar.gz) and [SHA-256](https://github.com/veighnsche/canlang/releases/download/v0.1.1/can-0.1.1-darwin-arm64.tar.gz.sha256)
- [Linux archive](https://github.com/veighnsche/canlang/releases/download/v0.1.1/can-0.1.1-linux-x64.tar.gz) and [SHA-256](https://github.com/veighnsche/canlang/releases/download/v0.1.1/can-0.1.1-linux-x64.tar.gz.sha256)

Each host streams the pinned public installer into Bash with no version override,
so default resolution selects the one latest tag `v0.1.1`, then fetches its own
matching archive/checksum. Temporary HOME, install and ZDOTDIR paths contain
spaces; Bash or Zsh sources the newly written shell configuration and runs
`can --version`. The installed manifest confirms exact version/platform and
private Node execution. The temporary directories are removed afterward.
The public installer is byte-identical to the tagged canonical source and passes
`bash -n`. The website deployed its static copy on 2026-10-15; an unauthenticated GET returns HTTP 200, the bytes match the pinned asset with `cmp`, and `bash -n` passes on the downloaded public script.

### Optional local artifact installation (contributors)

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

The macOS arm64 artifact has passed the complete external-app verification.
Linux x64 qualification and compatibility limits are recorded below; arbitrary
Linux distributions are not qualified. GitHub Release hosting is verified above;
a Homebrew tap is not published. The website curl command still awaits its static
installer deployment.

Earlier local macOS arm64 artifact (retained pre-release measurement): **90,087,787 bytes download (85.9 MiB)**;
**260,139,952 bytes installed files (248.1 MiB)**; **277,823,488 allocated bytes
(265.0 MiB on this filesystem)**. Filesystem allocation varies. App data,
package-manager caches and retained older versions are additional.
`output/install/size-report.json` is the generated breakdown. The previous
core used 404.1 MiB on this filesystem; this build is **34.4% smaller**.
Bun is now a contributor build dependency only. Dynamic application bundles use
Node and the same esbuild 0.28.1 already required by Wrangler. The assembler
removes local native symbols from Node/workerd (preserving dynamic exports),
re-signs the modified macOS binaries ad hoc, and verifies their execution.

The size report distinguishes the archive payload from `actualInstallation`,
which measures the installed version directory, including the installer's
65-byte checksum marker. `installedFileBytes` sums regular file lengths;
`allocatedFileBytes` sums their allocated blocks; `installedDiskBytes` also
includes directory blocks. Parent directories, public symlinks, application
state and retained older versions are additional. Allocation varies by filesystem.

### Linux x64 qualification — 2026-10-15

The existing Linux/glibc target was built and tested on **Rocky Linux 10.2
(Red Quartz), x86_64, glibc 2.39**, kernel `6.12.0-211.64.1.el10_2.x86_64`.
The local artifact is `can-0.1.0-linux-x64.tar.gz`; no version was changed.
All **21 installed qualification checks pass**, including installation through
Bash stdin in a disposable HOME with no host language tools on PATH, ordinary
check/build, original inline examples, protected local preview, automatic
R2/Durable Objects and model-free member-queue State provisioning. Chrome,
Chromium, Playwright and contributor tooling remain excluded.

| Measurement | Exact bytes |
| --- | ---: |
| Compressed download | 109,205,619 |
| Installed regular files, including checksum marker | 347,296,983 |
| Allocated regular files | 357,273,600 |
| Allocated installation, including directory blocks | 357,711,872 |

The archive itself contains 347,296,918 file bytes, 3,693 files and 155 package
identities. Installation adds the 65-byte checksum marker. These measurements
come from the generated `size-report.json` and `verification.json`.

Native execution checks cover compiler 0.1.0 with its matching catalog, private Node 24.22.0,
esbuild 0.28.1, workerd 1.20260730.1, Miniflare 4.20260730.0,
Sharp 0.35.2 with libvips 8.18.3, and Wrangler 4.116.0. The verifier checks
Linux x64 ELF headers and package OS/CPU/libc constraints, runs esbuild,
workerd and Sharp, and exercises Miniflare through real D1/Worker execution.
Wrangler bundling uses a dry run without account credentials.

This locally built compiler requires **glibc 2.39 or newer**. Node requires
2.28 and workerd 2.35; the compiler sets this archive's highest requirement.
The report lists required system shared libraries. Other distributions and CPU
generations have not been exercised; a matching glibc version alone is not a
qualification. Linux musl, Linux ARM and Windows are outside the existing
standalone targets. macOS assembly/signing support and its retained measurements
remain intact; macOS and the Linux browser add-on were not rerun here.

### Optional browser development tools

Browser automation is a separate opt-in installation, using Can's private Node. Core checks, inline examples and previews need no browser tooling and no manual Node, Bun or npm installation.

Public releases supply these sidecars in the separate
`can-browser-development-tools-VERSION.tar.gz` archive and its `.sha256` checksum.
Download both from the same release, verify the checksum with
`shasum -a 256 -c can-browser-development-tools-VERSION.tar.gz.sha256` (or
`sha256sum -c` on Linux), and extract the archive into an empty directory. Run
`sh install-browser-tools.sh` from that directory. The workflow artifact set
also contains the unpacked installer and adjacent `browser-development`
manifest/lock. This installer puts Playwright,
Chromium headless shell and ffmpeg under
`~/.local/share/can/development/browser/1.63.0`, outside the production install.
Measured additional files: **225,846,579 bytes (215.4 MiB)**; allocated disk:
**226,373,632 bytes (215.9 MiB)**, excluding package-manager caches. Browser
automation may require OS libraries on Linux; this add-on is verified on macOS arm64.
The installer verifies pinned package SHA-512 values using Node; no Bun or npm
executable is required. Set `CAN_BROWSER_TOOLS_ROOT` to select another separately installed tool root.

Core check/build, inline examples and local preview work without this add-on.
Mandatory browser acceptance reports missing development tools and stays failed
until they are installed; it never silently skips browser checks. Contributors working with a locally assembled artifact set can use `sh output/install/install-browser-tools.sh` instead of downloading the sidecars.
Service credentials and authored browser tests remain application inputs.
Git is needed only for explicitly requested `git:<revision>` rollback.

See [the bounded shipping audit](implementation/lean-install/README.md) for
retained files, dependency choices, verification and release gates.

## Optional compiler-only release artifact

This advanced route omits the full application runtime. Use the single-command standalone installation above for ordinary application work.

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
   `can 0.1.1 (commit 97bb83d; language 1.0; schema 1)`.

## Optional compiler build from source (contributors)

Needs Rust 1.99+ (see `compiler/Cargo.toml` `rust-version`):

```
git clone https://github.com/veighnsche/canlang.git
cd canlang/compiler
cargo build --release --locked
install -m 755 target/release/can ~/.local/bin/can
```

## Optional source workspace and release verification (contributors)

These instructions build and check CanLang itself. They are not prerequisites for using the standalone release. The [contributor guide](public/01-Getting-started/03-contributor-setup.md) covers complete source setup.

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
`PATH`. For `can dev`, build the independent Rust crate into the compatible
compiler target and set `CAN_DEV_BIN` to its `debug/can-dev`; see
[developer setup](dev-setup.md). Standalone assembly includes the native entry.

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
error, never silent output. The standard standalone installation already supplies this adapter; users do not install runtime packages separately.

## Environment

- `CAN_CATALOG`: producer catalog path for
  `check`/`compile`/`lint`/`policy` (below `--catalog`, above
  `./can-catalog.json`).
- `CAN_PLATFORM_BIN`: override path to the `can-platform` binary for the
  thin lane-7 entries (`run`/`test`/`build`/`deploy`/`activate`/`docs`).
- `CAN_DEV_BIN`: override path to the native `can-dev` owner and terminal entry
  for `can dev`.

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
its manifest records `inputMode: built-checkout`. Earlier local macOS qualification
covered all 13 package builds and the original 18 installed checks, including
API-only previews which provision R2/Durable Objects and a model-free member queue
automatically. The published release above passes the current 21 checks on both
native hosts. The verifier also checks that PATH contains no external language tools,
measures the actual installation and directly exercises the private native tools.
It supplies the canonical installer to Bash on stdin in a disposable HOME with
spaces, then runs the existing external-app checks. On Linux, the report records
ELF architecture, required shared libraries and maximum referenced glibc version.

The release workflow consumes the matching platform compiler artifact, assembles
and qualifies the standalone archive, and retains its checksum, size report,
verification report and canonical installer. Both Linux stages use Ubuntu 24.04.
The tagged v0.1.1 workflow passes both native qualifications, uploads the complete
asset set to a draft, then publishes it. Post-publication jobs verify all five core
URLs and streamed installation on both hosts. Local qualification and manual
dispatch do not publish. Website deployment and Homebrew remain separate.
