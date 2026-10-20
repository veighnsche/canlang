# Inputs

Bind explicit controls to canonical task inputs without copying their schema. These examples show field placement, finite choices, bounded values, validation outlets and shared appearance settings.

## Example context

The examples are alternative page-body fragments for the complete [ComponentTasks scaffold](../07-Build-interfaces/02-components-and-layout.md#start-with-a-complete-component-scaffold). Replace that scaffold’s root page body with one fragment at a time; nested forms and collections supply their own scope. Do not paste all alternatives into one form.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `calendar`

Headers: `calendar selector` or `calendar query start=field end=field`. A selector without endpoints is a date-input leaf within a field owner. Both endpoints select an agenda collection; one endpoint is invalid. Agenda options are columns, order, search, filter, empty and defaults with the same meanings as list. No drag/resize or inferred month-grid engine.

```can
form Todo.create display=inline
 calendar due
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `checkbox`

Header: `checkbox selector`. Field-placement leaf for bool. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
form Todo.create display=inline
 checkbox done size=sm
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `fieldset`

Header: `fieldset [caption]`. Requires a nonempty grouping suite within a canonical form/edit/preferences field owner; it defines no schema.

Appearance: `variant=solid`, `caption=text`.

```can
form Todo.create display=inline
 fieldset "Task wording"
  input title
  textarea note
 primary "Create task" submit=true
```

The group adds no fields. The submit belongs directly to the form, outside the fieldset.

### `file_input`

Header: `file_input selector`. Field-placement leaf for file with authorized upload and finalization. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

```can
form Todo.create display=inline
 file_input image
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `filter`

Header: `filter selector`. Leaf selecting a finite-choice input in a field owner, or an owned finite-choice view preference through its self-only save path. It cannot invent a query predicate.

```can
form Todo.create display=inline
 filter priority
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `input`

Header: `input selector`. Field-placement leaf for writable text or suitable scalar. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

```can
form Todo.create display=inline
 input title size=sm
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `label`

Header: `label selector [caption=text]`. Field-placement leaf moving the owning input’s label; at most one explicit label per field.

Appearance: `variant=solid`.

```can
form Todo.create display=inline
 label title caption="Task title"
 input title
```

The explicit label moves/captions the existing title input without copying its schema.

### `otp`

Header: `otp selector`. Field-placement leaf for constrained text, preserving leading zeros. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
form Todo.create display=inline
 otp code
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `radio`

Header: `radio selector`. Field-placement leaf for finite choices. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
form Todo.create display=inline
 radio priority size=sm
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `range`

Header: `range selector`. Field-placement leaf for finite numeric bounds or finite ordered choices. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`, `orientation=vertical`.

```can
form Todo.create display=inline
 range score orientation=vertical
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `rating`

Header: `rating selector`. Field-placement leaf for finite numeric bounds or finite ordered choices. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
form Todo.create display=inline
 rating score size=sm
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `select`

Header: `select selector`. Field-placement leaf for finite choices or authorized reference lookup. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

```can
form Todo.create display=inline
 select priority size=sm
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `textarea`

Header: `textarea selector`. Field-placement leaf for text. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

```can
form Todo.create display=inline
 textarea note variant=ghost
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `theme_controller`

Header: `theme_controller`. Shared Appearance leaf with finite theme choices and persisted viewer preference.

```can
theme_controller
```

This consumes shared Appearance settings rather than declaring a second theme preference.

### `toggle`

Header: `toggle selector`. Field-placement leaf for bool. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
form Todo.create display=inline
 toggle done size=sm
```

The control binds the scaffold’s existing input; unplaced inputs still render. Use this as an alternative to another control for the same field, not alongside it.

### `validator`

Header: `validator selector`. Field-placement leaf moving the owning input’s validation outlet; at most one per field. It adds no constraints.

```can
form Todo.create display=inline
 input title
 validator title
```

The outlet presents the title’s owning validation errors; min=1 remains a model/input constraint.
