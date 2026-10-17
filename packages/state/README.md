# @canlang/state (internal)

The one authoritative commit engine for CanLang (lane 03). It implements canonical
operation admission, authorized record queries, CRUD/invariants/locks/hooks, D1
revision-fenced and Durable Object local transactions, receipts/history/outbox/
schedule atomicity, and owner-local migration execution.

Generated programs import the thin `@canlang/stdlib` facade (lane 03 assembly),
which re-exports producer surfaces. This package never imports that facade back.

## Layout

- `src/catalog.ts` — versioned machine-readable entry manifest.
- `src/errors.ts` — safe business rejections (`StateError`, stable codes).
- `src/invocation/`, `src/query/`, `src/policy/`, `src/mutation/`, `src/storage/`,
  `src/migration/` — engine modules (land slice by slice; see
  `docs/implementation/status/lane-03.md`).
- `src/ports.ts` — constrained transaction/read/system-command ports for lanes 4/6/7.
- `test/` — `node:test` suites; storage suites run against real miniflare D1/DO APIs.

## Contracts

Shared boundary types live in `packages/contracts/src/state.ts` (lane 03 owned) and
are imported here by relative source path until lane 07 assembles the workspace and
`contracts` index. Engine-local descriptor/codec shims needed before lanes 01/02 land
are marked interim and replaced at those joins — never a second catalog.

Singular newly-created scenario model results can retain an original `first`
query through the existing query influence and saved association profile.
`selectScenarioReceiptQueryFirstRow(call, store, { query })` awaits source and
ancestor grants, then consumes the completed query handle once at its original
owner stage and returns the genuine first owning row or null. The native host
must privately bind that row before ordinary field observations and mutation;
the selected projected record is insufficient. All original matches, false
candidates, lazy executed markers and ordering remain saved; query limits still
refuse overflow. Current full source field and Identity authority are checked
against actual final effects and saved disclosure without predicate replay.
`bindScenarioReceiptQueryCount(call, store, { query })` consumes a count-only
occurrence at that same original stage and derives the exact bigint from the
private complete matched set. First and count consumption are mutually exclusive
and once-only per occurrence. Counting requires no first-row read, and cannot
certify native containment queries or subsequent arithmetic.
General scalar query influence and other model-result profiles remain unsupported.

`createFileReferenceConsumer` is the owning current File read and retention-fact
consumer. Bind it to the trusted app/team/owner store, the same loaded canonical
and artifact models, loaded `valueTypes` when present, current operation registry,
policies and Identity reader, with finite `maxRows` and `maxReferences` bounds.
`observeReferences(ref)` enumerates all committed direct and embedded File slots,
including archived retained rows and duplicate nested array positions. Each fact
retains its owning model, row/version, top field and relative wire `path`; the
legacy `index` is the top array position. Malformed wires, incomplete declarations,
overflow or a changed State revision refuse completeness. The observation and its
`revalidate()` grant no read permission and provide no cross-store deletion lock.

`read({model, recordId, field, ref}, authenticatedCaller, consume)` requires the
exact current whole-field grant (including its row predicate), owning model and
parent reads, current row lifetime, complete wire and coherent Identity facts.
It checks those same bindings and the original State revision before and after
one physical byte callback, then returns detached bytes or null. The host closes
`consume` over Files' genuine current policy/lifetime/digest-verified reader and
original physical receiver; the current authorized reader is a separate identity.
Host credential provenance, native download wiring and serialization through
retention deletion remain owning host/Files integration requirements.

The trusted D1 owner router accepts `fileRetirementAuthority` and
`fileReferenceProducers` on its existing `TrustedD1OwnerBinding`. Pass the original
State/Files assignment and actual same-load owning framework exports. The D1
constructor captures both before inspecting the database; the router retains that
same registered adapter while guarding receipt app/owner identity. A resolver
whose binding requires the authority returns a typed `FileReferenceStoragePort`,
including durable inventory, retirement and migration methods after physical
reopen. Existing bindings retain the generic `StoragePort` API.

The assignment's app and physical receiver owner must match the resolved route.
Its `stateOwner` remains the installed package/snapshot owner. The existing
persisted owner pin, complete declaration census and revision transaction still
govern issuance; copied ports lack the original migration validator binding.
The genuine physical Files transaction and native owner routing need their
separate owning consumer qualification.

