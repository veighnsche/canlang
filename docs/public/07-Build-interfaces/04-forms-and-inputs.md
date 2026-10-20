# Build task forms and canonical actions

Build forms from owning operations, bind record arguments, choose explicit controls and offer dependent choices. Reuse typed actions and complete invocations while preserving input through refusals and conflicts.

## Start with the complete TaskForms app

`TaskForms` is a separate complete application in the task learning path. It groups tasks by project and completes them with an optional note. It needs the [installed toolchain and a signed-in team member](../01-Get-started/05-first-app.md), with no external service or generation setup.

Save this complete file as `TaskForms.can`, or use the [handbook source file](../examples/task-forms/TaskForms.can). All later excerpts belong to this application; do not append duplicate declarations.

```can
# Edit project tasks through canonical forms and typed actions.
app TaskForms
Given
 Project {name:text trim min=1}
 Todo {project:Project,title:text trim min=1,done:bool=false,note:text?}
 policy Project read=members
 policy Todo read=members
When
 crud Project by=members fields=name delete=none
 crud Todo by=members fields=project,title,note
 scenario tasks_for(project:Project) read=true -> Todo[] by=members
  do return (Todo as task where task.project==project and not task.done)
 scenario complete_task(project:Project,task:Todo choices={read=tasks_for(project=project),labels=["title"]},note:text?=null) by=members
  require task.project==project and not task.done
  do set task {done=true,note}
 scenario complete_from_invocation(task:Todo,note:text?=null) by=members
  do
   let request=invocation(complete_task,{project=task.project,task,note})
   call request {}
Then
 page / title="Task forms"
  form Project.create display=inline
   input name
   primary "Create project" submit=true
  form Todo.create display=inline
   select project
   input title
   textarea note
   primary "Create task" submit=true
  card "Complete a task"
   form complete_task display=inline
    select project
    select task
    textarea note
    primary "Complete task" submit=true
  card "Find open tasks"
   form tasks_for display=inline
    select project
    primary "Find tasks" submit=true
    list result columns=title,note
     pagination
  list Project as project
   text project.name
   form Todo.create arguments={project=project} fields=title,note display=inline
    input title
    textarea note
    primary "Add task to this project" submit=true
 page /tasks title="Edit and complete tasks"
  list Todo as task columns=title,done,note
   card "Task controls"
    text task.title,task.done
    primary "Edit task" action=Todo.update arguments={record=task} fields=title,note
    secondary "Archive task" action=Todo.delete arguments={record=task}
   card "Typed completion form"
    form action(complete_task,{project=task.project,task=task}) display=inline
     textarea note
     primary "Complete with note" submit=true
   card "Complete invocation"
    form complete_from_invocation arguments={task=task} display=inline
     textarea note
     primary "Submit complete call" submit=true
   pagination
```

From the file's directory, run:

```sh
can check TaskForms.can
can dev ui --root . --source TaskForms.can --app TaskForms
```

Enter `check` in the preview terminal, wait for the serving revision, then use `open`. Sign in and select a team. Create two projects, `Release` and `Support`, and at least one task in each before trying dependent choices.

## Bind to an owner

A form names a canonical CRUD operation or scenario. Its inputs, defaults, normalization, bounds and permission rules come from that owner; the UI does not declare a second request schema. `edit` uses the current record's canonical update operation.

In the nested project list, this form binds the project and leaves only title and note editable:

```can
form Todo.create arguments={project=project} fields=title,note display=inline
 input title
 textarea note
 primary "Add task to this project" submit=true
```

The outer `Project as project` alias supplies an existing readable record. Its protected identity and expected version travel through the canonical binding. The form does not ask the user to reselect it or infer it from a label.

Record parameters can auto-bind when exactly one compatible record exists in the enclosing chain. Use `arguments={parameter=expression}` when there are multiple candidates or the intended binding needs to be explicit. In `/tasks`, `arguments={record=task}` selects the record for `Todo.update`; `record` is that CRUD operation's parameter name.

`fields=` may omit only bound, defaulted or optional inputs. The create form cannot omit the required unbound title. Update forms can choose a writable subset: omitting project from the title/note edit is an omitted patch, not a null assignment or relationship reset. Server-owned and protected metadata never become writable inputs.

## Infer inputs or place them explicitly

The minimal `form Todo.create` derives all eligible inputs. `display=inline` places them in the page; a canonical operation action can open the shared input dialog. Explicit controls position the same inferred fields rather than redefining their types.

| Control in TaskForms | Owning type | Behavior |
| --- | --- | --- |
| `input title` | Trimmed nonempty text | Collects text; owner normalization and bounds still run |
| `textarea note` | Nullable text | Provides a multiline editor for the same optional input |
| `select project` | Project reference | Uses bounded authorized record lookup |
| `select task` | Todo reference with `choices=` | Uses the operation's declared dependent read |
| `primary ... submit=true` | Owning form submission | Submits this canonical operation |

