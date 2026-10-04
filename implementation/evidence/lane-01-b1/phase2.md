# B1 evidence, lane-01 — Phase 2 (post-PR6 main)

Branch: `muse/lane-01-language/b1-phase2`. Base: `origin/main` 08abe86 (PR #118 merged).
Status: **lane-01 half PROVEN** (real artifact a runtime can consume);
runtime consumption is lane 7's half (their `run` is still a
missing-producer stub — see below).

## What changed since phase 1

Phase 1 ran on a pre-PR6 shelf with `complete=false` and expected
`E6006` gaps. All phase-1 assumptions are retired:

- Analysis is complete (`complete=true`, PR5); emission is merged
  (PR6); the shelf is dropped (never merged).
- `compiler/tests/b1_join.rs` rewritten for post-PR6 reality with
  equal strictness (no weakening): production `EmitOptions::new()`,
  zero E1/E2/E3, `E6006=0` (bridged), `E6007=0` (real catalog pins
  every builtin), `E6008=10` (the pinned unlowered-UI positions),
  entrypoint markers from real emission, pages=2 with exports
  resolved, callables bound, `canlang.builtins` require pin, exactly
  the real `TeamTasks.Todo.update` suite with the normative §13
  `return {fixtures:{...},examples:[...]}` shape, JSON envelope
  `artifact_version` 1 round-trip. SKIPS loudly without
  `packages/values/dist/catalog.json` (hermetic CI); strict otherwise.
- BUG FOUND AND FIXED HERE: page descriptors were module-local
  consts while `artifact.pages[].export` named them as importable
  bindings (`js.rs` emitted `const {descriptor}=`). Now
  `export const {descriptor}=` per the artifact.ts contract; pinned
  by the strengthened `construct_pages` golden and a b1
  `export const {export}=` check per page.

## CLI end-to-end (demo.can)

Full `examples/TeamTasks.can` still exits 10 with exactly the 10
pinned E6008s (CLI policy: no artifact while emission errors
report — by design). `/tmp/lane01-b1/demo.can` (TeamTasks minus the
12 unlowered-factory lines) compiles clean:

```
can compile demo.can --catalog packages/values/dist/catalog.json --format=json  # exit 0
```

3 production modules (teamoffice entry + message-const shims),
6 CRUD operation callables, 2 page descriptors, 1 BDD suite,
requires `canlang.builtins@0,state@1`. Envelope VALID vs the
artifact.ts mirror probe (version, sha256-of-source, shapes, export
cross-refs, normative fixtures shape, no prod↔test imports);
`node --check` clean on all 4 emitted files.

## Loadability (consumability proof)

`/tmp/lane01-b1phase2/load.mjs` (scratch probe, mechanics
documented inline): stubs the exact `@canlang/*` imported names,
evaluates the entrypoint, and resolves every envelope reference:

- entrypoint evaluates; all 6 callable exports resolve with their
  qualified identities; `appDefinition.pages` aggregates 2.
- PRE-FIX (red, honest): both page-descriptor imports failed
  (`TeamTasksPageDescriptor not exported`).
- POST-FIX (green): both page exports resolve to descriptors with
  matching owner/path and function `render`.

This proves the artifact is CONSUMABLE. It is not a
runtime-success claim: no stdlib/UI bindings are linked (stubs),
and no operation is executed against state.

## Runtime state (lane 7's half, read-only finding)

`packages/cloudflare/src/cli/platform.ts` `run|test|build|deploy`
all exit 2 with missing-producer ("no L1 CompileArtifact emission
to execute yet") — stale since PR #116. E2E compiled-path loader
is a loud stub awaiting the same. A runtime scoping pass sizes the
B1-capable binding slice at ~2–3k LOC gated on two decisions
(admission-data source R1, model→DDL source R2); recorded for the
closeout. Handoff package for that work:
`/tmp/lane01-b1/{demo.can,artifact.json,validate.js,js/}`.

## Reproduce

```
(cd packages/values && npm run catalog)   # or bun equivalent
cargo test --test b1_join                 # strict with catalog, SKIPs without
cargo build && ./target/debug/can compile <demo.can> --catalog packages/values/dist/catalog.json --format=json
node /tmp/lane01-b1phase2/load.mjs <artifact.json>   # scratch probe, exit 0
```

## Test record (this branch)

314 green (43 lib + 29 analysis + 52 syntax + 30 authoring +
33 check + 21 codegen + 25 effects + 20 format + 27 ide +
29 lint + 4 foundation + 1 b1); `cargo fmt --check` and
`cargo clippy --all-targets -- -D warnings` clean.
