# Complete witness registration — SEQ-003

This registers source witnesses for root acceptance; it does not accept their execution.

**Image witness:** `draft/CanCreative.{md,can,mjs}`, composed with complete `draft/CanChat.{md,can,mjs}`. Preserve upload/inspect/map/validate/publish, bounded private generation, chat-to-image, stop/reconcile/skipped release, revocation recovery, cumulative progress, once-only allowance settlement, and authorized finalized-image access. JSON retains operations, CRUD, and pages including transitive chat. CanGallery is downstream, not a substitute.

**Original approval witness:** `draft/CanApprove.{md,can,mjs}` with `draft/shared/Employees.can` and `Locations.can`. Preserve document intake and immutable revision submission; eligible current reviewer selection and assignment; approve/reject with reasons or conditions; replacement, withdrawal, notices, reminders, rejection-to-replacement-to-approval, stale-review/reassignment/revocation recovery, and retained downloadable evidence. The workflow uses one assigned reviewer, not a generic quorum or expense fixture.

The current private drafts are tracked in a clean Git submodule at `a55a0f700f07f6f972d9d6091b0fdbceee399eb9`. The October 7 provenance ledger described earlier copies as ignored local drafts; that historical label needs reconciliation before acceptance. CanCreative and CanChat have no matching October 4 archived snapshots. Earlier approval excerpt sections requesting lines 293–355 are empty; complete archived requirements/source preserve the intent.

CanCreative declares `ImagesV1` at `deployment.images` and transitive `TextGenerationV1` at `deployment.llm`. Its file policy does not select concrete metadata/file backends. CanApprove requires D1 metadata, R2 files, and EmailService, with `EmailV1` at `deployment.mail`. Actual backend instances, provider versions, node/model allowlists, and cancellation isolation remain deployment obligations.

Existing core/UI state-machine evidence does not qualify either whole application. Compiled browser/MCP journeys, real provider/file evidence, crash/restart/replay, and stored/pending-work upgrades remain execution gates.
