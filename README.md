# Canlang

Canlang is an AI-native language for custom business SaaS applications. It describes records, permissions, business rules, workflows, and presentation in compact `.can` source organized around **Given / When / Then**.

The goal is to help companies replace expensive SaaS subscriptions with applications tailored to their operations and economical to generate, run, and change. Canlang is designed for AI to write: canonical business primitives and shared defaults reduce boilerplate and competing implementation patterns. Its scope is CRUD-centered applications such as task management, expense approval, bookings, and invoicing.

**Current status:** this repository contains the language specification, reference examples, an application-drafts submodule, a Python syntax parser, editor highlighting, and a Rust CLI scaffold. Application compilation and execution are not implemented yet.

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

## Main concepts

- **Typed data and explicit authority.** Models describe stored records; contracts describe structured values. Policies grant reads, operation `by` clauses govern invocation, and invariants and locks protect business state across mutation paths. Team ownership is the default; it does not grant access.
- **Canonical operations.** `crud` supplies standard record operations. Typed `scenario` declarations express company-specific behavior through guards and an ordered `do` body. The design specifies atomic mutations, version checks, events, scheduled work, and typed external delivery.
- **Examples beside behavior.** Shared `fixture` declarations and operation-local `examples` tables describe success and rejection cases without separate step definitions. Executing these examples through the operation runtime is planned.
- **Apps and packages.** Small apps own an implicit package named after the app. Larger products select packages or compose apps with `uses=[...]`; consumers explicitly import exported declarations with `use`. One app is selected per deployment, and moving a package between files does not change its identity.
- **Shared interfaces and localization.** Pages bind to canonical models and operations. The planned browser and MCP interfaces reuse their types, descriptions, and permissions. Translations live beside authored text; named messages serve actual reuse. `#` attaches description metadata, while `##` is an ordinary comment.

The planned stack compiles Canlang directly to JavaScript for **workerd**, with **Cloudflare D1** storage, inferred **R2** file storage, **daisyUI/HTMX** presentation, and a generated **MCP** interface. These are specified defaults and targets; the runtime and generators remain implementation work. Arbitrary app-level HTML, CSS, JavaScript, and specialized visual editors are outside v1.

## Getting the source

Application drafts live in the independent [canlang-drafts](https://github.com/veighnsche/canlang-drafts) repository, included at `draft/` as a Git submodule pinned to a specific commit. Clone both repositories for corpus checks and draft work:

```sh
git clone --recurse-submodules https://github.com/veighnsche/canlang.git
```

For an existing checkout, run `git submodule update --init --recursive` after pulling changes. Draft edits are committed and pushed inside `draft/`; then commit the updated `draft` pointer in Canlang. Before editing a detached submodule checkout, create a drafts branch from the pinned commit with `git -C draft switch -c <draft-branch>`. Historical draft commits remain available in both repositories; the extracted history uses new commit IDs.

## Explore what exists

From the repository root, use Python 3 to parse the reference examples or inspect a syntax tree. The parser uses only the standard library:

```sh
python3 tools/can_parser.py examples
python3 tools/can_parser.py examples/TeamTasks.can --json
```

Parsing checks syntax only. It does not resolve imports, check types or permissions, validate message patterns, generate applications, or run inline examples. Some current application drafts use grammar extensions the parser does not yet accept. See [language tools](tools/README.md) for details.

With a Rust toolchain supporting edition 2024, inspect the CLI scaffold:

```sh
cargo run --manifest-path compiler/Cargo.toml -- --help
```

Its help and version output work; `compile`, `lint`, and `fmt` are reserved commands that currently fail. See [compiler status](compiler/README.md). [VS Code-compatible highlighting](editors/vscode/README.md) is also available, without language-server diagnostics.

## Documentation

- [Approved full UI vocabulary](design/UI-COMPONENTS.md): all 68 pinned daisyUI components, typed bindings and the shared right-sidebar shell. The former small subset was a design mistake; implementation and app migration must cover the full catalog.
- [Frontend migration launch prompt](implementation/prompts/08-frontend-catalog-migration.md): copy into a human-launched Muse Code 1.3 Contributor session to migrate sources in a separate worktree, reviewing and merging each PR before continuing.
- [Requirements](REQUIREMENTS.md): purpose, scope, and product goals.
- [Language design](DESIGN.md): semantics, defaults, permissions, operations, integrations, and interfaces.
- [Grammar](GRAMMAR.md): exact syntax and layout rules, including one-space indentation.
- [Application drafts](https://github.com/veighnsche/canlang-drafts/blob/main/README.md): larger business sources and their companion requirements; [coverage and remaining gaps](https://github.com/veighnsche/canlang-drafts/blob/main/MIGRATION.md) records unfinished behavior.

The handwritten JavaScript targets in `draft/` illustrate desired output. Their proposed library imports are unimplemented; they are not generated or runnable applications.
