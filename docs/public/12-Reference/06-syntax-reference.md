# Syntax reference

This index and complete small app summarize the accepted source forms; use each linked owner for semantics. The complete production and contextual boundaries live in the [normative grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md). A source fragment requires the enclosing app/package and all declarations it references.

## File and declaration forms

```can
# Manage team tasks.
app Tasks
Given
 Todo { title:text, done:bool=false }
 policy Todo read=members
When
 # Complete an open task.
 scenario finish(todo:Todo) by=members
  require not todo.done message="Task is already complete"
  do
   set todo {done=true}
Then
 page / title="Tasks"
  list Todo columns=title,done
```

An explicit package uses `package Name` with indented sections. Composition uses `app Name uses=[Package]`, optional context, then imports before declarations. Models, contracts, field/parameter enum types, policies, invariants, unique constraints, locks, retention, fixtures, CRUD, scenarios, events, capabilities, judgments, corpora, pages, forms, collections, and components have distinct productions; similar-looking names do not choose a production by capitalization.

## Expression and operation forms

Fields and parameters declare types explicitly. Nullable values use `?`; arrays use `[]`; enums use `enum(a,b)`. Query clauses have grammar-defined order. A mutation has one `do` body with source-ordered effects. Effects include `create`, `set`, `transition`, `delete`, `call`, `emit`, `send ... as name`, `schedule ... at=... event=...`, `cancel`, `if/else`, exhaustive enum `match/case`, bounded `for`, and `return`. There is no arbitrary SQL/JS body or nested atomic block. See [scenarios](../05-Workflows/02-scenarios-and-effects.md), [language values](../02-Language/03-types-and-values.md), and [UI constructs](../06-Interfaces/01-pages-and-navigation.md).
