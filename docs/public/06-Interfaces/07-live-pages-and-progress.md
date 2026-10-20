# Live pages and progress

Live refresh keeps a page current while preserving the user’s context and in-progress edits. It refreshes authorized reads. An explicitly declared refresh operation can additionally repeat an accepted form submission under the active session.

## Polling and refresh

A page may declare `poll=2s` using a whole-second interval from one second to one hour. Each refresh repeats admission and current authorization, and returns an authorized partial view. It preserves selected query/team context, edited control values and focus while applying fresh action, version and CSRF metadata. Withdrawn controls disappear.

Polling pauses while the document or page is inactive, does not queue missed ticks and allows one read in flight. Navigation, accepted context changes and mutations supersede older reads. Errors, full-document responses, foreign context and stale navigation stop painting. Visibility never grants permission.

A page may additionally declare `refresh=Operation` only when it has `poll=`. The target must be an enabled canonical user mutation presented by a form on that page, with no record-typed parameters. After the user successfully submits it, the shared interaction may repeat its accepted validated non-secret arguments at that cadence while the same page, principal and team remain active. Each repeat uses a fresh operation identity and current CSRF, authorization and guards; retrying that same repeat retains its identity. Poll reads alone never invoke that mutation.

Only one refresh chain and its source deliveries may be outstanding. Coalesce ticks, back off on unavailable sources and never accumulate deliveries merely because an HTTP response returned. Accepted changed inputs supersede old responses. Hide old projected action handles after a source mutation until a fresh authorized projection arrives. Refresh completion cannot trigger itself. Page visibility/context loss or logout cancels repeat triggers and clears private retained arguments; no background watch is inferred without an installed source channel.

For queued generation or delivery progress, display the typed delivery association and its latest sequence. A receipt means work was accepted, not that the provider completed it. See [deliveries](../07-Integrations/02-deliveries-and-recovery.md) and [scheduling](../05-Workflows/06-scheduling-and-recurring-work.md).
