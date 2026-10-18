# Shared action gallery

This standalone Can app exists only to inspect shared default action components. It has no imports, package composition, generated styling, generated views, prompts or external provider bindings.

The gallery covers every admitted non-form owner:

| Route | Owners |
|---|---|
| `/` | Card footer primary actions and header secondary menu; page create entry |
| `/page` | Page heading create dialog and secondary navigation menu |
| `/rows` | List-row and table-row trailing actions |
| `/overlays` | Modal and drawer `slot actions`; `details display=drawer` |
| `/split-list` | Selected split-list panel footer and header menu |
| `/split-table` | Selected split-table panel footer and header menu |

Create a neutral sample on `/`, then use the sidebar to visit all static inspection pages, including **Page heading owner**. The shared Archive controls use canonical CRUD archive confirmation; cancellation keeps the sample available for inspection. Nothing is seeded into the development browser: Playwright creates its one sample through the real canonical create dialog. The source fixture is used only by native examples.

From the repository root, with the current compiler, platform outputs and catalog available:

```sh
can validate tests/fixtures/action-gallery/ActionGallery.can
```

The app-local Playwright test consumes the normal `CAN_ACCEPTANCE_SOURCE`, `CAN_ACCEPTANCE_WORKSPACE` and `CAN_ACCEPTANCE_OUTPUT` contract and uses the existing real development-session helper. It captures default, edit, open secondary-menu and archive-confirmation states for eight record owners at 1440×1000 and 390×844. The static page owner instead captures its default heading, create dialog and secondary navigation menu, then follows the navigation target. Dark table edit and archive dialogs also check that Cancel and the committing action share one footer without a nested card. These produce 74 inspection screenshots; edits, archives and the extra create are cancelled, and the owned session is closed. Screenshots are written beneath the acceptance output's `screenshots/` directory; local test execution uses `playwright/results/screenshots/`. Captures are inspection artifacts, not automatically approved visual baselines.

For interactive inspection, use the installed native development control:

```sh
can dev start --root "$PWD" --source tests/fixtures/action-gallery/ActionGallery.can --app ActionGallery
```

Use the returned session with `can dev preview.open --root "$PWD" --session SESSION --app ActionGallery --profile local-d1-identity` to open the protected preview. When finished, run `can dev stop --root "$PWD" --session SESSION --app ActionGallery --profile local-d1-identity`. No fixture-specific server or wrapper is involved.

The paired [form app](../action-forms/README.md) covers canonical form/edit submit ownership and native operation-dialog cancellation. Tooltip, layout, tab, collapse and fieldset wrappers are deliberately not action owners.

Native `can validate` passed compilation, app build, four examples and the complete desktop/mobile Playwright journey on 14 October 2026. The acceptance report (`.can/gen/checks/source-851aad76-2aef-4ed2-a7c6-f5b855a4d910/report.json`, local run output) records the run.

The 74 inspection captures remain local under ignored `playwright/screenshots/` or the acceptance output directory. Regenerate them with the native validation command above. They expose current defaults for human inspection; passing behavior does not approve their visual design, and run outputs are not checked into Git.
