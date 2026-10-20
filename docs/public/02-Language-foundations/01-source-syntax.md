# Source layout and syntax

Learn how Given, When and Then organize a CanLang app, and how static dollar prompts generate reusable extensions and presentation while ordinary builds use saved implementation.

## Read the three application sections

`Given` declares data and rules, `When` declares operations, and `Then` declares presentation. An implicit app has one ordered section triple. A package uses the same triple indented beneath `package NAME`. Blank lines and comments aid reading but do not introduce executable bindings.

## A complete minimal source file

```can
# Track team tasks.
app Tasks
Given
 Todo { title:text }
When
Then
 page / title="Tasks"
```

Indentation defines suites; use one space per level. Declarations and fields use braces where the grammar calls for schemas. `#` lines attach prose descriptions to the next eligible declaration at the same column; `##` lines are explanatory comments discarded by the parser. Inline hash comments are not valid. Strings use quoted literals; `true`, `false`, and `null` are values. Expressions and query tails have defined grammar and precedence—see [expressions and derives](03-expressions-and-derives.md).

The sample is a complete minimal app with an empty operation section. A snippet taken from a section is a fragment and needs an owning app/package and all referenced declarations. The [syntax reference](../13-Language-reference/01-syntax-reference.md) indexes productions; this page introduces source layout and generation intent.

## Write identifiers and logical lines

Identifiers are case-sensitive ASCII names: start with a letter or underscore, then use letters, digits or underscores. `Todo`, `todo` and `todo_2` are different names; `2todo` and `todo-title` are not identifiers. Text values and descriptions may contain Unicode even though identifiers use this narrower alphabet.

Words are contextual rather than globally reserved. For example, `event` can be a field name after a dot. At expression-primary position, however, `true`, `false` and `null` are literals and `not` is an operator. A declaration's written shape and enclosing section determine its meaning; capitalization does not make a name a model, function or keyword.

Use exactly one additional space for a child suite. Tabs in code or indentation are errors. A newline normally ends a logical line, but open `()`, `[]` or `{}` continue it until the matching delimiter closes. This continuation does not create an indented suite. There is no backslash line continuation. UTF-8 source accepts LF or CRLF line endings.

## Separate descriptions from comments

`#` supplies user-facing description metadata; `##` is an explanatory comment discarded by the parser. Put either marker on its own physical line. A trailing `## comment` after code is not valid.

This complete app demonstrates both markers and a multiline schema:

```can
# Track the team's work.
app Tasks
Given
 Todo {
  # The work to carry out.
  title:text trim,
  ## Default new tasks to open.
  done:bool=false
 }
When
 crud Todo by=members fields=title,done
Then
 page / title="Tasks"
```

The first description belongs to `app Tasks`; the indented description belongs to `title`. A description attaches to the next eligible declaration starting at the same physical column. Blank lines and `##` comments do not interrupt it. It cannot skip an ineligible statement or another indentation level to find a later declaration. A dangling description is an error.

Consecutive `#` lines at the same column form one description joined with newlines. Sections (`Given`, `When`, `Then`), `do`, guards, effects and example rows cannot receive descriptions. Inside open schema braces, field indentation still controls description attachment even though it does not open a suite.

Fields and parameters can instead use inline `desc=`. This is a `Given` fragment:

```can
Todo {title:text trim desc="The work to carry out.",done:bool=false}
```

Place `desc=` after the field's initializer/modifiers/default and before any `label=`. A declaration has one description slot: do not give the same field both a preceding `#` and `desc=`. A description explains meaning; a label supplies the visible name.

`#= messages.task_help` reuses a static, zero-parameter message declaration; replace that path with an actual visible message. There is no space between `#` and `=`. It must be the sole description line for that declaration. `# = text` is ordinary prose. Inline `desc=` can likewise reference a static message path. See [messages and localization](../07-Build-interfaces/06-localization.md) for message definitions and variants.

