# Lane 06: Identity, HTTP and MCP interfaces

Status: active. Coordinator: Muse Spark 1.3 Contributor MAX session
01a10712-85a8-7e21-90c6-0241c81dd79a.
Worktree: /Users/vince/Projects/canlang-worktrees/lane-06-identity-interfaces
(branch muse/lane-06-identity-interfaces/plan, from origin/main b06d873).
Native goal: goal-01a10712-dbc4-7652-bec1-0d9ef6c27cc5. Cleanup: coordinator
removes this worktree only after all writers/viewers release it; primary
checkout /Users/vince/Projects/canlang is never reset or edited.

Owner prompt: [lane 06](../prompts/06-identity-interfaces.md).

## Current implementation evidence (from origin/main b06d873)

- No packages/ tree, no root package.json/tsconfig, no .github/workflows.
  Rust CLI scaffold (compiler/src/main.rs), Python syntax prototype, 39 draft
  sources, 2 reference examples (TeamTasks, ExpenseFlow). No producer
  contract has merged; all other lane status files read "awaiting human
  launch" and no PRs exist. Main branch is NOT protected (checked 2026-10-04).
- Normative inputs read: PLAN/WORKFLOW/CONTRACTS/DIAGNOSTICS, AGENTS.md,
  REQUIREMENTS §§Runtime/MCP/shell, DESIGN §§4,5,5.1,6,7,8(v1 upload
  bridge),9(admission),10(MCP),11.3(action handles), GRAMMAR upload/route
  notes, DECISIONS current-status + auth audit entries 65-73 (historical;
  DESIGN §4 is the adopted rule).
- Settled lane-06 rules distilled from those sources:
  - Default `auth email password` (verified-email registration, sign-in/out,
    expiring email-token recovery, sessions, MCP authorization) and default
    `teams` (owner-managed membership, expiring verified-email invitations,
    roles, team selection, team timezone UTC default) need no source lines.
    Deployment provisions the first owner. No app-authored login/role tables.
  - Actor predicates: members/owner/declared-role/authenticated/public;
    last-owner removal/demotion rejected; invitation acceptance verifies the
    addressed email and cannot exceed the stored role; completed removal
    prevents new admissions while an admitted op may finish.
  - actor.email / actor.email_verified are read-only admission facts for the
    authenticated caller only; nothing else exposes them.
  - Mutation envelope: stable UUIDv7 operation_id + expected versions;
    receipt identity = app, owner/team, principal, FQ operation, id; receipt
    check precedes version/default/business evaluation; replay returns the
    saved outcome projected against current access. Identities >24h old
    rejected, 5min future tolerance; receipts kept >=7 days.
  - Business error codes: validation, forbidden, not_found, conflict,
    rule_failed, busy, limit, delivery_unknown. Existence-hiding lookups
    return not_found. Guard failures are generic; no confidential disclosure.
  - MCP: one Streamable HTTP /mcp server per selected app; registry-owned
    tools package.Model.read/list/create/update/delete + package.scenario;
    owner-authorized system.team.invite/.remove/.role tools; login/recovery/
    session/OAuth/trusted handlers never tools. OAuth consent binds one app
    user + one team; permissions rechecked per discovery and call. Closed
    typed JSON schemas; int/decimal as canonical decimal strings (incl.
    money.minor, record.version); datetimes RFC3339 UTC; files are completed
    opaque IDs; mutations carry operation_id; unknown args fail. Mutations
    return {status,operation_id,records,deliveries,result}.
  - Upload bridge v1 (§8): POST /files/intents
    {upload_id,operation,field,arguments,name,type,size} ->
    {intent_id,content,finalize,expires_at}; PUT bytes to content; POST
    finalize -> {file}. fileTransfer _meta {version:1,intents}; schema
    format:"can-file". Unsupported hosts offer browser handoff or report
    cannot-supply; never silent omit or false success.
  - HTTP: one page per normalized route shape; page GET side-effect-free;
    team routes need selected team; public record routes resolve team from
    record. Canonical POST uses current CSRF. Collections default 25/max 100
    with opaque cursors; page max 500 records + 1MiB. HTMX error statuses
    must explicitly swap validation/error fragments.
  - Provider-event ingress authentication delegates typed verification to
    lane 4; no raw request manufactures trusted handler context.

