# @canlang/interfaces

HTTP/MCP/upload/provider-ingress interfaces for CanLang: routing, envelope
validation, error envelopes, projection, and the dependency ports the L7
worker assembly binds at B1. Production bindings come from L1 (registry,
catalog, app facts), L3 (canonical invocation), and L4 (file kernel,
ingress verifier); this package ships the shell, not the engines.

Ownership per `docs/implementation/PLAN.md`: lane 06 (account/session/team
identity, HTTP/MCP routing, canonical request/result and upload transport).

An admitted `PageReadScope` can install `observeGenerationCallbackDiagnostics`
on the frozen page `canonical` context. Full and partial page paths forward the
exact observer, accepting only the original `{ record, field }` locator and
returning one whole nullable closed result. Source extras cannot install it.
The native result uses Can `int` (`bigint`) for `failures[].recordedAtMs`; the
owning binding validates and converts the Work timestamp and enforces current
authority. Interfaces does not derive origin facts or issue diagnostics.

## Install

Private workspace package (`"private": true`, ESM, `"node": ">=22"`).
Consumed from the monorepo; no registry install. Runtime dependencies
(from `package.json`): `@canlang/contracts`, `@canlang/identity`,
`@canlang/ui`, `@modelcontextprotocol/sdk`.

## Usage

The public surface is `src/index.ts`, which re-exports `ports.ts` and
every boundary module. `src/testing.ts` is deliberately NOT re-exported:
its fakes (`createFakeInvoker`, `createTestMcpDeps`, `createFakeKernel`,
and friends) are test-only doubles, imported directly by tests.

```ts
import {
  checkClosedInputs,
  redactForLog,
  validateOperationId,
} from '@canlang/interfaces';

// Framing-only checks: null means valid, BusinessError otherwise.
const idError = validateOperationId(envelope.operation_id);
const shapeError = checkClosedInputs(envelope.inputs, {
  allowed: ['name', 'email'],
  required: ['email'],
});

// Never log untrusted values raw; redact secrets first.
logger.log('info', 'operation received', {
  inputs: redactForLog(envelope.inputs),
});
```

Key exports (all verified in `src/`):

- HTTP: `createHttpHandler`, `handleAuthRequest`,
  `handleOperationRequest`, `handlePageRequest`, `SIGN_IN_PATH`,
  `OPERATIONS_PREFIX`
- MCP: `createMcpHandler`, `toolsFor`, `toMcpTool`,
  `MCP_SERVER_VERSION`
- Uploads: `handleUploadRequest`; ingress: `handleIngressRequest`,
  `INGRESS_BODY_MAX_BYTES`, `createIdentityRemovalIngressVerifier`; OAuth: `handleOAuthRequest`,
  `authorizationServerMetadata`, `TOKEN_PATH`
- Envelope: `validateOperationId`, `checkClosedInputs`,
  `extractUuidV7Ms`; errors: `redactForLog`, `fieldError`,
  `isBusinessErrorCode`; projection: `projectFields`,
  `hasGrantedPath`
- Ports (`ports.ts`): `HttpDeps`, `McpDeps`, `UploadDeps`,
  `IngressDeps`, `OAuthDeps`, `OperationInvoker`, `AppInfo`,
  `PageRegistry`, `SchemaCatalog`, `RateLimiter`, `FileKernel`,
  `IngressVerifier`, `IngressSink`, `Logger`, `systemInterfacesClock`

## Scripts

From the repository root, after `bun install --frozen-lockfile`:

```sh
bun run build --filter=@canlang/interfaces
bun run --filter @canlang/interfaces typecheck
bun run --filter @canlang/interfaces test
```

The filtered root build schedules this package and its declared producer
dependencies. It emits only each owner’s outputs, cleaning them before execution
or cache restoration. Package `typecheck` and `test` use the same graph, then
run the owning TypeScript check or compiled `node:test` suite uncached.
Internal `build:emit`, `typecheck:check`, and `test:unit` tasks are execution
steps; use the public commands above to prepare dependencies.

The full File journey kernel requires `readCurrentBytes` and
`readCurrentSnapshot(ref, physicalReceiver, retention)` from its owning Files
binding. The latter returns immutable facts and the exact detached bytes
validated with them. It forwards the original method, arguments, result/null
and errors without revalidation, separate provenance reads or legacy fallback.
Files owns current physical policy validation; State and the host must separately
establish current field/occurrence authority before disclosure. An absent or
nonfunction binding refuses at kernel construction.

`createIdentityRemovalIngressVerifier` implements only the configured
`standard-webhooks-v1-identity-removal` profile. Its six options are the exact
existing `binding`, trusted `clock`, synchronous `keys` and `isCurrent`, captured
`readOriginalOccurrence`, and synchronous `captureVerified`. The host owns the
original namespace/app/team/owner/physical receiver and source lifetime;
`isCurrent` must refuse closed or replaced bindings/receivers. `keys()` returns
one canonical `whsec_` Base64 32-byte current key and at most one explicit previous
key, or null. Removing a key immediately withdraws it from subsequent admission,
including verification already awaiting crypto or original lookup. Keys come
only from trusted private configuration, never the request.

