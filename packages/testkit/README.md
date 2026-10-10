# @canlang/testkit

Lane-07 inline-BDD runner. Executes COMPILED example artifacts row by row,
each row in a fresh isolated scope, and assembles machine-readable
`ExampleReport`s. The runner never interprets `.can` and never bypasses
production admission: row specs carry `setup`/`invoke`/`observe` closures
that a future lane-1 artifact loader will build from emitted test modules
(handoff recorded in the lane-07 status file). Until that join lands, only
`test/` doubles exercise the runner; production paths use
`unsupportedInvoker`, which reports `unsupported`, never a pass.

Core §5.1 rules enforced structurally:

- A `setup` throw is `setup-failed`, even when the row expects `error(code)`.
- Only an exact business error code plus a deep-equal state snapshot
  satisfies an expected rejection.
- Unexpected throws and observation mismatches are `failed`, never passes.
- `unsupported` paths report `unsupported`, never pass or fail.

## Seed vocabulary (S8d decision)

Row `seed` entries are scenario refs, `<provider>:<scenario>` (lowercase
kebab-case, e.g. `mail:send-retry-success`), parsed by
`parseSeedRef`/`parseSeedRefs` (`src/fixtures/seeds.ts`). Each ref selects
one lane-04-authored scenario table played back per call inside the row
scope; the playback interpreter lands with the B2 slice. See the lane-07
status file for the decision record (scenario-data over fixture-server,
JEV evidence, escape hatch).

## Optional Node Chromium producer

An invoking application can install Testkit and resolve
`@canlang/testkit/browser/chromium` from its own package boundary. This
Node-only leaf declares optional `@playwright/test` 1.63.0 and is absent from
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
