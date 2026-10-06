# Canlang

Canlang is an AI-native language for custom business SaaS applications. Compact `.can` source describes records, permissions, business rules, workflows, presentation, and behavior examples through **Given / When / Then**.

The goal is to help companies replace expensive SaaS subscriptions with applications tailored to their operations and economical to generate, run, and change. Canlang is designed for AI to write: canonical business primitives, shared defaults, and reusable components keep source concise.

Its scope is CRUD-centered business software: tasks, approvals, bookings, invoicing, reporting, files, scheduling, and external synchronization. Bounded provider-backed workflows, such as reviewed model output and authorized company-document answers, belong within the same records, permissions, and business rules.

**Status:** active development. The repository includes a Rust compiler with JavaScript and BDD artifact emission, language-server/editor tooling, and TypeScript runtime packages. Complete application workflows and installed releases still require integration and qualification. The [living ideal file-tree plan](docs/ideal-filetree-plan.md) describes the intended finished product; the architecture below follows that target.

## A small app

```can
# Track the team's work.
app Tasks
Given
 export Todo { title:text trim, done:bool=false }
 policy Todo read=members
When
 crud Todo by=members fields=title,done
Then
 page / title="Tasks"
  form Todo.create display=inline
  list Todo
   edit
   delete
```

`Given` declares the data and its read policy. `When` enables the canonical create, update, and delete operations for team members. `Then` binds a page to those same records and operations. The design supplies standard authentication, teams, storage, and interface behavior through language defaults.

For fuller examples, read [TeamTasks.can](examples/TeamTasks.can), which adds assignment, filters, translations, inline examples, and app composition, or [ExpenseFlow.can](examples/ExpenseFlow.can), which demonstrates reviewer permissions, guarded approval workflows, and reporting.

## What Canlang brings together

- **Typed data and explicit authority.** Models describe stored records; contracts describe structured values. Policies grant reads, operation `by` clauses govern invocation, and invariants and locks protect business state across mutation paths. Team ownership is the default; it does not grant access.
- **Canonical operations and durable work.** `crud` supplies standard record operations. Typed `scenario` declarations express company-specific behavior through guards and an ordered `do` body. The design includes version checks, atomic business mutations, events, scheduled work, typed external delivery, receipts, and recovery from uncertain outcomes.
- **Examples beside behavior.** Shared `fixture` declarations and attached `examples` tables or sequences express business success and rejection cases. The intended runner invokes the same canonical operations and permission checks in isolated state, using independently authored expectations.
- **Source-owned composition.** Small apps own an implicit package named after the app. Larger products select packages or compose apps with `uses=[...]`; consumers explicitly import exported declarations with `use`. One app is selected per deployment. Dependencies and interfaces derive from owning declarations, and moving a package between files does not change its identity.
- **Shared interfaces and localization.** Browser pages, forms, and MCP tools reuse operation types, descriptions, and permissions. The presentation target covers the full [68-component daisyUI vocabulary](design/UI-COMPONENTS.md), with HTMX and a shared shell. Translations live beside authored text; named messages serve actual reuse. `#` attaches description metadata, while `##` is an ordinary comment.

These are the language's intended capabilities; completion is tracked per workflow. Arbitrary app-level HTML, CSS, JavaScript, specialized visual editors, and unrestricted autonomous agents are outside v1.

## Intended architecture

The selected target compiles `.can` applications to JavaScript for **workerd**, with **Cloudflare D1** storage, **Durable Object** authority where required, **R2** when files are used, and shared browser and MCP interfaces. Business policy stays in `.can`; each compiler or runtime responsibility has one defining owner.

| Owner | Responsibility in the finished codebase |
| --- | --- |
| `.can` source in `examples/` and `draft/` | Application identity, composition, records, permissions, business operations, pages, descriptions, translations, and inline examples. |
| `compiler/` | Rust parsing, resolution, type/effect analysis, diagnostics, artifact emission, and shared CLI/LSP authoring services. |
| `packages/values/` | Exact values and ordered input validation, with a shared package-local Rust semantics core, distinct validation profiles, and TypeScript façades/Wasm bindings. |
| `packages/state/` and `packages/identity/` | TypeScript storage authority, canonical admission and commits, queries, replay, sessions, teams, and current grants. |
| `packages/work-kernel/`, `packages/work/`, `packages/files/`, and `packages/services/` | A work-owned Rust leaf for shared pure decisions; TypeScript durable scheduling, delivery, progress, provider integration, and file lifecycle coordination. |
| `packages/ui/` and `packages/interfaces/` | TypeScript browser presentation, forms, HTTP/MCP adapters, and shared operation schemas and errors. |
| `packages/cloudflare/` | Platform assembly, local execution, build, release, deployment, and upgrades; a separate Rust native process prepares artifacts while host orchestration and publication remain TypeScript. |
| `packages/testkit/` and `tests/` | Isolated fixtures, canonical operation examples, cross-package checks, browser journeys, and original-application qualification. |