The existing route still caps the body and parses JSON before verification.
This adapter additionally requires strict UTF-8, unique decoded JSON member
names and the closed original `VerifiedTeamsMemberRemovedEnvelope`. It verifies
`webhook-id.webhook-timestamp.rawBody` with native HMAC-SHA256 verification using
the [Standard Webhooks signing scheme](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md#verifying-webhook-authenticity).
IDs, canonical decimal timestamps and canonical padded Base64 signature entries
are bounded; only the named `v1` profile is supported. The trusted clock enforces
300 seconds past/30 seconds future for the attempt and 24 hours past/30 seconds
future for the canonical original journal timestamp. A retry cannot renew that
original age.

The reader has exactly `IdentityStore.readMemberRemovalOccurrence`'s five original
arguments: binding-owned team/namespace plus admitted original subject/remover/
operation. Dev must close over the authentic SELECT-only receiver and its original
`this`, with no removal-command fallback. Every original envelope field must
match the signed body; absent, conflicting or invalid causes refuse. Verification
returns that same genuine reader envelope, granting no user/principal authority
to signed JSON. After all awaited work and current key/lifetime checks,
`captureVerified(original, rawBodyDigest)` privately associates that exact object
with SHA-256 of its captured raw bytes; a throwing or asynchronous callback
refuses. The digest is distinct from the original five-argument `requestDigest`.
The paired host sink
must consume this private association and independently establish durable
occurrence/routing correspondence, idempotency, current receiving authority and
final fences. This library does not stage a source/handler or activate an endpoint.

## Source layout

All paths under `packages/interfaces/`:

- `src/index.ts` — public surface (re-exports everything but `testing.ts`)
- `src/ports.ts` — dependency ports: `HttpDeps`, `McpDeps`, clocks,
  loggers, kernels, verifiers
- `src/http/` — `routes.ts` (`createHttpHandler`), `operations.ts`,
  `pages.ts`, `auth.ts`, `fragments.ts`, `limits.ts`,
  `presentation.ts`, `context.ts`
- `src/mcp/` — `server.ts` (`createMcpHandler`), `tools.ts`,
  `schemas.ts`, `discovery.ts`
- `src/uploads/` — `routes.ts` (`handleUploadRequest`), `kernel.ts`,
  `principals.ts`
- `src/ingress/` — `routes.ts` (`handleIngressRequest`), `mapping.ts`,
  `identity-removal.ts` (configured original-cause verification)
- `src/oauth/` — `routes.ts` (`handleOAuthRequest`), `metadata.ts`
- `src/envelope/` — `validate.ts`, `refs.ts`, `versions.ts`
- `src/errors/` — `envelope.ts`, `safe.ts`, `redact.ts`, `logging.ts`
- `src/projection/project.ts` — granted-path field projection
- `src/testing.ts` — test-only doubles (never production)
- `test/` — fixtures (copied into `dist/` by `build`) and tests

## Ownership / lane note

Lane 06 per `docs/implementation/PLAN.md` (row: lane
`prompts/06-identity-interfaces.md`; tree slot `interfaces/ # L6`).
Downstream joins bind the ports: L1 operation/page registry and catalog
(join J3), L3 canonical invocation (join J2), L4 file kernel (join J6)
and typed ingress verification (S8), L7 worker assembly at B1.

No `LICENSE` file or `license` field exists in the repo, so no license
pointer is given.

## Distribution API

`@canlang/interfaces/distribution` exposes the producer-owned compiled module
directory URL for portable Worker staging. Tests remain outside that module
inventory. Compilation stays within each owning package; public commands also
prepare declared dependencies.

## CSV intake resource profile

CSV review and commit retain the existing authenticated, CSRF-qualified 1 MiB
streaming JSON body cap. Only these routes additionally cap JSON container
depth at three: the root object, consent object or selection array, and each
selection object. That guard runs before JSON graph allocation; byte/depth
resource refusals precede later syntax admission. Other JSON routes have no
implicit depth policy.

After current catalog admission, CSV uses the same 1 MiB text byte ceiling and
existing 1,000 data-row ceiling. Total cells, including header and malformed
rows, are limited to 1,001 times the number of checked writable operation
inputs allowed by its shape, with a minimum width of one. This provides capacity
for every maximum valid row under the exact source. Allocation-free shared
preflight checks Unicode, quoting and counts before `csv-parse` constructs
records. Within the byte budget, malformed syntax retains priority over row or
cell excess, including an unterminated quote after 1,001 rows. Accepted raw
cells, defaults, duplicates, consent and current-authority invocation stay the
same. Refusals carry safe `limit` messages and no input text.

Shared parsing and browser advisory accept an optional `CsvResourceLimits`
profile. Standalone callers have no implicit byte/cell quota, and advisory
without checked metadata cannot certify the mounted profile. Original generated
browser/durable and supported-host peak-memory qualification remain separate
from the owning mounted resource checks.
