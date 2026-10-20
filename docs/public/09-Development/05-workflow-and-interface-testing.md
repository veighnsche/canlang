# Workflow and interface testing

Verify business behavior through real operation boundaries and user interfaces, including denials, conflicts, retries and external uncertainty.

## Verify the business operation

Run the app's declared examples against its checked artifact with `can test` after building. Include at least one allowed caller and one denied caller for each important operation. For rejection, assert both the expected error and the absence of protected state changes. Test stale versions and duplicate requests where the workflow can race or be retried.

Examples are useful focused evidence, but they do not replace a joined workflow. A sequence should follow the actual actor journey and verify the result after each committed operation. See [fixtures and examples](./04-fixtures-and-examples.md) for fixture ownership and expected-value rules.

## Verify the interface

Exercise the browser with actors whose permissions differ. Confirm inaccessible records are not disclosed through lists, details, counts, errors, exports or related-data fields. Submit invalid values, navigate away and return, and verify that conflicts preserve the user's draft and focus so they can reconcile it. A visible or disabled control never substitutes for server-side authorization.

When an app exposes MCP, exercise the declared tool schema with a granted identity, an ungranted identity and malformed/stale input. Confirm tool descriptions and results do not disclose data the actor cannot read.

## Exercise files and external services

Test the full file path: upload, finalize, attach to the intended record, read under current authorization, and verify behavior when access is revoked or retention expires. A file reference is not proof that its bytes were finalized or remain readable.

For external delivery, cover accepted, rejected, timed-out and uncertain outcomes. A timeout can mean the provider accepted the request but the receipt was lost; reconcile by the stable delivery identity before resubmitting. Verify cancellation separately from confirmed termination. Do not fabricate provider success in a business assertion.

## Keep scopes separate

Application CI runs the app's source checks, declared examples and required acceptance journey. Repository contributor checks verify compiler/runtime packages and are described in contributor documentation, not as app requirements. Neither a successful compile nor one local preview qualifies every provider, browser or deployment environment.
