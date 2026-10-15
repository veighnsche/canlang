# Source, packages and composition

Keep business identity in `.can` declarations so moving a file does not change the meaning or ownership of your application.

## Write the source clearly

Source uses UTF-8, case-sensitive names and JSON double-quoted strings. Indent each block by one space. Newlines end statements outside balanced parentheses, brackets and braces. Use `##` for an ordinary explanatory comment.

A line beginning with `#` attaches description metadata to the next declaration at the same indentation. Describe the app and explain the business effect of custom user-callable scenarios. Descriptions appear in generated interfaces and references; they do not execute business rules. Use explicit guards and effects for behavior.

Each implicit app or explicit package has one ordered `Given`, `When`, `Then` body. A section can be empty. Preserve all three sections, even when the app only needs data and operations.

## Start with an implicit package

The [Tasks application](../01-Getting-started/02-installation.md#create-tasks) declares `app Tasks` followed by its three sections. It owns an implicit package also named Tasks. The model identity is `Tasks.Todo`; its create operation is `Tasks.Todo.create`.

A filename does not create a namespace. Moving that app into another file preserves its identity. Renaming `Tasks` changes the identities it owns, so treat a deployed rename as a compatibility and data-migration decision.

## Compose independent apps

A composed app selects existing apps or packages with `uses`. This selection fragment assumes Tasks and Notes are declared elsewhere in the project:

```can
# Manage team tasks and shared notes.
app Office uses=[Tasks,Notes]
```

An app with `uses` does not also contain an implicit Given/When/Then body. Selected packages contribute their own declared pages and interfaces. Check that composed apps do not declare the same normalized route or conflicting explicit resource settings.

Composition includes each canonical package once. It does not copy models or create another set of role grants. Separate deployments still have separate data and authority.

## Use explicit packages as an app grows

The following complete application illustrates two selected packages and an explicit import:

```can
# Manage customer work.
app Office uses=[crm,work]
package crm
 Given
  export Customer { name:text }
  policy Customer read=members
 When
  crud Customer by=members fields=name
 Then
  page /customers title="Customers"
   list Customer
package work
 use crm {Customer}
 Given
  Task { customer:Customer, title:text }
  policy Task read=members
 When
  crud Task by=members fields=customer,title
 Then
  page /tasks title="Tasks"
   list Task
```

`export` makes a declaration importable. `use crm {Customer}` imports that exported name. `uses` selects product membership; `use` makes a symbol available to the importing owner. Neither grants access to records. Importing production business declarations includes their owning executable package internally, preserving its rules and behavior.

## Change defaults only when needed

A context follows the app declaration before imports and sections. This fragment changes the locale and theme:

```can
context
 locale default="nl"
 theme mode=dark accent=green density=compact
```

Omit unchanged runtime, authentication, teams and storage defaults. Context settings from composed apps must agree; composition never silently chooses one conflicting value. Continue with [data and queries](02-data-and-queries.md).
