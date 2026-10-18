# Shared form actions

This standalone Can app exists only to inspect canonical input workflows with shared defaults. It contains no imports, package composition, generated styling, generated views, prompts or external provider bindings.

`/` shows an inline create form with one direct primary submit and a card action that opens the canonical create dialog. `/edit` shows a direct inline update form and a canonical `edit` control with its own direct primary submit. Each uses the same small Sample model and native CRUD permissions/examples.

Forms and edits support **direct primary `submit=true` only**. Secondary menus and independent operation/open/navigation actions are unsupported inside an active form, including inside its fieldsets or other visual wrappers. Consequently this app does not place secondary primitives inside forms.

The canonical operation dialog provides the existing native **Cancel** control. The canonical `edit` control uses its existing drawer presentation and native **Close** control. Inline forms retain their existing submit-only behavior; the source introduces no cancel attribute, custom cancellation handler or extra form control.

From the repository root, with the current compiler, platform outputs and catalog available:

```sh
can validate tests/fixtures/action-forms/ActionForms.can
```

The app-local Playwright test consumes the normal `CAN_ACCEPTANCE_SOURCE`, `CAN_ACCEPTANCE_WORKSPACE` and `CAN_ACCEPTANCE_OUTPUT` contract and uses the existing real development-session helper. It creates one neutral sample through the canonical inline UI, then captures inline create/update, required-input validation and native create-dialog cancellation and edit-drawer closing at 1440×1000 and 390×844. It verifies one authored submit and no secondary menu per form, checks that cancellation does not create/change records, then submits distinct notes through both inline update and canonical edit and reloads to verify persistence while keeping the sample title unchanged. The two viewports produce 14 inspection screenshots, including both saved states. The test closes its owned session. The source fixture belongs only to native examples; it is not browser seeding.

Screenshots are written beneath the acceptance output's `screenshots/` directory; local test execution uses `playwright/results/screenshots/`. Captures are inspection artifacts, not automatically approved visual baselines.

For interactive inspection, use the installed native development control:

```sh
can dev start --root "$PWD" --source tests/fixtures/action-forms/ActionForms.can --app ActionForms
```

Use the returned session with `can dev preview.open --root "$PWD" --session SESSION --app ActionForms --profile local-d1-identity`. Stop it with `can dev stop --root "$PWD" --session SESSION --app ActionForms --profile local-d1-identity` when finished. `can dev FILE` is not a supported command; no fixture-specific server or wrapper is used.

The paired [owner gallery](../action-gallery/README.md) covers all admitted non-form action owners.

Native `can validate` passed compilation, app build, four examples and the complete
desktop/mobile Playwright journey on 14 October 2026 (56.9 seconds, no skipped or
flaky tests). The acceptance report (`.can/gen/checks/source-b3067695-c754-4384-ab6b-d72b13e67a7f/report.json`, local run output)
records the run. Browser verification exposed overlapping sibling cards in a
list row; the shared UI layout now stacks these cards in source order.

The 14 inspection captures remain local under ignored `playwright/screenshots/` or the acceptance output directory. Regenerate them with the native validation command above. Run outputs are not checked into Git; authored references and approved baselines remain separate.
