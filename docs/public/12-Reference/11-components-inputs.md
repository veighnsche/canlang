# Inputs

Input components bind an existing typed field or view setting; the owning operation remains responsible for validation and authorization.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `calendar`

Headers: `calendar selector` or `calendar query start=field end=field`. A selector without endpoints is a date-input leaf within a field owner. Both endpoints select an agenda collection; one endpoint is invalid. Agenda options are columns, order, search, filter, empty and defaults with the same meanings as list. No drag/resize or inferred month-grid engine.

### `checkbox`

Header: `checkbox selector`. Field-placement leaf for bool. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

### `fieldset`

Header: `fieldset [caption]`. Requires a nonempty grouping suite within a canonical form/edit/preferences field owner; it defines no schema.

Appearance: `variant=solid`, `caption=text`.

### `file_input`

Header: `file_input selector`. Field-placement leaf for file with authorized upload and finalization. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

### `filter`

Header: `filter selector`. Leaf selecting a finite-choice input in a field owner, or an owned finite-choice view preference through its self-only save path. It cannot invent a query predicate.

### `input`

Header: `input selector`. Field-placement leaf for writable text or suitable scalar. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

### `label`

Header: `label selector [caption=text]`. Field-placement leaf moving the owning input’s label; at most one explicit label per field.

Appearance: `variant=solid`.

### `otp`

Header: `otp selector`. Field-placement leaf for constrained text, preserving leading zeros. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

### `radio`

Header: `radio selector`. Field-placement leaf for finite choices. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

### `range`

Header: `range selector`. Field-placement leaf for finite numeric bounds or finite ordered choices. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`, `orientation=vertical`.

### `rating`

Header: `rating selector`. Field-placement leaf for finite numeric bounds or finite ordered choices. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

### `select`

Header: `select selector`. Field-placement leaf for finite choices or authorized reference lookup. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

### `textarea`

Header: `textarea selector`. Field-placement leaf for text. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|ghost`.

### `theme_controller`

Header: `theme_controller`. Shared Appearance leaf with finite theme choices and persisted viewer preference.

### `toggle`

Header: `toggle selector`. Field-placement leaf for bool. It binds an existing eligible input in its nearest canonical form/edit/preferences owner and cannot copy or redefine its schema.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`.

### `validator`

Header: `validator selector`. Field-placement leaf moving the owning input’s validation outlet; at most one per field. It adds no constraints.
