# Workflow and interface testing

Verify business behavior through real operation boundaries and user interfaces, including denials, conflicts, retries and external uncertainty.

## Verify the business operation

Run the app's declared examples against its checked artifact with `can test` after building. Include at least one allowed caller and one denied caller for each important operation. For rejection, assert both the expected error and the absence of protected state changes. Test stale versions and duplicate requests where the workflow can race or be retried.

Examples are useful focused evidence, but they do not replace a joined workflow. A sequence should follow the actual actor journey and verify the result after each committed operation. See [fixtures and examples](02-fixtures-and-examples.md) for fixture ownership and expected-value rules.

## Verify the interface

Exercise the browser with actors whose permissions differ. Confirm inaccessible records are not disclosed through lists, details, counts, errors, exports or related-data fields. Submit invalid values, navigate away and return, and verify that conflicts preserve the user's draft and focus so they can reconcile it. A visible or disabled control never substitutes for server-side authorization.

When an app exposes MCP, exercise the declared tool schema with a granted identity, an ungranted identity and malformed/stale input. Confirm tool descriptions and results do not disclose data the actor cannot read.

## Exercise files and external services

Test the full file path: upload, finalize, attach to the intended record, read under current authorization, and verify behavior when access is revoked or retention expires. A file reference is not proof that its bytes were finalized or remain readable.

For external delivery, cover accepted, rejected, timed-out and uncertain outcomes. A timeout can mean the provider accepted the request but the receipt was lost; reconcile by the stable delivery identity before resubmitting. Verify cancellation separately from confirmed termination. Do not fabricate provider success in a business assertion.

## Keep scopes separate

Application CI runs the app's source checks, declared examples and required acceptance journey. Repository contributor checks verify compiler/runtime packages and are described in contributor documentation, not as app requirements. Neither a successful compile nor one local preview qualifies every provider, browser or deployment environment.

## Install browser tools for acceptance

Browser checks use the release's separate browser-development add-on. Download `can-browser-development-tools-VERSION.tar.gz` and its `.sha256` sidecar from the same selected release, replacing `VERSION` with that release's version. In an empty directory containing both downloads:

```sh
shasum -a 256 -c can-browser-development-tools-VERSION.tar.gz.sha256
tar -xzf can-browser-development-tools-VERSION.tar.gz
sh install-browser-tools.sh
```

On Linux use `sha256sum -c` for the checksum command. Stop if verification fails. The installer uses Can's private Node and installs Playwright, Chromium headless shell and ffmpeg separately from production tooling. No global npm install is required. Linux also needs the browser's OS libraries. `CAN_BROWSER_TOOLS_ROOT` can select a separately installed tool root; pointing it at an empty folder does not install anything.

Source checks, inline examples and ordinary local preview do not require this add-on. Required browser acceptance does: missing tools are a setup failure, not a skipped pass.

## Configure app-local browser acceptance

Place exactly one `playwright.config.ts` (or supported JS/TS module variant) beside the app source. This configuration is a complete configuration file; it still requires authored browser journeys in `playwright/`:

```typescript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { ...devices["Desktop Chrome"], trace: "off" },
});
```

Keep browser tests integration-level: navigate a real app and exercise its operations. Do not import production functions into unit tests or use a mock web server as the accepted candidate. `can validate` supplies these environment values to the browser run:

| Variable | Browser harness responsibility |
| --- | --- |
| `CAN_ACCEPTANCE_SOURCE` | Start this absolute candidate source, never the original source or a hard-coded deployed URL. |
| `CAN_ACCEPTANCE_WORKSPACE` | Use this execution workspace for the candidate session. |
| `CAN_ACCEPTANCE_OUTPUT` | Store acceptance outputs here; preserve session cleanup/report information. |

The harness uses [development controls](../15-Tooling-reference/02-development-controls.md) to start the candidate, check it, verify that its source revision equals its serving revision, and open the protected preview. Authenticate through the returned local identity setup and select the intended team. A role grant in a fixture is not a browser login.

After actual browser navigation and assertions, stop the owned session in cleanup even when an assertion fails. The acceptance adapter expects `browser-session.json` in its output directory, containing `source`, `sourceRevision`, `servingBuild`, `browserNavigations` and `closed`. Populate these from the actual session and observed successful browser navigations; never write a static success document. This is test-harness output, not application source. Keep credentials and protected preview URLs out of reports and traces.

Acceptance requires at least one executed browser test, no failures, skips, flaky results or runner errors, and confirmation that the current candidate session was closed. The configuration above does not supply that harness or constitute a passing journey by itself. Adapt an app-owned harness to the documented controls and returned schemas; do not depend on private compiler/runtime helper APIs.

## Exercise the reviewer journey

For [VerifiedTasks.can](../examples/verified-tasks/VerifiedTasks.can), implement this browser journey against the candidate:

1. Start with `Ava` granted `reviewer` and `Ben` with no custom role. Use separate browser contexts so cookies and active teams cannot leak between actors.
2. As Ben, create “Browser review task”; assert it appears unfinished after the successful submission.
3. Verify Ben cannot complete it. A hidden action is a presentation assertion; the inline `member` example separately checks canonical rejection.
4. As Ava, open the same team's task, complete it and assert the resulting finished state.
5. Return to Ben's current authorized view and verify the committed state. Navigate away and back to establish that the result survived a page read.
6. Close both browser contexts and stop the owned candidate session, preserving failures if cleanup also fails.

Use locators based on actual accessible labels and role/name combinations; do not invent selectors from a generated screenshot. For a changed app, adapt the journey to its real rendered controls. See [live pages](../07-Build-interfaces/09-live-pages-and-progress.md) for a two-session refresh/conflict exercise and [MCP](../08-Connect-services/07-mcp.md) for discovery and file-transfer cases.
