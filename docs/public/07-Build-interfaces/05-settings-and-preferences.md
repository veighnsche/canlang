# Save personal task views and presentation preferences

Declare personal view choices and connect them to task lists, tab panels and help expansion. Distinguish saved preferences from transient tabs, shared settings and business configuration.

## Start with the complete TaskPreferences app

This separate task tutorial needs the [installed toolchain and team access](../01-Get-started/05-first-app.md). Save the complete listing as `TaskPreferences.can`; it is also available in the [handbook source](../examples/task-preferences/TaskPreferences.can). The [localization lesson](06-localization.md) explains its Dutch variants and messages.

```can
# Choose how to browse team tasks. @{nl="Kies hoe je teamtaken bekijkt."}
app TaskPreferences
Given
 message task_count(n:int) = "{n, plural, =0 {No tasks} one {# task} other {# tasks}}"@{nl="{n, plural, =0 {Geen taken} one {# taak} other {# taken}}"}
 message add_task = "Add task"@{nl="Taak toevoegen"}
 Todo {title:text trim min=1,done:bool=false label={values={true="Finished"@{nl="Afgerond"},false="Open"@{nl="Open"}}}} label="Task"@{nl="Taak"}
 policy Todo read=members
When
 crud Todo by=members fields=title,done label={create=add_task}
Then
 preferences {view:enum(all,unfinished,finished)=all label={text="Task view"@{nl="Taakweergave"},values={all="All"@{nl="Alles"},unfinished="Unfinished"@{nl="Open"},finished="Finished"@{nl="Afgerond"}}},expand_help:bool=false label="Expand help"@{nl="Help uitklappen"}}
 page / title="Tasks"@{nl="Taken"}
  form Todo.create display=inline
  text task_count(count(Todo))
  tabs preferences.view
  list Todo as task where preferences.view==all or (preferences.view==unfinished and not task.done) or (preferences.view==finished and task.done) columns=title,done
   edit
   pagination
  details "Help"@{nl="Help"} open=preferences.expand_help
   text "Choose a task view above."@{nl="Kies hierboven een taakweergave."}
 page /panels title="Saved panels"@{nl="Opgeslagen panelen"}
  tabs preferences.view
   tab all
    list Todo columns=title,done
   tab unfinished
    list Todo as task where not task.done columns=title,done
   tab finished
    list Todo as task where task.done columns=title,done
 page /help title="Help"@{nl="Help"}
  tabs
   tab "Reading"@{nl="Lezen"}
    text "Use the task list to inspect current work."@{nl="Bekijk het huidige werk in de takenlijst."}
   tab "Editing"@{nl="Bewerken"}
    text "Edit a task to change its title or completion."@{nl="Bewerk een taak om de titel of voltooiing te wijzigen."}
```

From its directory, run `can check TaskPreferences.can`, then `can dev ui --root . --source TaskPreferences.can --app TaskPreferences`. Enter `check`, wait for the serving revision, use `open`, sign in and select a team. Create one open and one finished task to compare the views.

## Declare preferences and their consumers

The unnamed `preferences {fields}` declaration belongs in `Then`. It extends the common Settings dialog, rather than creating a business model or an app-owned settings page. This app declares two fields, each with an actual consumer:

| Preference | Default | Consumers |
| --- | --- | --- |
| `view` | `all` | Task-list predicate, bound tab selector and the matching panel on `/panels` |
| `expand_help` | `false` | Initial expansion of the Help details group |

Nonnullable values need context-free constant defaults; nullable authorized model references default to null. Scalars and enums use ordinary constraints. Arrays, files, secrets, actions, JSON/objects and nested schemas are not preference fields. Server initializers and uniqueness do not belong here. One owner has one unnamed declaration; it cannot be exported.

For configuration validation, an owning `Then` section can declare `invariant preferences: row...` with a pure predicate over its preference values. It is separate from stored-model invariants in `Given`. Do not invent a business model named Preferences or a save scenario to duplicate this behavior.

## Persist viewer choices at the right scope

The runtime persists preferences by user, selected app, canonical owner and current team (or none). Composition includes one settings section per owner. Changing a choice in Team A does not update another person's settings or impose a team policy. Anonymous rendering uses the declared schema defaults.

Self-only generated save/reset controls own changes. Concurrent saves use version checks; correctable failures preserve the draft, Cancel discards it and Reset affects only the relevant preferences. Saving and consuming a model-reference preference rechecks access; a revoked reference falls back safely with feedback.

Preferences may narrow an authorized presentation query or choose layout. They cannot control business guards, authority, transitions, schedules, correlation IDs or stored business fields. A read form can accept a preference as an ordinary input under its unchanged read contract. Business-wide choices such as approval thresholds belong in authorized models.

## Connect a saved tab selector to a query

The root page's `tabs preferences.view` is a selector leaf. It does not contain three panels: its selection feeds the existing task-list predicate. `all` shows every readable task, `unfinished` adds `not task.done`, and `finished` adds `task.done`.

That predicate narrows the readable dataset; it cannot override `policy Todo read=members`. Editing a task's `done` field changes business state, while choosing Finished changes only what this viewer sees. The enum wire values remain `all`, `unfinished` and `finished` even when their labels are translated.

## Use saved panels or transient tabs

The `/panels` page uses a block rather than a leaf:

