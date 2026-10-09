# `can dev` session, failure evidence, replay and control

**Status:** selected pre-implementation contract for the first local Unix profile. It defines what the development service should expose, not an existing `can dev` command, daemon, trace stream or replay engine. The [Generation feasibility check](evaluation/can-dev-generation-local-20261009/README.md) limits what can currently be demonstrated. The [three Jev comparisons](jev/can-dev-session-control-20261009/assessment.md) advised the transport and replay choices; they are not runtime evidence.

## One isolated session per checkout

A session is one server lifetime for one **canonical checkout/worktree root**, one selected `.can` app and one capability profile. `realpath` of the checkout, not a branch name or shared Git common directory, establishes the workspace boundary. The server generates an opaque random session ID and binds it to the current OS user, root, app and profile. In the first profile, only one live session owns a checkout; agents working on the same checkout may deliberately attach to it, while independent work uses separate worktrees. Selecting another app or profile ends that session and creates another with fresh resources. Source edits keep the session and advance its revision. A Git commit is context, never a source revision.

The session owner keeps a private, owner-readable descriptor and an exclusive claim for the canonical root in an OS user runtime directory **outside the checkout**. A root hash is only an index, not authorization. The descriptor records protocol version, session ID, selected app/profile, root identity, local control endpoint and process start identity. Discovery may attach only to the sole live session for this exact root; an explicit session ID selects it otherwise. The client verifies an owner-only endpoint handshake returning the same root, app and ID. A PID or stale descriptor alone is never attachment evidence. Source paths and generated paths must stay within the root or the session-owned staging directory after symlinks are resolved.

Each check captures the exact input closure defined in the [revision contract](can-dev-error-contract.md): sorted logical `.can` paths and byte hashes, selected app, compiler binary identity, catalog, help index, profile and semantic options. `source_revision` hashes source membership and bytes; `revision` is a monotonic session epoch over that source set **and** non-source inputs. The selected app is fixed for the session. The compiler should consume the immutable capture under its logical paths; until it can, the owner must compare the compiler's returned per-source hashes and complete membership with the capture before publishing a current result. If full closure discovery or coherence cannot be established, report `capture_incomplete`; an explicit-file check is not a whole-app check.

Watcher notifications mark the session dirty and schedule a capture; they do not certify its contents. Debounce edits, reconcile additions/removals/renames on explicit checks and after uncertain watcher events, and serialize publication by revision epoch. An obsolete check may be retained as `current:false` but cannot replace newer diagnostics or preview state. The session keeps separate `source_revision`, `check_revision`, `build_revision` and `serving_revision`. A build revision identifies the actual artifact, browser resources and runtime profile, not just the `.can` hash. A failed check has no new successful build.

The preview uses one session-owned worker and D1 scope per **serving build**. A successful replacement is prepared and checked before it becomes the serving build; the first profile creates fresh preview data for that build and reports the reset. A failed rebuild leaves the previous healthy preview available with `stale:true`, its old serving revision and the current dirty/check revision both visible. If no healthy build exists, return `preview_unavailable`. Old evidence may remain addressable under a bounded retention policy, but an evicted revision returns `revision_unavailable` rather than current data. The same check/build cannot be marked ready solely because compilation succeeded: required runtime resources and preview startup must also pass.

Preview state is separate from examples. Each example row gets a fresh workerd/D1 namespace and caller/fixture scope; a row cannot inherit preview writes or another row's mutations. Worker names, D1 IDs, staging paths and evidence IDs include the session and scope identity. The session owner closes its listener, disposes workers, terminates owned child processes and releases its descriptor/claim on stop or crash recovery. Existing [`startLocalDev`](../packages/cloudflare/src/dev/local-run.ts) and [`createLocalRowScope`](../packages/cloudflare/src/dev/row-scope.ts) provide disposable runtime pieces, but neither implements this session lifecycle. The test-only [loopback bridge](../tests/e2e/bridges/http-bridge.ts) proves an HTTP route; production must accept only loopback bind addresses and use an ephemeral port by default.

The control endpoint is private to the owning local user. The initial Unix implementation uses an owner-only directory and Unix socket, verifies peer identity where available, and never binds control to TCP. The preview is a separate loopback HTTP origin. Only an explicit preview-open action returns a short-lived bootstrap URL; it establishes an HttpOnly, SameSite preview cookie, redirects to a clean URL and does not substitute for the app's own identity and permissions. Validate Origin and CSRF on effectful preview requests. A random port alone is not authorization. Limit request size, process lifetime, retained evidence and output bytes. Treat `.can` prose, logs and provider responses as data. Live external providers are off in the first local profile unless an explicit resource configuration and normal business authority admit them.

