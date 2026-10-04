# CanCatch requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanCatch.can](CanCatch.can).

## Purpose and Adoption Goal

Help the workspace operator triage JavaScript errors in its booking, member, billing, and staff applications. Adoption depends on finding regressions that interrupt customer or employee workflows.

## Users and Permissions

Authorized team members view and triage their project's issues. Developers provision projects and maintain intake credentials, grouping configuration, quotas, retention and alert destinations directly in the authoritative database/configuration outside the product UI. Reporting clients have intake-only configuration and never gain team administration or read access through a browser key.

## Data and Ownership

Project belongs to a team and has a name. Project owns event IDs, credential/configuration, grouping rules, quotas, and optional alert URL. Persist normalized events and issue metadata separately from raw R2 payloads. Store resolution time, occurrence/receipt times, environment, release, and fingerprint version. Default raw-event retention is 30 days; issue metadata lasts 90 days after last activity.

Projects identify the deployed application and environment. Authorized, minimized event context may include an opaque location or booking-operation reference; do not capture payment details, door credentials, or member documents.

## Workflows and Business Rules

Deduplicate event IDs within a project before increasing counts. Group by exception type plus normalized stack, with normalized message as fallback; an explicit SDK fingerprint overrides that rule. New events after resolution reopen the matching issue. Validated late events predating resolution enter history without generating a false regression.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). The declared Application errors (`/errors`) page supplies the authorized viewer's sidebar entry; project selection, issue detail and occurrence evidence stay contextual. Use daisyUI. Project provisioning, DSN/SDK wiring, credentials, grouping, quotas, retention and alert destinations remain developer maintenance outside product forms/settings.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Application errors | Configured-project Select, application/environment/release context Card and issue Table with status filters, message search, count, last activity and owner Badges. | Read only scoped configured projects and captured issues; project selection creates no project or intake credential. |
| Grouped issue | Error summary Card, normalized stack Collapse, occurrence/receipt-time List and state/owner Fieldset. | Resolve or assign through existing triage operations; a new post-resolution event may reopen the issue while a late earlier event only extends history. |
| Occurrence evidence | Table/List ordered by receipt time with occurrence time, environment, release and fingerprint context; authorized minimized/raw-payload detail in Collapse. | Open only permitted retained payloads. Explain expired payloads without implying that retained issue metadata disappeared. |
| Notes and repair link | Attributed staff-note List and note Input with submit Button; declared CanDo task reference Card; capture/processing/alert failure Alerts. | Record authorized notes and follow the explicitly declared task link. Triage neither provisions bindings nor reveals restricted customer data. |

Counts describe captured occurrences, not total transactions or guaranteed incident coverage. Distinguish a quiet project, no filter matches, unavailable evidence and intake/processing gaps; display known rejected/dropped events and alert delivery failures separately from issue state. During asynchronous triage, disable repeated mutation and preserve the current issue reference. A resolve/recurrence conflict refreshes server state and explains the reopened issue without discarding unsaved notes. On narrow screens use labeled issue Cards with status/count/last activity always visible and expandable stack/payload evidence. Protect content from accidental credential disclosure and show only context already authorized and minimized.

## Personal Configuration

Inherit the shared own-user dialog and base settings. Remember a permitted project's triage filters and whether stack/occurrence sections open expanded. These preferences never change instrumentation, credentials, quotas, retention, grouping or alerts, and require no technical setup forms.

## Interfaces and Integrations

Initial instrumentation supports JavaScript browser and workerd exceptions/rejected promises, plus explicit reporting of handled errors and observed request failures. Expose a versioned error-event contract through /errors/{key}; its own SDK configuration is not a promise of Sentry protocol compatibility. Browser keys allow intake, never report reads or administration. Use D1, Queues, and R2; bind CanDo to a project explicitly.

Only issue read/triage and the declared intake operations belong to the app interface. Developer-owned project/configuration records have no end-user create/update/delete, credential-rotation tool or configuration form; their stored values still drive intake, quotas, retention and alert delivery.

## Background Actions

Acknowledge only durably queued events. Consumers tolerate repeated/reordered messages. Apply per-project quotas and a 256 KiB event limit, track rejected/dropped events, and clean up expired payloads. Project deletion prevents pending work from recreating its data. Alert new issues/regressions with bounded retries.

## Error Handling

Strip credentials, authorization headers, cookies, and obvious password fields before storage; allow projects to restrict context. Show intake, processing, and alert failures and capture gaps. SDK buffers are bounded and never break the host app. Internal reporting failures must not recurse.

## Scope and Completion

Complete when repeated delivery counts once, distinct fingerprints form separate issues, real recurrence reopens an issue, late events do not falsely regress it, and retention/deletion work. The initial product captures instrumented JavaScript events, not every error on every platform.

A failed booking-page action can be traced to a grouped issue and assigned for repair without exposing another location's restricted customer records.

Frontend completion additionally requires these journeys:

- Staff trace a failed booking action to a grouped issue, inspect scoped occurrence evidence, assign an owner and follow its declared repair task without viewing restricted customer records.
- After resolution, a late pre-resolution occurrence leaves the issue resolved while a real later recurrence shows reopened state; missing/expired payloads and delivery gaps remain understandable rather than appearing as zero errors.

## Composition and Ownership

Recommended placement: Digital application-error module. Own error ingestion/grouping and triage. It may share operations navigation with CanCheck/CanStats but retains its intake credentials, event retention, quotas and issue lifecycle. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Pinned intake and maintenance contract

