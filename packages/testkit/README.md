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