## The smallest honest failure occurrence

The server wraps **owner records** rather than inventing a second explanation engine. The first compact occurrence contains only the following common fields; nullable fields stay absent when an owner cannot supply them:

```json
{
  "schema": "can.dev.failure.v1",
  "ref": "s7/r18/run3/f0",
  "session": "s7",
  "revision": "r18",
  "source_revision": "sha256:<full source-set digest>",
  "serving_build": null,
  "origin": "example",
  "phase": "setup",
  "code": null,
  "summary": "fixture setup failed",
  "owner_ref": {"operation": "App.action", "row_index": 0},
  "at": null,
  "evidence": {"state": "partial", "missing": ["structured_example_location"]},
  "detail_ref": "s7/r18/run3/f0/detail"
}
```

The example is schematic; no present server emits it. `ref` names one captured observation, not a cross-run causal identity. Compiler diagnostics use their canonical index; example and HTTP observations additionally use a unique run/request ID. `origin` is one of `compiler`, `example`, `http`, `invocation` or `delivery`, and `phase` retains the owning subsystem's vocabulary. `code` is the owner's actual diagnostic/business code or null. `summary` is a bounded, safe rendering. `serving_build` is required for preview/runtime observations and absent for compile-only failures. `at` distinguishes an exact compiler byte span from an optional source-map **point**; it never upgrades a point into a range. `evidence.missing` lists expected but unavailable facts for that origin, while unrelated stages are simply inapplicable. A possible cause from Jev or a heuristic is a separate advisory object, never an observed boundary.

| Owner | Evidence currently available | Limit on the first explanation |
| --- | --- | --- |
| Compiler | Versioned diagnostics, exact source SHA-256, primary/related UTF-8 byte spans, `complete` and `omitted` from the [diagnostic contract](../packages/contracts/src/diagnostic.ts). | These cover supplied files, not automatic full-app closure, root cause or runtime behavior. Related diagnostics are not a proven causal chain. |
| Testkit | [Example reports](../packages/contracts/src/examples.ts) identify artifact digest/source revision, operation, row/step, caller, outcome, mismatches and expected rejection with side-effect proof. | The current CLI executes zero rows; source locations are not structured in the report, and side-effect proof only covers resources actually snapshotted by the selected scope. Setup/unsupported cannot pass as expected business rejection. |
| Invocation/source map | [`InvokeResult`](../packages/cloudflare/src/runtime/invoke.ts) may attach a mapped `.can` point to a throwing frame. | Mapping is optional; there is no general guard-by-guard trace, stable runtime trace ID or intermediate-value stream. `trace` must say unavailable when no owner evidence exists. |
| HTTP | The [business error envelope](../packages/contracts/src/wire.ts) and status provide safe code/message and optional operation ID. | An unexpected internal incident is logged but its incident ID is not returned by the [operation handler](../packages/interfaces/src/http/operations.ts). HTTP status alone cannot identify the internal failing stage. |
| State/delivery | [Receipts](../packages/contracts/src/state.ts) retain operation identity, input hash, defaults, outcome and committed revision; [work records](../packages/contracts/src/work.ts) carry durable delivery provenance. | Observation and authorized lookup joins are incomplete. A committed-receipt observer does not cover every rejection or admission denial; provider timeout does not prove absence of an external effect. These are optional detailed evidence, not default trace claims. |

The compact response shows one failure and counts/cursors for the rest, following the [error response contract](can-dev-error-contract.md). Details are revision-bound and fetched explicitly. The first known **observed** boundary may be compiler analysis, example setup/invoke/observe, HTTP refusal or a mapped handler exception; it is not automatically the root cause. Preserve the owner's expected and actual values only in a bounded detail view after applying the effective example/request actor's access policy and redaction rules; without that actor context, withhold raw runtime values. Never print raw session tokens, provider bodies, stacks, source-map `sourcesContent`, receipt defaults/results, outbox payloads or full D1 rows in the compact response. Existing keyed logging cannot guarantee redaction of secrets embedded in freeform error messages, so those messages require a separate safe projection before agent or Jev use. Missing mapping, incomplete capture, omitted diagnostics, unavailable trace and uncertain external effects remain explicit.

