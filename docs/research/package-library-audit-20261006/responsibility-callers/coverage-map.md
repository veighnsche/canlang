# Production responsibilities and callers

Source pin: `851352d5225f0d707246eba7da81482087566994`. One current package owner per responsibility; status describes reviewed source, not installed execution. Public exposure and detailed caller/evidence/limits are retained in [machine records](responsibilities.jsonl). [Declared package APIs](public-apis.tsv) and [file coverage](file-coverage.tsv) are complete structural maps. No row authorizes deletion.

## cloudflare

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| CF-activation | Fail closed on compatibility, release and installed/state/work activation gates | source path | packages/cloudflare/src/cli/platform.ts:308 activate; packages/cloudflare/src/preparation/host.ts:353 activate |
| CF-apply | Run bounded explicit Wrangler deploy and expose honest manual fallback instructions | source path | packages/cloudflare/src/preparation/host.ts:435 manualApplyCommand; packages/cloudflare/src/preparation/host.ts:440 runWranglerDeploy |
| CF-artifact | Read/parse compiler artifact, validate its shape and compiled identity before platform use | source path | packages/cloudflare/src/cli/platform.ts:212 loadArtifactFile; packages/cloudflare/src/preparation/host.ts:251 loadArtifactFile |
| CF-asset-bundle | Validate/attach binary assets and Wasm pins, stage optional values glue and browser asset files | conditional | scripts/verify-installed-worker.mjs:85 buildDeployBundleWithAssets; scripts/verify-installed-worker.mjs:110 writeDeployBundleWithAssets |
| CF-bundle | Assemble portable worker, artifact, owning producer vendor modules, catalog and deterministic module inventory | source path | packages/cloudflare/src/preparation/build-adapter.ts:220 buildDeployBundle; packages/cloudflare/src/preparation/host.ts:429 writeDeployBundle |
| CF-canonical-mutation | Bind canonical admission/replay, state CRUD/scenario writes, staged overlay and same-context commit guards | source path | packages/cloudflare/src/worker/assembly.ts:907 invokeCanonical |
| CF-canonical-policy | Read owning operation/model policies, adapt CRUD/scenario predicates and require canonical descriptor/contract pins | source path | packages/cloudflare/src/worker/assembly.ts:883 canonical invoker loaders |
| CF-canonical-read | Bind current-authority model query/read through owning state producer and descriptor policies | source path | packages/cloudflare/src/worker/assembly.ts:940 readCanonical |
| CF-cli | Parse CLI commands/options and route run/test/build/deploy/activate/docs with stable envelopes | source path | packages/cloudflare/package.json:10 bin.can-platform |
| CF-compat | Compare installed runtime/artifact capability contracts and compiler release version | source path | packages/cloudflare/src/deploy/activate.ts:1 checkCompatibility |
| CF-context-stdlib | Provide contextual mutation/read guards and explicit unsupported effect stubs for in-memory stdlib injection | conditional | packages/cloudflare/src/cli/platform.ts:222 stdlibUrl runtime/stdlib.js |
| CF-deploy-plan | Resolve resource requirements into a deploy plan and deterministic configuration text | source path | packages/cloudflare/src/preparation/host.ts:381 buildDeployPlan |
| CF-deploy-review | Admit previous plans and show deterministic resource diffs/preview before explicit confirmation | source path | packages/cloudflare/src/preparation/host.ts:394 loadPreviousPlan; packages/cloudflare/src/preparation/host.ts:398 diffPlans |
| CF-diagnostics | Invoke loaded callable functions and map thrown JS frames through assembled/deployment source maps | conditional | packages/cloudflare/src/runtime/executors.ts:261 invokeCallableInOccurrence |
| CF-dispatch-composition | Compose explicit injected dispatch command segments with callable/uniqueness gates | tests only | No direct caller established; see evidence/limits |
| CF-dispatch-driver | Drive dispatch intents, execute handler occurrence, commit results and sweep expired recovery claims | conditional | injected driver -> invoke/commit/fence/attempt -> result or recovery |
| CF-dispatch-staging | Load canonical state system/join producers and execute injected work command registry with origin/fence checks | conditional | explicit dispatch API -> state registry/join producers -> supplied work command registry -> staged batch |
| CF-dist-integrity | Build/verify release inventory of supported package outputs and bytes | conditional | package.json:19 release:manifest/release:verify; scripts/pack-release.mjs:39 manifest.js --verify |
| CF-docs | Render localized reference model from stdin with package contract renderer | source path | packages/cloudflare/src/cli/platform.ts:411 runDocs |
| CF-env-stores | Bind D1 and initialize state/identity schemas with owning package producers | source path | packages/cloudflare/src/worker/main.ts:1 loadBuildProductionDeps |
| CF-exports | Node public export assembly for compatibility, deploy-plan and local-host APIs; separate Worker exports exclude Node imports | source path | @canlang/cloudflare root export -> compat/plan/local-run reexports |
| CF-fanout-composition | Compose six required injected fanout-serving entries as one immutable surface | tests only | No direct caller established; see evidence/limits |
| CF-fanout-driving | Claim children, record attempts, release stale claims, schedule finite fair turns, read progress and cancel providers | conditional | explicit fanout serving segments -> state producer auto-load -> injected work/provider/authority ports |
| CF-fanout-staging | Consume emitted finite cohorts and stage fanout intent/checkpoint/child rows against current fences | conditional | explicit emitted cohort consumer -> state producer auto-load plus injected work ports -> finite rows |
| CF-grant-route | Authenticate MCP grant request and issue/revoke scoped credentials against current identity store | source path | packages/cloudflare/src/worker/main.ts:1 loadHandleGrant and grant route |
| CF-handler-context | Provide transactional create/set/delete/read and injected context functions to generated handlers | source path | packages/cloudflare/src/runtime/invoke.ts:2841 createContext |
| CF-imports | Parse admitted ECMAScript import syntax and rewrite specifiers preserving edit maps; reject forbidden dynamics | source path | packages/cloudflare/src/runtime/modules.ts:120 rewriteModuleImports; packages/cloudflare/src/deploy/bundle.ts:437 rewriteModuleImports |
| CF-in-memory-assembly | Assemble modules into a private Node directory and rewrite UI/stdlib imports with maps | source path | packages/cloudflare/src/cli/platform.ts:224 assembleModules; packages/cloudflare/src/cli/platform.ts:352 assembleModules |
| CF-installed-runtime | Resolve actual installed producer versions/capabilities; build truthful installed descriptor | source path | packages/cloudflare/src/cli/platform.ts:295 probeInstalledRuntime; packages/cloudflare/src/preparation/host.ts:333 probeInstalledRuntime |
| CF-legacy-executors | Expose older occurrence/direct execution and dispatch-write wrapper helpers | tests only | No direct caller established; see evidence/limits |
| CF-local-defaults | Discover one artifact, derive local compatibility/name defaults and require built UI inputs | source path | packages/cloudflare/src/cli/platform.ts:341 resolveLocalDefaults; packages/cloudflare/src/cli/platform.ts:416 resolveLocalDefaults |
| CF-local-host | Create configurable local Miniflare runtime; inject booted modules and dispose resources | source path | packages/cloudflare/src/dev/row-scope.ts:76 startLocalDev |
| CF-local-rows | Snapshot/reset/dispose per-row D1 local scopes and isolate fixtures | source path | packages/cloudflare/src/cli/platform.ts:361 createLocalRowScope |
| CF-maps | Compose original source maps with rewrite maps without changing raw source identities/content | source path | packages/cloudflare/src/runtime/modules.ts:124 composeModuleMap |
| CF-mcp-permissions | Resolve member-scoped derived inputs and deny unauthorized MCP operations | source path | packages/cloudflare/src/worker/main.ts:1 loadCreateMcpPermissions |
| CF-mcp-registry | Derive operation/schema/derived-input catalog and deny-closed default permission surface from artifact | source path | packages/cloudflare/src/worker/assembly.ts:1 registry/catalog producers |
| CF-native-artifact | Admit tagged input trees and artifact structure/errors for native preparation | unadopted | packages/cloudflare/preparation/src/job.rs:424 real-stage artifact admission |
| CF-native-build-tool | Pin/build native release binary for explicit supported host; stage source/toolchain/lock digests | conditional | packages/cloudflare/scripts/package-preparation.mjs:20 hostTriple/binaryName |
| CF-native-entry | Registered native binary/library entries expose algorithm modules and dispatch framed real versus scaffold jobs | unadopted | packages/cloudflare/preparation/Cargo.toml:1 registered binary/library |
| CF-native-frame | Native framed stdin/stdout codec and host message admission | unadopted | packages/cloudflare/preparation/src/job.rs:42 next_message |
| CF-native-host-protocol | Encode bounded admitted UTF-16 tagged trees and drive framed finite native jobs with exact host replies | unadopted | explicit native-job API -> framed session -> real/scaffold stages via supplied onNeed |
| CF-native-integrity | Native lockstep, output inventory, executable manifest and digest algorithms | unadopted | packages/cloudflare/preparation/src/job.rs:491 build-tail lockstep/inventory |
| CF-native-modules | Scan/rewrite admitted import syntax and construct native staged module map | unadopted | packages/cloudflare/preparation/src/job.rs:491 build-tail module staging |
| CF-native-package-tool | Package existing host binary with integrity/license/release metadata and forbid Worker contamination | conditional | explicit release packaging script -> existing binary inventory/manifest |
| CF-native-plan | Native compatibility, deployment plan, render and review algorithms | unadopted | packages/cloudflare/preparation/src/job.rs:615 deploy-tail algorithms |
| CF-native-selection | Resolve integrity-checked native executable and select requested backend or readiness probe | unadopted | explicit native API -> resolution/manifest -> launch |
| CF-producer-lookup | Resolve package-owned installed build outputs instead of checkout guesses | source path | packages/cloudflare/src/deploy/bundle.ts:943 resolveProducerFile; packages/cloudflare/src/runtime/modules.ts:80 resolveProducerFile |
| CF-publication | Contain native prepared outputs in symlink-safe temporary roots and publish/rollback final destinations | tests only | No direct caller established; see evidence/limits |
| CF-selected-receipt | Serve selected receipt join and observe compatible work progress with optional real observer fallback | conditional | packages/cloudflare/src/worker/assembly.ts:1 selected receipt reader |
| CF-ts-build | Validate build artifact and release lockstep in the current CLI build route | source path | packages/cloudflare/src/cli/platform.ts:394 runPreparedBuild |
| CF-ts-deploy | Gate, bundle, render/review preview and explicitly apply deployment through host phases | source path | packages/cloudflare/src/cli/platform.ts:404 runPreparedDeploy; packages/cloudflare/src/preparation/host.ts:362 buildBundleWithHostPhases |
| CF-ts-host-helpers | Own host-only I/O, sidecar admission, failure envelopes and package roots | source path | packages/cloudflare/src/cli/platform.ts:286 loadDescriptor/loadEnvironment/loadTarget |
| CF-upgrade-sequence | Expose staged upgrade callback ordering and refusal behavior | tests only | No direct caller established; see evidence/limits |
| CF-worker-composition | Load canonical runtime dependencies, check contract pins, build operation invoker and mount interim MCP/HTTP/page routes | source path | packages/cloudflare/src/worker/main.ts:1 loadAssembly and assembleWorker |
| CF-worker-main | Worker fetch entry validates env, lazily loads staged modules, caches assembly and delegates grant/general routes | source path | packages/cloudflare/src/deploy/bundle.ts:109 DEPLOY_MAIN_MODULE worker/main.js |

