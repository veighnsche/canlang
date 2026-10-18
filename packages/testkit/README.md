# @canlang/testkit

Inline-BDD runner. Executes COMPILED example artifacts row by row,
each row in a fresh isolated scope, and assembles machine-readable
`ExampleReport`s. The runner never interprets `.can` and never bypasses
production admission: row specs carry `setup`/`invoke`/`observe` closures
loaded from emitted test modules. Missing invocation support reports
`unsupported`, never a pass.

Core §5.1 rules enforced structurally:

- A `setup` throw is `setup-failed`, even when the row expects `error(code)`.
- Only an exact business error code plus a deep-equal state snapshot
  satisfies an expected rejection.
- Unexpected throws and observation mismatches are `failed`, never passes.
- `unsupported` paths report `unsupported`, never pass or fail.

## Native row resources and D1 snapshots

The native development owner allocates each example row's Worker and distinct
Identity/owner databases, then releases them after the canonical row runner joins.
The former `createLocalRowScope` Worker allocator is retired.

`snapshotLocalDatabases(host, bindings)` reads already allocated D1 bindings through
`host.getD1Database(binding)`. It includes every effect-capable table, preserves
single-database snapshot shape, and groups multiple stores by binding. Engine fences
and canonical rejected receipts are admission bookkeeping; committed receipts and
domain writes remain visible. This helper allocates no runtime or database.

## Seed vocabulary

Row `seed` entries are scenario refs, `<provider>:<scenario>` (lowercase
kebab-case, e.g. `mail:send-retry-success`), parsed by
`parseSeedRef`/`parseSeedRefs` (`src/fixtures/seeds.ts`). Each ref selects
one provider-authored scenario table played back per call inside the row
scope.

## Optional Node Chromium producer

An invoking application can install Testkit and resolve
`@canlang/testkit/browser/chromium` from its own package boundary. This
Node-only leaf declares optional `@playwright/test` and is absent from
the root entry. It neither downloads browsers nor imports into the portable
Worker runtime.

Node consumers that already depend on Contracts use
`ChromiumProducer` and `OwnedChromium` from the type-only
`@canlang/contracts/browser/chromium` leaf. Testkit re-exports the same types;
`OwnedChromium.browser` is the genuine Playwright `Browser`. Contracts declares
that driver's types as an optional peer, without requiring the driver for its
ordinary root. Cloudflare can describe the application-installed producer
through this port without adding a reverse dependency on Testkit.

`chromiumAvailability()` returns `available: true` with the actual
`identity.driverEntryPath` and `identity.executablePath`, or `available: false`
with `driver-not-installed` or `executable-not-installed`. Broken installed
exports, entry/API/loading failures and executable permission errors throw.
Availability supplies capture inputs; the application owns producer/source
currency checks and actual UI qualification.

`acquireChromium({ signal?, timeoutMs? })` returns the real Playwright
`browser`, the same identity shape and an idempotent awaited `close()`.
Always await `close()` in `finally`, including cancellation. The default
launch bound is 30 seconds; the supplied bound must be positive and finite.
An aborted signal closes an acquired browser. Cancellation during launch
waits for the bounded Playwright launch to settle and closes before rejecting;
the locked driver has no launch signal port. Only its declared Chromium
executable is used, with no system-browser fallback.

Compiled behavior tables may carry `selectorChannels`, a dense array aligned
with `selectors`: `input` applies the full path to operation inputs, `request`
applies a `request.*` path to wire-envelope overrides, and `caller` belongs to
`as`. Compiler supplies this checked distinction; a lexical input named
`request` remains an ordinary input, including a whole value supplied by a row
cell. The loader copies the routing metadata before asynchronous closures run,
rejects malformed or inconsistent channels, and forwards the checked channels
to `prepareRowCells` for input-only fixture materialization. Older tables that
omit the metadata retain their existing `request.*` wire-envelope behavior.
