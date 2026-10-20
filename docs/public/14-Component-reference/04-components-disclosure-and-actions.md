# Disclosure and actions

Open task details and canonical operations through scoped disclosure and action controls. Follow concrete trigger, panel and slot examples while preserving record bindings and current permissions.

## Example context

The examples are alternative page-body fragments for the complete [ComponentTasks scaffold](../07-Build-interfaces/02-components-and-layout.md#start-with-a-complete-component-scaffold). Replace that scaffold’s root page body with one fragment at a time; nested forms and collections supply their own scope. Do not paste all alternatives into one form.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `accordion`

Header: `accordion`. Requires a nonempty suite of collapse children only, with one open child.

```can
accordion
 collapse "Task guidance" open=true
  text "Use a specific title."
 collapse "Completion guidance"
  text "Review the work before marking it done."
```

The accordion owns its collapse children and keeps one open; it does not save business state.

### `button`

Header: `button action=operation [arguments={...}] [caption=text]`. Leaf. Exactly one of action=operation, submit=true, target=destination or opens=Name is required. Submit belongs to a canonical form/edit/preferences owner; target is a safe URL or authorized file; opens activates a declared local panel. Missing operation inputs open the canonical input form. A sole nullable file destination that is null or withheld renders a captioned disabled non-submitting button without a URL or file details; malformed values or presenter errors remain failures.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|outline|soft|ghost`.

```can
list Todo
 button action=Todo.update arguments={record=row} caption="Edit task" variant=outline
```

The bound record identifies the update; missing writable arguments open the canonical form.

### `collapse`

Header: `collapse caption [open=bool]`. Requires a nonempty content suite. The compatibility spelling is details caption; details ... display=drawer uses drawer behavior and cannot use open=.

Appearance: `variant=solid`, `caption=text`.

```can
list Todo
 collapse "Task note" open=false
  text row.note
```

The collapsed group retains its current row; opening it is presentation, not a mutation.

### `drawer`

Header: `drawer caption [id=Name]`. Requires its content slot. An explicit trigger or matching external button opens=Name replaces the implicit captioned opener. IDs are local to the lexical page and instantiated per row.

Slots: `slot content` (required, once); `slot trigger` (optional, once); `slot actions` (optional, once).

Appearance: `variant=solid`, `caption=text`.

```can
list Todo
 button opens=TaskPanel caption="Inspect task"
 drawer "Task detail" id=TaskPanel
  slot content
   text row.title,row.note
  slot actions
   primary "Edit task" action=Todo.update arguments={record=row}
```

The external opener targets the local panel instance for this row. Actions retain that same protected record binding.

### `dropdown`

Header: `dropdown`. Requires trigger and content slots. The trigger receives local activation automatically and cannot also submit, navigate or invoke an operation.

Slots: `slot trigger` (required, once); `slot content` (required, once).

```can
dropdown
 slot trigger
  text "Task actions"
 slot content
  button action=Todo.create caption="Add task"
```

The trigger receives local activation automatically; only the content button invokes an operation.

### `fab`

Header: `fab`. Requires a nonempty suite of existing canonical action controls; it defines no batch transaction.

```can
fab
 button action=Todo.create caption="Add task"
 button target="/" caption="Tasks"
```

Each control has its own binding. The group does not run them as a batch.

### `modal`

Header: `modal caption [id=Name]`. Requires its content slot. An explicit trigger or matching external button opens=Name replaces the implicit captioned opener. IDs are local to the lexical page and instantiated per row.

Slots: `slot content` (required, once); `slot trigger` (optional, once); `slot actions` (optional, once).

Appearance: `variant=solid`, `caption=text`.

```can
list Todo
 button opens=TaskPanel caption="Inspect task"
 modal "Task detail" id=TaskPanel
  slot content
   text row.title,row.note
  slot actions
   primary "Edit task" action=Todo.update arguments={record=row}
```

The external opener targets the local panel instance for this row. Actions retain that same protected record binding.

### `tooltip`

Header: `tooltip caption`. Requires a nonempty content suite and accessible alternatives. Priority actions are invalid within tooltip descendants.

Appearance: `tone=primary|secondary|accent|info|success|warning|error`, `variant=solid`, `caption=text`.

```can
tooltip "Opens the canonical task form" tone=info
 button action=Todo.create caption="Add task"
```

The button keeps a useful caption without hover. Priority actions cannot be nested here.