## Exact desired tree within ownership

```text
packages/contracts/src/identity.ts      # L6: principal/session/team/membership/auth facts
packages/contracts/src/wire.ts          # L6: operation envelope, errors, uploads, MCP/action transport
packages/identity/
  package.json, tsconfig.json
  src/index.ts                          # public assembly (accounts/sessions/teams/authentication)
  src/accounts/{passwords,recovery,registration}.ts
  src/sessions/{tokens,cookies,csrf}.ts
  src/teams/{membership,invitations,roles,selection}.ts
  src/authentication/{context,revocation,audience}.ts
  src/ports.ts                          # storage/system-command ports (L3 binds D1; test double here)
  src/testing.ts                        # test-only in-memory fenced store + fixtures (never production)
  test/*.test.ts + fixtures/*.json      # two-user/team + revoked-session examples
packages/interfaces/
  package.json, tsconfig.json
  src/index.ts
  src/http/{routes,pages,operations,fragments,limits}.ts
  src/mcp/{server,tools,schemas,discovery,authorization}.ts
  src/uploads/{intents,content,finalize,bridge}.ts
  src/errors/{envelope,safe,redact,logging}.ts
  src/ports.ts                          # registry/invoker/renderer/finalizer/verifier ports
  src/testing.ts                        # test-only doubles
  test/*.test.ts + fixtures/*.json
.github/workflows/lane-06.yml           # install/build/test owned packages only
implementation/status/lane-06.md        # this file
```

Not owned, never written here: packages/contracts/{package.json,src/index.ts,
other src} (L7 assembly + other producers), root manifests/locks/tsconfig
(L7), compiler/, editors/, draft/, examples/, other lanes' packages/status.

## Interfaces and dependencies

Consumes (ports defined by producers; until merged, lane-06 defines minimal
consumer-side port types in its own ports.ts and marks them for replacement):
- L3 invocation/commit: operation admission + canonical invocation callable;
  D1-fenced membership/session tables (identity store port). Needed by B1.
- L2 values/wire: canonical decimal/RFC3339/opaque-id codecs + schema
  catalog entries. Needed for wire codecs; minimal local closed-JSON copy
  only as explicitly test-marked fixture until L2 lands.
- L1 artifact/registry: appDefinition, callable operation registry, page
  descriptors + admission callables, source revision. Needed by B1.
- L5 presentation: fragment/page render callables, form schemas. Needed by B1.
- L4 files/services: upload finalization/provenance, provider-event typed
  verification, delivery observation. Needed by B1/B2.
- L7 platform: root workspace/lock/tsconfig.base, @canlang/contracts
  manifest+index, workerd/D1 local runner, BDD testkit. Root/contract
  assembly needed as soon as any slice is ready to integrate; runner by B1.

Provides: identity.ts/wire.ts contracts (slice 1); @canlang/identity
(authenticated context constructor — the single verified identity entry both
transports use); @canlang/interfaces (HTTP/MCP/upload dispatch). L3 admission,
L5 forms, L7 host consume these.

## Reuse and qualification decisions

- Cryptography: WebCrypto SubtleCrypto only (digest SHA-256, HMAC, PBKDF2 for
  password hashing with OWASP-2023 iteration count, getRandomValues for
  tokens). Rationale: identical API in Node 24 and workerd; no Node-only
  scrypt/argon2 dependency. Password hashes: PBKDF2-HMAC-SHA-256, per-user
  16-byte salt, 600k iterations, modular text encoding with version tag.
  Sessions: opaque 256-bit tokens, SHA-256 hash at rest, constant-time
  compare; bearer only over Secure/HttpOnly/SameSite cookies (browser) or
  app-audience MCP authorization (MCP bridge). No custom primitives.
- MCP: official @modelcontextprotocol/sdk, Streamable HTTP transport only.
  Qualification spike in slice 5 must prove the used transport path runs
  under workerd (no Node http/net); if the SDK server transport needs Node,
  implement the narrow Streamable HTTP endpoint against the MCP spec using
  the SDK's protocol/types only, and record the exact gap. Importability
  alone is not qualification.
- Email delivery for verification/recovery/invitation: capability call
  through the L4-bound mail adapter port (std.EmailV1 shape); tests use a
  test-only outbox double. No direct SMTP/fetch in identity code.
