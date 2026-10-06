# @canlang/identity

Account/session/team identity for CanLang: email registration and
verification, password login, sessions and CSRF, team membership and
invitations, MCP grants, and OAuth public-client authorization codes.

All persistence goes through the `IdentityStore` port (`src/ports.ts`);
production binds it to lane-03 fenced D1 tables (join J2), never a side
database. Failures surface as `IdentityError` with a wire business code.

## Install

Workspace-private package; depend on it from another workspace package:

```json
{ "dependencies": { "@canlang/identity": "0.1.0" } }
```

## Usage

```ts
import {
  loginWithPassword,
  registerWithEmail,
  resolveIdentity,
} from '@canlang/identity';
import {
  createMemoryIdentityStore,
  createTestMailOutbox,
} from '@canlang/identity/testing';

const store = createMemoryIdentityStore();
const mail = createTestMailOutbox();

await registerWithEmail(
  store,
  mail,
  { email: 'ada@example.com', password: 'correct horse battery staple' },
  { verifyBaseUrl: 'https://app.example.com/verify-email' },
);
const { token } = await loginWithPassword(store, {
  email: 'ada@example.com',
  password: 'correct horse battery staple',
});
const identity = await resolveIdentity(store, { session_token: token });
```

Key exports from `@canlang/identity` (via `src/index.ts`): `ports.ts`
(`IdentityStore`, `MailPort`, `Clock`, `RandomSource`, `StoredUser`,
`IdentityError`, `systemClock`, `webRandom`, `toInstant`);
`accounts/` (`registerWithEmail`, `loginWithPassword`, `verifyEmail`,
`requestRecovery`, `recoverAccount`, `hashPassword`, `verifyPassword`,
`normalizeEmail`); `sessions/` (`createOpaqueToken`, `buildSessionCookie`,
`buildSessionClearCookie`, `parseSessionCookie`, `deriveCsrfToken`,
`verifyCsrfToken`, `SESSION_COOKIE_NAME`, `CSRF_HEADER_NAME`);
`teams/` (`inviteMember`, `acceptInvitation`, `removeMember`,
`setMemberRole`, `selectTeam`, `clearTeamSelection`); `authentication/`
(`resolveIdentity`, `issueMcpGrant`, `revokeMcpGrantByToken`,
`revokeSessionByToken`, `signOutEverywhere`, `registerClient`,
`validateAuthorizationRequest`, `issueAuthCode`, `exchangeCode`,
`assertAudience`). `@canlang/identity/testing` holds test-only doubles
(`createMemoryIdentityStore`, `createTestMailOutbox`,
`createFrozenClock`) and is never re-exported from the index.

## Scripts

From the repository root, after `bun install --frozen-lockfile`:

```sh
bun run build --filter=@canlang/identity
bun run --filter @canlang/identity typecheck
bun run --filter @canlang/identity test
```

The filtered root build schedules this package and its declared producer
dependencies. It emits only each owner’s outputs, cleaning them before execution
or cache restoration. Package `typecheck` and `test` use the same graph, then
run the owning TypeScript check or compiled `node:test` suite uncached.
Internal `build:emit`, `typecheck:check`, and `test:unit` tasks are execution
steps; use the public commands above to prepare dependencies.

## Source layout

```text
src/
  index.ts            # public surface (re-exports feature modules; not testing.ts)
  ports.ts            # IdentityStore, MailPort, Clock, IdentityError
  testing.ts          # test-only doubles (imported directly by tests)
  accounts/           # passwords.ts, registration.ts, recovery.ts
  sessions/           # tokens.ts, cookies.ts, csrf.ts
  teams/              # invitations.ts, membership.ts, roles.ts, selection.ts
  authentication/     # audience.ts, context.ts, grants.ts, oauth.ts, revocation.ts
test/                 # accounts, context, contracts, grants, oauth, sessions, teams suites
```

## Ownership

Per `implementation/PLAN.md`: lane 06
(`implementation/prompts/06-identity-interfaces.md`) owns
`packages/identity`. Production store binding is lane 03 (join J2); mail
binding is the lane-04 mail adapter.

## License

No `LICENSE` file in the repo; all rights reserved by default.

## Distribution API

`@canlang/identity/distribution` exposes the producer-owned compiled module
directory URL for portable Worker staging. Tests remain outside that module
inventory. Compilation stays within each owning package; public commands also
prepare declared dependencies.
