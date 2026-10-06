# V01.2 — Bounded HTTP adoption join assessment

Task: V01.2 (lane `V-http`, wave 1, after `C01.ready`). Produced
2026-10-06T08:37:40Z by lane F session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9.
Planning record only; no implementation authorized.

- Head verified: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06`
- Companion: `contracts.md` (profiles), `caller-inventory.json` (modes).

## Verdict

The existing handler is real and well-tested, but the deployed join seam
for HTTP does **not** exist yet: `AssemblyDeps` (`worker/assembly.ts:415`)
carries `files?` and `mcp?` join inputs and no `http?` input, so the
"interfaces join" promised by the module doc ("The interfaces join replaces
it") is currently absent as a typed seam. The bounded join below names the
exact handler, the exact seam to add, and the owning files — it invents no
new HTTP feature. Until it lands, the interim dispatcher and default 501s
are the correct deployed behavior and must be retained.

## The existing handler (handler side — exists)

- `packages/interfaces/src/http/routes.ts:85` —
  `createHttpHandler(deps: HttpDeps, sub: HttpSubHandlers)`:
  `POST /api/operations/<op>` → injected operations handler,
  `/auth/*` → injected auth handler, uploads/ingress/page routes per the
  factory; anything else `not_found`; unexpected throws → generic
  internal envelope after an incident-logged journal entry.
- `packages/interfaces/src/http/operations.ts:168` —
  `handleOperationRequest(deps, request, operation)`: framing checks
  (auth, CSRF, operation-id, closed inputs) through to L3 canonical
  invocation; non-POST/malformed names `not_found`; `action_handle`
  carve-out rejects loudly (sealed handles are MCP-only).
- `HttpDeps` wiring needs: identity store (`IdentityStore`, bound as
  `HttpDeps.identity.store`), clock, and the invoker bridge — the SAME
  `buildInvoker` bridge the MCP path uses (`assembly.ts` module doc).
- Test cover (no new proof needed that the handler works): `e1-bound-
  dispatch`, `e2-dispatch-agreement`, `e2b-transport-seams`,
  `http-operations`, `integration-lifecycle`, `integration-parity`,
  `mcp-server`, `t19a-derivation`, `t19b-depth`, `t20a-presentation`.

## The seam gap (assembly side — absent)

- `packages/cloudflare/src/worker/assembly.ts:415` `AssemblyDeps` has no
  HTTP join input. Interim dispatcher serves page GETs (anonymous
  identity, real descriptor `admit`/`render`, exact paths only);
  mutations/auth answer explicit interim 501s naming the join; `/files/*`
  is a documented mirror (never fake bytes).
- T16b canonical routing, T17b flips/retirements, T04a pins,
  `requires[]` fulfillment, and descriptor preloads all sit in the
  assembly path and are untouched by this assessment.

## The bounded join (no new HTTP feature)

Mirror the proven MCP P-B pattern (`deploy/bundle.ts:585-590`, which
stages `createMcpHandler as createHandler` from interfaces server dist):

1. **Interfaces owner** — no handler change: `createHttpHandler` +
   sub-handlers are consumed as-is. Only requirement: keep the factory
   signature and `HttpDeps` shape stable while the join lands.
2. **Cloudflare owner** — `worker/assembly.ts`: add an `http?` join input
   to `AssemblyDeps` (handler factory + `HttpDeps` wiring:
   `identityStore` → `HttpDeps.identity.store`, clock, `buildInvoker`
   bridge); delegate operation/auth/uploads/page routes to the real
   factory once supplied; keep interim 501s while absent.
3. **C04 delivery owner** — `deploy/bundle.ts` (+ `dev/local-run.ts` dev
   wiring): stage the real factory from interfaces dist exactly as the
   MCP join does; no new route, no new handler, no behavior invention.
4. **Out of scope**: new endpoints, auth semantics, uploads semantics,
   page shell, files binding, permissions (join J2), and any change to
   T16b/T17b gating.

## Separately testable gates

- **Gate 1 — package/workerd fixture proof** (V08): the actual handler +
   actual Wasm/adapter + a workerd fixture proves the port path. Testable
   without any deployment change; unit tests against an injected invoker
   do not satisfy it.
- **Gate 2 — default deployed adoption**: the bounded join above has
   landed and default routes are served by the real factory (assembly/
   deployment tests green). Testable only after the join.
- **Blocked-join fallback**: if the join is unavailable, report package
  completion (Gate 1) and blocked default deployment (Gate 2)
  separately, and retain the default interim 501s. A 501 is the honest
  signal, never a failure to paper over.

## Owner review status

Required (recorded, not assumed): interfaces owner (factory/`HttpDeps`
stability), cloudflare owner (`AssemblyDeps.http` seam + delegation),
C04 delivery owner (bundle staging parity with the MCP join).
