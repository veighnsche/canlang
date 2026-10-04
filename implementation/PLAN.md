# CanLang implementation: seven parallel owners

Status: implementation plan, October 4, 2026. The user will launch the Muse coordinators. This plan implements no compiler, library or infrastructure code and starts no Muse sessions. Repository: https://github.com/veighnsche/canlang (private), main. Read [the common execution protocol](WORKFLOW.md), [shared boundaries](CONTRACTS.md), [diagnostic policy](DIAGNOSTICS.md), then the lane prompt.

## Outcome and evidence

The user approved the [entire pinned daisyUI vocabulary](../design/UI-COMPONENTS.md): 68 components, not the former small subset. That restriction was a design mistake and must not propagate through any lane's implementation, completion criteria or agent-facing discovery. L5 owns the full typed presentation catalog and rendering; L1 consumes it for source analysis/emission, diagnostics, completion and highlighting; L6/L7 integrate its real interfaces. All apps share the static right-sidebar page menu, bottom-right user menu, common user configuration dialog and canonical login screen. The separately launched [frontend migration coordinator](prompts/08-frontend-catalog-migration.md) replans each app's entire frontend using the full vocabulary and authors complete `.can`/desired-output drafts first; L5 and L1 derive the UI library/compiler contracts from those reviewed drafts rather than gating them on current implementation support; the seven implementation lanes do not acquire draft ownership from this approval.

An end-user coding agent can author a compact `.can`, discover valid constructs, get precise errors and actionable warnings, run its examples, and build a functioning departmental SaaS with the standard shell, permissions, workflows and MCP operations. Can emits JavaScript directly. Rust owns the language/tooling; TypeScript implements the library and platform support and is built to JS for distribution. The company authors its policy; defaults and canonical facilities supply repeated mechanics.

Current evidence is a Rust CLI scaffold, a Python syntax prototype, a TextMate extension, 39 app sources and 21 handwritten desired JS targets. Neither syntax checks nor those targets demonstrate a working runtime. REQUIREMENTS.md, DESIGN.md, GRAMMAR.md and accepted DECISIONS.md entries define meaning. App requirements and examples define business outcomes. Draft JS is a witness to check, not an implementation to trust blindly. Proposal documents do not adopt new language semantics.

The user broadened the original five-lane limit because the library is probably the largest work area. Seven gives four substantial library lanes, a dedicated identity/interface lane, one unified Rust toolchain lane and a delivery/qualification lane. These are reasoned scope allocations, not measured equal hours. [Consultation evidence](evidence/jev/lanes-20261004/review.md) preserves conflicting JEV advice. Do not optimize for identical file counts or manufacture work to keep a lane busy.

## Ownership and first useful output

| Lane | Owner and scope | First useful output | Independent work while interfaces land |
| --- | --- | --- | --- |
| [1](prompts/01-language.md) | Rust language, codegen, lint/format/LSP, Cursor/VSCode extension and binary command dispatch | Recoverable source analysis plus identical CLI/LSP diagnostics; one app emits canonical JS | Source corpus, parser/type tests, formatter losslessness, IDE transport and lookup |
| [2](prompts/02-values.md) | Exact values, schemas, codecs and pure standard builtins | Checked scalar/structural semantics with canonical signatures and conformance vectors | Money/decimal/date/time/text/array behavior and invalid-input boundaries |
| [3](prompts/03-state.md) | Record queries, current authorization, invocation, CRUD, invariants/locks/hooks, versions, owner transactions, local migrations | Real D1-fenced canonical operation and denied/stale/replayed cases | SQL/storage spike, policy projection, mutation candidate semantics |
| [4](prompts/04-work-services-files.md) | Durable events/schedules/deliveries, provider adapters, file lifecycle and observable runs | Committed send intent becomes one safely observed delivery; authorized finalized attachment | Adapter protocol tests, state-machine/retry fixtures, R2/file lifecycle |
| [5](prompts/05-ui.md) | Server-rendered component stdlib, shell, HTMX, settings and presentation i18n | Real descriptor-driven page and canonical bound form with accessible errors | Component rendering, escaping, keyboard/mobile behavior, localized formatting |
| [6](prompts/06-identity-interfaces.md) | Account/session/team identity, HTTP/MCP routing, canonical request/result and upload transport | Authenticated browser and MCP invoke the same operation with equal authority | SDK compatibility, session revocation, wire encodings, protocol tests |
| [7](prompts/07-platform.md) | Cloudflare assembly/build/dev/deploy, migration orchestration, executable BDD runner, CI/release and integration | Reproducible local workerd app and real compiled-example execution | Build/provision plan, test orchestration, CLI package bridge, release layout |