- Test stack B0: typescript (tsc) + node:test + node:assert, package-local
  tsconfig (strict, nodenext, es2022), no test framework dependency.
  workerd/vitest qualification arrives with the L7 runner at B1.
- No JEV consultation opened yet: session/CSRF/hash choices above are
  standard vetted practice with cited rationale, not difficult language
  decisions. JEV (three-rewrite rule) will be used if MCP transport
  qualification or delegated-identity mapping hits a genuine fork.

## Subtasks, worker reservations, PR order

At most two active implementation subagents; disjoint exact files each; no
git/worktree commands in children; command cadence yield_time_ms:120000.

- [x] P0 plan: this file (coordinator).
- [x] S1 contracts-1: contracts identity.ts+wire.ts; identity/interfaces
      package.json+tsconfig; fixtures (two-user/team, revoked session);
      lane-06.yml; PR #6. Coordinator-authored (core design surface);
      implementer delegation starts at S2.
- [x] S2 identity-core: accounts/sessions/teams/authentication + ports +
      testing double; password/recovery/session/CSRF/team lifecycle tests.
      Implemented inline after EMFILE killed both spawns (incident resolved
      by instance restart; shell + subagents back).
- [ ] S3 wire-errors: error envelope/safe/redact/logging + operation envelope
      codecs + version/operation_id validation; projection-before-disclosure
      enforcement point used by both transports. Workers: C owns
      interfaces/src/errors/* + test/errors.test.ts; D owns
      interfaces/src/envelope/* + src/projection/* + test/envelope.test.ts +
      test/projection.test.ts. Coordinator owns ports/index/tsconfig/
      package.json/CI/status + the identity contracts-import upgrade.
- [ ] S4 http-routes: page/fragment/operation dispatch, source-derived
      admission via L1 descriptor port, CSRF enforcement, request limits,
      HTMX error-swap statuses; B1 route/admission cases.
- [ ] S5 mcp-server: SDK qualification spike, registry->tool generation,
      closed-schema derivation, OAuth audience binding, discovery/call
      permission rechecks; same-invocation proof with S4.
- [ ] S6 uploads: intent/content/finalize routing vs L4 finalizer port,
      fileTransfer _meta, browser handoff + truthful unsupported-host errors.
- [ ] S7 ingress-trust: provider-event ingress auth framework delegating to
      L4 verifier port; delegated-operation identity mapping; forbidden
      manufacture cases.
- [ ] B1/B2 join: real-registry two-user browser+MCP flows, denied/stale/
      replay, revocation, finalized files, error-meaning preservation.

## Test cases (acceptance spine; producers' doubles marked T)

- Forged/missing/expired identity, wrong team/owner, stale version, revoked
  role, unauthorized result field: rejected equally over HTTP and MCP.
- Two-user/team fixture: owner invites member, member accepts via addressed
  expiring token; owner-only tool hidden/denied for member; last-owner
  removal rejected; removed member loses admission; prior admitted op may
  finish (documented boundary).
- Sessions: revocation ends browser + MCP grants immediately; recovery token
  single-use + expiring; wrong-audience token rejected; CSRF missing/stale
  rejected on POST; GET stays side-effect-free.
- Wire: unknown args/undeclared writable fields fail; int/decimal strings
  exact (no Number collapse); action_handle mode omits protected inputs;
  mixed/ordinary+handle envelopes fail.
- Uploads: JSON-declared file without intent/bytes/finalize never yields an
  attachment; partial/oversize/malformed bytes yield no file; cross-team
  reference fails admission; unsupported host gets handoff-or-cannot-supply.
- Errors: every code maps to documented HTTP status + HTMX-swappable
  fragment + MCP isError shape with identical safe meaning; logs carry no
  credentials/tokens/bodies.
- B1: TeamTasks-style compile+run, two authenticated users, browser+MCP
  same-op invocation, denied read, stale update, mutation replay.
- B2: ExpenseFlow + attachment/approval/notice, role revocation, finalized
  files, failed/unknown/skipped delivery, retry, changed versions.

## Integration joins

- J1 (L7; landed in #9 except root-check include): (a) index re-exports
  identity/wire DONE; (b) root lock references both lane-06 members DONE
  (CI confirms); (c) tsconfig.check.json include for packages/identity +
  packages/interfaces still PENDING (tsconfigs are extends-compatible).
  Our tests switch from relative to @canlang/contracts imports once (c)
  lands and contracts/dist is built in CI. No root file is touched by
  lane 06.
- X1 (L7/L4 export conflicts, filed by L7 in #9 index comments; lane-06
  acknowledgment): `UploadIntentRequest` (files vs wire) is NOT divergent —
  both spell the identical DESIGN section-8 POST body
  {upload_id,operation,field,arguments,name,type,size}; only readonly and
  alias style differ. Same for `FileTransferMeta` and `DeliveryStatus`
  (identical text). Counter-proposal: dedupe to one canonical definition
  instead of renaming. CONTRACTS assigns upload transport to L6, so wire.ts
  keeps the two transport envelopes (request/response/finalize) and files.ts
  owns intent lifecycle/provenance, importing the envelopes; `DeliveryStatus`
  + `DeliveryError` stay canonical in services.ts (L4 owns the outcome
  vocabulary) with wire.ts importing them for the closed mutation result.
  `OperationId` keeps BOTH spellings by layer (plain wire string in,
  branded engine type constructed at admission). `StateErrorCode` vs
  `BusinessErrorCode` need runtime equality at S4 admission, not a rename.
  Scoped to S3 (wire codecs slice); S2 touches no wire.ts shape. Needs L4
  + L7 acknowledgment; L7's interim picks stand until then.
- J2 (needs L3): bind identity store port to fenced D1 tables; use canonical
  invocation callable in HTTP/MCP dispatch. Request: membership/session
  table contract + invocation port signature with a two-user witness.
- J3 (needs L1): real operation registry + page descriptors/admission
  callables. Request: registry + descriptor shape with TeamTasks witness.
- J4 (needs L2): canonical value codecs + schema catalog entries.
- J5 (needs L5): fragment/page render callables + form schemas.
- J6 (needs L4): file finalization/provenance + provider-event verifier.
- J7 (needs L7): workerd/D1 local run + BDD testkit for B1/B2 evidence.

## Progress and file reservations

- 2026-10-04: worktree+goal+inventory+plan done. S1 merged as e5b7334
  (PR #6). S2 branch: muse/lane-06-identity-interfaces/identity-core.
- 2026-10-04 S2 incident (RESOLVED by instance restart): both implementer
  subagent spawns failed with environment EMFILE, and coordinator shell
  calls failed the same way for 4 turns; the coordinator implemented S2
  inline and verified after recovery. Reservations: coordinator holds all
  of packages/identity/src/**, test/accounts.test.ts, test/sessions.test.ts,
  test/teams.test.ts, test/context.test.ts and this file until S2 merges.
  No other lane-06 writer exists. Delegation resumes at S3.

## Interface requests and handoffs

- None merged yet. Standing requests J1-J7 above; each will be filed as a
  committed status entry + PR description naming producer, exact
  type/function/behavior, consuming example and earliest milestone, per
  WORKFLOW. First: J1 to L7 on the S1 PR.

## PR and verification evidence

- S1 (in progress): branch muse/lane-06-identity-interfaces/plan, PR
  https://github.com/veighnsche/canlang/pull/6. Independent read-only
  subagent review: REQUEST-CHANGES (MCP flat-projection framing in wire.ts
  comments) — all findings addressed (framing corrected, SealedActionHandle
  spelling labeled lane-06, retryable cites DESIGN section 7, test/CI
  hardening incl. owned-import guard). After L7 B0 (#4) merged, rebased and
  adapted: tsconfigs extend tsconfig.base.json (NodeNext), member lockfiles
  removed (single root lock), CI installs at root workspace ephemerally.
  Local checks 2026-10-04 post-adaptation: `npm test --workspace
  @canlang/identity --workspace @canlang/interfaces` 4/4 + 7/7 pass
  (Node v24.21.0). Merged 2026-10-04 as e5b7334 (squash of reviewed head
  66c12fa, CI contracts-conformance green). J1 (a)+(b) landed via L7 #9;
  (c) root-check include and L3 convergence acknowledgment still pending,
  tracked above, non-blocking.
- S2 (MERGED 2026-10-04 as f092bbb, PR #12): identity core, 33/33 tests.
  Independent review REQUEST-CHANGES (F1 login timing oracle, F2 clear-cookie
  Secure, F3 caller-now, F4 re-admission orphan, F5 grant collapse, F6-F9 test
  gaps, F10-F13 notes) — all addressed, delta re-review APPROVED, CI green.
  Execution also caught the opaque-token text-vs-bytes hash bug pre-PR.
- S3 (MERGED 2026-10-04 as f5a1db6, PR #19): errors/envelope/projection,
  interfaces 60/60 (identity 33/33). Two disjoint implementers (C errors,
  D envelope+projection); coordinator-reviewed. Independent review
  REQUEST-CHANGES (F1 business-path redaction, F2 __proto__, F3 key list,
  N1-N7 notes) — all addressed, delta re-review APPROVED, lane-06 CI
  green. Note: the `integration`/`workspace` check is RED ON MAIN since
  before #19 (root lock missing miniflare/workerd/sharp entries; L7-owned,
  pre-existing — verified via main-branch run history, not lane-06 caused).
  J1 follow-up for L7 stands (root-lock regen incl. new member->contracts
  edges + tsconfig.check include).
- S4 (MERGED 2026-10-04 as 9a01b51, PR #22): canonical HTTP dispatch,
  interfaces 120/120 (identity 33/33). Two disjoint implementers (E routes/
  pages/fragments, F operations/auth/limits) + coordinator seams. Review
  APPROVE-WITH-NOTES (N1 clock, N2 logout idempotence, N3 urlencoded gaps,
  N4 team oracle, N5 docs, N6 undecodable cookie, N7/N8 notes) — all fixed
  with pins. Post-review main move (L5 S3 PresentationContext
  invocation/query) adapted via row-query runner bound to read invoker;
  delta re-review APPROVED; lane-06 + workspace CI green. Observed hazard
  (L5/L7 owned): @canlang/ui dist bundles its own contracts copy — dual
  type identities unless every consumer builds fresh in dependency order.
- S5 (MERGED 2026-10-04 as 090f7b4, PR #32): branch `muse/lane-06-identity-interfaces/mcp-server`
  from origin/main (rebased onto 64d459a post Lane-02 PR4). Scope: MCP SDK
  qualification, registry->tool generation, closed-schema derivation,
  grant-bearer audience binding, discovery/call permission rechecks,
  same-invocation proof with S4.
  - QUALIFIED 2026-10-04: official `@modelcontextprotocol/sdk` 1.32.0
    (pinned). Evidence: `WebStandardStreamableHTTPServerTransport` closure
    (transport + shared/requestBody + shared/sseKeepAlive) contains zero
    `node:` imports; documented Cloudflare-Workers-safe; stateless via
    `sessionIdGenerator: undefined`; `LATEST_PROTOCOL_VERSION =
    '2025-11-25'` matches the DESIGN-pinned MCP auth spec date; tool names
    allow dots (`/^[A-Za-z0-9._-]{1,128}$/`), so canonical fq names are
    used verbatim. SDK OAuth authorization-server code is express-bound
    (not workerd-safe) -> full OAuth HTTP dance (metadata/authorize/token)
    deferred to S7; S5 authenticates via grant bearers + `mcp-grant`
    audience only. Local `npm install` run for dev; root-lock regen stays
    L7-owned (J1 follow-up extended with the SDK edge).
  - Coordinator files landed: identity `authentication/grants.ts`
    (`issueMcpGrant`, 30-day TTL) + `test/grants.test.ts` (identity 36/36);
    interfaces SDK dep, ports.ts S5 section (McpSchemaField, descriptors,
    registry/permissions/files ports, McpDeps), testing.ts MCP doubles.
  - Implementers: G owns mcp/{server,discovery}.ts + mcp-server.test.ts
    (SDK Server + stateless transport, raw JSON-RPC round-trips,
    same-invocation proof vs S4 HTTP); H owns mcp/{tools,schemas}.ts +
    mcp-tools.test.ts (generation, closed schemas, handle-mode anyOf).
    Coordinator pre-PR fixes: owner check on call path (not just
    discovery), requireVersion-keyed ref parser (schema/server agree).
  - PR #32 open at f25f460 (interfaces 148/148, identity 36/36).
    Independent review REQUEST-CHANGES, all valid, all addressed: F1
    integer renders decimal-string (was JSON number); F2 handle mode
    admits non-record canonical inputs per wire ActionHandleInvocation
    (schema branch + `handleModeAllowed` + forwarding; ref overrides
    fail); F3 mutation schema root `type:'object'`; F4 oracle comments
    corrected to the actual guarantee. Folded notes: N1 negotiation
    fallback pin, N2/N3 auth+framing pins (lowercase bearer accepted
    per RFC 9110, session-as-bearer/expiry 401s, read+op_id closed,
    malformed op_id, ReadRef-with-version, catalog-skew not_found),
    N5 case-insensitive scheme, N8 denial info-logging like S4 deny(),
    N9 client_id trim + 256 bound, N10 catalog/descriptor consistency
    comment, N12 results-unvalidated comment. Deferred with reason: N4
    (keep collapsed auth message), N6/N7 (need L1 joins: initialize
    instructions, union/array fields), N11 (SDK 4 MiB/413 + batch-100
    vs S4 1 MiB/429 noted divergence, bounded). Discovered while
    pinning: SDK protocol layer rejects unparseable params with
    -32603 before our handler (test documents the seam).
    After fixes: interfaces 160/160, identity 38/38. Delta re-review
    REQUEST-CHANGES on two stale comments (R1/R2) + sealed-message pin
    suggestion — all fixed, final confirm APPROVED. Rebased onto fb226e0
    (L1 B0 + L3 S4 + L4 S5/S6 + L5 S5); lock conflict resolved with
    main's lock + SDK edge re-applied; suites re-verified green;
    merged with lane-06 + workspace CI green (lock sync fixed the
    `npm ci` failure the new dep had introduced).
- S6 (in progress): branch `muse/lane-06-identity-interfaces/uploads`
  from origin/main (090f7b4). Scope: POST /files/intents, PUT
  /files/content/{id} (append + auto-complete), POST
  /files/finalize/{id} per DESIGN section 8; session+bearer auth,
  usesFiles gating, principal/binding construction, kernel-outcome
  error mapping; _meta/intentsUrl consistency (S5 double fixed to
  /files/intents).
  - Join J6 (new, L4): @canlang/files ships no built surface, so S6
    routes against a `FileKernel` port mirroring the real L4 entry
    points (upload/index.ts + bridge.ts + finalize/index.ts) with
    contracts file types; B1 binds the real kernel (compile-time
    forcing function). Committed tests script the port (routing/auth/
    mapping, like the L3 invoker precedent); kernel semantics stay
    covered by L4 journey tests; a /tmp probe exercises the real
    kernel through these routes as supplementary evidence.
  - Lane-06 decisions: team slot falls back to user id in non-team
    apps (L4 binder rejects empty); binding adapter constant
    `bridge-v1`, deliveryId=upload_id, resultPath=field; PUT
    auto-completes via kernel complete after every append (partial
    = stay-open success, not error); foreign/expired collapse to
    not_found (no oracle).
  - Coordinator files: ports.ts (AppInfo.appId, FileUseInfo,
    UploadReceiver/Binding, kernel outcomes, FileKernel, UploadDeps,
    HttpDeps.uploads), testing.ts (fake kernel/use-info/upload deps),
    routes.ts /files mount + UPLOADS_PREFIX, spy/literal updates.
  - Implementer I owns uploads/{principals,routes}.ts + uploads.test.ts.
  - Verification: interfaces 192/192 (32 new), committed tests script
    the port; /tmp/s6-kernel-probe.mjs (supplementary, kept out of the
    repo) drives the REAL L4 kernel through the compiled routes:
    PROBE PASS 9/9 (grant, same-origin destinations, PUT complete with
    accepted pdf check, wrong-digest conflict, finalize ref + repeat,
    invented-intent 404, oversized 429, cross-team 404).

## Remaining work and cleanup

Full lane scope (S1-S7 + B1/B2) remains. Owned resources: one worktree
(lane-06-identity-interfaces), no build caches beyond package-local
node_modules. Cleanup after writer release: remove worktree via primary
checkout `git worktree remove`, prune branch.
