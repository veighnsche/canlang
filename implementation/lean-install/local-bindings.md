# Local binding implementation — current execution view

User-authorized outcome: derive R2 and the other declared bindings from Can source,
complete the missing compiler/runtime implementations, and include the local engine
in the one-command production install. Browser development tools remain opt-in.
This qualifies the finite profiles below; it does not invent external service
implementations or credentials.

## Finite acceptance

| ID | Defining outcome | Current status |
| --- | --- | --- |
| LB1 | Compiler emits same-IR resource inventory, selected owner closure, typed queue/analytics sends, queue handlers and actual root authority. | Accepted: production compiler controls and isolated release. |
| LB2 | Actual local D1/R2/KV/DO/queue/service bindings and observable persisted analytics require no extra package installation. | Accepted: real emulator controls and source-owned planner/preflight controls. |
| LB3 | State/Work atomic publication, original typed provenance, delayed dispatch, durable queue intake, real handlers, rollback/replay/recovery. | Accepted for the guarded/unconditional scalar, nominal, model-reference and File cases below. |
| LB4 | Real root execution, current identity and File grants, protected local routes, no D1 business fallback, exact unavailable-profile refusals. | Accepted for the rooted, File and model-free team cases below. |
| LB5 | Integrated production packages, installed representative workflows outside checkout using private Node, actual final archive measurement. | Accepted: integrated build, 18 archive checks, installed root workflows and measured final archive. |

No parallel writer mutates a consumed producer closure during a capture. Root
qualification uses the same source with retained coherent outputs plus the exact
corrective leaves; the final installed run consumes the integrated package build.
The qualified production compiler is included at `output/install/can/libexec/can`,
with verified notices. No new third-party production package is added by these implementations.

## Accepted behavior and evidence

- Compiler inventory and exact selected-owner closure cover implicit Files R2,
  declared DO roots, typed queues, KV cache, analytics and bound services. The
  artifact and original module must agree. New semantics require
  `cloudflare.runtime-bindings@1`; older hosts cannot silently substitute D1.
- Real local R2/KV/DO/queue/service controls pass, including persistence and
  namespace isolation. Thirty original planner/preview controls pass; the new
  model-free ownership planner passes eight focused controls and strict typing.
  A real model-free member invocation and replay use the actual team database,
  durable queue intake and handler completion; no business State is placed in
  the Identity database.
  One real workerd check covers the private scheduled recovery wake-up.
- The actual compiled imported-feature queue/analytics host passes guarded void
  sends, requirement rollback, no external effects before commit, exact maximum
  integer/38-digit decimal payloads, durable handler effects, broker duplication,
  source replay, injected handler failure and restart recovery.
- The actual authenticated File journey passes upload/finalize, rejected
  attachment rollback, current field-authorized download, restart and revoked
  access. Lower-level controls cover competing offsets, interrupted publication,
  lost accepted D1 reply, physical allocation mismatch and safe journal cleanup.
- Real `Queue<file>` and guarded `Queue<Contract{file}>` pass authenticated R2
  upload/finalize, rollback without attachment/publication, timely attachment at
  23 hours, source replay, delivery at 25 hours, handler commit failure and
  restart recovery without another broker publication. Exactly two handler
  effects and the original persisted R2 bytes remain. This test took 148.4s;
  nested full-source validation was reduced only where the unchanged State
  revision already pins the source. File availability is still checked freshly.
- Actual root CRUD, protected root Files and same-root queue workflows pass.
  These cover source rejection, child writes, original credential checks,
  cross-team/root refusal, MCP discovery, restart, queue recovery after broker
  loss, replay without duplicate effects, and absence of D1 business-row copies.
- Existing Work/framework compatibility controls pass 48 cases. Legacy Files
  finalize/retention controls pass 53 cases; the new strict retention policy
  carrier control passes. Reuse unchanged results rather than rerunning them.

## Retention and recovery

The user selected keeping attached files until explicitly deleted. Local upload
intents last one hour; unattached files have a 24-hour horizon. The literal
optional `retainAttached: true` preserves attached availability without a fake
infinite timestamp. Existing finite policy behavior is unchanged when absent.

Queue publications retain their own original typed payload/header on the existing
Work dispatch. Only the actual authenticated committed source and its verified
receipt/outbox/header can mark attachment. Authenticated replay repairs an
interrupted marker while Files still accepts the file. A crash after State commit
but before the marker, followed by recovery only after unattached expiry, remains
a finite limitation shared with the existing business-field attachment path;
markers are never backdated and expired files are never revived.

Published-byte deletion still requires the existing complete authoritative State
reference census. One root cannot authorize deleting another root's reference.
The bounded R2 journal reclaims only unpublished objects. No automatic cross-root
published-byte garbage collector is claimed.

## Explicit profile limits

- KV is the optional public reconstructible presentation cache in DESIGN §7,
  not another business-record store or permission authority.
- The emulator queue broker is memory-only. Work's durable intake and handler
  receipts own recovery. Local analytics is persisted observable telemetry,
  not an authoritative billing ledger.
- Root queue handlers may run in their actual existing same root. Cross-authority
  delivery, creating a new root from queue intake, and arbitrary root page-query
  fanout remain refused. Generated root discovery is eventual; direct root
  references do not depend on its directory.
- Guarded sends across different source and queue owners remain refused. A
  composed app importing a feature which owns its own guarded queue is qualified.
- Model-free public/authenticated resource operations, mixed app/team preview
  and complex model-free caller selectors need their owning storage-selection
  API and fail before preview allocation. Team-owned model-free effects work;
  app-scoped models retain their existing global-owner path.
- Unsupported private invocation carriers and non-static cache TTLs fail
  explicitly. External bound services require their actual supplied local worker.

## Decisions

The accepted choices and uncertainty are recorded in `docs/specification/DECISIONS.md`.
Three equivalent JEV binding-inventory requests disagree; existing pre-import
activation and same-IR correspondence justify the artifact inventory choice.
Root advice favors whole-invocation actor execution; Files advice favors the
bounded D1/R2 adapter. Queue File advice is uncertain: inspection favored the
existing dispatch pair over a separate model/lifetime. Advice is not acceptance
evidence; the actual controls above are.


## Final standalone artifact

The final macOS arm64 archive is `output/install/can-0.1.0-darwin-arm64.tar.gz`.
Download: 90,087,787 bytes (85.9 MiB); installed contents: 260,139,952 bytes
(248.1 MiB); allocated disk here: 277,823,488 bytes (265.0 MiB). It contains
3,698 files and 156 package identities. This is 34.4% smaller on disk than the
original 404.1 MiB core, with no Bun, browser or new third-party resource package.

All 18 installed checks pass. The integrated source build passes all 13 packages;
production dependency ownership passes 1,276 JS/TS files with zero violations.
The original four Office inline examples pass with the matching rebuilt compiler.
That compiler emits byte-identical complete artifacts for the already-qualified
File queue and three root cases; unchanged resource results are reused. Actual
installed root/File and root/queue journeys also pass outside checkout with only
the bundled Node/compiler and clean PATH. API-only preview checks require actual
readiness and pass real login, team, MCP, assets and resource probes.

The one-command local entry is `sh output/install/install-local.sh`. Public curl
hosting, Homebrew publication, Linux CI qualification and authenticated remote
deployment remain external release/account gates; no such completion is claimed.