## contracts

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| contracts-artifact | Compiler artifact modules/maps/pages/callables/model/default/operation/cohort/test records | types | packages/cloudflare/src/runtime/artifact.ts:15 CompileArtifact |
| contracts-artifact-version | Pinned artifact runtime format version | source path | packages/interfaces/src/http/operations.ts:396 ARTIFACT_VERSION |
| contracts-assembly | Type/runtime version barrel and explicit conflict resolution picks | source path | packages/cloudflare/src/release/stamp.ts:146 CONTRACTS_VERSION |
| contracts-asset-helpers | Total asset kind mapping, exact text/raw byte lengths and text-only predicate | public / no observed call | No direct caller established; see evidence/limits |
| contracts-asset-types | Text/binary deployment inventory/digest versions and installed module kind vocabulary | source path | packages/cloudflare/src/deploy/bundle.ts:1221 ASSET_DIGEST_V2; packages/cloudflare/src/dev/local-run.ts:90 COMPILED_WASM_MODULE_TYPE |
| contracts-delivery-leaves | Frozen declared nominal delivery result leaf catalog and lookup helper | source path | packages/interfaces/src/mcp/schemas.ts:531 deliveryResultLeaves |
| contracts-deployment | Activation verdict, versions/dependencies, app migration/install snapshot deployment boundary | types | packages/cloudflare/src/deploy/activate.ts:276 ActivationVerdict |
| contracts-diagnostic | Compiler diagnostic spans, severities, source locations and output envelope | types | packages/cloudflare/src/cli/platform.ts:1 Diagnostic |
| contracts-distribution | Package-owned installed module location inventory | source path | packages/cloudflare/src/deploy/bundle.ts:176 distribution.modules |
| contracts-examples | Example/scenario assertions, observations, mismatch and report envelope | types | packages/testkit/src/reporting/report.ts:13 ReportValue/ExampleReport |
| contracts-files | Upload/content/object store, binding/claim and file lifecycle boundaries | types | packages/files/src/upload/index.ts:73 UploadIntentRequest/files ports |
| contracts-generated-forms | Derived-input generated form mapping/reference-version/null/currency/fold companion vocabulary and props | source path | packages/ui/src/forms.ts:1379 GENERATED_FORM_TYPE_FOR_KIND; packages/ui/src/forms.ts:1415 GENERATED_REF_VERSION_SUFFIX |
| contracts-identity | Accounts/session/membership/grants/OAuth/team ports and resolved caller authority | types | packages/identity/src/authentication/context.ts:68 ResolvedIdentity |
| contracts-identity-catalog | Reserved system team tool name catalog | public / no observed call | No direct caller established; see evidence/limits |
| contracts-packaging | Package manifest export/TS emission boundaries | source path | scripts/build-package.mjs:1 package lifecycle |
| contracts-presentation-components | Component catalog/header/slot/appearance and controls/forms/collections/media/layout/feedback/action/settings props | types | packages/ui/src/controls.ts:44 FieldControlProps; packages/ui/src/catalog.ts:27 ComponentCatalog |
| contracts-presentation-page | Presentation context, message/theme, admission/page/shell/navigation/row query contracts | types | packages/ui/src/shell.ts:14 PresentationContext/ShellData; packages/interfaces/src/http/presentation.ts:21 PresentationContext |
| contracts-presentation-runtime | Shared anti-CSRF/presession/team form keys and default theme data | source path | packages/interfaces/src/http/auth.ts:228 CSRF_FIELD; packages/interfaces/src/http/presentation.ts:68 DEFAULT_THEME |
| contracts-reference | Localized reference descriptions and compiler docs model | types | packages/interfaces/src/docs/reference.ts:358 ReferenceModel |
| contracts-services-descriptors | Runtime standard email/errors/payments/text generation/images/mailbox capability versions and input/result descriptors | source path | packages/interfaces/src/mcp/schemas.ts:377 STD_*_V1_CONTRACT |
| contracts-services-types | Capabilities/receipts/provider bindings/verified ingress and standard/provider result/input vocabularies | types | packages/services/src/ports.ts:29 CapabilityCompletion/provider types |
| contracts-state-execution | Execution descriptors/op input fields/fanout contracts and pinned artifact/state runtime versions | types | packages/state/src/invocation/registry.ts:586 T04A_PINNED_VERSIONS; packages/state/src/invocation/invoke.ts:29 ExecutionDescriptorSet |
| contracts-state-migration | Installed snapshots, staged migration chunks/work inventory/outcome and publication control types | types | packages/state/src/migration/index.ts:52 MigrationProgress/StoragePort |
| contracts-state-storage | Branded identifiers, invocation receipts/query/row/write/commit/authority storage port boundaries | types | packages/state/src/storage/port.ts:1 StoragePort/CommitBatch |
| contracts-values | Shared native/wire values, catalogs, failures and omission type boundaries | types | packages/values/src/index.ts:6 values contract re-export |
| contracts-wire-envelopes | Closed read/mutation refs/envelopes, safe errors/outcomes/action handles, upload and MCP derived-input contracts | types | packages/interfaces/src/envelope/refs.ts:8 MutationRef/ReadRef; packages/interfaces/src/mcp/server.ts:44 BusinessError |
| contracts-wire-runtime-policy | Business error vocabulary/HTTP mapping, file metadata schema markers and collection/upload/CSV limits | source path | packages/interfaces/src/errors/envelope.ts:50 BUSINESS_ERROR_HTTP_STATUS; packages/interfaces/src/http/limits.ts:139 COLLECTION_MAX_LIMIT |
| contracts-work-fanout | Fanout cutoff/intent/cohort/checkpoint/child cause/outcome/progress/diagnosis and terminal notification boundaries | types | packages/work/src/kernel/tables.ts:41 FanoutIntent/FanoutCheckpoint |
| contracts-work-lifecycle | Scheduled/recurring/outbox/claim/retry/receipt association/selected projection boundary types | types | packages/work/src/kernel/commands.ts:36 ScheduledOccurrence/OutboxItem; packages/work-kernel/src/recovery.ts:26 WorkInventoryItem |
| contracts-work-observable-catalog | Pinned receipt/progress observable declaration catalogs | public / no observed call | No direct caller established; see evidence/limits |

