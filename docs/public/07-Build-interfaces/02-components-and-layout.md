# Components and layout

Compose the finite approved component vocabulary around source-owned data and actions. Components control presentation and interaction; they do not create schemas, permissions or business operations.

## Composition rules

Use explicit component children and declared slots. A slotted group requires its required slots exactly once; repeatable item slots follow the declared sequence. Bind controls to the nearest checked field, view state or canonical action context. Unknown attributes and unsupported appearance values are errors, not arbitrary HTML escape hatches.

Keep headings, labels and accessible names meaningful. Preserve keyboard operation, visible focus, contrast and reduced-motion behavior. Dynamic values are escaped as text unless the owning component explicitly accepts a safe, authorized media reference. Responsive composition should retain the same meaning and actions at narrow widths.

Component-specific signatures and bindings live in [layout and navigation](../14-Component-reference/01-components-layout-and-navigation.md), [content and feedback](../14-Component-reference/02-components-content-and-feedback.md), [inputs](../14-Component-reference/03-components-inputs.md), [disclosure and actions](../14-Component-reference/04-components-disclosure-and-actions.md), and [collections and media](../14-Component-reference/05-components-collections-and-media.md).


## Start with a complete component scaffold

Save this complete application as `ComponentTasks.can`, or use the [source file](../examples/component-tasks/ComponentTasks.can). It supplies every model, field and operation used in the 68 reference examples. Each reference block is an alternative body for its `page /`; replace the existing form/list body with one example, indented beneath the page.

```can
# Explore task components with canonical data and actions.
app ComponentTasks
Given
 Todo {title:text trim min=1,note:text?,done:bool=false,priority:enum(low,normal,high)=normal,score:int=3 min=1 max=5,due:date?,code:text min=6 max=6,image:file?}
 Photo {title:text,image:file}
 policy Todo read=members
 policy Photo read=members
When
 crud Todo by=members fields=title,note,done,priority,score,due,code,image
 crud Photo by=members fields=title,image
Then
 page / title="Component examples"
  form Todo.create display=inline
  list Todo columns=title,done
   edit
```

Run `can check ComponentTasks.can`, then `can dev ui --root . --source ComponentTasks.can --app ComponentTasks`. In preview, enter `check`, wait for the serving revision and use `open`; sign in and select a team as in the [first-app tutorial](../01-Get-started/05-first-app.md#obtain-access-and-sign-in).

The scaffold deliberately supplies a constrained six-character text code for `otp`, a score bounded from one to five for `range`/`rating`, an enum for choice controls, and nullable date/file inputs. The code is sample business text, not a real authentication OTP flow. Creating a task requires a title and a six-character code; other writable fields keep their declared defaults or nullable values. Media examples need actual finalized image files and readable Photo records. To create those through preview, use `form Photo.create display=inline` in the page before the media collection.

These examples exercise presentation semantics, not a requirement to put every component on one screen. Alternative controls for the same field belong in separate forms or separate versions of a form. Do not turn a static loading/success mockup into a factual runtime status.

## Review a task in a focused panel

Replace the root page body with this composition:

```can
list Todo as task columns=title,done
 card task.title size=sm
  badge task.priority variant=outline
  text task.note
  button opens=ReviewTask caption="Review task"
 drawer "Task review" id=ReviewTask
  slot content
   text task.title,task.note
   collapse "Completion status"
    status task.done caption="Completion"
  slot actions
   primary "Edit task" action=Todo.update arguments={record=task}
   secondary "Archive task" action=Todo.delete arguments={record=task}
 pagination
```

The [card](../14-Component-reference/01-components-layout-and-navigation.md#card) summarizes one task; the [drawer](../14-Component-reference/04-components-disclosure-and-actions.md#drawer) keeps that same record through its local opener and action slots. [Badge](../14-Component-reference/02-components-content-and-feedback.md#badge) and [status](../14-Component-reference/02-components-content-and-feedback.md#status) display different typed values. Archive retains canonical confirmation and permission checks. No panel opening changes a record.

## Group inputs without moving their submit owner

```can
form Todo.create display=inline
 fieldset "Task wording"
  label title caption="Task title"
  input title
  validator title
  textarea note
 fieldset "Review settings"
  select priority
  rating score size=sm
 primary "Create task" submit=true
```

[Fieldset](../14-Component-reference/03-components-inputs.md#fieldset), [label](../14-Component-reference/03-components-inputs.md#label) and [validator](../14-Component-reference/03-components-inputs.md#validator) arrange existing inputs and feedback. [Select](../14-Component-reference/03-components-inputs.md#select) uses the enum; [rating](../14-Component-reference/03-components-inputs.md#rating) uses the declared numeric bounds. Unplaced eligible fields, including the required code, still render. The form owns its direct primary submit; it is not nested inside a fieldset. Read [forms and actions](04-forms-and-inputs.md) for dependent choices, bound arguments and conflict handling.

## Browse authorized images beside their metadata

```can
form Photo.create display=inline
 file_input image
 input title
table Photo columns=title display=split size=sm
 avatar row.image caption=row.title
 link target=row.image caption="Open original"
 pagination
```

[File input](../14-Component-reference/03-components-inputs.md#file_input) uses real upload/finalization. The [table](../14-Component-reference/05-components-collections-and-media.md#table) supplies the selected row, [avatar](../14-Component-reference/05-components-collections-and-media.md#avatar) presents its readable image and [link](../14-Component-reference/01-components-layout-and-navigation.md#link) resolves its currently authorized original. [Pagination](../14-Component-reference/05-components-collections-and-media.md#pagination) keeps the table's query state. Use a gallery or carousel when image comparison is the main task; see [collections](03-collections-and-views.md).

## Verify placement and interaction

Check each composition with synthetic data. Open and close the correct row's panel using keyboard and touch, confirm focus returns to its opener, and verify edits target that row. Submit invalid input and inspect the existing validation outlet without losing the draft. Check narrow-screen placement, readable text alternatives, reduced-motion behavior and current file access.

Use only the finite appearance tokens listed for the component. For example, `size=sm` on a table and `variant=outline` on a badge are declared options; arbitrary classes and a global style object are not. Components without appearance options do not inherit them merely because a neighboring component accepts them.
