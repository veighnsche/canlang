# Build your first Tasks app

Install CanLang, write a complete Tasks app, and open its local preview. Sign in, choose a team, then create, edit and archive tasks while checking the results against your source.

## Install the toolchain

Use a terminal on macOS Apple Silicon or Linux x86-64 with glibc. You need `curl`, Bash and a text editor. The standalone distribution includes the compiler and preview runtime; you do not need a repository checkout or separate Rust, Node, Bun or npm installation. See [installation](03-installation.md) for platform requirements and selecting a release.

Run the installer in your terminal:

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

Open a new terminal so the updated PATH takes effect, then check that the command is available:

```sh
can --version
```

The command prints the installed toolchain version. This tutorial uses local preview accounts and task data; it needs no external service binding or generation provider.

## Declare the Tasks app

Create a folder for this application and enter it. Run the remaining shell commands from this folder:

```sh
mkdir can-tasks
cd can-tasks
```

In your text editor, create `Tasks.can` inside `can-tasks` and paste the entire listing below. Save it as plain text, retaining its indentation. This is a complete application, not a fragment to insert into another project.

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

`app Tasks` gives the application its identity. The three sections describe the data, allowed changes and interface:

| Declaration | What it gives you |
| --- | --- |
| `Todo { title:text trim, done:bool=false }` | Stored tasks with trimmed titles and an initial `done` value of `false` |
| `policy Todo read=members` | Current team members can read that team's tasks and ordinary fields |
| `crud Todo by=members fields=title,done` | Member-only create, update and archive-delete operations; only `title` and `done` are writable |
| `page / title="Tasks"` | The application's root page |
| `form Todo.create display=inline` | An inline creation form derived from the create operation |
| `list Todo columns=title,done` | An authorized list with title and done columns |
| `edit` and `delete` | Row controls for updating and archiving a task |

These permissions apply to operations and reads, including requests made outside the page. Hiding a button does not grant or remove authority, and extra submitted fields cannot bypass the mutation allowlist. See [models](../04-Model-and-query-data/01-models-and-relationships.md) and [operation permissions](../05-Permissions-and-policy/03-roles-and-operation-permissions.md) for the full rules.

## Check and preview

Check the saved source from the application folder:

```sh
can check Tasks.can
```

A successful check exits without source errors. If a diagnostic names a line in `Tasks.can`, correct that line, save the file and run the same command again. Checking source does not start a browser session.

Start the interactive development terminal for this source and app:

```sh
can dev ui --source Tasks.can --app Tasks
```

Keep this terminal running. At its control prompt, type `check` and press Enter. Manual checking is the default; this requests the build that the preview will serve. Wait until the terminal reports a serving preview for the checked source revision. Enter `status` to inspect progress or `details` to read diagnostics.

The controls `check`, `status`, `details` and `open` below are entered in the running development terminal, not as separate shell commands.

## Obtain access and sign in

### Open the private preview

1. Enter `open` in the development terminal. It prints a private preview access URL and local actor credentials.
2. Open that exact URL in your browser promptly. The access link is single-use and expires after 30 seconds; enter `open` again if you need a fresh link. The ordinary preview origin shown in status does not supply this access.

The access link and actor credentials are private. Do not include them in screenshots or shared logs. Preview access opens the local environment; sign-in and team selection establish the actor and membership used by the app's policies.

### Sign in and select a team

1. At sign-in, enter the email and password printed for one local actor, then submit the sign-in form. A local actor is a preview account you can use to exercise the app's permissions.
2. Select a team available to that actor. Keep this actor and team selected throughout the tutorial so you are viewing the same team's records.
3. Open the application's root page, titled **Tasks**. You should see the creation form and task list, with `title` and `done` columns.

Use the credentials returned by your session rather than inventing an account or using production credentials. Selecting the team establishes which team's tasks the `members` policy permits you to read and change.

## Recognize the generated page

Create two records so you can verify each operation independently:

1. In the inline creation form, enter `Ship prototype` for `title`, leave `done` false, and submit the form.
2. Confirm that `Ship prototype` appears in the list with `done` false.
3. Create another task named `Review checklist`, also with `done` false. Confirm that both tasks appear.

The form invokes `Todo.create`; the list reads the permitted records for your selected team. You did not write a separate database endpoint or page handler for either step.

```doc-visual
{
  "placeholder": "Preview the Tasks page with its inline creation form, task list, and row controls.",
  "caption": "The generated Tasks page with synthetic tasks. Marker 1 identifies the inline Todo.create form; marker 2 identifies the title and done columns; marker 3 identifies a row’s edit and delete controls.",
  "alt": "Tasks page with an inline create form, title and done list columns, and row edit and delete controls",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use the complete Tasks source printed on this page without adding components, actions, filters, or navigation. Check and preview it using the documented local-development prerequisites on an approved documentation instance.",
      "Use a signed-in documentation account with active membership in the current team. Create only synthetic Todo records titled Ship prototype and Review checklist; keep both done values false. Do not capture real team records, accounts, tokens, or private addresses.",
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

## Edit a task

1. Open the row edit control for `Ship prototype`.
2. Change its title to `Ship Tasks prototype` and set `done` to true.
3. Submit the update form.
4. Confirm the list now shows `Ship Tasks prototype` as done and still shows `Review checklist` as not done.

The update changes the selected record. The allowed fields come from `fields=title,done`; completing one task does not modify the other.

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

## Archive a task

Use the delete control on the `Review checklist` row and complete any confirmation shown. Verify that the row disappears from the ordinary task list while `Ship Tasks prototype` remains.

The default CRUD delete operation archives the record. It does not permanently erase it. See [CRUD and deletion](../06-Business-workflows/01-crud-and-record-lifecycle.md) for the lifecycle and its effect on queries.

## Verify the result

Reload the browser page while keeping the same preview, actor and team. Check these outcomes:

| Action | Expected result after reload |
| --- | --- |
| Edit `Ship prototype` | The remaining task is titled `Ship Tasks prototype` and has `done` true |
| Archive `Review checklist` | The archived task is absent from the ordinary list |
| Reload the page | The saved update and archive remain effective |

If you began with an empty list, exactly one task remains visible. If the selected team already had tasks, those other records should be unchanged.

These checks exercise storage and the generated interface together. `can check` validates source; using the app verifies the user journey. This member session does not by itself test denied access; the [first workflow](07-first-workflow.md) introduces explicit success and failure examples.

## Resolve common setup problems

| Symptom | What to check |
| --- | --- |
| The shell cannot find `can` | Open a new terminal after installation and retry `can --version`; see [installation](03-installation.md). |
| `Tasks.can` cannot be found | Run the command from `can-tasks` and verify the saved filename, including capitalization and the `.can` extension. |
| The preview is unavailable | Enter `check`, wait for completion, and use `details` for diagnostics. Correct the source, save and check again. |
| An access link is rejected | Enter `open` for a fresh private link and open it promptly. Do not reuse an expired or consumed link. |
| Sign-in fails | Use an actor's email and password from this session's `open` output. |
| Expected tasks are missing | Confirm you selected the same actor, team and preview; an archived task is excluded from the ordinary list. |
| A source edit is not visible | Save it and enter `check`. Confirm the serving revision advances; a failed check leaves the last valid preview identifiable. |

For session selection and deeper diagnostics, see [local development](06-local-development.md).

## Stop the preview and add a workflow

Enter `stop` in the development terminal that owns this session. Wait for it to report that resources have been released. An attached terminal can leave with `detach`; it cannot stop another terminal's owner.

You now have a complete application with stored records, team permissions and a generated interface. Continue to [your first workflow](07-first-workflow.md) to replace the direct done-field edit with an explicit guarded completion operation, or choose another branch in the [example progression](02-example-progression.md).