Lane 1 should use internal parallel owners for syntax/analysis, codegen, and authoring tools from the start. LSP and diagnostic usefulness are first-milestone work, not a final polish phase. Lane 3 has the strongest correctness dependencies; moving hosting, authentication and migration coordination out keeps its scope bounded. Lane 4 may eventually justify a separate file-lifecycle lane, but any eighth coordinator is human-launched and requires an explicit ownership transfer, not an agent silently spawning another lead.

## Desired file tree

Paths identify responsibility; create modules only when the first real use needs them. These are source boundaries, not a mandate to create an abstraction per directory. Keep the existing compiler location and editor work; no replacement scaffold beside them.

```text
compiler/                                  # L1: one native `can` executable
  Cargo.toml, Cargo.lock
  src/
    main.rs, lib.rs, cli/
    source/, syntax/, analysis/, codegen/
    diagnostics/, lint/, format/, ide/, lsp/
  tests/{syntax,analysis,codegen,authoring}/
editors/vscode/                            # L1: same client for Cursor/VSCode
  src/, syntaxes/, package.json
packages/
  contracts/                              # type-only boundaries; ownership below
    package.json, src/index.ts             # L7 manifest/export assembly
    src/{artifact,diagnostic}.ts           # L1
    src/values.ts                         # L2
    src/state.ts                          # L3
    src/{work,services,files}.ts           # L4
    src/presentation.ts                   # L5
    src/{identity,wire}.ts                 # L6
    src/{deployment,examples}.ts           # L7
  values/                                 # L2: exact values + pure library
    src/{scalar,temporal,text,array,schema,codec}/
    src/catalog.ts, test/
  state/                                  # L3: every authoritative commit path
    src/{invocation,query,policy,mutation,history,migration}/
    src/storage/{d1,durable-object}/
    src/catalog.ts, test/
  stdlib/                                 # L3: thin @canlang/stdlib export assembly
    src/index.ts, package.json
  work/                                   # L4
    src/{intent,event,schedule,dispatch,receipt,recovery}/
    src/catalog.ts, test/
  services/                               # L4
    src/{http,mail,models,judgments,media}/
    src/catalog.ts, test/
  files/                                  # L4
    src/{upload,finalize,provenance,retention}/
    src/catalog.ts, test/
  ui/                                     # L5: public @canlang/ui
    src/{shell,components,forms,settings,htmx,i18n}/
    src/catalog.ts, test/
  identity/                               # L6
    src/{accounts,sessions,teams,authentication}/
    test/
  interfaces/                             # L6
    src/{http,mcp,uploads,errors}/
    test/
  cloudflare/                             # L7; isolate Node build code from Worker code
    src/{build,dev,deploy,upgrade}/
    src/worker/
    test/
  testkit/                                # L7: actual compiled inline BDD
    src/{fixtures,runner,assertions,reporting}/
    test/
tests/integration/                        # L7 integrates; contributors own named cases
.github/workflows/
  lane-01.yml ... lane-06.yml              # respective lane
  integration.yml, release.yml            # L7
package.json, bun.lock                      # L7: bun workspace + lock owner
tsconfig.base.json                         # L7
implementation/
  PLAN.md, WORKFLOW.md, CONTRACTS.md, DIAGNOSTICS.md
  prompts/                                # human launch handoffs
  status/lane-01.md ... lane-07.md          # one coordinator writes each
examples/                                 # existing examples remain canonical inputs
draft/                                    # existing draft coordinator owns edits
```

The internal packages do not add app-facing APIs. Generated programs retain `@canlang/stdlib` and `@canlang/ui`; the façade only assembles canonical exports. Do not add synonymous CRUD/send/auth functions for each internal package. No dependency may import back through the public façade. `contracts` carries types and wire shapes, never an execution engine or alternate catalog. If separate package overhead is not justified, a lane may use modules within its named package; transferring an owned boundary requires the workflow handshake.

