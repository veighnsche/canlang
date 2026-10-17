# Canlang on Soda OS

`can-soda` builds and runs a selected Canlang application in the pinned workerd
runtime using Canlang's existing compilation artifact, deployment descriptor,
environment selection and portable bundle. The application retains its
Cloudflare Workers deployment path. Soda supplies the installed tools, retained
storage and host lifecycle; application policies, Identity, Files and State
remain owned by Canlang.

Build Soda tools from a clean, committed checkout with `bun run release:tools`
after building and validating the owning packages and compiler. The packager
refuses uncommitted source so `sourceRevision` identifies the delivered code.

This guide describes the implemented local target. Local runtime and image
checks do not qualify an appliance release or production ingress. The phrase
“all Cloudflare services” is still an open coverage decision.

## Installed commands and requirements

The examples use the neutral account `canlang-builder`; adjust paths for the
account that owns the application and its private data.

The Linux x86_64 tool archive contains `can`, `can-platform`, `can-dev` and
`can-soda`, their catalogs and runtime dependencies. It requires no Canlang
checkout or startup dependency installation. Each tool archive records its exact compiler, Node 24 and Bun 1.4.2 versions
in `tools.json`. Miniflare 4.20260730.0 and workerd 1.20260730.1 remain pinned;
the default compatibility date is `2026-07-15`.

```sh
can-soda --help
can-soda inventory
```

`inventory` returns the target's supported providers and explicit refusals as
JSON. Serving needs `flock`, `sh`, `cat`, the delivered Node/workerd runtime and
a private writable existing storage directory whose canonical path is under
`/home`. Default listener settings are `127.0.0.1:8080`. Missing storage, an
occupied writer lock or failed application admission is an error; required D1
never falls back to temporary storage.

## Compile and assemble

Compile the actual `.can` source with the installed native catalog and retained
scenario receipts. For example, with the Soda Project tools installed at
`/opt/canlang`:

```sh
umask 077
mkdir -p /home/canlang-builder/Apps/board/build
can compile --format=json --native-scenario-receipts \
  --catalog=/opt/canlang/lib/node_modules/@canlang/cloudflare/dist/native-catalog.json \
  /home/canlang-builder/Apps/board/Board.can \
  > /home/canlang-builder/Apps/board/build/artifact.json
```

The build takes the existing
[`CompatibilityDescriptor` and `EnvironmentSelection`](../packages/contracts/src/deployment.ts)
JSON contracts; there is no additional application
manifest. The descriptor identifies the selected source app and exact artifact,
its compiler/language/contracts versions, required capabilities, binding
requirements, secret references and declared interval schedules. The artifact
digest is SHA-256 of `JSON.stringify(parsedArtifact)`, as used by the runtime
preflight. Derive `requiredCapabilities` from `artifact.requires`, without
removing requirements to make an application fit this target.

For this target the descriptor must declare both of these bindings:

```json
[
  {"binding":"DB","kind":"d1","logicalName":"board-identity"},
  {"binding":"STATE_DB","kind":"d1","logicalName":"board-state"}
]
```

`DB` owns Identity; `STATE_DB` owns the selected team's application state. Map
them to different resource IDs in the environment. An example environment is:

```json
{
  "environment":"board-local-test",
  "resources":[
    {
      "requirement":{"binding":"DB","kind":"d1","logicalName":"board-identity"},
      "resourceId":"board-local-test-identity"
    },
    {
      "requirement":{"binding":"STATE_DB","kind":"d1","logicalName":"board-state"},
      "resourceId":"board-local-test-state"
    }
  ],
  "secretsPresent":[],
  "vars":{"CAN_AUTH_ORIGIN":"https://board.example.test"}
}
```

`CAN_AUTH_ORIGIN` must be a canonical origin, with no path or trailing slash.
File receivers require HTTPS. Environment variables here are non-secret values;
placing credentials in `vars` is not a secret delivery mechanism. A typed
deferred event such as the `Due` event in
[`soda-runtime.can`](../scripts/fixtures/soda-runtime.can) does not create an
interval schedule requirement: its descriptor has `schedules: []`. Preserve
actual `on=every(...)` requirements when an application declares them.

```sh
can-soda build \
  --artifact /home/canlang-builder/Apps/board/build/artifact.json \
  --descriptor /home/canlang-builder/Apps/board/build/descriptor.json \
  --environment /home/canlang-builder/Apps/board/build/environment.json \
  --out /home/canlang-builder/Apps/board/build/bundle.json
```

