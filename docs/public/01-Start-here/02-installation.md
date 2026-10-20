# Install the CanLang toolchain

Install the complete standalone distribution to get the `can` compiler, matching catalogs, private runtime, runtime adapters, inline-example tooling, and deployment CLI together. The supported standalone platforms are macOS Apple Silicon and Linux x86-64 with glibc; the Linux v0.1.1 bundle requires glibc 2.39 or newer. No separate Rust, Node, Bun, or npm installation is required.

## Install and verify

Run this in a terminal with `curl` and Bash available:

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

The installer selects a release and verifies its downloaded archive against its SHA-256 checksum. It configures your shell PATH. Open a new terminal, then verify:

```sh
can --version
```

Write apps in your own folder; a repository checkout is unnecessary. Browser automation tools are a separate optional installation; ordinary source checks, inline examples, and local previews do not need them.

## Select a version and update

To install a particular release, pass its version explicitly, for example:

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash -s -- --version v0.1.1
```

To update, rerun the installer for the release you selected, open a new terminal, and recheck `can --version`. The installer retains the previous installed version. Select a toolchain compatible with your app and saved generated code. Installing a compiler does not change app identity or deployed schema.

Continue with [your first app](03-first-app.md). App release upgrades and schema changes have their own [deployment workflow](../10-Deployment/01-deploying-an-app.md) and [migration rules](../10-Deployment/03-schema-migrations.md). Exact command arguments live in the [CLI reference](../12-Reference/01-cli.md).
