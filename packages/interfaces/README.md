# @canlang/interfaces

HTTP/MCP/upload/provider-ingress interfaces for CanLang: routing, envelope
validation, error envelopes, projection, and the dependency ports the L7
worker assembly binds at B1. Production bindings come from L1 (registry,
catalog, app facts), L3 (canonical invocation), and L4 (file kernel,
ingress verifier); this package ships the shell, not the engines.

Ownership per `implementation/PLAN.md`: lane 06 (account/session/team
identity, HTTP/MCP routing, canonical request/result and upload transport).

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
  `INGRESS_BODY_MAX_BYTES`; OAuth: `handleOAuthRequest`,
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
- `src/ingress/` — `routes.ts` (`handleIngressRequest`), `mapping.ts`
- `src/oauth/` — `routes.ts` (`handleOAuthRequest`), `metadata.ts`
- `src/envelope/` — `validate.ts`, `refs.ts`, `versions.ts`
- `src/errors/` — `envelope.ts`, `safe.ts`, `redact.ts`, `logging.ts`
- `src/projection/project.ts` — granted-path field projection
- `src/testing.ts` — test-only doubles (never production)
- `test/` — fixtures (copied into `dist/` by `build`) and tests

## Ownership / lane note

Lane 06 per `implementation/PLAN.md` (row: lane
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