Optional build flags are `--date DATE` and `--flags flag,...`. The output file
must not already exist. The JSON bundle carries the canonical modules and
base64-encoded binary modules; build prints its `mixedSha256`. Subsequent
commands check compatibility, bundle identity and module links again before
using it. No startup compiler or network downloads are required by the serving
image.

## Bootstrap one app-local team

The current target serves exactly one concrete, bootstrapped team. App-global
models, mixed app/team storage and routing multiple teams' State databases are
refused. Team policies still govern ordinary owner/member application access.
Soda or Forgejo accounts are not substituted for Canlang application users.

Create separate private retained storage and credential locations:

```sh
install -d -m 0700 /home/canlang-builder/Apps/board/data
install -d -m 0700 /home/canlang-builder/Apps/board/credentials
```

Write `owner.json` privately using an editor or credential delivery process.
Its exact input fields are:

```json
{
  "email":"owner@example.test",
  "password":"REPLACE_WITH_A_PRIVATE_PASSWORD",
  "timezone":"UTC"
}
```

`email` and `password` are required strings. `timezone` is optional, defaults to
`UTC`, and must be a supported timezone. Passwords must contain 8–512 characters.
Choose a unique private password for each account. The placeholders here are
documentation, not generated account credentials or shared deployment defaults.
The credentials file must be an account-owned regular file, not a symlink,
with no group/world permissions (normally mode 0600), and at most 64 KiB.
Pass its pathname, rather than the password, on the command line.

```sh
can-soda bootstrap \
  --bundle /home/canlang-builder/Apps/board/build/bundle.json \
  --data /home/canlang-builder/Apps/board/data \
  --credentials /home/canlang-builder/Apps/board/credentials/owner.json
```

Success returns JSON with `ok`, `command`, `userId` and `teamId`. Save the
returned `teamId` for `--owner`; it is the State owner, not the user's ID.
Bootstrap transactionally claims the first verified application user, team and
owner membership. A retry with the same credentials/timezone returns the saved
claim; different credentials, populated unclaimed Identity data or an incomplete
claim refuse. Bootstrap does not reset existing accounts or send verification
email. Identity administration errors intentionally omit credential details.

To add an ordinary verified member while the application is stopped, write a
separate private file containing exactly the required input strings:

```json
{"email":"member@example.test","password":"REPLACE_WITH_ANOTHER_PRIVATE_PASSWORD"}
```

```sh
can-soda member \
  --bundle /home/canlang-builder/Apps/board/build/bundle.json \
  --data /home/canlang-builder/Apps/board/data \
  --owner TEAM_ID_FROM_BOOTSTRAP \
  --credentials /home/canlang-builder/Apps/board/credentials/member.json
```

This requires the claimed team and its active owner. Matching verified accounts
and active memberships are reused; credentials are not reset and members are
not elevated to owner. Removed memberships, unverified accounts and mismatched
credentials refuse. Neither bootstrap nor member administration is a public
HTTP endpoint.

## Serve behind HTTPS

```sh
can-soda serve \
  --bundle /home/canlang-builder/Apps/board/build/bundle.json \
  --data /home/canlang-builder/Apps/board/data \
  --owner TEAM_ID_FROM_BOOTSTRAP \
  --host 127.0.0.1 --port 8080
```

Terminate the supervising process with SIGTERM or SIGINT for awaited shutdown;
forced shutdown is a failure. A lost supervisor IPC connection also retires its
worker and releases the retained writer lock. The runtime admits actual mounted
State, Identity and Files before exposing application traffic.

For Files, configure the external HTTPS gateway to forward the complete
application origin to this fixed backend port, including `/auth`, `/mcp`,
`/api/operations` and `/files`. The bundle's `CAN_AUTH_ORIGIN` must equal that
external origin. Preserve request bodies, Origin, CSRF headers, application
cookies, upload offsets and methods; Files upload grants refer to the external
HTTPS origin. TLS termination belongs to the gateway, not this loopback HTTP
listener. `--port 0` selects a temporary HTTP origin and is refused for File
applications. Binding another host requires an explicit connectivity choice;
the implemented default is loopback.

Only Canlang's `can_session` and `can_presession` request cookies cross the host
gateway. Forgejo or parent-domain cookies do not become application authority.
The public listener rejects internal `/__soda_` control routes. There are no
development fixture, preview bootstrap or generation routes in this target.
Outbound application networking is denied in the current profile. Registration
mail, password reset delivery and external identity federation are not configured.