## Rerun is not replay

The first profile may offer a **revision-pinned isolated example rerun** after the example loader and actor scopes work for the selected app. It starts a new run ID and fresh local data scope from the retained artifact and fixture recipe. It reports the original and new outcomes side by side, with changed/unknown inputs named. If the exact artifact was evicted, a required resource is unavailable, or the row is unsupported, it refuses rather than silently compiling current source. Generation currently cannot reach that action: `can test` fails to boot its artifact and its emitted first row fails fixture setup in the [feasibility check](evaluation/can-dev-generation-local-20261009/README.md).

`replay.available` remains `false` in the first profile. A future **execution replay** claim requires captured and restorable compiler/artifact/runtime versions, fixture recipes **and realized values**, actor/team/grants, clock/time zone, operation and generated IDs/random seeds, initial D1 and every other effect-capable resource, provider scripts/responses and their state, and any scheduler/interleaving inputs. The new run must verify that it restored the capsule and report deviations. Real external effects, unrecorded provider replies, ambient time/randomness, browser DOM state and asynchronous delivery without captured ordering make replay unavailable. A D1 snapshot used for side-effect comparison is not a restore capsule.

An operation's existing receipt `replayed` status means a matching idempotency key returns a saved outcome without rerunning the business body. Label it `saved_outcome`; it is not evidence that a failed execution was reproduced. Generic HTTP/browser request replay and live-provider replay are outside the first profile. Preserve a failure record for inspection even when neither rerun nor replay is available.

## First agent control transport: JSON CLI

Select a **JSON CLI** as the first agent-facing adapter to the long-lived session owner. A command starts or attaches to the owner through the private Unix socket; one bounded JSON envelope goes to stdout, human notes go to stderr. A machine-readable help command discovers the supported command schemas and protocol version. The CLI does not become the browser or business MCP server. The first command families are session start/discover/status/stop, check and diagnostics/help by revision, preview status/open URL, selected example run/rerun, and failure detail. Names and flags can be refined at implementation, but every stateful call must carry or resolve the exact session; a revision-dependent call must supply the expected revision or an immutable failure reference. Control failure and app diagnostic/example failure are different result classes in the envelope. Filters and revision-bound cursors keep responses small. Status returns both current source/check state and the build actually serving the preview, without minting a preview access URL.

| Same required operation | JSON CLI first | Local development MCP first |
| --- | --- | --- |
| Discover/attach session | Existing shell workflow; explicit session ID and owner-only local IPC; CLI help lists command schemas. | Native tool discovery, but host registration, session routing and endpoint access must be solved for each agent client. |
| Check, diagnostics, construct help | One bounded JSON result and cursor/reference lookups; polling for changes. | Typed calls and possible notifications; the same revision and content rules still need implementing. |
| Preview, example run, occurrence detail | Return the same URL, run ID and evidence references from the shared session owner. | Return those same facts with persistent tool connection. |
| First implementation burden | Extends an existing [JSON CLI convention](../packages/cloudflare/src/cli/platform.ts) and works for shell-capable agents. | Adds another public protocol/client setup while the auth, example and trace joins are still incomplete. |

Build a later local development MCP adapter over the **same** session core and evidence IDs after the CLI loop is qualified with unfamiliar agents. It must remain separate from the generated app's authenticated business `/mcp`; app grants cannot authorize development control, and control access cannot waive business admission. The CLI does not authorize Jev disclosure by itself: the [bounded ranking policy](can-dev-jev-ranking.md) and session/provider setting still govern any remote request. The transport choice favors broad immediate reach and one conformance surface; MCP's stronger native discovery remains a material reason to add it once the shared semantics work.

## Acceptance boundaries still open

- No session owner, watcher, Unix control socket, JSON `can dev` command, preview access cookie or production HTTP bridge exists yet.
- The current compiler's explicit file operands do not discover a complete app source closure; coherent captured-byte compilation needs qualification.
- Generation proves an anonymous compiled page and browser asset delivery, while generated auth, D1 state inspection and example execution remain unqualified. A first supported profile cannot claim those workflows until one same-app check passes.
- No runtime owner currently supplies a general trace stream or a complete deterministic replay capsule. Failure detail and replay availability must be driven by observed owner evidence, not by desired debug output.
- The three Jev responses favored JSON CLI and isolated rerun, but used an abstracted design packet and returned no rationale. Agent setup cost, total turns/tokens, accessibility across clients and rerun fidelity still need measurement.