A description can end with a contiguous `@{...}` translation suffix on its final prose line. Those variants describe the entire joined description. Literal prose is not string interpolation; the [grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md#descriptions-and-comments) specifies escaping and the retained legacy description spelling.

## Distinguish schemas, values and strings

A schema uses `name:type`; a value uses `name=expression`. For example, `Todo {title:text}` declares a stored model, while `{title="Review draft"}` supplies a value. `{title}` in a value means `{title=title}` and requires an existing binding named `title`. Braces alone do not mean a new scope or a stored record. See [types and values](02-types-and-values.md#schemas-and-value-objects).

Ordinary strings use double quotes and JSON escapes, such as `"Review draft"`, `"Line one\nLine two"` and `"Say \"hello\""`. Single quotes, unescaped physical newlines and source interpolation are not supported. Use [expressions and derives](03-expressions-and-derives.md) for calculations and formatting; `$"..."` below has the separate purpose of static generation intent.

## Generate with `$"..."` and reuse with `$Name`

`$"..."` marks a **static generation prompt** at a supported declaration. `$Name` attaches a **named style** already defined in the same owning namespace. It does not make an AI call or substitute a variable into text.

This complete Tasks source defines one style and reuses it on two cards. Keep the saved generated implementation with the source when building the application.

```can
# Manage team tasks with a reusable presentation style.
app Tasks
Given
 Todo {title:text trim,done:bool=false}
 policy Todo read=members
When
 crud Todo by=members fields=title,done
Then
 style TaskSurface $"Keep owned text and spacing readable at narrow widths. Preserve canonical controls, focus indicators and shared theme tokens. Do not add a second frame to canonical cards."
 page / title="Tasks"
  card "Create a task" $TaskSurface
   form Todo.create display=inline
  card "Your tasks" $TaskSurface
   list Todo columns=title,done
    edit
    delete
```

`style TaskSurface $"..."` defines the generation intent. Both `$TaskSurface` attachments reuse its saved CSS with separate instance hooks. The cards keep their normal form, list and action behavior; styling cannot grant access, modify records or replace canonical controls.

For a one-off visual treatment, an eligible component header can carry an inline prompt instead. This is a `Then` fragment to place inside a page; it needs no model:

```can
card "About Tasks" $"Keep this explanatory text readable on narrow screens using the shared theme."
 text "Tasks belong to the selected team."
```

The prompt comes after the header's ordinary arguments, before its child suite. Use either one inline style prompt or one named style attachment on that header, not both.

## Put each prompt with the declaration it extends

Dollar prompts have specific owners; they are not arbitrary executable statements:

| Placement | What the prompt prepares | Reuse |
| --- | --- | --- |
| `Given`: named trait or inline model/field trait | Checked model or stored-field contributions | Apply a named trait by its bare name, without `$` |
| `Given`: named `keyword` definition | A checked extension with typed compile-time arguments | Invoke the keyword by name with named arguments |
| `Then`: named `style` definition or eligible visual header | Scoped presentation CSS | Attach a named style with `$Name` |
| `Then`: `view` header | A renderer constrained by the view's checked inputs and canonical actions | Instantiate the view with `show` |

For example, `trait title_text $"..."` defines a trait, and `title:text title_text` applies it. `$title_text` is not trait application syntax. See [traits and custom keywords](../03-Generate-implementation/02-traits-and-custom-keywords.md) and the [dollar syntax reference](../13-Language-reference/01-syntax-reference.md#dollar-prompts-and-named-styles) for concrete forms.

Prompts are static JSON string literals, with `$` directly adjacent to the opening quote. They have no interpolation or translation suffix. A prompt cannot read the current actor or row by embedding an expression in its text. The enclosing declaration determines its checked target and available inputs. Ordinary `When` scenarios remain authored guards and `do` effects.

## Prepare implementation once, then build from saved files

For the styled Tasks application, configure an authenticated coding runner using [generation configuration](../15-Tooling-reference/03-generation-configuration.md). From its application folder, explicitly prepare the generated implementation:

```sh
can gen Tasks.can
```

Generation creates candidates and validates them against their target contracts before accepting them. Accepted implementation lives in tracked `can.generated/<opaque-unit-id>/` directories. Keep those files with the application; the prompt string alone is not the implementation.

After acceptance, ordinary source checks and builds consume the saved implementation and make **zero AI calls**:

```sh
can check Tasks.can
```

Compatible `$TaskSurface` reuse does not generate another implementation for every card. Missing or stale required output needs explicit generation preparation; a normal build does not silently call a model to repair it. Saved files are editable, subject to the same validation and freshness requirements. See [generation lifecycle](../03-Generate-implementation/01-generation-lifecycle.md) for acceptance and [editing and refinement](../03-Generate-implementation/04-editing-and-refinement.md) for changes.

Build-time prompts prepare application code. To ask a model a question while the application is running and use its result as data, use [runtime text and image generation](../09-Runtime-AI/01-text-and-image-generation.md).