Unplaced eligible inputs render in schema order, so adding one explicit input does not silently discard the rest. A field gets at most one writable control. Labels derive from its schema; explicit placement does not create new business fields. The optional completion note defaults to null, and completion sets `note` to that value: omitting it deliberately clears any old note rather than preserving it.

Other types require suitable controls: checkbox/toggle for booleans, constrained finite choices for radio/select, and file inputs for the real upload/finalize/attach flow. An arbitrary URL cannot substitute for a file reference. See [input controls](../14-Component-reference/03-components-inputs.md) for exact forms and [data defaults](../04-Model-and-query-data/02-defaults-and-validation.md) for omission versus null.

## Offer dependent choices without weakening the guard

The owning scenario parameter declares its assistance, not the page:

```can
scenario tasks_for(project:Project) read=true -> Todo[] by=members
 do return (Todo as task where task.project==project and not task.done)
scenario complete_task(project:Project,task:Todo choices={read=tasks_for(project=project),labels=["title"]},note:text?=null) by=members
 require task.project==project and not task.done
 do set task {done=true,note}
```

Choose Release in the completion form. The task lookup calls `tasks_for` using that current draft project and offers readable unfinished tasks in Release. Change to Support: the choices must follow Support, without applying a late response for Release or silently replacing a selected task with a same-named record. Missing prerequisites, empty eligible results and lookup failure are distinct states.

`labels=["title"]` names declared fields for candidate presentation. With no `value=`, the candidate value is the entire typed Todo reference. A `value="field"` mapping instead extracts a declared field of the assisted parameter's type. Labels must remain readable; choices do not grant a directory or enrich private fields.

The choice read must return a nonnullable one-dimensional stored-model collection. Its mappings use typed input roots and stable declared paths. Self-dependencies, cycles, ambient values and executable mapping expressions are invalid. The metadata does not run a read merely because an operation is declared or invoked, and it does not change defaults or final inputs.

The server guard independently checks both the project relationship and unfinished state. Even a previously offered task can become ineligible before submission. A caller bypassing the picker must still satisfy the same guard. The choices are guidance, not a second authorization policy.

## Render a pure read result inside its form

```can
form tasks_for display=inline
 select project
 primary "Find tasks" submit=true
 list result columns=title,note
  pagination
```

This form submits the pure `tasks_for` operation and renders its typed `Todo[]` result. It changes no task. `result` is available only to that form's descendants; siblings cannot read it. A result collection establishes its own row scope, so its children are result presentation rather than more controls for the outer form.