## files

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| files-attachment-read | Receiver-checked provenance/byte reads, attach pre-check and attachment record mutation; state inspection separates availability from immutable reference identity | tests only | packages/cloudflare/test/assembly.test.ts:762 readFinalizedBytes |
| files-bridge | Validate HTTPS same-origin bridge origin; advertise MCP transfer metadata, host-capability fallback; resolve typed principal then authorize create/append/complete/finalize | tests only | packages/files/test/bridge.test.ts:137 createBridgeOrigin |
| files-catalog | Versioned declaration of implemented file/upload/finalize/provenance/retention/bridge/storage capability APIs | public / no observed call | No direct caller established; see evidence/limits |
| files-distribution | Producer-owned compiled module directory (UI also browser resource directory) exposed for build/staging inventory | generated / staged | packages/files/package.json:72 ./distribution |
| files-finalization | Recheck owning intent/retry/digest, mint immutable ref and store/move bytes idempotently; ingest authenticated event bytes with validated provenance and actual-byte policy | conditional | packages/files/src/bridge.ts:234 finalizeUpload(; packages/files/src/finalize/index.ts:461 finalizeUpload(files, |
| files-fs-storage | Scoped flat filesystem blob implementation and safe key gate, create/read/write/append/remove/size operations | tests only | packages/files/test/foreign.test.ts:166 createFsBlobStore |
| files-port-contract | Upload intent/finalized record and clock/id/blob/intent/file/principal port contracts | types | No direct caller established; see evidence/limits |
| files-provenance | Bind immutable app/team/storage owner/verified principal + adapter/delivery/path request provenance; validate event identity and compare receiver ownership | conditional | packages/files/src/upload/index.ts:314 bindRequestProvenance(; packages/files/src/finalize/index.ts:185 freezeFinalized( |
| files-provider-output | Provider result slot retry identity and full create/append/complete/finalize flow; resume existing prefix, reject conflicting bytes and rederive rejected verdict | tests only | packages/files/test/provider-output.test.ts:85 finalizeProviderOutput |
| files-public-surface | Executable package export assembly for value functions/constants and erased type exports; supported public module surface | public / no observed call | packages/files/package.json:31 exports |
| files-retention | Sweep expiring intents/staging, orphan unattached bytes by horizon, expire retained rows and redact receipt availability while preserving metadata | tests only | packages/files/test/provider-output.test.ts:579 runRetention |
| files-scenarios | Empty file-provider scenario set by design; files use supplied bytes and real scoped local storage instead of remote provider playback | tests only | packages/files/test/scenarios.test.ts:7 scenarios |
| files-test-doubles | Explicit TestOnly manual clock, counter IDs, memory blob/intent/finalized stores and fixed principal | tests only | packages/files/test/helpers.ts:15 TestOnlyMemory |
| files-upload | Create principal-bound idempotent intent with protected field authority structure; append bounded staging bytes; actual magic/UTF8 policy validation and SHA256 completion evidence | conditional | packages/files/src/bridge.ts:176 createUploadIntent(; packages/files/src/finalize/index.ts:557 createUploadIntent( |

## identity

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| identity-account-registration | Normalize email, register unverified account, mail expiring verification, verify and sign in with password into session | conditional | packages/interfaces/src/http/auth.ts:156 registerWithEmail(; packages/interfaces/src/http/auth.ts:194 loginWithPassword( |
| identity-comparison | Reject unequal byte lengths then host-native constant-time compare: Node crypto timingSafeEqual or workerd crypto.subtle.timingSafeEqual; fail loudly without native provider | conditional | packages/identity/src/sessions/tokens.ts:74 return timingSafeEqualBytes; packages/identity/package.json:50 #identity-byte-compare |
| identity-cookie | Parse browser session cookies and serialize set/clear values with HttpOnly, Secure-default, SameSite=Lax, Path and MaxAge policy | source path | packages/interfaces/src/http/context.ts:49 parseSessionCookie(; packages/cloudflare/src/runtime/grant-route.ts:149 identity.parseSessionCookie( |
| identity-credentials | Opaque token random issuance, base64url/hex codecs and WebCrypto SHA256; hash exact presented text and preserve established decoder domain | source path | packages/identity/src/authentication/context.ts:89 await sha256HexText; packages/identity/src/authentication/grants.ts:14 createOpaqueToken |
| identity-csrf | Derive HMAC session-bound anti-forgery tokens and compare current submitted tokens | source path | packages/interfaces/src/http/context.ts:81 verifyCsrfToken(; packages/interfaces/src/http/operations.ts:115 deriveCsrfToken( |
| identity-d1 | Schema migration/ensures and durable account/session/pre-session/email-token/team/membership/invitation/MCP/OAuth code-client stores, including conditional token spending and revision participation | source path | packages/cloudflare/src/runtime/env-assembly.ts:334 await identity.ensureIdentitySchema(; packages/cloudflare/src/runtime/env-assembly.ts:337 identity.createD1IdentityStore( |
| identity-distribution | Producer-owned compiled module directory (UI also browser resource directory) exposed for build/staging inventory | generated / staged | packages/identity/package.json:19 ./distribution |
| identity-grants | Issue verified-user/team MCP grants with one-time bearer return and stored digest | source path | packages/cloudflare/src/runtime/grant-route.ts:185 identity.issueMcpGrant(; packages/identity/src/authentication/oauth.ts:241 issueMcpGrant( |
| identity-invitations | Owner-authorized invitation creation/acceptance with verified email, expiry and stored grant ceiling | tests only | packages/identity/test/teams.test.ts:75 acceptInvitation |
| identity-live-fence | Commit-time live membership/credential re-read helpers and pure liveness predicates; do not trust admission snapshots | source path | packages/interfaces/src/http/operations.ts:287 await assertCredentialLive(; packages/interfaces/src/mcp/server.ts:196 await assertCredentialLive( |
| identity-login-presession | Mint and atomically spend expiring pre-session login tokens to prevent session planting | conditional | packages/interfaces/src/http/auth.ts:180 mintPreSessionToken(; packages/interfaces/src/http/auth.ts:188 consumePreSessionToken( |
| identity-membership | Owner-managed member removal with last-owner guard and immediate future admission denial | tests only | packages/identity/test/teams.test.ts:199 removeMember |
| identity-oauth | Public client registration, redirect URI validation, S256 PKCE code authorization/exchange and atomic code spend for grant issuance | conditional | packages/interfaces/src/oauth/routes.ts:200 registerClient(; packages/interfaces/src/oauth/routes.ts:400 exchangeCode( |
| identity-password | Password policy, PBKDF2-HMAC-SHA256 salted hashing and encoded verification using host comparison | conditional | packages/identity/src/accounts/registration.ts:72 hashPassword(; packages/identity/src/accounts/registration.ts:131 verifyPassword( |
| identity-ports | Identity store/mail/clock/random contracts plus executable IdentityError, system clock/random/instant defaults | source path | packages/identity/src/authentication/context.ts:19 systemClock; packages/identity/src/sessions/tokens.ts:11 webRandom |
| identity-public-surface | Executable package export assembly for value functions/constants and erased type exports; supported public module surface | source path | packages/identity/package.json:10 exports; packages/cloudflare/src/runtime/env-assembly.ts:276 mod = await import(IDENTITY_SPECIFIER) |
| identity-recovery | Non-enumerating recovery request and expiring token consumption/password update/session invalidation | conditional | packages/interfaces/src/http/auth.ts:238 requestRecovery(; packages/interfaces/src/http/auth.ts:251 recoverAccount( |
| identity-resolution | Resolve anonymous/session/MCP identities from current hashed credential, team and active membership facts; reject mixed audiences and stale credentials | source path | packages/interfaces/src/mcp/server.ts:118 resolveIdentity(; packages/interfaces/src/http/context.ts:51 resolveIdentity( |
| identity-revoke | Revoke presented session, all user credentials or MCP grant idempotently; preserve first revocation instant | conditional | packages/interfaces/src/http/auth.ts:230 revokeSessionByToken(; packages/identity/src/accounts/recovery.ts:85 revokeUserSessions |
| identity-roles | Owner-managed role grant/revoke with closed role-value grammar and last-owner authority rules | tests only | packages/identity/test/teams.test.ts:241 setMemberRole |
| identity-team-selection | Set/clear session team hint after current authorization and credential checks | conditional | packages/interfaces/src/http/auth.ts:272 selectTeam(; packages/interfaces/src/http/auth.ts:293 clearTeamSelection( |
| identity-test-doubles | Memory identity store, frozen clock and captured mail outbox for controlled tests | tests only | packages/identity/test/context.test.ts:9 createMemoryIdentityStore |

## interfaces

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| interfaces-assets | Validate immutable finite JS/CSS byte table; exact GET/HEAD asset keys with traversal/method rejection and cache headers | tests only | packages/interfaces/test/browser-assets.test.ts:48 handleAssetsRequest( |
| interfaces-auth | Auth JSON/form callbacks for register/verify/login/recovery/logout/team; rate limits/body parsing/pre-session spend/cookie write and safe error mapping | conditional | packages/interfaces/src/http/routes.ts:139 return await sub.auth(request); |
| interfaces-contracts | HTTP/MCP identity/catalog/invoker/permissions/upload/ingress/logger and clock port type contracts | types | No direct caller established; see evidence/limits |
| interfaces-csv | Authoritative capped CSV grammar review, mapping and prepared closed/bound plan; current principal consent and per-row commit/receipt/frozen identity semantics | conditional | packages/interfaces/src/http/routes.ts:152 return await sub.csv(request);; packages/interfaces/src/http/csv.ts:255 runPreparedHttpPlan( |
| interfaces-distribution | Producer-owned compiled module directory (UI also browser resource directory) exposed for build/staging inventory | generated / staged | packages/interfaces/package.json:15 ./distribution |
| interfaces-docs | Localized pure reference Markdown rendering, descriptor/type/operation/error documentation through @canlang/values resolveVariant engine | source path | packages/cloudflare/src/cli/docs.ts:133 renderer.renderReferenceMarkdown( |
| interfaces-errors | Closed public business envelope/status projection and safe message vocabulary; redacted incident/business logs; never leak unexpected failures | source path | packages/interfaces/src/mcp/server.ts:131 logInternalError(; packages/interfaces/src/http/operations.ts:75 logBusinessError( |
| interfaces-export | Bounded current-authority list export with live authority checks, secret refusal, field CSV formula protection, inline payload or expiring download descriptor | conditional | packages/interfaces/src/http/routes.ts:156 return await sub.exports(request);; packages/interfaces/src/http/print.ts:183 readExportPage( |
| interfaces-file-kernel-binding | Validate injected real file kernel functions and promisify create/append/complete/finalize, provenance/attachment/read journey seams | tests only | packages/cloudflare/test/assembly.test.ts:764 createFileJourneyKernel |
| interfaces-form-rerender | Public form-binding registry and derived binding renderer; sanitize errors, draft values and errors/outcome HTML fragments on requested operation denial | conditional | packages/interfaces/src/http/operations.ts:119 renderFormError(; packages/interfaces/src/http/formErrors.ts:67 formBindingFor( |
| interfaces-http-limits | Bounded streaming request read, JSON/form parsers, collection query shape validation and unauthenticated auth rate policy | source path | packages/interfaces/src/http/operations.ts:195 parseJsonBody(; packages/interfaces/src/http/auth.ts:148 checkAuthRateLimit( |
| interfaces-http-operation | HTTP mutation dispatch: method/body cap, session identity and CSRF, closed envelope/ref/version/bound-input validation, live credential check, canonical invoker, business error projection or registered HTML rerender | source path | packages/cloudflare/src/worker/assembly.ts:1347 return factory(deps)(req, op);; packages/cloudflare/src/preparation/build-adapter.ts:131 export { handleOperationRequest } |
| interfaces-ingress | Provider callback admission: route/binding -> capped raw bytes -> JSON -> verifier -> namespace consistency -> trusted actor-null context -> sink | conditional | packages/interfaces/src/http/routes.ts:145 return await sub.ingress(request); |
| interfaces-input-derivation | Check artifact operations, derive closed writable input shapes/bindings; validate ordinary ref/delivery/scalar schema; project JSON schema and bound constants | source path | packages/cloudflare/src/preparation/build-adapter.ts:196 catalogFromArtifactOperations(; packages/interfaces/src/mcp/tools.ts:30 toToolInputSchema( |
| interfaces-intake | ErrorsV1 anonymous write-only intake key/project binding, caps/schema/rate admission, sink and safe error responses | tests only | packages/interfaces/test/intake.test.ts:68 handleIntakeRequest( |
| interfaces-mcp | Stateless SDK HTTP MCP server; resolve grant identity/audience, initialize metadata, permission-filter tools/list and tools/call; ordinary vs sealed action-handle mutation/read paths, live credential check and structured business receipts | source path | packages/cloudflare/src/worker/assembly.ts:1236 return factory(deps)(req);; packages/cloudflare/src/preparation/build-adapter.ts:78 export { createMcpHandler |
| interfaces-oauth | OAuth metadata/challenge, public registration/consent GET/POST with session CSRF, code/token exchange and generic error projections | conditional | packages/interfaces/src/http/routes.ts:148 return await sub.oauth(request);; packages/interfaces/src/mcp/server.ts:115 wwwAuthenticateChallenge( |
| interfaces-pages | Page exact/pattern routing, trailing-slash redirect, session/CSRF presentation, admission before render, fragment errors, permission-aware navigation/shell and HEAD behavior | conditional | packages/interfaces/src/http/routes.ts:163 return await handlePageRequest( |
| interfaces-prepared-mcp | Reusable prepared ordinary MCP closed-input/ref/operation-id/bound-input framing plan; excludes action handle branch | tests only | packages/interfaces/test/owned-mcp.test.ts:154 runPreparedMcpPlan( |
| interfaces-print | Declared print-view registry lookup, fresh identity/authority and bounded list read, escaped HTML view rendering | conditional | packages/interfaces/src/http/routes.ts:160 return await sub.print(request); |
| interfaces-projection | Grant leaf-path projection over structured/reference values and presence checks | tests only | packages/interfaces/test/projection.test.ts:33 projectFields |
| interfaces-public-surface | Executable package export assembly for value functions/constants and erased type exports; supported public module surface | source path | packages/interfaces/package.json:10 exports; packages/cloudflare/src/preparation/build-adapter.ts:37 import { catalogFromArtifactOperations } |
| interfaces-router | Full HTTP router dispatches injected operations/auth/uploads/ingress/OAuth and optional CSV/export/print, fallback page GET/HEAD; contains errors | tests only | packages/interfaces/test/csv-join.test.ts:66 createHttpHandler |
| interfaces-test-doubles | Memory clocks/logs/registries/limiters/invokers/file and ingress seams for controlled transport tests | tests only | packages/interfaces/test/mcp-server.test.ts:32 ../src/testing.js |
| interfaces-uploads | Parse upload routes, current session/MCP principal/audience and operation input binding; capped byte transfer; async kernel create/append/complete/finalize transport projections | conditional | packages/interfaces/src/http/routes.ts:142 return await sub.uploads(request); |
| interfaces-version-check | Expected-version optimistic concurrency predicate with canonical integer comparison | tests only | packages/interfaces/test/envelope.test.ts:187 checkExpectedVersion |

## services

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| services-catalog | Advertise four implemented capability families and main operations | public / no observed call | No direct caller established; see evidence/limits |
| services-distribution | Producer-owned compiled module directory (UI also browser resource directory) exposed for build/staging inventory | generated / staged | packages/services/package.json:95 ./distribution |
| services-harness | Real localhost scripted mail/model/judgment/media endpoints, request logs, timeout/redirect/body/stream scenarios and disposal | tests only | packages/services/test/mail-adapter.test.ts:20 startControlledMailServer; packages/services/test/models-ollama.test.ts:16 startControlledOllamaServer |
| services-http | Fixed-origin authenticated HTTP request, manual same-origin redirect policy, unified headers/body deadline, bounded binary/text/stream readers and caller abort distinction; typed status/transport limits | conditional | packages/services/src/mail/adapter.ts:628 await httpRequest(; packages/services/src/media/comfyui.ts:654 httpRequestBinary( |
| services-judgments | Validate/bound and freeze typed noul/choice/score question batch, serialize System One wire, validate answer identity/probability/usage; classify completion and honest no-resume reconcile | tests only | packages/services/test/judgments-systemone.test.ts:39 SystemOneAdapter |
| services-mail | Freeze delivery recipient/body/attachment refs and aggregate size; send idempotency key, classify accepted/rejected/unknown, reconcile original delivery identity; closed completion envelope validation | tests only | packages/services/test/mail-adapter.test.ts:44 EmailV1Adapter |
| services-media | Pinned graph digest/mapping admission and substitutions; submit caller-restorable prompt id, poll history/download bounded declared output bytes, cancel then reconcile observed state | tests only | packages/files/test/provider-output.test.ts:650 ComfyUINativeAdapter |
| services-model | Model allowlist/token validation, frozen chat request, final-only generation and cancellable streaming run snapshots/done; validate provider final reply and unknown no-resume reconcile | tests only | packages/services/test/models-ollama.test.ts:40 OllamaChatAdapter |
| services-pagination | Reject malformed/over-limit page request without loader call; validate bounded provider page response | tests only | packages/services/test/pagination.test.ts:28 fetchPage |
| services-port-contract | Mail/model run/judgment/media and attachment/clock/id contracts; executable clock, ID and size defaults | conditional | packages/services/src/mail/adapter.ts:599 systemClock(); packages/services/src/media/comfyui.ts:441 uniqueIds( |
| services-port-test-defaults | Fixed clock, sequential IDs and fixed attachment sizes used for deterministic adapter harnesses | tests only | packages/services/test/mail-adapter.test.ts:19 fixedClock |
| services-public-surface | Executable package export assembly for value functions/constants and erased type exports; supported public module surface | public / no observed call | packages/services/package.json:30 exports |
| services-scenarios | JSON-safe versioned provider scenario vocabulary, validation/base64 media decode and authored seed tables for playback | tests only | tests/integration/b2-delivery.test.ts:52 scenarios |

## state

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| S-DO | DurableObject SQL alternative adapter for fenced domain/work/migration storage | tests only | packages/state/test/storage/do-test-worker.js:50 createDOStorage; packages/state/test/storage/do-test-worker.js:51 ensureSchema |
| S-authority | Membership/by live authorization, grant matching, safe predicate paths and secret-aware policy/projection | source path | packages/cloudflare/src/runtime/invoke.ts:2162 producers.grants.buildPolicyTable |
| S-child-join | Fanout child/outbox/checkpoint lineage assertion and optional atomic commit wrapper | tests only | packages/work/test/state-fanout/t34-f5-child-join.test.ts:465 assertFanoutChildJoin; packages/work/test/state-fanout/t34-f5-child-join.test.ts:651 createFanoutChildJoinPort |
| S-d1-core | D1 schema/backfill and fenced atomic domain/receipt/history/unique commit with rollback/error translation | source path | packages/cloudflare/src/runtime/env-assembly.ts:336 state.createD1Storage |
| S-d1-work | Outbox/schedule/due scans and recoverable dispatch/fanout domain storage backing | conditional | packages/cloudflare/src/runtime/invoke.ts:1551 store.schedulesDue |
| S-descriptors | Artifact descriptor registry and generated prepared inputs; refs/defaults/nullability/containment/delivery intake; incompatible artifact rejection | source path | packages/cloudflare/src/runtime/invoke.ts:2125 producers.registry.loadArtifactDescriptors |
| S-dispatch-join | One-to-one dispatch row/outbox guard linkage assertion and optional fenced join commit wrapper | conditional | packages/cloudflare/src/runtime/invoke.ts:3674 producers.createDispatchJoinPort |
| S-effects | Validate outbox/schedule effects and operation identity; describe dispatch origins/guards; normalize fanout membership/outcomes | source path | No direct caller established; see evidence/limits |
| S-fanout-freeze | Admission-revision canonical frozen membership with bounded resumable checkpoint/outbox staging | conditional | packages/cloudflare/src/runtime/invoke.ts:7432 producers.membership.freezeFanoutMembership |
| S-fanout-lifecycle | Live child authority/lifecycle and atomic child outcome/checkpoint writes using own admission scope | conditional | packages/cloudflare/src/runtime/invoke.ts:7148 producers.lifecycle.classifyFanoutChildLifecycle; packages/cloudflare/src/runtime/invoke.ts:6481 producers.outcome.stageFanoutChildOutcomeWrite |
| S-fanout-progress | Canonical frozen membership/checkpoint/child progress counts | conditional | packages/cloudflare/src/runtime/invoke.ts:7539 producers.progress.readFanoutProgress |
| S-fanout-shape | Cohort/cutoff/child identities, intent/checkpoint/child structural row codecs and bounded child pages | conditional | packages/cloudflare/src/runtime/invoke.ts:6032 producers.cohort.checkCutoffSpec |
| S-fence | Fresh owner/transitive scopes and imported-parent dependencies; refuse eventual authority; success/rejected receipt live commit revalidation | source path | No direct caller established; see evidence/limits |
| S-invoke | Canonical mutation admission/idempotency replay, bounded fence retry, executor, live revalidation and atomic success/rejected receipt commit | source path | packages/cloudflare/src/runtime/invoke.ts:2906 loaded.producers.invoke.invoke; packages/cloudflare/src/worker/assembly.ts:907 invokeCanonical |
| S-memory | Full in-memory fenced domain/work/migration alternative and explicit test probe/injection | tests only | packages/cloudflare/src/runtime/d3b-join-assembly.test.ts:312 createTestMemoryStorage; packages/cloudflare/src/runtime/d3b-observer-seam.test.ts:183 createTestMemoryStorage |
| S-migration-failure | Failure evidence, abort/retry and staged discard; unexpected failure/recovery uncertainty | tests only | packages/state/test/migration/recover.test.ts:178 recordFailure; packages/state/test/migration/recover.test.ts:207 abortMigration |
| S-migration-lifecycle | Activate/resume migration state machine, inventory/evidence gates, publish chunks/drops and fenced installed flip | tests only | packages/cloudflare/src/deploy/activate.ts:256 gates.checkActivationInventory; packages/cloudflare/test/activate.test.ts:132 checkActivationInventory |
| S-migration-plan | Validate transition directives/model ownership/mappings, retained work carryover and fresh install snapshot | tests only | packages/state/test/migration/retain.test.ts:112 computeRetainedCarryover |
| S-migration-stage | Freeze old rows, seeded row builder/mapped-row validation and bounded resumable migration staging | tests only | No direct caller established; see evidence/limits |
| S-migration-validation | Global staged refs/unique/lock/drop/retention inventory validation | tests only | No direct caller established; see evidence/limits |
| S-models-crud | Canonical model tables, generated CRUD with refs/server defaults/nullability/containment; separate interim CRUD definitions | source path | packages/cloudflare/src/runtime/invoke.ts:2136 producers.models.buildModelTableFromCanonical; packages/cloudflare/src/runtime/invoke.ts:2901 loaded.producers.crud.generatedCrudExecute |
| S-pipeline | Stage create/update/remove, hooks/invariants/locks/defaults, archive/cascade, history and unique claims/releases | source path | packages/cloudflare/src/runtime/invoke.ts:2760 loaded.producers.pipeline.runMutationWrites |
| S-public-DO-test-worker | Miniflare test Worker and fixed TestDO instance exposing storage method RPC, reset and SQL inspection over built real DO adapter | tests only | packages/work/test/state-fanout/t34-f5-durable.test.ts:107 import.meta.resolve(@canlang/state/testing/storage/do-test-worker); packages/work/test/state-fanout/t34-f5-durable.test.ts:204 Miniflare scriptPath: doWorkerPath |
| S-public-T18-fixture | Generated source-bound Shop .can text and byte-identical compiled JSON fixture for real descriptor/default/containment/admission parity proofs | generated / staged | packages/state/src/mutation/t18-defaults.test.ts:70 JSON.parse(T18_SHOP_ARTIFACT_JSON); packages/cloudflare/src/runtime/t32b-cloudflare.test.ts:1545 JSON.parse(T18_SHOP_ARTIFACT_JSON) |
| S-public-fanout-support | Explicit test-only child claim/lifecycle/guard/admit/record driver and terminal-unit observation using real state joins on supplied store | tests only | packages/state/src/fanout/t34-f5-admission.test.ts:176 driveFanoutChild; packages/work/test/state-fanout/t34-f5-child-join.test.ts:725 driveFanoutChild |
| S-public-invocation-fixtures | Deterministic local membership double, identity/envelope/operation/record/receipt builders, storage seeding and failure capture helpers | tests only | packages/cloudflare/src/runtime/t34-f7-emitted-cohorts.test.ts:66 createMemoryIdentityStore; packages/cloudflare/src/runtime/t34-f7-emitted-cohorts.test.ts:67 seedMember |
| S-public-mutation-fixtures | Interim model/hook/invariant/lock builders and memory CRUD/invoke/pipeline wiring, fresh IDs and parent/row/receipt seed helpers | tests only | packages/state/src/invocation/t32b-wire.test.ts:452 modelDef/field; packages/state/src/mutation/b1-scenario-parity.test.ts:54 modelDef |
| S-public-query-fixtures | Deterministic rows/money/secret/notification fixtures, multi-user/team seeders and policy/grant/query/aggregate input builders | tests only | packages/state/test/ports/fixtures.ts:246 seedStandardTeam; packages/state/test/query/aggregates.test.ts:33 seedStandardTeam |
| S-query-other | Aggregate and explicitly eventual reads plus bound read-port APIs | tests only | packages/state/src/ports/read.ts:101 engineQueryAggregate; packages/state/src/ports/read.ts:104 engineQueryEventualRecords |
| S-query-records | Owner/viewer record selection, scopes, grants, projection, predicates and fence checkpoint validation | source path | packages/state/src/invocation/invoke.ts:484 queryRecords |
| S-read-invoke | Ordinary generated read builds per-call createReadInvoker closure then runs read admission/query at current fence without receipts; nested scenario readModel uses direct invokeRead | source path | packages/cloudflare/src/worker/assembly.ts:940 invokeCanonical; packages/interfaces/src/mcp/server.ts:226 deps.invoker.invokeRead |
| S-receipt-probe | Probe exact intentionally absent observer module and expose URL for absent-only fallback | source path | packages/cloudflare/src/runtime/invoke.ts:3324 loadReceiptObserver; scripts/verify-installed-worker.mjs:120 receipt.loadReceiptObserver |
| S-receipt-read | Fence owner row then delivery schema/grant authorization, stored associations/receipt decode, content availability and selected observation | conditional | packages/cloudflare/src/runtime/invoke.ts:3422 observeSelectedReceiptJoin |
| S-receipt-write | Association/receipt row construction and optional atomic outbox/completion consistency join | tests only | packages/cloudflare/src/runtime/d3b-durable-serve.test.ts:211 newAssociationRow; packages/cloudflare/src/runtime/d3b-durable-serve.test.ts:226 newReceiptRow |
| S-storage-contract | Storage contract/errors/recovery validation and adapter exports | source path | No direct caller established; see evidence/limits |
| S-storage-migration | Adapter staged/progress/failure/retained/publish/installed snapshot storage operations | tests only | No direct caller established; see evidence/limits |
| S-surface | Catalog/distribution and API export barrels | types | packages/cloudflare/src/deploy/bundle.ts:91 stateDistribution |
| S-system | System registry/command definitions and fenced systemRun; ack and schedule cancel/replace | conditional | packages/cloudflare/src/runtime/invoke.ts:3647 systemMod.scheduleCancelCommand |
| S-transact-wrappers | Single-shot transaction error mapping and bound canonical mutation invoker | tests only | No direct caller established; see evidence/limits |

## stdlib

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| stdlib-distribution | Package-owned installed module location inventory | source path | packages/cloudflare/src/deploy/bundle.ts:179 distribution.modules |
| stdlib-export-assembly | Explicit public pure builtin, operator, codec and associated type assembly | conditional | compiler/src/codegen/js.rs:1357 emit @canlang/stdlib import; packages/cloudflare/src/deploy/bundle.ts:179 stdlibDistribution.modules |
| stdlib-packaging | Package manifest export/TS emission boundaries | source path | scripts/build-package.mjs:1 package lifecycle |

## testkit

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| testkit-conformance-observers | Port parity measurement/vectors CLI support for current TS behavior; does not alter product caller reachability | tests only | No direct caller established; see evidence/limits |
| testkit-fixtures | Deterministic row caller/accounts/seed grammar, dependency recipe topological provisioning and facade for emitted closure observations | tests only | packages/testkit/src/runner/table.ts:88 provisionRowAccounts(; packages/testkit/src/runner/loader.ts:367 provisionFixtureValues( |
| testkit-journey-fixtures | B2 delivery seed/row plan and completion guards, durable batch/history/receipt literal builders, role/credential revocation fixtures and structural evidence readers | tests only | tests/integration/b2-delivery.test.ts:48 @canlang/testkit/fixtures/b2-delivery |
| testkit-loader-smoke | Controlled Node/workerd Rust loader boundary smoke support and transport identity ABI | tests only | No direct caller established; see evidence/limits |
| testkit-local-scope | Public reexport of Cloudflare isolated workerd/Miniflare row scope lifecycle | tests only | packages/testkit/test/isolation.test.ts:21 createLocalRowScope( |
| testkit-playback | Strict validated provider seed HTTP playback: stateful mail idempotency/reconcile, paced model streams, judgment/media history/files/cancel; per-seed logs and worker load/log/reset callbacks | tests only | packages/testkit/src/fixtures/playback-worker.ts:43 handler = createPlaybackHandler(tables);; tests/integration/b2-delivery.test.ts:6 playback |
| testkit-public-surface | Executable package export assembly for value functions/constants and erased type exports; supported public module surface | tests only | packages/testkit/package.json:12 exports; tests/e2e/fixtures/pilot-examples.ts:40 @canlang/testkit |
| testkit-report | Versioned example report summaries and located row/sequence failures with artifact digest/source revision | tests only | packages/testkit/test/report.test.ts:7 createReport( |
| testkit-runner | Load emitted exampleFixtures modules, validate recipes/closures/row headers, execute table and causal steps with per-row snapshot/reset/dispose, injected real dispatch and observations, deep report equality | tests only | tests/e2e/fixtures/pilot-examples.ts:341 await loadExampleSuite(; tests/e2e/fixtures/pilot-examples.ts:345 return runTable( |

## ui

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| ui-browser-bootstrap | Explicit browser start/rescan/stop lifecycle; poll/dirty guard/once-action binders, focus/Escape handling, htmx hook and context-scoped cleanup | generated / staged | packages/ui/scripts/build-browser.mjs:53 INSTALLED_CLIENT_MODULES; packages/cloudflare/src/deploy/package-assets.ts:31 BROWSER_FILES |
| ui-browser-styles | Browser CSS layer and theme variables assembled after pinned daisyUI CSS | generated / staged | packages/ui/scripts/build-browser.mjs:136 sourceCss |
| ui-build-assets | Compile-copy finite bootstrap/polling browser asset closure, pinned daisyUI/themes/source CSS and manifest hashing | generated / staged | No direct caller established; see evidence/limits |
| ui-catalog | Versioned UI word/factory signatures and allowed appearance matrix lookup | conditional | packages/ui/src/appearance.ts:34 UI_CATALOG.entries.find(; packages/ui/scripts/build-browser.mjs:113 catalogVersion |
| ui-collections | SSR bounded rows/list/table/board, query toolbar/pagination/search/order links, export/print/share links and multipart CSV upload/escaped review markup | conditional | compiler/src/codegen/js.rs:1085 is_ui_factory |
| ui-component-renderers | Catalog-specific escaped SSR components/text/state, controls/media/leaves/groups/overlays/panels and appearance legality; native HTML behaviors, no hydration invention | conditional | compiler/src/codegen/js.rs:1771 let call = format!("{}; packages/ui/src/forms.ts:666 input( |
| ui-csv-client | Advisory text parse/form, JSON review request/model/preview, frozen-principal selection/consent, per-row operation-id mint and commit result rendering | tests only | packages/interfaces/test/csv-join.test.ts:116 submitCsvReview |
| ui-csv-grammar | Shared strict csv-parse grammar including BOM/CR/blank-record/quote/scalar-string policy and row cap | conditional | packages/interfaces/src/http/csv.ts:156 parseCsvGrammar(; packages/ui/src/csv/parse.ts:119 parseCsvGrammar( |
| ui-distribution | Producer-owned compiled module directory (UI also browser resource directory) exposed for build/staging inventory | generated / staged | packages/ui/package.json:15 ./distribution |
| ui-error-client | Bounded browser exception capture body and ErrorsV1 submission with safe transport/business failures | tests only | packages/ui/test/browser-instrumentation.test.ts:136 submitErrorReport( |
| ui-escaping | HTML/attribute escape, safe URL policy, bidi isolation and spreadsheet formula armoring | conditional | packages/ui/src/forms.ts:270 escapeAttr(; packages/ui/src/collections.ts:1024 csvFormulaProtect( |
| ui-export-client | Export payload/status/expiry controller, request/retry lifecycle, safe inline CSV download sink and export panel markup | tests only | packages/ui/test/browser-export.test.ts:266 createExportController |
| ui-form-client | Collect DOM controls/files; file intent/content/complete/finalize then canonical operation POST; operation-id retry/ambiguous completion and HTML/document rerender sinks | tests only | packages/ui/test/t20b-client.test.ts:266 submitGeneratedForm |
| ui-forms-projection | Derived writable fields/drafts and flat control-to-canonical input projection including typed refs, time-zone wall-time roundtrip and exact scalar validation | conditional | packages/ui/src/client.ts:615 projectGeneratedInputs(; packages/interfaces/src/http/formErrors.ts:355 generatedDraftValues( |
| ui-forms-render | Form/edit/delete/action/actions render controls and hidden authority/id fields, field errors, readonly/bound suppression and time-zone display conversions | conditional | compiler/src/codegen/js.rs:1169 node.factory == "form"; packages/interfaces/src/http/formErrors.ts:299 await form(current) |
| ui-htmx | Safe HTMX attrs, fragment IDs, polling/refresh declarations, stale markers and OOB status/validation swaps | conditional | packages/ui/src/collections.ts:547 hxAttrs |
| ui-message | BCP47 lookup/caption resolution, bounded ICU/plurals and exact integer/decimal/money/scalar formatting | conditional | packages/ui/src/shell.ts:84 resolveCaption( |
| ui-policy-review | Render supplied company review policy/receipts and compiler policy JSON sections through declared content; strict shape, no invented compliance prose | conditional | packages/ui/src/policyPage.ts:201 await review(; compiler/src/policy.rs:16 policyPage.ts |
| ui-print-client | Declared print-view GET and MIME/business error admission, print link/frame markup | tests only | packages/interfaces/test/export-join.test.ts:221 fetchPrintView |
| ui-public-surface | Executable package export assembly for value functions/constants and erased type exports; supported public module surface | conditional | packages/ui/package.json:10 exports; compiler/src/codegen/js.rs:1365 from \"@canlang/ui\" |
| ui-settings | Escaped declarative settings panel controls for locale/theme/time-zone and authored sections | tests only | packages/ui/test/settings.test.ts:50 renderSettingsPanel |
| ui-shell | Locale/direction-aware escaped page shell, authorized children/nav/account/settings chrome; login markup with same-app redirect target guard | conditional | compiler/src/codegen/js.rs:3337 return renderPage(c,; packages/interfaces/src/http/pages.ts:313 await renderPage( |

## values

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| values-array-aggregates | Checked exact int/decimal/duration/money supplied-array sums, typed dispatcher and extrema | source path | packages/values/src/stdlib-pure.ts:95 sumInt; packages/testkit/conformance/ports/observations.mjs:195 sumDecimal |
| values-array-predicates | Encounter-order predicates, first and structural-key grouping | public / no observed call | No direct caller established; see evidence/limits |
| values-array-shape | Frozen empty/omission arrays, concat/flatten/index/count | public / no observed call | No direct caller established; see evidence/limits |
| values-backend-ts | Explicit synchronous six-operation TS smoke backend registry | tests only | packages/values/test/exact-bootstrap.test.ts:42 tsBackend |
| values-backend-wasm | ABI-checked synchronous exact request envelope, tagged transport/reconstruction and mapped ValueError failures | conditional | scripts/verify-installed-worker.mjs:118 wasmBackend(glue).call(add-int) |
| values-bootstrap | Synchronous supplied bytes/module bootstrapping, native export checks, private byte copy and first-asset pin | conditional | packages/values/test/exact-bootstrap.workerd.mjs:1 bootstrapWasm |
| values-catalog | Authored builtin/helper signatures, effect/availability feature metadata and validated emitted catalog | source path | compiler/src/analysis/catalog.rs:350 producer catalog loader; packages/values/scripts/emit-catalog.mjs:29 CATALOG.entries |
| values-currency-generation | Owning TS currency table to deterministic Rust facts and provenance manifest | generated / staged | packages/values/semantics/src/numeric/money.rs:31 currency_table_scale |
| values-decimal-arithmetic | Exact decimal and mixed integer/money arithmetic, half-even rounding and duration ratio | source path | packages/values/bindings/backend.ts:35 addDecimal/negateDecimal; packages/values/src/money.ts:79 roundRationalHalfEven |
| values-decimal-representation | Exact Decimal representation, guards and author-scale parsing/canonical printing | source path | packages/interfaces/src/mcp/schemas.ts:432 parseDecimal |
| values-distribution | Package-owned installed module location inventory and binding root | source path | packages/cloudflare/src/deploy/bundle.ts:181 distribution.modules; packages/cloudflare/src/deploy/package-assets.ts:112 valuesDistribution.bindings |
| values-equality | Typed recursive equality, decimal promotion, money equality and reference identity ignoring versions | source path | packages/values/src/array.ts:418 equalValue |
| values-errors | Value failure classes and structured path-bearing schema violations | source path | packages/interfaces/src/mcp/schemas.ts:435 parseDecimal failure ValueError |
| values-export-assembly | Producer export assembly and shared values contract re-export | source path | packages/stdlib/src/index.ts:25 values re-exports |
| values-generated-binding | Committed generated wasm-bindgen JS/declarations/Wasm and digest manifest staged as opt-in installed assets | generated / staged | packages/cloudflare/src/deploy/package-assets.ts:112 gatherValuesWasmAssets; packages/values/bindings/bootstrap.ts:79 initSync |
| values-icu-descriptors | Frozen typed message descriptors and bounded MessageFormat parser/binding validation | source path | packages/values/src/locale.ts:196 renderMessage |
| values-icu-render | Exact number/money rendering, safe plural operands, select branches and date/time host formatting | source path | packages/values/src/locale.ts:196 renderMessage |
| values-int | Checked signed int64 construction, arithmetic, comparison and overflow | source path | packages/values/bindings/backend.ts:32 addInt/negateInt; packages/interfaces/src/mcp/schemas.ts:411 INT64_MIN |
| values-kind-references | User/member/file/delivery/record/action/invocation/union identity shapes and frozen construction | source path | packages/values/src/stdlib-pure.ts:339 action -> makeActionRef; packages/values/src/stdlib-pure.ts:384 invocation -> makeInvocation |
| values-kind-scalars | Frozen money/date/datetime constructors and runtime structural guards | source path | packages/values/src/temporal.ts:129 makeDate/makeDatetime; packages/values/src/internal/wire-core.ts:411 decodeValueTsCore |
| values-locale | BCP47 canonicalization, RFC4647 whole-message fallback and message-format orchestration | source path | packages/interfaces/src/docs/reference.ts:61 resolveVariant; packages/interfaces/src/docs/reference.ts:150 resolveVariant |
| values-money | Pinned currency admission and checked money constructor/arithmetic/ratio/comparison | source path | packages/values/bindings/backend.ts:40 addMoney; packages/values/src/internal/wire-core.ts:1243 encodeMoneyValue |
| values-native-plan-handles | TS issued native handles with generation retirement/disposal/bounds over read-only TS plans | tests only | packages/values/test/validation-binding.test.ts:1 NativePlanRegistry |
| values-owned-input | Capped injected body reader, JSON parse provenance token and controlled text/value handoff | tests only | packages/values/test/owned-input.test.ts:44 parseOwnedJsonBody/readOwnedJson |
| values-packaging | TS emit/package export and shipped conformance fixture contract | source path | scripts/build-package.mjs:1 package build lifecycle |
| values-prepared-codec | Owner-plan coverage gate then canonical TS wire conversion | tests only | packages/values/test/prepared-validation.test.ts:1 decodePreparedValue/encodePreparedValue |
| values-prepared-plan | Opaque owner/provenance/liveness scoped normalized plans, defaults, registration and release | unadopted | packages/values/bindings/plans.ts:85 getValidationPlan |
| values-prepared-trace | Identity-sensitive trace snapshots, thrown digests and whole-call validation/codec comparator | tests only | packages/values/test/prepared-validation.test.ts:1 compareValidationCall/compareCodecCall |
| values-prepared-validation | Owner-plan admitted complete-call canonical validation | tests only | packages/values/test/prepared-validation.test.ts:1 validatePreparedValue |
| values-rust-abi | Thin wasm-bindgen exact and process-lifetime structural ABI adapters | conditional | packages/values/bindings/generated/values_semantics.js:24 wasm exports |
| values-rust-aggregates | Owned exact numeric/money sums and numeric aggregate carriers | conditional | packages/values/semantics/src/transport/exact.rs:286 dispatch |
| values-rust-arena | Iterative lossless UTF16/f64-bits owned structural input arena, budgets and minted tags | unadopted | packages/values/semantics/src/profiles.rs:495 InputArena::build |
| values-rust-codecs | Exact scalar numeric wire decode/encode only | conditional | packages/values/semantics/src/transport/exact.rs:286 dispatch |
| values-rust-failures | Native failure code/message parity representation | conditional | packages/values/semantics/src/transport/exact.rs:286 dispatch |
| values-rust-numeric | Exact int64, bigint decimal/money arithmetic and shared half-even rounding | conditional | packages/values/semantics/src/transport/exact.rs:286 dispatch |
| values-rust-plans | Native provenance owner-scope plan registration/lookup/default/retire/release registry | unadopted | packages/values/semantics/src/profiles.rs:523 ProfileHost::handle_line -> plans |
| values-rust-profile | Versioned structural envelope gate and server-side owner handles over arena/plan registry | unadopted | packages/values/bindings/src/validation.rs:29 ProfileHost::handle_line |
| values-rust-representations | Owned native exact value carriers, guards and construction | conditional | packages/values/semantics/src/transport/exact.rs:286 dispatch |
| values-rust-temporal | Civil Gregorian date/instant parsing, arithmetic and checked duration semantics | conditional | packages/values/semantics/src/transport/exact.rs:286 dispatch |
| values-rust-transport | Versioned JSON exact operation registry, lossless tagged input/output and fault/error envelopes | conditional | packages/values/bindings/src/exact.rs:23 exact_call -> handle_line; packages/values/semantics/examples/conformance.rs:31 handle_line |
| values-schema-facade | Public normalized-schema/type assembly and canonical create/update/operation validation entry | tests only | packages/testkit/conformance/ports/observations.mjs:219 validateValue |
| values-schema-normalization | Descriptor shape checking, contract/enum/op normalization, frozen explicit defaults and factory schema lineage | tests only | packages/testkit/conformance/ports/observations.mjs:216 normalizeSchema |
| values-schema-operation | Operation closed args, reserved mutation operation_id, nested expected-version requirements and query preservation | tests only | packages/values/src/schema.ts:33 validateOperationInputTsCore |
| values-schema-validation | Recursive declared contract bounds/trim/defaults, engine omission, update omission sentinels and create-complete array/union semantics | tests only | packages/values/src/schema.ts:26 validateValueTsCore; packages/values/src/prepared/validation.ts:456 validateValueTsCore |
| values-semantic-build | Pinned wasm-bindgen/Rust build, release web glue generation, inventory and dist mirror | conditional | packages/values/package.json:18 build:semantics |
| values-semantic-staging | Validate complete pinned generated set then copy to emitted host binding directory | source path | packages/values/package.json:20 build:emit |
| values-stdlib-dispatch | Runtime abs/sum/format overload dispatch and strict choose | conditional | compiler/src/codegen/js.rs:1751 catalog builtin lowering |
| values-structural-host | Structural ABI glue wrapper and stage/code/check error envelope | tests only | packages/values/test/validation-binding.test.ts:30 validationBackend |
| values-temporal-civil | Civil-day conversion, date parsing/calendar arithmetic, bounded date sequences and half-open overlap | source path | packages/values/bindings/backend.ts:38 dateToEpochDays; packages/values/src/timezone.ts:180 dateToEpochDays |
| values-temporal-duration | Instant parsing/range, exact datetime comparison and int64 duration arithmetic | source path | packages/values/src/internal/wire-core.ts:1212 encodeDatetime; packages/values/src/icu.ts:710 DATETIME_MAX_MS/DATETIME_MIN_MS |
| values-text | Unicode scalar text operations and bounded plain named formatting | source path | packages/values/src/stdlib-pure.ts:408 format -> formatPlain |
| values-timezone | Host ICU IANA-zone admission and local date/instant fold-gap resolution | source path | packages/values/src/internal/wire-core.ts:1647 encodeStringlike timezone branch |
| values-types | Parsed frozen type-id AST, guards and canonical spelling | source path | packages/values/src/internal/wire-core.ts:1179 parseTypeId; packages/values/src/internal/schema-core.ts:1849 parseTypeId |
| values-url-action-invocation | Trusted-origin URL construction and action/invocation argument packaging | public / no observed call | No direct caller established; see evidence/limits |
| values-wire-decode | Scalar/string-like exact wire admission, path errors, closed value wrappers and recursive nominal/union/action/invocation/json decode | source path | packages/values/src/wire.ts:7 decodeValueTsCore; packages/values/src/internal/schema-core.ts:533 decodeValueTsCore alias |
| values-wire-encode | Canonical frozen wire serialization, exact scalar text, recursive contracts/ref versions and secret refusal | source path | packages/values/src/wire.ts:12 encodeValueTsCore; packages/values/src/internal/schema-core.ts:420 encodeValueTsCore alias |
| values-wire-facade | Public decode/encode entry preserves canonical TS conversion and error identity | source path | packages/interfaces/src/mcp/schemas.ts:1072 decodeValue(datetime) |

## work

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| W-dispatch | Ordered commit/supersession/state/availability/guard/fresh-authority claim decision plus fanout claim/outcome/progress | conditional | No direct caller established; see evidence/limits |
| W-dispatch-commands | Fenced state-system bodies for dispatch stage/claim/record/requeue/release/supersede/recover and occurrence receipt | conditional | No direct caller established; see evidence/limits |
| W-event | Occurrence dedup/replay and committed-change handler gate | tests only | packages/work/test/event.test.ts:23 admitOccurrence; packages/work/test/event.test.ts:112 admitCommittedChange |
| W-every | Recurring scope/slot arithmetic, coalescing and occurrence IDs with root recurrence refusal | tests only | packages/testkit/conformance/ports/observations.mjs:260 computeEverySlot; packages/testkit/conformance/ports/observations.mjs:263 deriveRecurringOccurrenceId |
| W-intent | Stable outbox identity/frozen requests, staged versus committed gate/origin, dispatch staging plan and fanout lineage | tests only | packages/work/src/dispatch/t32b-fence.test.ts:24 stageOutboxIntent; packages/work/src/dispatch/t32b-fence.test.ts:31 commitOutboxIntent |
| W-observe | Authorized selected receipt observation, locator consistency, leaf projection and fresh-fence decisions; resolve real owner receipt functions | conditional | packages/cloudflare/src/runtime/invoke.ts:3336 loadWorkReceiptFns |
| W-port-types | Clock/random/claim/outbox/schedule/occurrence/supersession and observation grant/content contracts | types | No direct caller established; see evidence/limits |
| W-progress | Identity-matched progress apply, related terminal/retry/cancel transitions and relation allowlist/resume plan | tests only | packages/work/src/observation/t25a-progress.test.ts:65 applyReceiptProgress |
| W-recovery | Inventory, bounded due cursor scans, stale claims, staging failure and dispatch/fanout recovery decision plans | conditional | packages/cloudflare/src/runtime/invoke.ts:5162 opts.planRecoveryScan; packages/cloudflare/src/deploy/activate.ts:245 gates.buildWorkInventory |
| W-retry-lifecycle | Provider delivered/failed/uncertain recording; retry class/backoff/horizon/dead-letter; reconcile and consistency | conditional | packages/cloudflare/src/runtime/invoke.ts:4854 opts.classifyFailure |
| W-rows | Dispatch/occurrence/schedule/every/supersession and fanout row IDs/codecs/query shapes/metadata validation | conditional | No direct caller established; see evidence/limits |
| W-schedule | Synchronous keyed schedule put/replace/cancel and supersession port helper | tests only | packages/work/test/schedule.test.ts:63 putSchedule; packages/work/test/schedule.test.ts:110 replaceSchedule |
| W-schedule-commands | Fenced keyed schedule put/cancel with supersession and durable every slot advance | conditional | No direct caller established; see evidence/limits |
| W-surface | Catalog/distribution and API export assembly | types | No direct caller established; see evidence/limits |
| W-test-doubles | Explicit non-atomic/non-durable unbounded in-memory work and grants/content doubles | tests only | packages/work/src/dispatch/t32b-fence.test.ts:36 TestOnlyManualClock; packages/work/src/dispatch/t32b-fence.test.ts:37 TestOnlyCounterClaimIds |

## work-kernel

| ID | Responsibility | Caller status | Representative caller or boundary |
| --- | --- | --- | --- |
| K-facts | Version/profile/count/presence/provenance/payload references/rejection transport facts and validation | unadopted | No direct caller established; see evidence/limits |
| K-host | Call-scoped payload ownership/ref generations, retention/clone/mutation, cancellation and cleanup | unadopted | packages/work-kernel/conformance/host-values.test.ts:25 CallScope; packages/work-kernel/conformance/host-values.test.ts:81 runInScope |
| K-native | Registered namespaced Rust rows/retry/every/lifecycle/receipt/recovery/linkage decision candidates and JS numeric-text conversion | unadopted | No direct caller established; see evidence/limits |
| K-surface | Version, neutral API exports and distribution descriptor | types | No direct caller established; see evidence/limits |
| K-ts-every | Recurring scope/slot/coalescing with injected ID derivation extracted mechanism; live donors retain callers | unadopted | No direct caller established; see evidence/limits |
| K-ts-lifecycle | Provider uncertainty and lifecycle reconciliation extracted mechanism; live donors retain callers | unadopted | No direct caller established; see evidence/limits |
| K-ts-linkage | Dispatch/fanout/receipt batch assertions extracted mechanism; live donors retain callers | unadopted | No direct caller established; see evidence/limits |
| K-ts-receipt | Receipt observation/consistency/association and receipt row codecs extracted mechanism; live donors retain callers | unadopted | No direct caller established; see evidence/limits |
| K-ts-recovery | Inventory/scans/stale/retry/fanout/related progress planning extracted mechanism; live donors retain callers | unadopted | No direct caller established; see evidence/limits |
| K-ts-retry | Retry defaults/classification/backoff extracted mechanism; live donors retain callers | unadopted | No direct caller established; see evidence/limits |
| K-ts-rows | Ordered identities/rows/set and state/work profile errors/JSON cloning extracted mechanism; live donors retain callers | unadopted | No direct caller established; see evidence/limits |