The Rust package ports are selected targets with adoption gates. Observable JavaScript object traversal, callbacks, storage authority, and host integrations retain their TypeScript owners. Rust/Wasm parity, complete-call performance, installed assets, and supported hosts must be verified before adoption. Native artifact preparation is opt-in on qualified hosts.

The [living plan](docs/ideal-filetree-plan.md) brings together original application intent, challenge and reference work, remaining implementation, and the four subsystem-port plans. Its [selected file tree](docs/ideal-filetree-plan/finished-product/target-tree.md), [ownership boundaries](docs/ideal-filetree-plan/finished-product/ownership.md), and [dependency-ordered work](docs/ideal-filetree-plan/finished-product/tasks.md) are the detailed codebase direction.

Required completion work includes durable identity/file/provider joins, complete finite fanout and recovery, owner expiry and sensitive-data disposal, authorized document grounding, browser assets and polling, preferences, CSV intake/export, staged upgrades, and installed release checks. Compiler output or an isolated runtime test establishes only its own scope; supported applications require their complete declared workflows and failure outcomes to be verified.

## Getting the source

Application drafts live in the independent [canlang-drafts](https://github.com/veighnsche/canlang-drafts) repository, included at `draft/` as a Git submodule pinned to a specific commit:

```sh
git clone --recurse-submodules https://github.com/veighnsche/canlang.git
cd canlang
```

For an existing checkout, run `git submodule update --init --recursive` after pulling changes. Draft edits are committed and pushed inside `draft/`; then commit the updated `draft` pointer in Canlang. Before editing a detached submodule checkout, create a drafts branch from the pinned commit with `git -C draft switch -c <draft-branch>`.

## Build and explore

The workspace uses **Bun 1.4.2**, **Node.js 22+**, and **Rust 1.99+**. From the repository root:

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
cargo build --manifest-path compiler/Cargo.toml --locked
./compiler/target/debug/can --help
```

Use `bun run test` for workspace tests and `cargo test --manifest-path compiler/Cargo.toml --locked` for compiler tests. See [developer setup](docs/dev-setup.md), [compiler commands](compiler/README.md), and [installation](docs/install.md) for details. `can check`, `compile`, `lint`, `fmt`, `policy`, and `lsp` provide compiler and authoring services; platform commands delegate to `can-platform`.

The [VS Code-compatible extension](editors/vscode/README.md) provides highlighting and compiler-backed diagnostics, navigation, and completion. The separate Python parser remains a syntax prototype with known corpus drift; it does not establish type, permission, compilation, or runtime correctness. See [language tools](tools/README.md) for its scope.

## Documentation

- [Requirements](docs/specification/REQUIREMENTS.md): purpose, scope, and product goals.
- [Language design](docs/specification/DESIGN.md): semantics, defaults, permissions, operations, integrations, and interfaces.
- [Grammar](docs/specification/GRAMMAR.md): exact syntax and layout rules, including one-space indentation.
- [Decisions](docs/specification/DECISIONS.md): accepted choices, rationale, uncertainty, and superseded proposals.
- [Completed evaluation plan](design/evaluation/PLAN.md): the design study, its reports, frozen baseline, and verification limits.
- [Living ideal file-tree plan](docs/ideal-filetree-plan.md): unified finished-product architecture, responsibility owners, required workflows, and future work. After every merge, its handler reconciles accumulated changes and advances the checkpoint only after complete review; plan maintenance does not authorize implementation.
- [Approved UI vocabulary](design/UI-COMPONENTS.md): all 68 pinned daisyUI components, typed bindings, and the shared shell.
- [Subsystem-port plans](docs/research/package-subsystem-ports-20261006/implementation-plans/README.md): exact values, owned input validation, work transitions, and artifact preparation.
- [Application drafts](https://github.com/veighnsche/canlang-drafts/blob/main/README.md): larger business sources and their companion requirements; [coverage and remaining gaps](https://github.com/veighnsche/canlang-drafts/blob/main/MIGRATION.md) records unfinished behavior.

The handwritten JavaScript targets in `draft/` illustrate desired output. They are design witnesses, not compiler-generated artifacts or evidence that their proposed imports and complete applications run.
