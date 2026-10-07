# Implemented guard export closure

The exact lease is implemented and frozen for review: state owns the unchanged synchronous `require` and `hasRole` bodies under `@canlang/state/effects/guards`; Cloudflare's existing `runtime/stdlib` route and the stdlib root expose identical producer bindings. The state root and async policy `hasRole` are unchanged. No compiler, shared documentation, Git, deploy/bundle, invoke, or other package source edits were made by this worker.

Changed files:

- `packages/state/src/effects/guards.ts`: structural readonly `HandlerRoleContext`, original guard bodies, exact subject unsupported error.
- `packages/state/test/effects/guards.test.ts`: truthiness/error behavior, snapshot role separation, every defined subject refusing before context access, exact getter evaluation order.
- `packages/state/package.json`: one supported JS/types export subpath; no dependency changes.
- `packages/cloudflare/src/runtime/stdlib.ts`: only replace original guard definitions with verbatim compatibility re-exports.
- `packages/stdlib/src/index.ts`: two verbatim guard re-exports.
- `packages/stdlib/test/assembly.test.ts`: exact inventory and producer binding identity.

The narrow filed request is `producer-request.md`. `changes.patch` contains only this six-file lease; `pins.json` captures its source, built output, catalog and relevant foreign execution-owner dependencies. Reconstructed original Cloudflare stdlib and stdlib index match the pre-edit research SHA256 exactly. State manifest and assembly-test diff baselines reconstruct only this worker's exact recorded edits, without falsely claiming a captured pre-edit hash.

## Verified

- Genuine package task DAG: final `build --filter=@canlang/cloudflare` passed **22/22 tasks** (`build-final.log`). `typecheck:check --filter=@canlang/cloudflare` passed **23/23 tasks** (`cloudflare-typecheck.log`); separate leaf typecheck passed ten tasks. Existing stdlib→state and Cloudflare→stdlib/state dependency direction stays acyclic.
- Focused guard producer and facade assembly tests: **8/8 pass** (`leaf-tests.log`).
- Installed supported public routes state/stdlib/Cloudflare expose the exact same two function objects (`compatibility.log`). Public declaration compilation proves existing Cloudflare `HandlerContext` can call the producer and compatibility/facade function types agree (`type-contract.ts`, zero-error `type-contract.log`).
- Root's copied frozen compiler SHA256 is `b8ec81900121effeab3b2145c0f4436089eeea7a273642317335309861c0cd3d`. The executable now lives only at `/private/tmp/can-runtime-guard-review/can-pinned`, not in repository evidence. Its supplied source/build manifest is copied as `compiler-producer-pins.json`. Both `guard.can` and `mutation-guard.can` check clean and compile. JSON artifacts and byte-exact emitted modules are retained.
- Actual unmodified generated read handler imports the installed stdlib successfully and executes direct allow/deny controls (`consumer-receipts.json`). The previous UI-order emitted module also now imports successfully. Direct fixture contexts are explicitly not canonical authorization proof, and authorized query rendering remains separate.
- Actual production `assembleModules` and `buildInvoker`, supplied the unchanged generated mutation artifact and installed public stdlib, execute **member allow → committed → replayed**, **member false guard → rule_failed / forbidden message → identical rejection replay**, and **anonymous admission → forbidden → identical denial replay** (`canonical-receipts.json`, `canonical-final.log`). The canonical probe obtains identities through the identity package resolver and reads memberships through its package test memory store; storage is the state package test memory implementation. This is canonical seam and generated-consumer evidence, without a durable substrate or production deployment claim.
- Existing focused canonical guard-trip rejection/replay regression passes. State distribution includes its built src directory, and the existing platform bundle maps any supported `@canlang/state/...` producer import to `vendor/state/<subpath>.js`; guards follow the existing transition route. No platform rewrite was needed or edited here. An end-to-end deployed bundle is not claimed by this leaf.

## Preserved failures and remaining boundaries

`build.log` retains the initial new test's exact-optional-property annotation error; the test getter was corrected to return `never`, and later builds passed. `build-retry.log` retains transient foreign invoke.ts errors for undefined `isRecord`; the owning worker changed those to the existing `isUnknownRecord`, and this worker then rebuilt successfully without modifying that file. The first canonical script asserted an incorrect nested receipt shape; `canonical-mutation.log` preserves that harness failure, and the corrected flat MutationResult assertions plus replay assertions pass in `canonical-final.log`.

The actual generated read scenario is still refused by the canonical core: `validation`, readable operations must be named `<Model>.read`. That occurs before member/anonymous authorization and is saved separately in the same canonical receipt. No read-scenario completion claim or foreign invocation change is made.

Two selected existing T16 hand-written fixture regressions fail with appDefinition/canApp model policy disagreement (`acme.Todo`), yielding `rule_failed`; the guard-trip case passes (**1 pass / 2 fail**, `canonical-regressions.log`). Those fixture failures are reported to root and are not rewritten or counted as successful canonical preservation. The new compiler-emitted mutation guard consumer passes independently. Subject-scoped synchronous tests remain unsupported exactly as before. Broader builtin-role, declared-role revalidation, durable state, full-suite and deployed-bundle coverage are not claimed here.

The earlier UI `message(string)` failure has no factory fix in this lease: current message factory matches MessageFactory and initializes emitted titles successfully; actual card rendering fails because its emitted props omit required CardProps.title. That separate UI owner gap stays open.