Changing the project input does not itself submit the read form. After Find tasks, verify the result matches the accepted project. An empty authorized result is valid; read failure must display failure rather than an empty success. Page-level `data=` has a different result scope, described in [pages](01-pages-and-navigation.md#load-a-scalar-route-through-a-pure-read).

## Place primary and secondary actions with their owner

On `/tasks`, the card declares independent task actions:

```can
card "Task controls"
 text task.title,task.done
 primary "Edit task" action=Todo.update arguments={record=task} fields=title,note
 secondary "Archive task" action=Todo.delete arguments={record=task}
```

The card owns their presentation: primary in its footer, secondary in its heading menu. A page owns a heading toolbar/menu; a list or table row owns its trailing action area. Split details use the selected record's panel footer/menu. The binding, record version, permissions and archive confirmation remain canonical.

Inside a form or `edit`, the primary is a direct `submit=true` child, outside fieldsets. It submits that owner only. Secondary actions and independent operations, links or panel openers cannot be nested inside a form, even through a visual wrapper. Keep Archive outside the edit form. A dialog's standard Cancel is supplied by the shared dialog behavior; inline forms retain their submit behavior.

Action captions are explicit and localizable. A visual primary is not privileged authority, and a secondary menu entry is not a weaker operation. Each has exactly one checked binding; no raw callback or endpoint is introduced.

## Bind a typed action and collect its remaining inputs

```can
form action(complete_task,{project=task.project,task=task}) display=inline
 textarea note
 primary "Complete with note" submit=true
```

This is the typed completion form within `list Todo as task`. `action(...)` constructs a reference without executing it. It binds **every record parameter**, including project and task, with protected identities and expected versions. The remaining non-record `note` becomes the input derived from `complete_task`.

A typed action is not arbitrary partial application. It cannot prefill unrelated scalar inputs, accept a target string, or modify its bound record identities. The operation still checks current authority, versions and its business guard at submission. A form over a stored nullable action similarly has no submit control when the reference is null, expired or invalidated.

For a closed type admitting several operations, declare `action(OperationA,OperationB)` using enabled canonical user mutations. Their actual signatures determine the possible forms; trusted handlers and pure reads are not action targets. Remote bound actions have separate sealed authority and asynchronous receipt rules; see [actions and invocations](../06-Business-workflows/05-actions-and-invocations.md).

## Execute a complete typed invocation

The final form calls this ordinary scenario from the complete app:

```can
scenario complete_from_invocation(task:Todo,note:text?=null) by=members
 do
  let request=invocation(complete_task,{project=task.project,task,note})
  call request {}
```

`invocation(...)` supplies the complete owning input object, including note. `call request {}` adds no replacement arguments: the call value already contains them. It is immutable typed data, not executable text, consent or a grant. This deterministic wrapper demonstrates a local invocation under the actual submitting member's authority.

The callee still checks membership, task/project identity, versions and unfinished state. A failure rolls back the local transaction. For externally proposed calls, disclose the exact operation, arguments and protected versions to the authorized reviewer before explicit execution; do not treat an AI suggestion as consent or allow it to mint protected references.

## Submission outcomes

| Outcome | What the user should do | What the form must preserve |
| --- | --- | --- |
| Invalid input or a confirmed business refusal | Correct the input or resolve the stated business condition | Editable input and safe field/operation feedback |
| Version conflict | Compare with current authorized data, refresh the binding and deliberately submit a reviewed attempt | Draft values, conflict feedback and focus; never silently overwrite the draft |
| Membership or permission revoked | Reauthenticate or obtain the required access | No revoked private values merely to retain a draft |
| Transport failure with unknown commit status | Resolve/replay the original request identity | The original identity and protected proof, not a speculative new operation |
| Confirmed success | Inspect the authorized result and refreshed read regions | Unrelated still-authorized unsaved controls and focus |

A confirmed rejected receipt remains immutable. Corrected input is a new attempt: a replacement identity/proof can be issued only after confirming the rejected outcome and rechecking its protection. A conflict's stale version is not automatically overwritten just because a retry button exists. Unknown transport/storage/post-commit failure is different: retain the original identity for safe replay until the outcome is known.

Do not invisibly repeat a non-idempotent mutation under a fresh identity. Authentication expiry requires full navigation. Validation feedback belongs beside the appropriate controls, and a successful refresh must still apply current field grants. See [transactions and replay](../06-Business-workflows/03-transactions-and-concurrency.md).

```doc-visual
{
  "placeholder": "Compare your preserved form input with current values when a submission reports a conflict.",
  "caption": "A sample record edit after a version conflict: marker 1 identifies preserved editable input; marker 2 identifies the conflict message and authorized current values.",
  "alt": "Record edit form with preserved input and a conflict message comparing current field values",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use an approved documentation app with an existing editable sample record and a documentation account authorized to read and update it. Open its declared record page and canonical edit form; obtain the actual address from the operator rather than inventing a route.",
      "Use synthetic text only: begin editing a text field to Draft note in one browser session, update that same sample record to Current note in a second authorized session, then submit the first edit to produce a real version conflict. Retain its editable input, the conflict message, current-value table and submit control in the capture. Do not add a visible version field when the actual form carries it only as hidden metadata.",
      "Record the captured application and runtime revisions and capture date in the asset notes; do not include credentials, private addresses, session tokens or real personal data.",
      "Capture at 1280 by 800 with English interface text and the light theme. Use a focused crop so essential labels remain readable at narrow article widths."
    ],
    "edits": [
      "Crop browser chrome, account details and unrelated records while keeping the form heading, edited field, conflict message, current-value table and submit control visible.",
      "Add marker 1 beside the preserved editable field and marker 2 beside the conflict message and current-value table. Do not cover labels or change interface text; these are the only numbered annotations.",
      "Use the caption to explain markers 1 and 2, and verify the alt text against the final capture."
    ]
  }
}
```


## Verify allowed, refused and conflicting submissions

1. Create Release and Support projects, then add one task under each nested project form. Confirm the bound project is correct without re-entering it.
2. In Complete a task, switch between the projects and inspect their available tasks. Complete Release's task with a note; confirm only that task changes and its note is saved.
3. Try that task's typed completion form again. The owner refuses an already-completed task; showing the form never grants permission to complete twice.
4. Use Find tasks for Release. Confirm the completed task is absent and Support's task is not leaked into the result.
5. Complete Support's task through Submit complete call. Confirm the invocation follows the same guard and result behavior as direct completion.
6. Open the same task edit in two authorized sessions. Save a different title in the second, then submit the first draft. Confirm conflict feedback preserves the first draft and shows only currently authorized comparison values. Review before making a new attempt.
7. Use Archive task and its canonical confirmation on a disposable task. Confirm cancellation leaves it unchanged and accepted archive follows the owner's lifecycle.
