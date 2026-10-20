# Live pages and progress

Keep task pages current with authorized polling, preserve unsaved edits, and opt into explicit repeated submissions only when the operation is suitable for an active-page refresh.

## Polling and refresh

A page may declare `poll=2s` using a whole-second interval from one second to one hour. Each refresh repeats admission and current authorization, and returns an authorized partial view. It preserves selected query/team context, edited control values and focus while applying fresh action, version and CSRF metadata. Withdrawn controls disappear.

Polling pauses while the document or page is inactive, does not queue missed ticks and allows one read in flight. Navigation, accepted context changes and mutations supersede older reads. Errors, full-document responses, foreign context and stale navigation stop painting. Visibility never grants permission.

A page may additionally declare `refresh=Operation` only when it has `poll=`. The target must be an enabled canonical user mutation presented by a form on that page, with no record-typed parameters. After the user successfully submits it, the shared interaction may repeat its accepted validated non-secret arguments at that cadence while the same page, principal and team remain active. Each repeat uses a fresh operation identity and current CSRF, authorization and guards; retrying that same repeat retains its identity. Poll reads alone never invoke that mutation.

Only one refresh chain and its source deliveries may be outstanding. Coalesce ticks, back off on unavailable sources and never accumulate deliveries merely because an HTTP response returned. Accepted changed inputs supersede old responses. Hide old projected action handles after a source mutation until a fresh authorized projection arrives. Refresh completion cannot trigger itself. Page visibility/context loss or logout cancels repeat triggers and clears private retained arguments; no background watch is inferred without an installed source channel.

For queued generation or delivery progress, display the typed delivery association and its latest sequence. A receipt means work was accepted, not that the provider completed it. See [deliveries](../08-Connect-services/02-deliveries-and-recovery.md) and [scheduling](../06-Business-workflows/07-scheduling-and-recurring-work.md).

## Watch task changes without resubmitting forms

Use [InterfaceTasks.can](../examples/interface-tasks/InterfaceTasks.can), a complete app with a task table and a separate refresh demonstration. On its `/` page, `poll=2s` updates authorized reads:

```can
page / title="Import and review tasks" poll=2s
 form add import=csv review=matching
  input title
 table Todo columns=title,done,evidence order=title
  pagination
```

Open the app in two signed-in browser sessions in the same team. In the first, begin typing a new task title without submitting. In the second, create a different task. On the next successful read refresh, the first session should show the newly committed task while preserving its unsaved title and focus. Polling does not submit that draft or repeat the CSV import.

Now change a row in the second session while the first has an edit draft open. A refresh must retain the draft rather than silently replacing it; submission still obeys the current concurrency contract. Review a version conflict against fresh data instead of overwriting it blindly. Switching team or losing admission must stop painting results from the old context.

## Opt into a repeated mutation explicitly

The sample's `/activity` page demonstrates the separate `refresh=` contract with a harmless check-in operation. The complete source defines one `Checkpoint` per user and updates its server timestamp; it does not create one record per tick.

```can
page /activity title="Explicit refresh" poll=5s refresh=check_in
 form check_in
 list Checkpoint
  text row.checked
```

1. Open **Explicit refresh**. Merely visiting starts read polling, not check-ins.
2. Submit the `check_in` form once. Its successful submission activates the repeat chain for the current page, principal and team. Observe `checked` advance after accepted repeats.
3. Leave the page or log out. Repeated submissions stop; the page is not a background scheduler. Return and explicitly submit again to start a new chain.

`check_in` has no record parameters or secrets. Each accepted repeat is a fresh mutation with its own identity; retrying that repeat keeps its identity. For operations with ordinary inputs, repeats retain the last successfully accepted validated arguments. Never use an operation that charges money or creates unbounded records just to make a screen look live. Use an explicit [scheduled workflow](../06-Business-workflows/07-scheduling-and-recurring-work.md) for work intended to outlive the page.

## Show external progress without creating more work

In the [runtime AI examples](../09-Runtime-AI/01-text-and-image-generation.md), the source starts a generation once and displays the original delivery's typed progress on a polling page. Read `request.status` separately from `request.progress.state`: delivery acceptance is not provider success. Reopening or refreshing the page must not generate a second paid request. Cancellation and reconciliation are explicit operations with the retained source/revision identity.

Test a slow request: only one refresh chain and its source work may be outstanding, with coalesced ticks rather than a queue of missed submissions. A stale response from before a navigation, mutation or accepted input change must not replace the current view.
