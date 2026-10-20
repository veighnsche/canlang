# Content and feedback

Content components display readable values, state and feedback. They do not perform the business action suggested by their appearance.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `alert`

Header: `alert [notice]`. Expression-only leaf, or a nonempty readable-content suite. Business invocation and activation children are invalid.

Appearance: `tone=info|success|warning|error`, `variant=solid|outline|soft`, `orientation=horizontal|vertical`.

### `aura`

Header: `aura`. Requires a nonempty scope-transparent content suite; it adds presentation only.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

### `badge`

Header: `badge value`. Leaf displaying a readable typed value.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|outline|soft|ghost`, `caption=text`.

### `chat_bubble`

Header: `chat_bubble`. Requires its named-slot suite; it performs no automatic business comparison, state transition or messaging.

Slots: `slot content` (required, once); `slot avatar` (optional, once); `slot header` (optional, once); `slot footer` (optional, once).

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`.

### `countdown`

Header: `countdown value`. Leaf displaying a numeric or duration value; it does not schedule work.

Appearance: `variant=solid`, `caption=text`.

### `diff`

Header: `diff`. Requires its named-slot suite; it performs no automatic business comparison, state transition or messaging.

Slots: `slot before` (required, once); `slot after` (required, once).

### `hover_3d`

Header: `hover_3d`. Requires a nonempty content suite; interactive descendants are invalid.

### `indicator`

Header: `indicator`. Requires its named-slot suite; it performs no automatic business comparison, state transition or messaging.

Slots: `slot content` (required, once); `slot indicator` (required, once).

### `kbd`

Header: `kbd text`. Leaf displaying escaped shortcut notation; it registers no keyboard handler.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

### `loading`

Header: `loading [state]`. Leaf; omission is an authored placeholder. It does not infer provider state.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

### `mask`

Header: `mask`. Requires a nonempty scope-transparent content suite; it adds presentation only.

### `mockup_browser`

Header: `mockup_browser`. Requires a nonempty scope-transparent content suite; it adds presentation only.

### `mockup_code`

Header: `mockup_code text`. Leaf displaying escaped text; it executes no code.

### `mockup_phone`

Header: `mockup_phone`. Requires a nonempty scope-transparent content suite; it adds presentation only.

### `mockup_window`

Header: `mockup_window`. Requires a nonempty scope-transparent content suite; it adds presentation only.

### `progress`

Header: `progress value max=bound`. Leaf with a required compatible numeric maximum.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`, `caption=text`.

### `radial_progress`

Header: `radial_progress value max=bound`. Leaf with a required compatible numeric maximum.

Appearance: `variant=solid`, `caption=text`.

### `skeleton`

Header: `skeleton [state]`. Leaf; omission is an authored placeholder. It does not infer provider state.

### `stat`

Headers: `stat observations` or the slotted form `stat`. A typed metric leaf, or a named-slot suite with required value slot. The slotted form has no positional value.

Slots: `slot value` (required, once); `slot title` (optional, once); `slot description` (optional, once); `slot icon` (optional, once).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

### `status`

Header: `status value`. Leaf displaying explicit state with a text alternative.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid`, `caption=text`.

### `steps`

Header: `steps [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked.

Slots: `slot item` (required, repeatable).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

A container `tone=` is rejected; step tones belong to the item presentation contract and are not arbitrary attributes on `slot item`.

### `swap`

Header: `swap [value]`. Requires off/on slots. A supplied value is a readable bool or owned bool preference; omitted selection is transient view state.

Slots: `slot off` (required, once); `slot on` (required, once).

### `text_rotate`

Header: `text_rotate [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked. At most six items; reduced-motion behavior applies.

Slots: `slot item` (required, repeatable).

### `timeline`

Header: `timeline [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked.

Slots: `slot item` (required, repeatable).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

### `toast`

Header: `toast [notice]`. Expression-only leaf, or a nonempty readable-content suite. Business invocation and activation children are invalid.