Project provisioning is trusted developer maintenance using the canonical owner admission rules; direct SQL writes that bypass the owner fence, validation or hooks are not valid maintenance. There are no product configuration tools. Each installed intake binding fixes one source namespace and resolves its project from the credential and server configuration. A body cannot nominate another project, quota, grouping version, viewer or health authority. Rotated/revoked keys stop new admissions. Browser keys remain public write-only identifiers and do not authenticate the truth of a report.

The version-1 HTTP/SDK boundary accepts JavaScript report identity, occurrence time, message, optional stack/environment/release and an optional explicit fingerprint. The deployed adapter maps `std.ErrorsV1.report` from CanDo (`event.id`, `event.occurred_at` and the same minimized fields) to this same boundary; it does not create a second collector or require the compiler to know CanCatch. `/errors/{key}` accepts at most 256 KiB of encoded UTF-8 input before parsing. The normalized message is limited to 4096 characters and stack to 32000; unsupported fields or invalid types fail admission instead of being stored as arbitrary context. Configured environment/release allowlists apply before grouping. An optional raw payload contains only that normalized, redacted representation, never the original request.

Credentials, authorization/cookie headers, passwords, request/response bodies, payment values, door credentials and uploaded member documents are excluded. URL query/fragment and user-info are removed from recorded frame URLs. Project restrictions may remove further fields; they cannot reenable the forbidden context. Free-form exception strings remain untrusted and pass the pinned redactor before either storage or outbound instrumentation. Sanitization precedes grouping, queue persistence and R2 finalization. File-valued payloads use receiving-app finalization and the verified event provenance contract; arbitrary client file IDs cannot become attachments.

Grouping version 1 hashes a canonical UTF-8 JSON tuple with SHA-256. A nonempty explicit SDK fingerprint uses `[1,"explicit",fingerprint]`; otherwise a recognized exception uses `[1,"stack",exceptionType,normalizedFrames]`, or `[1,"message",normalizedMessage]` when no frames remain. The adapter recognizes JavaScript `at function (url:line:column)` and `function@url:line:column` frames, preserves their order, removes location line/column numbers and URL query/fragment/user-info, and trims/collapses whitespace. It never fetches frame URLs or source maps. Unrecognized frame lines are not arbitrary grouping inputs; they fall back to the normalized message. Issue identity includes the resulting fingerprint, grouping version and environment. Releases are occurrence context, allowing a later release to regress an existing issue. The issue table derives its latest release from occurrence time; late older events do not replace it. The occurrence table filters any retained release, including previous ones. The installed adapter version pins parsing/redaction details and test vectors; changing them requires a new grouping version, and already queued work retains its original version.

Event identity is project/source-scoped, content-bound and retained through the full retry horizon independently of expiring occurrence rows. Admission rejects occurrence times over five minutes ahead or more than seven days old, preserving the same bound when delayed work is processed. Replaying the same identity and normalized content returns its existing receipt; conflicting content is rejected. These ingress tombstones remain safe keyed digests/outcomes and cannot expose expired payloads. Within that window, late pre-resolution events extend captured history without reopening. An unseen expired identity cannot become a fresh report after history disposal.

The configured quota is accepted unique reports per UTC day. Quota admission, durable identity/receipt and accepted work intent commit under the project owner's fence; retries do not spend quota twice. HTTP 202 means that durable intent exists, not that issue processing or notification has succeeded. Saturated quotas/backpressure return an explicit rejection and never break the reporting host application. SDK buffering/retries are bounded and reporter failures are excluded from recursive capture. Transport and runtime implementation remain outside this draft pass.

`IntakeV1.health` is a verified technical snapshot from the configured intake/processing authority, not a browser operation. Its per-project revision and cumulative accepted/rejected/dropped/processing-failed counters persist across process restarts. Identical revisions must contain identical values; newer snapshots cannot decrease counters or observation time. A reset requires a newly provisioned project identity rather than an unexplained counter reset. The Health row displays when the last snapshot was observed; absent or stale evidence is not a zero-error claim. Project deletion/expiry prevents queued work or health events from recreating that project.

## Completed triage connections

Issue assignment requires the selected active employee to hold the developer role and be a configured project viewer. The repair link is a typed reference to CanDo's actual exported Task; users create work through `Task.create` and link it explicitly, under the task's location/read/CRUD grants. This adds neither an automatic task nor a copied task workflow. A task reference never broadens another project's or location's access.

New-issue and regression notifications have separate Notice rows and correlated delivery status. Their localized outbound text is frozen by the committed send; failure/unknown/skipped delivery never changes issue resolution or occurrence counts. Destination configuration is frozen for that notice, and disabling the project suppresses undispatched notices. Health snapshots and notice outcomes appear alongside captured evidence rather than being inferred from quiet event counts.

Five authored inline tables cover 20 cases: triage authority, eligible owner assignment, duplicate processing, finalized raw-file retention, genuine versus late recurrence, stale/future intake independent alert outcomes, and monotonic/idempotent health snapshots. These are source expectations; no SDK, transport, storage or example runner was executed.

Scenario-created new/regression Notice rows emit `Notice.created`; the background handler reloads the exact current unassociated row before enqueuing its frozen destination/content and recording the attempt. It does not depend on Notice CRUD. Replayed or already-associated notifications do not enqueue another send; the dispatch guard still checks the current project. No notification delivery is executed by these draft corrections.
