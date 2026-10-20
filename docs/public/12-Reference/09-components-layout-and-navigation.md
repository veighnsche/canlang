# Layout and navigation

Layout and navigation components arrange content and present destinations already admitted by the page and caller policy.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `breadcrumbs`

Header: `breadcrumbs`. Derived-ancestry leaf; alternative authored ancestry is invalid.

### `card`

Header: `card [caption] [layout=stack|columns]`. Requires a nonempty regular content suite.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `caption=text`.

### `divider`

Header: `divider [caption]`. Leaf; omitting the caption gives an uncaptioned divider.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`, `orientation=horizontal|vertical`, `caption=text`.

### `dock`

Header: `dock [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `caption=text`.

### `footer`

Header: `footer [caption]`. Requires a nonempty regular content suite or its named-slot suite.

Slots: `slot content` (required, once); `slot start` (optional, once); `slot end` (optional, once).

Appearance: `variant=solid`, `orientation=horizontal|vertical`, `caption=text`.

### `hero`

Header: `hero [caption]`. Requires a nonempty regular content suite or its named-slot suite.

Slots: `slot content` (required, once); `slot start` (optional, once); `slot end` (optional, once).

Appearance: `variant=solid`, `caption=text`.

### `join`

Header: `join`. Requires a nonempty scope-transparent content suite; it adds presentation only.

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

### `link`

Header: `link target=destination [caption=text]`. Leaf with a required safe URL or authorized file destination. Internal routes retain their admission checks. A caption may be omitted only when a safe destination caption already exists; otherwise it is required.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`.

### `megamenu`

Header: `megamenu [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `orientation=vertical`, `caption=text`.

### `menu`

Header: `menu [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `orientation=horizontal|vertical`, `caption=text`.

### `navbar`

Header: `navbar [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations. Navbar additionally accepts its closed slot schema.

Slots: `slot content` (required, once); `slot start` (optional, once); `slot end` (optional, once).

Appearance: `variant=solid`, `caption=text`.

### `stack`

Header: `stack`. Requires a nonempty scope-transparent content suite; it adds presentation only.

### `tabs`

Header: `tabs [preferences.selector]`. An owned enum-preference selector may be a leaf or a suite of tab enum_case children, every case exactly once. Without a selector, requires nonempty tab caption children and transient selection. Each tab has a nonempty content suite.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.
