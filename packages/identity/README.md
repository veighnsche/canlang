# @canlang/identity

Account/session/team identity for CanLang: email registration and
verification, password login, sessions and CSRF, team membership and
invitations, MCP grants, and OAuth public-client authorization codes.

All persistence goes through the `IdentityStore` port (`src/ports.ts`);
production binds it to global Identity D1 tables; broader cross-store fence
join J2 remains separate. Business failures use `IdentityError` and a wire code.

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

For cold removal recovery, use optional `store.readMemberRemovalOccurrence`
with the original `team_id`, `member_user_id`, `removed_by`, `namespace` and
`operationId`. It returns only the immutable saved outcome or `null` for absence,
and refuses same-key argument skew. It performs no command retry, removal,
cascade, event minting or current-authority admission, even after re-admission or
remover revocation. D1 supports this read without transactional batch capability.
Trusted source/ingress binding remains necessary. Use `removeMemberWithOccurrence`
only for the separately authorized command and its existing exact retry semantics.

Account recovery requires optional `store.recoverAccountWithToken`. D1 exposes
it only with transactional `batch`: the store rechecks the exact live recovery
token after password hashing, changes the password, revokes account sessions,
MCP grants and other recovery tokens, then consumes the proof in one transaction.
Only one contender succeeds; verification tokens stay unchanged. A failed
statement rolls back all changes. A lost acknowledgement may follow a commit;
the spent token cannot authorize another password change. Stores without this
command refuse recovery before mutation, with no sequential fallback.

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

Production storage comes from State; mail comes from the Services mail adapter.

## License

No `LICENSE` file in the repo; all rights reserved by default.

## Distribution API

`@canlang/identity/distribution` exposes the producer-owned compiled module
directory URL for portable Worker staging. Tests remain outside that module
inventory. Compilation stays within each owning package; public commands also
prepare declared dependencies.
