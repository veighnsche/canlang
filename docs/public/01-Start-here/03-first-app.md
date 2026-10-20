# Build your first app

This tutorial builds a complete small `Tasks` app: users create tasks, see only tasks readable to them, edit permitted fields, and use a generated page. The `Tasks` app owns its records and routes; it is not a fragment for another package. Start after [installing CanLang](02-installation.md). See [models](../03-Data/01-models-and-relationships.md) and [operation permissions](../04-Access-and-rules/02-roles-and-operation-permissions.md) for the full semantics.

## Declare the Tasks app

```can
# Manage team tasks.
app Tasks
Given
 Todo { title:text trim, done:bool=false }
 policy Todo read=members
When
 crud Todo by=members fields=title,done
Then
 page / title="Tasks"
  form Todo.create display=inline
  list Todo columns=title,done
   edit
   delete
```

The app identity comes from `app Tasks`. `Todo` is a stored model. `crud` derives create, update, and archive-delete operations whose call eligibility is restricted to current members. The policy grants members reads of this team's tasks and ordinary fields; a page or hidden button is never the authority. `fields` is the mutation allowlist, so an update cannot assign another field by submitting extra data. `list` uses the authorized model query.

## Recognize the generated page

The root page places creation above the authorized task list. Use its row edit control to change the allowed title or done fields; delete follows the default archive lifecycle.

```doc-visual
{
  "placeholder": "Preview the Tasks page with its inline creation form, task list, and row controls.",
  "caption": "The generated Tasks page with synthetic tasks. Marker 1 identifies the inline Todo.create form; marker 2 identifies the title and done columns; marker 3 identifies a row’s edit and delete controls.",
  "alt": "Tasks page with an inline create form, title and done list columns, and row edit and delete controls",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use the complete Tasks source printed on this page without adding components, actions, filters, or navigation. Check and preview it using the documented local-development prerequisites on an approved documentation instance.",
      "Use a signed-in documentation account with active membership in the current team. Create only synthetic Todo records titled Ship prototype and Review checklist; keep one done value false and the other true. Do not capture real team records, accounts, tokens, or private addresses.",
      "Open the generated root page / titled Tasks. Capture the actual rendered application with its inline Todo.create form, title and done list columns, and edit/delete row controls visible. Do not substitute a generated mockup.",
      "Record the compiler/runtime revision, application-source revision, and capture date in the asset notes. Use a 1280 by 800 viewport and light theme; change the capture environment theme without changing the tutorial source."
    ],
    "edits": [
      "Crop browser chrome and unrelated shell content while retaining the Tasks title, complete inline form, list column labels, and at least one full row with both controls. Preserve actual control labels and values.",
      "Add numbered rectangles: 1 around the inline create form, 2 around the title and done list columns, and 3 around one row’s edit and delete controls. Do not cover labels or depend on color alone.",
      "Verify that the caption and alt text match the real capture and numbered markers. Check readability at narrow article widths; use a tighter crop if needed without losing the form-to-list relationship."
    ]
  }
}
```

```doc-visual
{
  "placeholder": "Open a task’s edit control to see the generated title and done inputs.",
  "caption": "Editing the synthetic Ship prototype task. Marker 1 identifies the title input, marker 2 the done input, and marker 3 the generated update submission control.",
  "alt": "Task update form showing title and done inputs and its submission control",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Run the exact complete Tasks source on this page in a configured approved documentation preview. Use a signed-in account with current team membership and only synthetic Todo records.",
      "At the root Tasks page, open the row edit control for Ship prototype with done=false. Capture the actual generated update form before changing or submitting values; the allowed inputs come from fields=title,done. Preserve its real labels and presentation rather than inventing a panel or control.",
      "Record application-source and compiler/runtime revisions and capture date in the asset notes. Capture at 1280 by 800 in light theme, with the full update form visible. Keep credentials, private URLs, account details, and unrelated records out of the capture."
    ],
    "edits": [
      "Crop to the complete update form, including its heading or record context, title and done inputs, and submission control. Retain enough surrounding page context to connect the form to the selected task.",
      "Add numbered rectangles: 1 at the title input, 2 at the done input, and 3 at the update submission control. Keep real labels unobscured; do not rely on color alone.",
      "Match caption and alt text to the actual capture and markers. Check input-label readability at narrow article widths; do not combine this capture with the overview if that makes either view too small."
    ]
  }
}
```

## Check and preview

Check the source before emitting or previewing it using the commands for your installed CLI in the [CLI reference](../12-Reference/01-cli.md). This is a complete app source example, but local preview still needs the configured runtime and identity context described in [local development](../09-Development/01-local-development.md). To add a business action with its own guard, continue to the [first workflow](04-first-workflow.md).
