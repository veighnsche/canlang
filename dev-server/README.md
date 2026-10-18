# Native development server

This crate implements the Rust development-session owner and Ratatui presenter.
The installer packages this native entry beside the compiler and bundled runtime host.

From this checkout, build the Cloudflare producer closure and Values catalog,
then build this crate:

```sh
CARGO_TARGET_DIR="$PWD/compiler/target" cargo build --locked --manifest-path dev-server/Cargo.toml
CAN_DEV_BIN="$PWD/compiler/target/debug/can-dev" compiler/target/debug/can dev ui --source App.can
```

When using a compatible `CARGO_TARGET_DIR`, point `CAN_DEV_BIN` to that target's
`debug/can-dev`. The compiler dispatcher is unchanged. `CAN_DEV_RUNTIME_HOST` and
`CAN_DEV_NODE` explicitly select the subordinate bridge and Node executable for
local integration. Installed defaults resolve the same release's Node/bridge;
the public compiler launcher and explicit overrides remain unchanged.

`ui --source` owns a foreground manual session; `ui` attaches to a verified
existing owner. Enter submits the displayed commands. Ctrl+C stops an owned
session and detaches an attached view. Failed cleanup retains control and blocks
new allocation until an explicit retry succeeds. Plain and redirected output
use stderr; explicit JSON controls use stdout. Routine status exposes only the
non-secret origin; `preview.open` explicitly mints private browser access.
The JSON and terminal controls share captured diagnostics, safe failure lookup,
isolated examples and retained single-row reruns, construct help and local ranking.
Construct support follows the authored reference and owning package catalogs;
external disclosure is disabled by default.

The owner loop selects generations, captures and checks inputs, and retains
cleanup handles. Blocking work returns identified facts to that loop. The
owner derives Workerd configuration and local bindings; the subordinate host
invokes fixed SDK methods. It cannot publish a generation or schedule another
check. Private process groups cover the supported non-detached runtime
descendants, with bounded shutdown and conservative release
confirmation. A log line is never a readiness fact.

Run focused native checks with `cargo test --locked --manifest-path
dev-server/Cargo.toml`. Process and HTTP tests require permission for local Unix
sockets, loopback listeners and signaling their own child process groups.
