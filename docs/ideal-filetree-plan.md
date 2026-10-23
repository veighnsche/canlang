# Can architecture and implementation direction

Can expresses application identity, composition and business behavior in `.can` source. The compiler derives checked operations, interfaces and artifacts from owning declarations. Runtime packages implement storage, identity, work, provider and browser behavior without introducing a second source of language semantics.

The [remaining work](implementation/REMAINING-WORK.md) describes functional gaps and proposed changes. The [language specification](specification/DESIGN.md), [grammar](specification/GRAMMAR.md), [requirements](specification/REQUIREMENTS.md) and [decisions](specification/DECISIONS.md) explain the intended behavior and consequential choices. Plans describe direction; the source and focused behavior checks establish what currently works.

## Responsibilities

- `.can` source owns application composition, declarations, permissions, workflows and authored examples.
- `compiler/` owns parsing, checking, diagnostics, lowering, artifact generation and shared authoring analysis.
- `dev-server/` owns native development sessions, configuration, persistence, discovery, examples and preview lifecycle. The JavaScript host adapts SDK and browser calls.
- `packages/contracts/` owns shared producer and consumer protocols.
- `packages/values/` owns exact values, ordered validation and value catalogs. Its Rust core and bindings have explicit supported domains.
- `packages/state/` owns canonical admission, query authority, mutation, commit, replay and migration.
- `packages/work/` and `packages/work-kernel/` own durable intent, dispatch, recovery and pure work decisions.
- `packages/identity/` owns sessions, grants, membership, roles and account recovery.
- `packages/services/` and `packages/files/` own external providers and file lifecycle.
- `packages/interfaces/` and `packages/ui/` own HTTP/MCP/browser projections of checked operations and presentation.
- Deployment and installer code own artifact closure, installation, activation, upgrades and rollback. Testkit owns reusable execution helpers and conformance fixtures.

Keep authority with its defining owner. Share checked facts and generated catalogs instead of maintaining parallel semantic schemas. Split large modules when cohesive responsibilities warrant it; functional repairs need not wait for a file-tree refactor. Introduce dependencies or native implementations when they simplify a real mechanism while preserving the supported inputs, errors, ordering, identity and recovery behavior.

## Detailed design

The current [audit baseline](ideal-filetree-plan/baseline.md), [exact target tree](ideal-filetree-plan/proposed-tree.md), [ownership boundaries](ideal-filetree-plan/package-ownership.md), [reviews](ideal-filetree-plan/reviews/index.md), [slice matrix](ideal-filetree-plan/slices/index.md) and [dependency-ordered tasks](ideal-filetree-plan/tasks.md) provide the current planning record. The older [responsibility overview](ideal-filetree-plan/finished-product/target-tree.md) and [required workflows](ideal-filetree-plan/finished-product/workflows.md) remain bounded design references. The retained design and research documents explain specific alternatives and unresolved behavior. Their historical task assignments, source counts and execution claims do not impose a development process.

Use a short plan when it helps organize complex work. Check the affected behavior and relevant failures, reuse applicable results, and update documentation when a change makes it misleading.

The current audit catalogues all 3,741 parent paths and 951 initialized draft inputs. Responsibility and workflow review is partial across the whole product; independent challenge covers the selected boundaries; exact path retention and sixteen selected successor leaves are allocated. The audit itself performed no product checks; the subsequently authorized implementation and its real build/integration evidence are now recorded in [task status](ideal-filetree-plan/tasks.md#implementation-status--2026-10-23). Grammar and CI corrections plus fourteen supported extractions are implemented; the dev policy migration and unselected semantic families retain their actual gates.