`queryGenerationCallbackDiagnosticsForViewer` keeps callback authority separate
from ordinary delivery grants. An installed `callbackRead` evaluates the checked
source predicate with State's coherent Identity context and observed row/revision/
fence; it is exclusive with the legacy `callbackPolicy`. Ordinary current row,
delivery identity and live readable parent-chain permissions remain required.
After authority and exact association checks, installed `resolveOrigin` derives
the genuine original request revision and declaration; it is exclusive with a
legacy `origin`. Authorized absence needs neither origin nor Work lookup. State
revalidates Identity and its revision before Work and after evidence awaits.
These functions come from the verified host, never request data. Native checked
ordinary predicates can also use the reader's existing `readPolicies` map. A source
entry supplies exact declared `fields`, typed `secretFields`, checked `parent` and
ordered `grants: [{fields, read(observation)}]`; the loader expands omitted selectors
before binding each original rule, including its `where` clause. State captures
these declarations before awaits, calls every predicate in ordinal order under
tracked Identity, derives visibility and exact delivery-identity authority from
matching selectors, and refuses secret identity or any unreadable live ancestor.
This reader-local entry adds no placeholder grants to the global policy table.
The native decoded row/relation binding and original-app rendering need their own join.

## Build and test

Stored `File[]` child CALL arguments use the existing receipt dependency path.
The checked static `ScenarioReceiptCallSite.fileInputs` names each exact parameter
and original stored dependency ID. Before entering the child, the native adapter
reports the genuine current-stage owner row through
`observeScenarioReceiptDependency`, with `files` containing one genuine receiving
Files observation for each distinct reference. The stored wire retains order and
duplicate occurrences; an empty array still needs its declared source capture.
Bind the original ordered source/ancestor `readPolicies` and the installed Files
producer before execution. Copied rows/observations, stale stages, incomplete
censuses, absent/null nonnullable fields and unbound slots refuse and poison caught
owner failures. The child consumes the capture once and must receive the exact
captured wire. Other File/Delivery argument profiles remain unsupported.

The original row/type/version and File facts survive in the existing receipt
observation. Commit and recovery recheck whole-field/ancestor grants, full Identity
facts, source lifetime, current physical bytes/receiver/retention and the State
fence. Recovery uses the saved values without executing the child. The defining
State tests use real Files SQLite observations and hand-built descriptors;
Compiler occurrence emission and genuine native capture need their own adoption.

Reserved scenario row IDs use the existing return dependency with `field: "id"`
and `type: "text"`; the value comes from row metadata. Bind the original source
`readPolicies` through `bindScenarioReceiptReferenceProducer` before execution.
`observeScenarioReceiptRowId(call, store, { dependencyId, model, row })` accepts
only the actual current-stage owner row and returns its ID. The alternative
`{ dependencyId, model, reference }` accepts this call's exact `recordRefs` entry,
including before or after later owner updates. It retains that admission's
original row and version without renewing issuance. The general dependency
observer can capture `id` from a current owner row as well.

Any actual source row grant exposing a record permits its ID metadata; complete
ancestor, Identity and checkpoint checks still apply. Capture rechecks authority
after its common load, and the private commit guard checks final owner effects
or the actual captured effects for an admitted reference without an owner.
Copies, stale rows, other calls/models/sites, removal, archive, replacement and
lost source/ancestor authority refuse. Saved recovery retains the original
observation, applies the consuming definition's current original source grants,
and never executes the source or child. The defining component tests qualify
this State seam; original Compiler occurrence emission and Dev native capture
remain separate prerequisites.

```sh
bun install --frozen-lockfile   # from the repo root
bun run --filter @canlang/state typecheck
bun run --filter @canlang/state test
```

Dependencies are exact-pinned; the single root `bun.lock` is lane 07 owned.

`build:emit` also bundles the original `test/storage/do-test-worker.js` with
the actual emitted DO adapter and its declared dependency closure into
`dist/test/storage/do-test-worker.js`. Internal loaders and the public
`@canlang/state/testing/storage/do-test-worker` export use this built asset.
The worker protocol and real Miniflare SQLite/transaction assertions stay
unchanged. Missing or browser-incompatible dependencies fail the build; the
bundler removes its old asset before attempting to rebuild it. The test worker
is not a production deployment or a substitute for owning adapter qualification.

Both artifact and canonical descriptor loading retain explicitly declared model
field nullability and the complete checked delivery descriptor, including ordered
result leaves and their constraints. Delivery metadata is copied from own data
before freezing; getters and inherited claims supply no declaration authority.
Source Judgment leaves must match their complete checked nominal declaration.
This metadata preserves correspondence; it grants no delivery or File permission.
