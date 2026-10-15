# SodaOS installer hosting handoff

The website is maintained on another computer. This checkout owns the installer
and GitHub release assets; the website owns the static public entry point.

## URLs and current gate

Public command after deployment:

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

Canonical file: `scripts/install.sh` in `veighnsche/canlang`.
Release page: https://github.com/veighnsche/canlang/releases
Stable installer asset, **available after the new release job publishes**:
https://github.com/veighnsche/canlang/releases/latest/download/install.sh

Each release publishes these core assets (`VERSION` excludes the `v` tag prefix):

- `can-VERSION-darwin-arm64.tar.gz` and its `.sha256`
- `can-VERSION-linux-x64.tar.gz` and its `.sha256`
- `install.sh`
- `can-browser-development-tools-VERSION.tar.gz` and its `.sha256` (separate opt-in tooling)

Downloads come directly from
`https://github.com/veighnsche/canlang/releases/download/vVERSION/ASSET`.
The website does not mirror the 86 MiB bundle or serve a dependency installer.
The core contains its own runtime; Chrome/Playwright remain separately opt-in.

As of this implementation, the existing `v0.1.0` GitHub release contains older
compiler/package artifacts, not these standalone assets. Do not point the public
install button at it. The new workflow needs a matching-version tag containing
the implementation and successful qualification on both supported hosts. Source
changes here are not automatically committed, tagged, pushed or published.
Website deployment is a separate external action. Homebrew is outside this change.

## Copy-ready prompt for the website agent

```text
Please add the CanLang shell installer to the existing SodaOS.dev website.

Serve the exact case-sensitive route:
  https://sodaos.dev/CanLang/install.sh

The CanLang repository owns the installer and binary releases:
  https://github.com/veighnsche/canlang/releases

Before deploying, confirm the latest release contains all seven assets:
  install.sh
  can-VERSION-darwin-arm64.tar.gz
  can-VERSION-darwin-arm64.tar.gz.sha256
  can-VERSION-linux-x64.tar.gz
  can-VERSION-linux-x64.tar.gz.sha256
  can-browser-development-tools-VERSION.tar.gz
  can-browser-development-tools-VERSION.tar.gz.sha256
VERSION is the release tag without its leading v. If any asset is absent, report
that release publication is still pending; do not advertise a working install.

Obtain the installer from:
  https://github.com/veighnsche/canlang/releases/latest/download/install.sh
Record the resolved release tag and use that release's pinned install.sh URL
when copying it into the website's static/public files. Preserve the file bytes.
Do not rewrite the installer or include binary bundles in the website repository.

Serve the script as plain UTF-8 text (text/plain or application/x-sh), with a
short cache lifetime or revalidation. Ensure this route bypasses SPA HTML
fallbacks, authentication, and page rendering. A static response is preferred.

Add a copyable installation command to the appropriate CanLang page:
  curl -fsSL https://sodaos.dev/CanLang/install.sh | bash

Mention macOS Apple Silicon and Linux x64 with glibc as the supported platforms.
The bundle includes its own Node/runtime dependencies; users need no manual
Rust, Node, Bun, npm or browser installation. Browser automation is optional
separate development tooling, not part of the default install.
The optional browser archive contains install-browser-tools.sh and its adjacent
browser-development manifest/lock; download and checksum-verify it, extract it
into an empty directory, then run the installer explicitly after core setup.

After deployment, verify an ordinary GET returns the script successfully over
HTTPS, compare its bytes with the pinned GitHub installer asset, and run
bash -n on the downloaded file. Verify both platform archive/checksum URLs exist.
If testing installation, use a disposable HOME/CAN_INSTALL_DIR, not your own
shell configuration. Report the deployed URL and exact GitHub release tag used.
```

## Local verification

The shell installer tests cover Bash/sh stdin installation, truncated transfer
refusal before any install mutation, latest GitHub resolution, pinned HTTPS
assets, checksums, archive safety, upgrade preservation and shell PATH setup.
A real existing macOS bundle was also streamed through Bash and its installed
`can --version` executed with a clean PATH. Website HTTP behavior and the next
release's hosted assets remain external qualification gates.