## Storage and supported scope

Each data root has one kernel `flock` writer covering serve and administration.
Keep its mode private and its effective runtime user able to read/write it.
Storage includes Identity/State D1 files, target-owned actor SQLite (including
File bytes), a retained form-binding key and storage identity. `storage.json`
pins the app, exact artifact digest and resource assignments. A changed artifact
or mapping refuses that data instead of silently opening another database.
Stop the application before copying or restoring it; do not delete metadata or
select a new database to bypass a refusal. Migrating a release over retained
data requires a separately qualified upgrade procedure.

| Requirement | Current target |
| --- | --- |
| D1 Identity and team State | Separate required retained SQLite assignments |
| Canlang Files | Canonical authorization and durable application-actor SQLite; default maximum 10 MiB per file |
| Scheduled Canlang work | Durable D1 occurrences and receipts, target actor alarms and recovery |
| R2 | Refused; no qualified R2 file lifecycle adapter |
| User-declared Durable Objects | Refused; only the target-owned application actor is installed |
| Queues | Refused; an in-memory local broker is insufficient |
| Services and required provider secrets | Refused; no qualified external provider adapter |
| Analytics Engine | Refused; no durable sink |
| KV, Workflows, AI, Vectorize | Unsupported; no installed qualified binding contract/adapter |
| Migrations | Refused pending qualified upgrade and pending-work procedures |

This inventory does not approve a permanent limit on eventual Cloudflare service
coverage. Keep development, disposable test and serving environments in separate
data roots, resource IDs and credential files. Retained `can-dev` data and its
seeded development users are not production bootstrap input. Examples use their
existing disposable fixture databases; File-requiring applications currently
refuse `can-dev`'s D1/Identity preview profile and require the Soda target with
separate development data and HTTPS.

## Reproduce the finite local checks

Run the repository scripts from a built Canlang checkout. They are integration
drivers, not startup dependencies. Keep their state under `/home`, freeze their
consumed producer inputs during execution and use disposable private test roots.
Set the checkout and installed-tool locations to the paths used for your run:

```sh
CANLANG_REPO="$PWD"
SODA_REPO=$(realpath "$CANLANG_REPO/../sodaos")
CANLANG_TOOLS=/home/canlang-builder/.cache/canlang-soda/installed-tools-final-delta/canlang
CANLANG_TEST_TMP=/home/canlang-builder/.cache/canlang-runtime-tests
mkdir -p "$CANLANG_TEST_TMP"

TMPDIR="$CANLANG_TEST_TMP" node scripts/verify-native-runtime.mjs \
  --compiler compiler/target/release/can \
  --state "$CANLANG_REPO/.artifacts/soda-native-runtime-FRESH"

TMPDIR="$CANLANG_TEST_TMP" node scripts/verify-soda-host.mjs \
  --tool-root "$CANLANG_TOOLS" \
  --state "$SODA_REPO/.artifacts/canlang-soda-full-FRESH" \
  --containers \
  --podman-state "$CANLANG_REPO/.artifacts/soda-native-runtime"
```

The second command requires the explicitly selected existing task-owned Podman
store and Rocky image; it does not pull an image. Use a fresh full-test state
directory. The HTTPS witness creates and trusts a task-owned test certificate,
without disabling TLS verification. It uses actual Identity credentials and
retains real sessions and MCP grants across the stable application origin.

The G1 command above checks the native process path. Add `--containers` for its
container checks; that experimental driver pulls its selected Rocky base into
the task-owned store under `--state`. It does not describe serving-image startup.
The locally qualified runtime/application recipes can be exercised from the
canonical Soda checkout, using the already retained images and admitted assets:

```sh
node "$SODA_REPO/system/containers/canlang/verify-runtime-image.mjs" \
  --assets "$SODA_REPO/.artifacts/canlang-integration-20261014/final-assets-v2" \
  --bundle "$SODA_REPO/.artifacts/canlang-soda-full-v4-20261014/input.json" \
  --release "$SODA_REPO/system/project/canlang-release.json" \
  --state "$SODA_REPO/.artifacts/canlang-production-images-FRESH" \
  --podman-state "$CANLANG_REPO/.artifacts/soda-native-runtime" \
  --runtime-image sha256:6f504c78ff5eb81d58b2420c4150a645c71765b83c29c26a936d4646b7241947 \
  --application-image sha256:e959ac43b7255f1025d5556d5df3029f555e6a205339aa567dd97bbac719e85a
```

