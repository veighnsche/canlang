# @canlang/cloudflare

Cloudflare delivery. Two sides with a hard boundary:

- **Node side** (`@canlang/cloudflare`): deploy-plan generation, compatibility
  checks, install/upgrade orchestration and shared application runtime APIs.
  May use Node APIs, Miniflare, and spawned `wrangler`.
- **Worker side** (`@canlang/cloudflare/worker`): Worker entry assembly.
  Must import no Node builtins or Node-only packages; enforced by
  `test/worker-boundary.test.ts`.

`can dev` is implemented in the Rust `dev-server` owner. It owns capture,
compilation, configuration, retained preview state, examples and construct help.
`dev-server/host` makes fixed JavaScript SDK calls for Miniflare, module/AST facts
and browser access. The former TypeScript development controller and helpers are
removed. Private native-backed SDK fixtures support semantic tests and are
excluded from installed packages.

Native development checks are serialized and share the requesting connection's
cancellation lifetime with service shutdown. Canceled queued checks do not start
capture or compilation; a canceled prepared preview is disposed before the check
settles and leaves the prior serving build in place. Directory watchers pin their
attachment identity so replacement is reconciled before the slower fallback audit.

## Installed Worker bundling

Import `buildDeployBundle` from `@canlang/cloudflare/deploy/bundle` and pass
`{ verdict }`. Worker/MCP/HTTP entry files and producer module trees resolve
through installed package exports; a checkout root is unnecessary.

For explicit values WASM and browser assets:

```ts
import {
  buildDeployBundleWithAssets,
  writeDeployBundleWithAssets,
} from "@canlang/cloudflare/deploy/bundle";

const bundle = buildDeployBundleWithAssets(artifact, {
  verdict,
  assets: { valuesWasm: true, browser: true },
});
writeDeployBundleWithAssets(bundle, outputDirectory);
```

The bundler verifies producer manifests before staging bytes. Values bindings
and WASM belong to the Worker inventory; browser scripts/CSS are separate
`bundle.resources` entries for host asset serving. Selection does not initialize
or change the backend. The writer verifies both inventories before writing and
requires canonical output parents, rejecting existing symlinks. Browser routing
is still the serving host's responsibility.

## Account invitation mail

Generated Cloudflare hosting accepts an optional trusted `CAN_AUTH_MAIL` service
binding alongside the canonical `CAN_AUTH_ORIGIN`. Bind a Worker RPC entrypoint
implementing `sendMail(to: string, subject: string, body_text: string): Promise<void>`.
The configured service owns sender identity and provider credentials. Requests
and app source cannot select another service or change the trusted invitation
origin. Missing mail leaves mail-dependent flows unavailable; malformed binding
configuration refuses before serving-store initialization.

The service must reject failed or unknown provider outcomes and return no value
only when it acknowledges the request. This acknowledges the service, not inbox
delivery. Invitations persist the original offer/message and claim before one
service call. Lost acknowledgements remain `unknown`; HTTP/MCP retries retain
that original and do not resend. This port provides no provider reconciliation.
It is separate from an app's source-declared `std.EmailV1` capability.

## Explicit native builtin catalog

`@canlang/cloudflare/distribution` exposes `distribution.nativeCatalog`, the
installed `dist/native-catalog.json` emitted by the owning build. Pass its local
path to the Compiler's existing `--catalog` input for the native Cloudflare
facade. The artifact derives every signature, effect, feature and entry from
Values, changing only `builtin:active_member` availability to `implemented`.
Generic Values keeps that entry `external`; default catalog selection is unchanged.

Emission requires the actual native `active_member` export to be the owning
function. It refuses incomplete producers and removes stale native catalog output.
Availability does not create a membership frame or authorize a call: original
checked source/marker, owning State/Work execution, current Team and awaited
lifetime restrictions remain required by their producers and Compiler lowering.

## Deployment links

Set optional `CAN_DEPLOYMENT_BASE` to the trusted HTTP(S) root base for the
installed app, for example `https://app.example/`. The host preserves this
configuration separately from `CAN_AUTH_ORIGIN` and forwards it to page and
handler contexts. `app_url(path)` requires that context when executed; request
headers and auth origins supply no fallback, and a generated link grants no
access. Nonroot mounts currently refuse until all route and link consumers are
joined. Protected local previews supply their actual bound loopback root base
and reject overrides pointing elsewhere.

Page-only previews retain the same source, activation, resource and Identity
checks. Their authenticated MCP discovery must be empty when the checked app
declares no operations. Readiness probes the declared root page, or the first
declared page when the app has no root route.

Cookie-authenticated `POST /mcp/grants` requires an active team membership,
`application/json`, and the session-derived `x-csrf-token` (or `_csrf` body
field). The header takes precedence. The owning JSON parser caps the body at
1 MiB; unsupported or malformed JSON returns 400, overflow 429 and missing or
invalid CSRF 403. Protected preview readiness forwards its session-derived CSRF token.

Login descriptors bind their token to the host-only `can_presession` cookie.
Native clients forward that exact cookie with `_presession` and read the distinct
`can_session` response cookie. A presented Origin must match the configured
canonical auth origin. HTTP/MCP credentials are checked again before invoker
entry; revocation after entry does not cancel canonical work already entered.

## `can-platform` CLI (L1 IR-03 delegation target)

Thin `can run|test|build|deploy` entries exec this binary, resolved from
`node_modules/.bin` after workspace install:

```
can-platform <run|test|build|deploy> --artifact <path> [--env <name>]
can-platform --help | -h | --version | -V
```

