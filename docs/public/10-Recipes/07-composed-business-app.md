# Compose a task board and linked notes

Combine two owned packages into one app, reuse an exported task operation from linked notes, and verify navigation, authority and rollback when a joined action is refused.

## Source and prerequisites

Download this complete multi-file example, preserving its directory layout:

```text
team-office/
  Office.can
  packages/
    Tasks.can
    Notes.can
```

The files are [Office.can](../examples/team-office/Office.can), [Tasks.can](../examples/team-office/packages/Tasks.can) and [Notes.can](../examples/team-office/packages/Notes.can). They need the installed toolchain and a test team, with no external provider.

From `team-office/`, check all source owners together:

```sh
can check Office.can packages/Tasks.can packages/Notes.can
can dev ui --source Office.can --app TeamOffice
```

The preview workspace must discover the adjacent package files. Do not paste just the composition declaration into an empty project and expect the package owners to exist.

## Follow ownership through the source

`Office.can` declares TeamTasks using `task_board`, TeamNotes using `team_notes`, and TeamOffice composing both apps. Its compact density context is a shared presentation default, not an access grant.

The notes package imports the task type and completion operation with local aliases:

```can
use task_board {Todo as Task,complete as finish_task}
```

The alias changes source spelling inside notes, not the task's canonical identity. Task records and `complete` remain owned by `task_board`. The notes package cannot reach private declarations merely because both are selected.

## Create a task and resolve its linked note

As a team member, create “Prepare demo” in the task board. Open **Linked notes**, create a note linked to that task, and choose **Resolve**. The notes operation calls the exported completion operation before marking the note resolved:

```can
scenario resolve(note:Note) by=members
 require not note.resolved
 do
  call finish_task {task=note.task}
  set note {resolved=true}
```

Verify that the task is completed and the note resolved. The imported operation performs its own guard checks; the caller does not duplicate task-completion rules in the notes package. The joined local operation uses the owning transaction boundary rather than invoking a remote service.

## Verify refusal and composition boundaries

Create another task and two notes linked to it. Resolve the first, then resolve the second. Task completion now refuses because the task is already done; the second note must remain unresolved. The outer transaction must not partially commit its later note update after the inner call fails. Resolving the already-resolved first note is also refused.

Check both routes in the composed app and confirm the intended membership policies. Test an ungranted identity as well as the happy path. Composition does not bypass read fields or user-operation gates, and aliases do not create extra authority.

This is local composition, not atomic coordination with a remote account system or another physical owner. For remote work use typed durable delivery and reconciliation; a successful first-owner commit cannot be undone merely because a second service times out. See [apps and packages](../02-Language-foundations/04-apps-and-packages.md) and [external integrations](../08-Connect-services/01-contracts-and-service-bindings.md).