This reuses the exact compiled G2 fixture bundle, rather than recompiling a
different image witness. Remove both image options only when intentionally
checking the recipes' local image-build path with the required retained base.

The 2026-10-14 evidence has distinct accepted scopes:

- **G1:** native Rocky x86_64 real compiled HTTP D1 writes survived process and
  retained-container replacement; graceful shutdown and missing/unwritable
  storage rejection passed. Receipt:
  `$CANLANG_REPO/.artifacts/soda-native-runtime/results.json`.
- **G2:** selected team application HTTP CRUD, concurrent one-winner writes,
  stale-version refusal, authenticated page, real File upload/attach/download,
  member/foreign-team denial, missed-work recovery and repeated-wake receipts
  passed through process restart and two Rocky container replacements. Receipt:
  `$SODA_REPO/.artifacts/canlang-soda-full-v4-20261014/results.json`.
- **P16:** native runtime/application image recipes with final installed tools
  passed unprivileged offline bootstrap/HTTP, member administration, retained
  sessions/grants/files, graceful and abrupt replacement, missed-work recovery
  and required-mount refusal. Receipt:
  `$SODA_REPO/.artifacts/canlang-production-images-v3-20261014/results.json`.
- **Stopped recovery:** the owning Soda storage tool copied and checked the
  stopped snapshot, restored it, and the real application reopened the restored
  data. Ordinary owner login/MCP read observed one saved Entry with `ticks=1`,
  exact authorized File bytes, no duplication after a wake and graceful stop.
  Receipt and command:
  `$SODA_REPO/.artifacts/canlang-soda-full-v4-20261014/recovery-results.json`.

- **D1 exhaustion:** a bounded task-owned 32 MiB filesystem actually filled.
  A valid mutation failed visibly without committing; full storage refused
  startup. After freeing space, the prior acknowledged record survived restart,
  the failed write was absent and the same input succeeded. No shared filesystem
  was filled. Exact commands and results:
  `$SODA_REPO/.artifacts/canlang-enospc-20261014/{README.md,results.json}`.
- **Fresh Project image:** the complete current Soda Project recipe built with
  real current helpers, verified public tools and the final Canlang closure.
  An ordinary account in a fresh network-disabled container compiled, checked,
  linted/formatted, served an authenticated persistent preview, ran isolated
  examples and used LSP. No Canlang checkout or startup downloads were present.
  Receipt and exact commands:
  `$SODA_REPO/.artifacts/canlang-fresh-project-20261014/{results.json,commands.sh}`.
  This local image check does not substitute a matching-release appliance's
  Project Create/systemd boot.
- **G3 component evidence:** a fresh disposable CoreOS VM used older public
  media with current native components. Actual install/start/stop, same-artifact
  image replacement, stale-generation and selected runtime/tools refusal before
  effects, Project-stop independence and two genuine guest reboots passed.
  Trusted private-host HTTPS reopened D1/File/session/MCP/work state; explicit
  stopped intent survived the later boot. A stopped snapshot restored into fresh
  storage and reopened in real workerd. The retained Project compiled, served a
  persistent preview, executed isolated examples and passed explicit same-root
  maintenance. Exact commands and component identities:
  `$SODA_REPO/.artifacts/canlang-g3-vm-20261014/README.md`. This is not a full
  matching-source candidate, physical LAN/Tailnet rollout or installed Go/UI
  administration qualification.

The final tool archive SHA-256 is
`f97a6cbe09f1383065ed1b1663e7dca16b64e5ea1f1496d882889aa7e85a5e8a`.
The initial G2 witness used a predecessor qualified archive. Preview/compiler/LSP
consumer files remain byte-identical in the current archive; the earlier focused
delta passed in a Rocky container with networking disabled, without a
`.wrangler` metadata cache, and with explicit File/missing-State refusals.
Installed compiler LSP diagnostics, completion, navigation and formatting also
passed. The current archive's changed Soda writer launcher passed actual installed
CLI/D1 private-lock and exclusion checks in
`$SODA_REPO/.artifacts/canlang-lock-20261014/`, followed by the complete current
production image check above. These checks do not exercise a Cloudflare deployment or establish a full
matching-source appliance release, physical LAN/Tailnet rollout, automatic
backup schedule, RPO or RTO. Runtime image distribution, lifetime and connectivity
choices are adopted in Soda's owning plan; component and full installed-release
qualification remain separate.
