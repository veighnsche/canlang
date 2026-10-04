/**
 * @canlang/identity public surface (lane 06).
 *
 * Feature modules first; `testing.ts` is deliberately NOT re-exported
 * (test-only doubles, imported directly by tests).
 */
export * from './ports.js';
export * from './accounts/passwords.js';
export * from './accounts/registration.js';
export * from './accounts/recovery.js';
export * from './sessions/tokens.js';
export * from './sessions/cookies.js';
export * from './sessions/csrf.js';
export * from './teams/invitations.js';
export * from './teams/membership.js';
export * from './teams/roles.js';
export * from './teams/selection.js';
export * from './authentication/context.js';
export * from './authentication/revocation.js';
export * from './authentication/audience.js';
export * from './authentication/grants.js';
export * from './authentication/oauth.js';