```can
tabs preferences.view
 tab all
  list Todo columns=title,done
 tab unfinished
  list Todo as task where not task.done columns=title,done
 tab finished
  list Todo as task where task.done columns=title,done
```

This is an excerpt from the complete app. A bound block must cover each enum case exactly once; case captions come from the enum's labels. Both `/` and `/panels` consume the same saved preference, so a change follows the viewer between those pages within its persistence scope.

The Help page instead uses unbound tabs:

```can
tabs
 tab "Reading"@{nl="Lezen"}
  text "Use the task list to inspect current work."@{nl="Bekijk het huidige werk in de takenlijst."}
 tab "Editing"@{nl="Bewerken"}
  text "Edit a task to change its title or completion."@{nl="Bewerk een taak om de titel of voltooiing te wijzigen."}
```

These captions describe transient panels. Their selection belongs to that render site and does not save `preferences.view`, change a business field or create a user-setting record. Unbound tabs require nonempty panels. Both forms retain enclosing row scope and recheck the active authorized panel; a tab never grants access to its content.

## Shared settings

The shell owns Account, Language, Appearance and Security. Do not redeclare locale, theme, density or account controls as app preferences. `theme_controller` consumes the shared Appearance choice, not a second theme field. Sidebar collapse is device-local.

Open Settings through the account menu. Language and Appearance preview changes while preserving business input, then follow the dialog's confirm/cancel outcome. The app's `expand_help` controls its own help group, not the shell's common history-expansion setting.

## Verify persistence and separation

1. Choose Unfinished on `/`. Confirm only the open task appears. Visit `/panels` and confirm the saved Unfinished panel is selected.
2. Change to Finished, revisit the root page and reload. Confirm the saved choice is consumed without changing any task's completion state.
3. Change Expand help in Settings. Reopen the task page and check the help group's initial expansion.
4. Switch Help's transient tab. Confirm it does not change the saved task view or create another settings field.
5. Use another viewer or team and confirm their scoped preferences remain separate. Reset the relevant preferences and verify defaults.
6. Switch Language to Dutch and follow the localization lesson's checks. Confirm labels change while task titles and enum identities remain intact.

## Find shared presentation settings

Open Settings from the shell’s account menu, then select the relevant section in the dialog’s internal sidebar. Language offers the application’s available locales; Appearance provides supported presentation choices. The dialog displays the active section’s panel, so inspect each section separately.

### Language

```doc-visual
{
  "placeholder": "Select Language in Settings to see the locales offered by the application.",
  "caption": "The Settings dialog with Language active and an offered locale selected. Marker 1 identifies the active section; marker 2 identifies the locale control.",
  "alt": "Settings dialog showing the active Language section and its offered locale control",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use a real approved documentation instance with the shared Language section available and a synthetic signed-in account allowed to change its own viewer settings. Open the shell account menu, choose Settings, then select Language in the dialog sidebar. Obtain the actual instance address from its operator.",
      "Capture only the active Language panel and section sidebar, with a locale actually offered by this application selected. Keep the existing selection and any actual confirmation controls visible; do not fabricate locale options, save controls or another section panel. If the deployed revision lacks this shared section, defer capture until it is available.",
      "Record the captured application and runtime revisions and capture date in the asset notes; do not include credentials, private addresses, session tokens or real personal data.",
      "Capture at 1280 by 800 with English interface text and the light theme. Use a focused crop so essential labels remain readable at narrow article widths."
    ],
    "edits": [
      "Crop browser chrome and unrelated application content, retaining the Settings title, section sidebar, active Language heading and locale control.",
      "Add marker 1 beside the active Language section and marker 2 beside the locale control. Preserve actual labels and explain both markers in the caption.",
      "Exclude personal account information and verify the alt text against the completed capture."
    ]
  }
}
```

### Appearance

```doc-visual
{
  "placeholder": "Select Appearance in Settings to find the supported theme and density controls.",
  "caption": "The Settings dialog with Appearance active and sample light-theme, comfortable-density selections. Marker 1 identifies the active section; marker 2 identifies the theme and density controls.",
  "alt": "Settings dialog with the Appearance section active and supported theme and density controls",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use a real approved documentation instance with shared Appearance settings and a synthetic signed-in account permitted to change its own viewer preferences. Open the shell account menu, choose Settings, then select Appearance in its section sidebar; use the actual address supplied by the operator.",
      "Select the offered light theme and Comfortable density for sample viewer settings. Capture the active Appearance panel, its actual theme choices, density controls and existing save/reset affordances with the section sidebar. Do not show Language controls alongside the active Appearance panel. If the instance does not yet expose this shared panel, defer capture instead of composing a mock interface.",
      "Record the captured application and runtime revisions and capture date in the asset notes; do not include credentials, private addresses, session tokens or real personal data.",
      "Capture at 1280 by 800 with English interface text and the light theme. Use a focused crop so essential labels remain readable at narrow article widths."
    ],
    "edits": [
      "Crop browser chrome and unrelated content, keeping the Settings title, sidebar, active Appearance heading, theme and density labels and their real controls visible.",
      "Add marker 1 beside the active Appearance section and marker 2 beside the theme and density control group; explain both markers in the caption and preserve all interface text.",
      "Exclude account details and verify the caption and alt text against the finished capture."
    ]
  }
}
```
