# Native development server

This independent crate implements the Rust owner and Ratatui presenter described
in [T14–T17](../docs/implementation/can-dev-server/PLAN.md). The installed command
still uses the TypeScript controller until the complete manual parity and
distribution checks pass. Native help lists command families that remain open.

From this checkout, build the Cloudflare producer closure and Values catalog,
then build this crate with the repository's resource settings:

```sh
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path dev-server/Cargo.toml
CAN_DEV_BIN="$PWD/dev-server/target/debug/can-dev" compiler/target/debug/can dev ui --source App.can
```

When using a compatible `CARGO_TARGET_DIR`, point `CAN_DEV_BIN` to that target's
`debug/can-dev`. The compiler dispatcher is unchanged. `CAN_DEV_RUNTIME_HOST` and
`CAN_DEV_NODE` explicitly select the subordinate bridge and Node executable for
local integration; packaging their installed defaults belongs to T17.

`ui --source` owns a foreground manual session; `ui` attaches to a verified
existing owner. Enter submits the displayed commands. Ctrl+C stops an owned
session and detaches an attached view. Failed cleanup retains control and blocks
new allocation until an explicit retry succeeds. Plain and redirected output
use stderr; explicit JSON controls use stdout. Routine status exposes only the
non-secret origin; `preview.open` explicitly mints private browser access.

The owner loop selects generations, captures and checks inputs, and retains
cleanup handles. Blocking work returns identified facts to that loop. The
subordinate runtime host configures Workerd and local bindings; it cannot publish
a generation or schedule another check. Private process groups cover the supported
non-detached runtime descendants, with bounded shutdown and conservative release
confirmation. A log line is never a readiness fact.

Run focused native checks with `cargo test --locked --manifest-path
dev-server/Cargo.toml`. Process and HTTP tests require permission for local Unix
sockets, loopback listeners and signaling their own child process groups.
