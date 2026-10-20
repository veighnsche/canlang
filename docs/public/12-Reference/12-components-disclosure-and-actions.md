# Disclosure and actions

Disclosure components reveal scoped content; action components present canonical checked operations. Neither creates new authority.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `accordion`

Header: `accordion`. Requires a nonempty suite of collapse children only, with one open child.

### `button`

Header: `button action=operation [arguments={...}] [caption=text]`. Leaf. Exactly one of action=operation, submit=true, target=destination or opens=Name is required. Submit belongs to a canonical form/edit/preferences owner; target is a safe URL or authorized file; opens activates a declared local panel. Missing operation inputs open the canonical input form. A sole nullable file destination that is null or withheld renders a captioned disabled non-submitting button without a URL or file details; malformed values or presenter errors remain failures.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|outline|soft|ghost`.

### `collapse`

Header: `collapse caption [open=bool]`. Requires a nonempty content suite. The compatibility spelling is details caption; details ... display=drawer uses drawer behavior and cannot use open=.

Appearance: `variant=solid`, `caption=text`.

### `drawer`

Header: `drawer caption [id=Name]`. Requires its content slot. An explicit trigger or matching external button opens=Name replaces the implicit captioned opener. IDs are local to the lexical page and instantiated per row.

Slots: `slot content` (required, once); `slot trigger` (optional, once); `slot actions` (optional, once).

Appearance: `variant=solid`, `caption=text`.

### `dropdown`

Header: `dropdown`. Requires trigger and content slots. The trigger receives local activation automatically and cannot also submit, navigate or invoke an operation.

Slots: `slot trigger` (required, once); `slot content` (required, once).

### `fab`

Header: `fab`. Requires a nonempty suite of existing canonical action controls; it defines no batch transaction.

### `modal`

Header: `modal caption [id=Name]`. Requires its content slot. An explicit trigger or matching external button opens=Name replaces the implicit captioned opener. IDs are local to the lexical page and instantiated per row.

Slots: `slot content` (required, once); `slot trigger` (optional, once); `slot actions` (optional, once).

Appearance: `variant=solid`, `caption=text`.

### `tooltip`

Header: `tooltip caption`. Requires a nonempty content suite and accessible alternatives. Priority actions are invalid within tooltip descendants.

Appearance: `tone=primary|secondary|accent|info|success|warning|error`, `variant=solid`, `caption=text`.
