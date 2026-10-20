# Layout and navigation

Arrange task content and admitted destinations with practical layout and navigation examples. See how slots, row scope and checked action bindings stay intact inside the shared application shell.

## Example context

The examples are alternative page-body fragments for the complete [ComponentTasks scaffold](../07-Build-interfaces/02-components-and-layout.md#start-with-a-complete-component-scaffold). Replace that scaffold’s root page body with one fragment at a time; nested forms and collections supply their own scope. Do not paste all alternatives into one form.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `breadcrumbs`

Header: `breadcrumbs`. Derived-ancestry leaf; alternative authored ancestry is invalid.

```can
breadcrumbs
```

On a typed task-detail page, this follows the declared ancestry; on the root page there is no invented parent.

### `card`

Header: `card [caption] [layout=stack|columns]`. Requires a nonempty regular content suite.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `caption=text`.

```can
list Todo
 card row.title size=sm layout=stack
  text row.note
  primary "Edit task" action=Todo.update arguments={record=row}
```

The card retains its task row and places the canonical edit action in its footer.

### `divider`

Header: `divider [caption]`. Leaf; omitting the caption gives an uncaptioned divider.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`, `orientation=horizontal|vertical`, `caption=text`.

```can
text "Task summary"
divider "Actions" orientation=horizontal
button action=Todo.create caption="Add task"
```

The divider separates content from actions without changing their scope.

### `dock`

Header: `dock [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `caption=text`.

```can
dock pages=["/"] size=sm
```

The selection references the scaffold’s declared root page; permission still determines whether its link appears.

### `footer`

Header: `footer [caption]`. Requires a nonempty regular content suite or its named-slot suite.

Slots: `slot content` (required, once); `slot start` (optional, once); `slot end` (optional, once).

Appearance: `variant=solid`, `orientation=horizontal|vertical`, `caption=text`.

```can
footer
 slot start
  text "Task workspace"
 slot content
  link target="/" caption="Tasks"
```

Named slots own all direct children; the link remains a checked destination, not a second route declaration.

### `hero`

Header: `hero [caption]`. Requires a nonempty regular content suite or its named-slot suite.

Slots: `slot content` (required, once); `slot start` (optional, once); `slot end` (optional, once).

Appearance: `variant=solid`, `caption=text`.

```can
hero
 slot start
  text "Task workspace"
 slot content
  link target="/" caption="Tasks"
```

Named slots own all direct children; the link remains a checked destination, not a second route declaration.

### `join`

Header: `join`. Requires a nonempty scope-transparent content suite; it adds presentation only.

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

```can
join orientation=horizontal
 button target="/" caption="Tasks"
 button action=Todo.create caption="Add task"
```

The joined controls retain separate navigation and operation bindings.

### `link`

Header: `link target=destination [caption=text]`. Leaf with a required safe URL or authorized file destination. Internal routes retain their admission checks. A caption may be omitted only when a safe destination caption already exists; otherwise it is required.

Appearance: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `variant=solid`.

```can
link target="/" caption="Back to tasks" tone=primary
```

This navigates to the declared root; it does not invoke a mutation.

### `megamenu`

Header: `megamenu [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `orientation=vertical`, `caption=text`.

```can
megamenu pages=["/"] size=sm
```

The selection references the scaffold’s declared root page; permission still determines whether its link appears.

### `menu`

Header: `menu [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`, `orientation=horizontal|vertical`, `caption=text`.

```can
menu pages=["/"] size=sm
```

The selection references the scaffold’s declared root page; permission still determines whether its link appears.

### `navbar`

Header: `navbar [pages=selection]`. No positional expression. Bare form derives admitted navigation; pages= selects an array of declared static route shapes such as ["/tasks"]; an authored presentation suite may contain canonical links/actions or display groups, never route declarations. Navbar additionally accepts its closed slot schema.

Slots: `slot content` (required, once); `slot start` (optional, once); `slot end` (optional, once).

Appearance: `variant=solid`, `caption=text`.

```can
navbar
 slot start
  text "Task workspace"
 slot content
  link target="/" caption="Tasks"
```

Named slots own all direct children; the link remains a checked destination, not a second route declaration.

### `stack`

Header: `stack`. Requires a nonempty scope-transparent content suite; it adds presentation only.

```can
stack
 text "Review tasks"
 badge count(Todo)
```

Stack changes placement while the count keeps ordinary read authority.

### `tabs`

Header: `tabs [preferences.selector]`. An owned enum-preference selector may be a leaf or a suite of tab enum_case children, every case exactly once. Without a selector, requires nonempty tab caption children and transient selection. Each tab has a nonempty content suite.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
tabs size=sm
 tab "Summary"
  stat count(Todo)
 tab "Tasks"
  list Todo columns=title,done
```

These panels use transient selection. Use an owned enum preference for persisted selection.
