# Browser pages, MCP and localization

Build interfaces from the same records, operations and permissions that define the application, with translations next to the text they describe.

## Bind pages to canonical behavior

In `Then`, a page declares its route and title. This fragment assumes the Todo model and CRUD from the first app:

```can
page / title="Tasks"
 form Todo.create display=inline
 list Todo order=-created search=title filter=done
  text row.title,row.done
  edit
  delete
  pagination
```

The create form uses the operation's input schema. The list supplies `row` for each readable result; edit and delete refer to that row's canonical operations. Ordering, searching and filters still respect read policies. Do not duplicate authorization in page-local data access.

Use `fields` on a form or edit control to narrow its rendered inputs, while keeping the operation's own allowlist authoritative. Server-owned fields and protected identity metadata stay outside user input. A custom scenario form can bind its record argument to the current row with `arguments={expense=row}`.

## Choose presentation deliberately

The shared component vocabulary covers business layouts, cards, tables, lists, forms, dialogs, navigation and feedback. Component headers have checked binding and structural options; arbitrary props are not implicit extension points.

Use a card to group a task, a form for an action, and a list or table for a collection. Provide meaningful empty text and visible labels. Design populated, empty, invalid and denied states, then test at mobile and desktop sizes. A data-bound page or history control retains current read checks.

Preferences describe personal presentation settings, not shared business state. This fragment declares an enum preference and selects it with tabs:

```can
preferences { view:enum(all,unfinished,finished)=all }
page / title="Tasks"
 tabs preferences.view
```

Connect that preference to a list filter when you want it to change the displayed records. A tab label alone does not filter data.

## Put translations beside text

Use inline variants for text that belongs to one declaration:

```can
page / title="Tasks"@{nl="Taken"}
```

Descriptions can also carry a final translation suffix. A named message is useful when multiple declarations actually reuse it. In `Given`:

```can
message add = "Add"@{nl="Toevoegen"}
message task_count(n:int) = "{n, plural, one {# task} other {# tasks}}"@{nl="{n, plural, one {# taak} other {# taken}}"}
```

Bind the parameter with `task_count(count(Todo))`. Keep parameters consistent across variants. Locale resolution uses the requested locale, application default and source fallback; it is not a second set of business rules. A context `locale default="nl"` changes the app default when needed.

## Reuse operations through MCP

The generated MCP interface describes public operations using their typed inputs and descriptions. Tool discovery and invocation retain the caller's current identity, team and grants. A tool's presence does not authorize every record or input, and revocation must be respected by admission.

When designing an AI client, use the operation schemas and returned errors instead of fabricating a parallel write API. Test representative allowed and denied requests through MCP as well as browser controls.

For an application-specific written reference, run `can docs Tasks.can --out reference.md`. See [CLI reference](../04-Reference/01-cli.md) for locale and runtime requirements.