Exactly one JSON envelope on stdout on every path (`--help` included,
as `{ok:true,name,version,usage}`); human text on stderr only. `--help`
is honored in subcommand position too (`can-platform run --help`),
because L1 thin entries pass flags through verbatim. Exit 0
carries `{ok:true,...}`; exit 2 carries `{ok:false,command,code,detail}`
with `code` one of `usage`, `missing-artifact`, `missing-producer`
(names `producer` + `contract`), and exit 1 `internal`, `command-timeout`
or `command-cancelled`.

`can-platform run` assembles modules and returns a local `file:` entry URL.
The successful staging directory remains after CLI exit; the caller owns its
removal when finished. This command does not start a Worker listener or promise
a retention period against caller/system temporary-file cleanup. Failed assembly
or reporting attempts scratch removal while preserving the original failure.
`can dev` owns its runtime resources until confirmed `can dev stop`; protected
preview URLs expire when their preview owner disposes them.

Normal commands share one cooperative budget from argument parsing: 60 seconds
for `run`/`build`, 300 for `test`, 120 for deploy preview and 360 for confirmed
deploy. SIGINT/SIGTERM cancel the same lifetime. Stage checkpoints refuse late
success; the example runner receives its cancellation signal, and acquired
cleanup is awaited before reporting. Cleanup may exceed the budget. Each of the
three Bun stages uses the lesser of 30 seconds and the remaining command budget,
with SIGKILL and a 1 MiB captured-output cap. Wrangler similarly uses the lesser
of 180 seconds and the remaining budget. Synchronous stages observe signals at
their next checkpoint. These controls do not guarantee an absolute process exit
time or descendant termination. Compiler and control budgets belong to their
separate callers. Cancellation after publication reports known written files;
after an attempted apply, the remote outcome is unconfirmed and requires
inspection before manual retry. There is no automatic retry or remote rollback.

Native private cohorts use State's bounded physical identity, row, child-page
and anchor ports under the original source or retained-turn revision. The
selected profile allows 1,000 frozen members, 100 per transport page/chunk,
200 UTF16 code units per identity component and 6,000 per compound identity.
Retained turns advance their read revision only after a successful owned commit;
external changes refuse rather than refreshing stale intent or coverage.
Original saved logical transport bounds are retained, including older values
above 100; actual capture, admission and installed scheduler calls cap at 100.
Child pages retain terminal and held rows, and navigation wraps only on an empty
page. Staged overlays cannot serve these physical checkpoint reads.

Confirmed deployment preflights both plan/TOML sidecars with the bundle writer's
canonical-root and existing-entry checks before writing deployment output.
Pre-existing symlinks and file/directory collisions refuse. Publication remains
sequential: after a write failure earlier files may remain, the original error
is retained, and apply is not attempted. Concurrent path replacement is outside
this static preflight guarantee.

To execute compiled example rows with `can test` or `can-platform test`, the
invoking application explicitly installs both `@canlang/cloudflare` and
`@canlang/testkit`. Run the command from that application's root. Testkit
resolves through the application's package installation and exported entry;
Cloudflare does not supply it transitively because Testkit already depends on
Cloudflare's local row runtime. An absent installation reports
`missing-producer`; module initialization failures and malformed producer
exports retain their own errors. Source capture, activation, compiled rows,
and the portable Worker prerequisites still apply.

## Trusted local File maintenance

The internal Node host `src/runtime/file-retirement.ts` composes
`createNativeFileRetirementBinding` from an original verified assembly,
current Identity team, trusted owner D1 database and State store ID, and the
actual SQLite File store. Supply explicit retention and complete census bounds.
Its original `store` and `ownerStorage` route participating canonical writers;
`bindings` supplies the actual Files kernel. A physical store has one permanent
receiver/State assignment. Additional State databases require atomic guard
participation and are outside this profile.

Installation requires the complete checked canonical, artifact and value-type
inventory plus the actual same-load State/Work framework producers. Missing
value declarations, mixed migrations, changed assignments and opaque framework
payloads without original checked correspondence refuse. Capture every original
own contract declaration and literal default from the verified entry before
normalization or another await, preserving raw wrappers and native integer
constraints through the Values wire codec. Install actual callable input/result
profiles and this detached closure in the same State inventory transaction;
reopen compares source correspondence and retains the persisted original closure.
Missing result metadata supplies no explicit void proof. Empty contracts require
the compiler's explicit `valueTypes: {contracts: []}` inventory.

The complete native retirement/reopen consumer retains unused declarations,
null/false/empty and padded literal defaults, absent defaults and exact integer
constraints. Compiler's File contract collector and State's original wrapper
admission are owning prerequisites. Opaque payload origin producers and current
File disclosure/receiving authority remain separate requirements; declaration
data supplies no grant.

Trusted maintenance calls `retireAndDelete(ref, disposition)` explicitly. State
fences permanent retirement against the complete installed census; Files checks
the original decision before atomically journaling the terminal metadata and
deleting bytes. Interrupted physical deletion retains the State decision for
retry. Reopen the same physical store and original State database with a freshly
verified host assembly; retry returns the original decision and eventually
`already-deleted` without advancing State. An existing assembly cannot replace
its installed receiving port. Installation performs no automatic deletion and
exposes no public maintenance route.

Deferred File payloads use the installed original event and callable profiles.
The host prepares a separate State-validated header for each actual Work row;
a saved receiver crosses the Files kernel only after current original-source,
slot, profile, owner and revision checks, with a fresh genuine observation and
unchanged explicit retention policy. Normal actor-null attachment and disclosure
remain refused. Cancelled payloads remain physical retirement barriers. The
compiled deferred native join is unfinished pending the defining Compiler's
complete event-aware Values census and its affected workflow validation.