Each lane owns its package manifests. L7 alone integrates changes to the root Node manifest/lock/config; L1 owns compiler Cargo metadata and lock. Do not force every root file through L7 or let seven agents rewrite shared locks independently. Standard tooling generates locks; they are not hand-merged. Root `.gitignore`, common CI and release assembly belong to L7; existing application source/draft trackers remain outside these lanes.

## Bootstrap and integration milestones

**B0 — bounded contracts, all lanes start immediately.** Each lane inventories its current inputs, writes a lower-level finite plan and public-interface proposal, and ships its first small contract/source milestone. L1 owns source/artifact/diagnostic versions; L2 owns scalar wire/signature facts; L3 owns invocation/commit ports; L4 owns intent/file/provider contracts; L5/L6 own presentation/transport; L7 owns workspace assembly and local runner. Merge producer contracts promptly. A consumer can use test-only contract fixtures while the implementation lands; no duplicate production implementation or green “supported” flag follows from a stub. No big-bang wait for every API or package.

**B1 — one real connected app.** Compile a supported TeamTasks-style source; run it with real local workerd/D1, two authenticated users, browser and MCP actions. Exercise a denied read, stale update and mutation replay. Run its inline examples through the actual compiled handlers. CLI and LSP report the same deliberate source error. UI uses real compiler descriptors. L7 coordinates this join; every missing producer keeps its own implementation task.

**B2 — authority, evidence and durable work.** Expand through ExpenseFlow and an accepted attachment/approval/notice journey. Exercise real finalized files, role revocation, immutable evidence, failed/unknown/skipped delivery, retry and changed versions. Test D1 rollback/fence conflict and DO-local behavior separately. Wire the actual runtime; provider test servers may simulate documented external responses without pretending the remote service itself was exercised.

**B3 — change and authoring.** Execute an explicit schema evolution with retained work and recovery, source-mapped runtime diagnostics, canonical formatting, navigation/completion/rename and safe fixes. Demonstrate compact agent JSON feedback, stale-edit rejection, actual form errors and source-derived company-policy inspection. Activation checks installed artifacts, binding capabilities and outstanding work.

**B4 — language and library coverage.** Map every accepted normative construct, public builtin/operation/component and declared integration contract to its owner and real evidence. Bring the 39-source corpus and 21 target witnesses through applicable analysis/generation/correspondence; handle actual draft defects through the draft owner. Implement accepted behavior instead of weakening tests or turning missing runtime functions into successful no-ops. Unadopted proposal syntax remains a specific unsupported diagnostic. Add harder AI/service journeys only from accepted contracts and requirements; library wrappers do not authorize hidden business policy.

**B5 — usable release.** One `can` executable exposes compiler, check, lint, format and LSP commands; one extension serves Cursor/VSCode; released JS libraries and platform tooling are compatible and reproducible. Local setup, test/run and a reviewable deployment path work without app-authored build/connection manifests. Credentials and environment binding choices remain deployment inputs. Paid/prod resource operations require the user's applicable authorization; PR self-review and merge are already authorized. State exact local, emulator and live-provider evidence separately.

Do not mark the platform complete at B1. Conversely, unfinished optional experiments do not invalidate completed supported workflows. After B1, compare actual remaining substantive milestones and waiting time; move a coherent unstarted scope only with a recorded owner transfer. Spending more tokens is useful when it closes those milestones, not when it repeats unchanged reviews or expands scope arbitrarily.

## Reuse and research evidence

- [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html) share a lockfile/build directory within a workspace; begin with the existing crate and extract only real boundaries. Seven worktrees do not imply seven language implementations.
- [VS Code language-server guide](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide) and [LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) support a separate server/client boundary; use the same Rust analysis for CLI and editor.
- [Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/bundling/) supplies existing build integration; Can does not rebuild workerd or UTF-8. Generate binding requirements from source, then map environment resources.
- [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/) support transactional batches; Can's optimistic algorithm still needs real rollback/conflict evidence and does not become an arbitrary JS transaction callback.
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) and [Workers testing](https://developers.cloudflare.com/workers/testing/) are reuse candidates. Confirm their exact semantics and compatibility before relying on them.
- [Official MCP SDKs](https://modelcontextprotocol.io/docs/sdk) supply protocol tooling; verify the selected transport under workerd instead of assuming all Node code can run there.
