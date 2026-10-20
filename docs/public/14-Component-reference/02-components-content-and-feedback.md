# Content and feedback

Display task values, progress and feedback with concise examples of readable bindings and named slots. Distinguish illustrative presentation from confirmed outcomes, business actions and real runtime state.

## Example context

The examples are alternative page-body fragments for the complete [ComponentTasks scaffold](../07-Build-interfaces/02-components-and-layout.md#start-with-a-complete-component-scaffold). Replace that scaffold’s root page body with one fragment at a time; nested forms and collections supply their own scope. Do not paste all alternatives into one form.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `alert`

Header: `alert [notice]`. Expression-only leaf, or a nonempty readable-content suite. Business invocation and activation children are invalid.

Appearance: `tone=info|success|warning|error`, `variant=solid|outline|soft`, `orientation=horizontal|vertical`.

```can
alert "Review the task before saving." tone=warning variant=soft
```

A notice displays authored guidance; it does not assert that a business check succeeded.

### `aura`

Header: `aura`. Requires a nonempty scope-transparent content suite; it adds presentation only.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
aura size=sm
 text "Task workspace"
```

The wrapper changes presentation only; no data or operation owner changes.

### `badge`

Header: `badge value`. Leaf displaying a readable typed value.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|outline|soft|ghost`, `caption=text`.

```can
list Todo
 badge row.priority variant=outline size=sm
```

The badge displays the typed enum with a text label, not color alone.

### `chat_bubble`

Header: `chat_bubble`. Requires its named-slot suite; it performs no automatic business comparison, state transition or messaging.

Slots: `slot content` (required, once); `slot avatar` (optional, once); `slot header` (optional, once); `slot footer` (optional, once).

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`.

```can
chat_bubble
 slot header
  text "Example discussion"
 slot content
  text "Please review the task title."
 slot footer
  text "Illustrative message"
```

This is authored sample content; rendering a bubble neither sends a message nor declares a conversation service.

### `countdown`

Header: `countdown value`. Leaf displaying a numeric or duration value; it does not schedule work.

Appearance: `variant=solid`, `caption=text`.

```can
countdown 5m caption="Example remaining time"
```

This displays a supplied duration. It does not start a business timer or schedule a callback.

### `diff`

Header: `diff`. Requires its named-slot suite; it performs no automatic business comparison, state transition or messaging.

Slots: `slot before` (required, once); `slot after` (required, once).

```can
diff
 slot before
  text "Draft task title"
 slot after
  text "Reviewed task title"
```

Both sides are explicitly supplied illustrative values; the component does not calculate a change or approve it.

### `hover_3d`

Header: `hover_3d`. Requires a nonempty content suite; interactive descendants are invalid.

```can
hover_3d
 text "Task workspace preview"
```

Keep this surface noninteractive; edit buttons belong outside it.

### `indicator`

Header: `indicator`. Requires its named-slot suite; it performs no automatic business comparison, state transition or messaging.

Slots: `slot content` (required, once); `slot indicator` (required, once).

```can
indicator
 slot content
  text "Readable tasks"
 slot indicator
  badge count(Todo)
```

The marker is an authorized count attached to its labeled content.

### `kbd`

Header: `kbd text`. Leaf displaying escaped shortcut notation; it registers no keyboard handler.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
kbd "Ctrl + K" size=sm
```

This displays shortcut notation only. Do not imply that this app registers the shortcut.

### `loading`

Header: `loading [state]`. Leaf; omission is an authored placeholder. It does not infer provider state.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
loading size=sm
```

This is an authored loading placeholder; use it only in a region whose actual loading state warrants it.

### `mask`

Header: `mask`. Requires a nonempty scope-transparent content suite; it adds presentation only.

```can
list Photo
 mask
  avatar row.image caption=row.title
```

The mask wraps an authorized image presentation; it cannot hide missing file permission.

### `mockup_browser`

Header: `mockup_browser`. Requires a nonempty scope-transparent content suite; it adds presentation only.

```can
mockup_browser
 text "Illustrative task preview"
```

This is a presentation mockup, not a captured interface, embedded browser or separate application runtime.

### `mockup_code`

Header: `mockup_code text`. Leaf displaying escaped text; it executes no code.

```can
mockup_code "can check ComponentTasks.can"
```

The command is escaped display text; it is not executed.

### `mockup_phone`

Header: `mockup_phone`. Requires a nonempty scope-transparent content suite; it adds presentation only.

```can
mockup_phone
 text "Illustrative task preview"
```

This is a presentation mockup, not a captured interface, embedded browser or separate application runtime.

### `mockup_window`

Header: `mockup_window`. Requires a nonempty scope-transparent content suite; it adds presentation only.

```can
mockup_window
 text "Illustrative task preview"
```

This is a presentation mockup, not a captured interface, embedded browser or separate application runtime.

### `progress`

Header: `progress value max=bound`. Leaf with a required compatible numeric maximum.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`, `caption=text`.

```can
card "Completion"
 require count(Todo)>0
 progress count(Todo as task where task.done) max=count(Todo) caption="Completed tasks"
```

Use only when the total is positive; an empty dataset needs an empty state instead of a zero maximum.

### `radial_progress`

Header: `radial_progress value max=bound`. Leaf with a required compatible numeric maximum.

Appearance: `variant=solid`, `caption=text`.

```can
radial_progress 3 max=5 caption="Example review score"
```

The value and maximum share a numeric domain. This illustrative score does not update a record.

### `skeleton`

Header: `skeleton [state]`. Leaf; omission is an authored placeholder. It does not infer provider state.

```can
skeleton
```

This is a placeholder for a known loading region, not automatic provider-status detection.

### `stat`

Headers: `stat observations` or the slotted form `stat`. A typed metric leaf, or a named-slot suite with required value slot. The slotted form has no positional value.

Slots: `slot value` (required, once); `slot title` (optional, once); `slot description` (optional, once); `slot icon` (optional, once).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

```can
stat
 slot title
  text "Readable tasks"
 slot value
  text count(Todo)
 slot description
  text "Current authorized collection"
```

The value slot receives an authorized metric; no extra counting permission comes from the component.

### `status`

Header: `status value`. Leaf displaying explicit state with a text alternative.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`, `caption=text`.

```can
list Todo
 status row.done caption="Completion"
```

The readable boolean retains a text alternative; the indicator does not complete the task.

### `steps`

Header: `steps [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked.

Slots: `slot item` (required, repeatable).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

A container `tone=` is rejected; step tones belong to the item presentation contract and are not arbitrary attributes on `slot item`.

```can
steps
 slot item
  text "Draft"
 slot item
  text "Review"
```

These are two explicit presentation items, not a state machine. A query form instead repeats one item template for each admitted row.

### `swap`

Header: `swap [value]`. Requires off/on slots. A supplied value is a readable bool or owned bool preference; omitted selection is transient view state.

Slots: `slot off` (required, once); `slot on` (required, once).

```can
list Todo
 swap row.done
  slot off
   text "Open task"
  slot on
   text "Finished task"
```

The business boolean selects display only. It cannot be toggled through this swap.

### `text_rotate`

Header: `text_rotate [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked. At most six items; reduced-motion behavior applies.

Slots: `slot item` (required, repeatable).

```can
text_rotate
 slot item
  text "Draft"
 slot item
  text "Review"
```

These are two explicit presentation items, not a state machine. A query form instead repeats one item template for each admitted row.

### `timeline`

Header: `timeline [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked.

Slots: `slot item` (required, repeatable).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

```can
timeline
 slot item
  text "Draft"
 slot item
  text "Review"
```

These are two explicit presentation items, not a state machine. A query form instead repeats one item template for each admitted row.

### `toast`

Header: `toast [notice]`. Expression-only leaf, or a nonempty readable-content suite. Business invocation and activation children are invalid.

```can
toast "Example: task changes are being reviewed."
```

This authored notice is not a success receipt; show success wording only from a confirmed outcome.
