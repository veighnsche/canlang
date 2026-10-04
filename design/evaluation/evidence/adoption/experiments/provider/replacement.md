# Bounded provider-replacement exercise — E019

2026-10-04, root evidence assistance for A. Inputs: frozen CanMail.can:12,92–106,226–255; DESIGN.md:471–477,525–541. This is a mapping-design exercise against two **hypothetical pinned provider contracts**, not a vendor compatibility test or an adapter implementation. Both providers meet the same selected send outcomes. No undisclosed SDK or wire capability is assumed.

## Required outcomes fixed before mapping

Keep `std.EmailV1`, canonical `Mail.send`, the `deployment.mail` slot, authorized recipient, recipient-resolved locale, frozen subject/body, delivery identity, current-notice correlation and explicit failed/unknown/skipped distinctions. Sending must not widen record/file access. Acceptance is not delivery or reading. Retrying an uncertain old delivery must not submit it independently to a new provider. Replacing the service cannot silently discard attachments even though this app's notice calls omit them.

## Before: provider Alpha, supplied interface fixture

`POST /messages`, bearer credential, `Idempotency-Key` scoped by its account. Body `{recipient, subject, text, attachments:[{name,content_base64,mime}]}`. Fixed configured sender is attached by adapter. A successful `202 {message_id}` means durable acceptance; lookup by account/idempotency key returns accepted, rejected, or unknown. `422 {code:"invalid_recipient"}` is definite permanent rejection; `429` with explicit not-accepted flag permits same-key retry; ambiguous network failure remains unknown. Aggregate attachment limit 12 MiB. Provider records same-key accepted receipt for 7 days; changed content under key conflicts.

Mapping: canonical `to→recipient`, `subject→subject`, `body→text`; authorized immutable attachments→encoded attachment entries, with aggregate limit checked; `message_id→EmailAccepted.reference`. Canonical delivery identity maps to account-scoped Idempotency-Key. Secret and sender belong to installed adapter configuration, not Can fields. Only a valid successful receipt produces `Mail.send.completed` with the original delivery ID and succeeded/result reference.

## After: provider Beta, supplied interface fixture

`POST /jobs/mail`, account credential, body `{request_key, sender_id, destination, message:{title,plain}, files:[{filename,bytes_base64,media_type}]}`. `200 {job_id, accepted:true}` means durable acceptance; query by account/request_key returns accepted, rejected, or unknown. `200 {accepted:false, reason:"address_invalid"}` is definite rejection. `503` with explicit not-accepted flag permits same-key retry; ambiguous network failure stays unknown. Aggregate attachment limit 12 MiB. Same 7-day account/key receipt retention and changed-content conflict as Alpha.

Mapping: canonical delivery identity→request_key, installed sender→sender_id, `to→destination`, `subject→message.title`, `body→message.plain`, immutable authorized attachments→files, `job_id→EmailAccepted.reference`. A bare HTTP 200 is insufficient. `accepted:false` cannot become success; no receipt stays unknown. Credentials, response parsing, serialization and error classification change in the adapter; Can's owner schema and handlers do not.

## Change record and transition obligations

The saved `CanMail.can` is byte-identical to the frozen input: **0 app-source lines changed, 0 operation/signature/example/UI changes**. One configured implementation and its wire mapping change. The mapping descriptions above are the visible additional contract work; zero Can edits does not mean zero engineering or stewardship effort. A new deployment-slot name could force one import edit, but provides no benefit in this controlled replacement.

New deliveries after a recorded switch may use Beta. Existing accepted/uncertain/pending Alpha deliveries retain Alpha's adapter revision and receipt namespace until resolved or the documented retry/recovery horizon ends. An ambiguous Alpha send must not be retried through Beta under a different provider namespace. Independent C review located existing release-transition requirements: DESIGN.md:760 includes resolved bindings/routing in installed snapshots; :820 fences dispatch during activation; :822 already retains old declaration contracts and requires uncertain/accepted work to reconcile or keep a compatible contract. This corrects the first inspection's overly broad suggestion that draining was missing. The remaining narrow clarification is to explicitly apply this same lifecycle gate to **config-only adapter/account/provider switches**, preserving each unresolved intent's original receipt namespace/config even when EmailV1's schema is unchanged. Benefit: safe vendor switching; tradeoff: temporary dual-provider access/support. Reevaluate the same queued and ambiguous cases below; no new app primitive or new general draining mechanism is demonstrated as necessary.

## Static acceptance trace

| Case | Mapping/owner consequence | Result of this exercise |
| --- | --- | --- |
| Successful current notice | Alpha 202/id or Beta accepted=true/job maps to same typed reference; current delivery matches Item.notification | Existing owner handler may mark notified; no read-confirmation claim |
| Old completion after a newer reminder | Both preserve original canonical delivery_id | Existing owner equality ignores unrelated old completion |
| Beta HTTP200 rejected | accepted=false maps to failed with safe typed error | Must not pass transport success to owner as accepted |
| Network uncertainty | No invented success; same provider/key queried/retried within contract | Unknown remains visible; replacement draining contract needs clarification |
| Recipient revoked before dispatch | Existing send guard checks current eligibility; frozen recipient/content is retained | Mapping grants no authority; dispatch/guard semantics stay shared |
| Recipient changes language/content after commit | Both serialize committed subject/body, with no localization at adapter retry | Fixed-content/locale outcome is preserved by proposed mapping |
| Attachments | Both use authorized finalized immutable bytes and declared aggregate limit | Schema and limits retained; actual transfer unverified |
| Live switch while Alpha uncertain | Original delivery must retain Alpha revision/account/key | Existing release gate covers draining; clarify config-only switches use it too; no unsafe replay through Beta |

These are inspectable mapping obligations, not executed HTTP, rendering, identity or delivery tests. No provider implementation, live secret, app redesign or deployment was made. C independently reviewed the transport/release boundary and supplied the counterevidence above. This small exercise supports stable app contracts for an equivalent provider; it does not claim arbitrary vendors can satisfy EmailV1 without capability differences or costs.
