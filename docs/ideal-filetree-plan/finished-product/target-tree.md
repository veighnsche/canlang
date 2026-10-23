# Intended project structure

Historical conceptual overview. The current complete path allocation is [proposed-tree.md](../proposed-tree.md); this overview does not establish current directories, implementation completion or evidence.

This is a responsibility guide, not a required inventory of future filenames. Keep implementation cohesive and change private module boundaries when the code benefits.

```text
compiler/
  src/analysis/       semantic checking and checked facts
  src/codegen/        lowering, JavaScript, artifacts and generated examples
  src/syntax/         tokens, syntax tree, parser and source locations
  src/ide/            shared authoring queries
  src/lsp/            language-server transport and lifecycle
  tests/              behavior and consumer regressions

dev-server/           native development sessions and preview lifecycle
editors/vscode/       editor integration

packages/
  contracts/          shared protocols and descriptors
  values/             exact values, validation and catalogs
  state/              admission, queries, commit, replay and migration
  work/               intent, dispatch, recovery and observation
  work-kernel/        pure work decisions
  identity/           sessions, grants, teams and account recovery
  services/           provider and external-effect lifecycle
  files/              upload, finalization and content lifecycle
  interfaces/         HTTP, MCP and browser-facing operation adapters
  ui/                 presentation components and browser behavior
  cloudflare/         platform adapters, assembly and deployment
  stdlib/             authored-language library facade
  testkit/            execution helpers and conformance fixtures

apps/                 authored application examples and requirements
scripts/              build, installation and development commands
tests/                integration and browser workflows
docs/specification/   language contracts and design decisions
docs/design/          feature designs and alternatives
docs/research/        useful research conclusions and repros
```

See [ownership](ownership.md) for semantic boundaries, [workflows](workflows.md) for required outcomes, and [remaining work](../../implementation/REMAINING-WORK.md) for functional gaps. Paths above express intended responsibilities; consult the current checkout before changing a particular module.
