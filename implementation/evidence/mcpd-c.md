# MCP deploy P-C: production McpDeps — evidence

Branch: `muse/closeout/mcp-deploy`. No commit (per packet).

## Contracts delivered (pinned, verbatim)

**(1) `packages/cloudflare/src/runtime/env-assembly.ts`**

```ts
export async function buildProductionDeps(
  env: Record<string, unknown>,
): Promise<{ store: StoragePort; identityStore: IdentityStore }>
```

- `store` via `createD1Storage(env.DB)` (dynamic producer load, validated, loud).
- `identityStore` = the D1-backed store (`createD1IdentityStore(env.DB)`).
- Ensure steps, all idempotent: state `ensureSchema` → `ensureIdentitySchema` →
  INTERIM todo/note DDL. **DDL application is unowned elsewhere** (verified:
  `src/deploy/*` only renders `d1_databases` bindings, `upgrade/apply.ts`
  has no live backend, `assembly.ts` only declares `INTERIM_DDL`), so the
  equivalent minimal ensure step runs HERE (`applyInterimDdl`, loaded from
  the worker sibling — never restated, cannot skew).
- `env.DB` missing/misshapen → throws self-identifying
  `buildProductionDeps (../runtime/env-assembly.js) requires env.DB …`
  (P-A surfaces it as 500 `deploy-join-missing`; tokens aligned with
  P-A's `worker-main.test.ts`, which passes).
- Workerd-safe: type-only imports, no `node:`; producers load via
  non-literal dynamic specifiers (tsc-blind, b2 precedent). P-B seam:
  the bundler must inline/scope `@canlang/identity`,
  `../../../state/dist/state/src/storage/d1.js` (relative: state has no
  package link/exports map), and `../worker/assembly.js`.
- Houses the verbatim `IdentityStore` (+ `StoredUser`, `TeamInvitationRow`)
  mirrors of `identity/src/ports.ts` — mutual assignability with the real
  interface proven statically in both directions (root check).

**(2) `packages/cloudflare/src/runtime/grant-route.ts`**

```ts
export async function handleMcpGrant(
  req: Request,
  ctx: { identityStore: IdentityStore },
): Promise<Response>
```

- Production issuance, mount-path agnostic (P-A mounts `POST /mcp/grants`):
  session-cookie authed exactly like the fixture (`can_session` →
  `resolveIdentity` → active-membership gate → `issueMcpGrant`), NO
  test-only marker. Request `POST {client_id}`; 200
  `{token, grant_id, user_id, team_id}` (only these four keys).
- Failures safe + loud: 405 non-POST, 401 missing/invalid session, 403 no
  active membership, 400 bad body/client_id, 500 unexpected (generic body,
  console journal; the raw token is never stored or logged).
- `IdentityError` recognition is cross-copy safe (`instanceof` + structural
  `name` + closed business-code fallback) so a P-B vendor skew can never
  flip a 4xx/500.

**(3) D1 `IdentityStore`: `packages/identity/src/storage/d1.ts`** (new dir;
verified layout first), exported from `identity/src/index.ts`.

- Full-port implementation over a minimal structural D1 surface (no new
  dependencies; a real `D1Database` satisfies it with no adapter — proven
  statically + at runtime against miniflare D1).
- Schema: 9 `identity_*` tables + 6 indexes (`IDENTITY_DDL`,
  `ensureIdentitySchema`, idempotent). UNIQUE on emails, token hashes,
  and (team, user) — collisions fail loud. Single-statement atomicity;
  **fence limitation is loud**: multi-step guards await the J2 fence join.

**(4) Production permissions: `packages/cloudflare/src/runtime/mcp-permissions.ts`**
`createMemberMcpPermissions(artifact)` — replaces deny-closed for members.

- Policy source (verified by reading the tree, documented in the module):
  NO per-operation L3 surface is reachable (`policy/grants.ts` is row
  visibility; `crud.ts by` defs have no worker supplier — J2 unlanded;
  artifact operations carry no policy field; `requires[]` = library caps).
  Owning policy read = team-membership (`members` semantics mirroring
  `evaluateBy('members')` line-by-line) + closed operation world from
  P1 `operations[]`. Unknown op / anonymous / app-only / missing / removed /
  foreign-team / principal-mismatch / malformed → deny. NEVER fail-open.

## D1 proof

- Identity suite (real SQL, node:sqlite): 11 D1 tests — full-port
  conformance, real `issueMcpGrant` + `resolveIdentity` grant round-trip
  (revoke/expiry/removal deny), session round-trip for the grant route.
- Cloudflare suite (real workerd D1, miniflare): constructor proves
  `records`, `fence_log`, `identity_users`, `identity_mcp_grants`, `todo`,
  `note` all exist post-ensure; idempotent re-construction; grant minted
  through `handleMcpGrant` over D1 → NON-EMPTY `tools/list` (2/2 fixture
  ops) + successful `tools/call` through the assembled worker.

## Matrix results

- Permissions unit matrix: member admit (discover+call, both ops) ✅;
  6 outsider shapes × discover/call deny ✅; unknown op deny ✅;
  malformed-identity deny-not-throw ✅; absent `operations[]` deny-all ✅;
  malformed entries throw naming entry ✅.
- Worker: unknown grant → 401 `{error:{code:forbidden}}` + Bearer
  challenge ✅; revoked grant → identical 401 ✅; membership removal ends
  admission (200 → 401) ✅; refused verdict + production McpDeps → 500
  `activation-refused` naming FIRST reason on `/mcp` and `/` ✅.

## Test output tails (this session)

- `identity`: build ✅, `node --test dist/identity/test/**/*.test.js` —
  58 pass / 0 fail (11 new D1).
- `cloudflare` (vitest): 3 new files, 18 tests pass (7 permissions +
  5 grant-route + 6 env-assembly/worker).
- Full cloudflare file: 294 pass / 2 fail → after P-A token alignment:
  only P-A's `worker-main` 501 test fails — stale premise
  ("P-C in flight", but grant-route.js now exists so the default loader
  resolves it → 401). Fix is one line in P-A's test file
  (`loadGrantHandler: async () => undefined`), outside P-C's file list —
  flagged to the coordinator. P-B's 2 earlier failures were parallel-run
  flakes (green in isolation and on re-run).
- Typechecks: `cloudflare typecheck` ✅ + `build` ✅, `identity
  typecheck` ✅, root `tsc -p tsconfig.check.json` — ZERO errors in P-C
  files (4 remaining errors all in P-B's `deploy-bundle.test.ts`).
- `worker-boundary.test.ts`: green (`src/worker/*` untouched).

## Files changed (P-C only)

- NEW: `packages/identity/src/storage/d1.ts`,
  `packages/identity/test/d1.test.ts`,
  `packages/cloudflare/src/runtime/{env-assembly,grant-route,mcp-permissions}.ts`,
  `packages/cloudflare/test/{mcp-permissions,mcp-grant-route,mcpd-env-assembly}.test.ts`,
  `implementation/evidence/mcpd-c.md` (this file).
- MODIFIED: `packages/identity/src/index.ts` (one export line).
- NOT touched: `src/worker/*`, `src/deploy/*`, `src/cli/*`, `src/dev/*`,
  `tests/e2e/*`. No commit.
