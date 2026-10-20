# Build typed pages and discoverable navigation

Build a task workspace with typed record and search routes, navigation metadata and page guards. Learn how the shared shell discovers destinations while every request keeps its own access checks.

## Start with the complete TaskPages app

`TaskPages` is a separate complete teaching app with tasks, contained checklist steps and uploaded photos. It extends the task-oriented learning path without changing the earlier `Tasks` app. Install the toolchain using the [first-app tutorial](../01-Get-started/05-first-app.md), and obtain a preview account with membership in a team.

Save the following complete source as `TaskPages.can`. The same file is available in the [handbook source](../examples/task-pages/TaskPages.can). Photos require a real, finalized image upload under the app's file policy; the task pages do not require uploading a photo.

```can
# Browse team tasks through pages and collection presentations.
app TaskPages
Given
 Todo {title:text trim min=1,status:enum(open,doing,done)=open,starts:datetime,ends:datetime}
 Step in Todo {title:text trim min=1,done:bool=false}
 Photo {title:text trim min=1,image:file}
 policy Todo read=members
 policy Step read=members
 policy Photo read=members
 invariant Todo: row.ends>=row.starts
When
 crud Todo by=members fields=title,status,starts,ends
 crud Step by=members fields=title,done
 crud Photo by=members fields=title,image
 scenario find_tasks(search_text:text) read=true -> Todo[] by=members
  do return (Todo as task where contains(task.title,search_text))
Then
 view TaskSummary(row:Todo)
  card "Task"
   text row.title,row.status,row.starts,row.ends
 page / title="Tasks" group="Work" order=-1
  form Todo.create display=inline
  list Todo as task search=title filter=status order=-created empty="No tasks match."
   show TaskSummary {row=task}
   link target=app_url(format("/tasks/{id}",{id=task.id})) caption="Open task"
   edit
   pagination
 page /tasks/{Todo.id} title="Task details"
  breadcrumbs
  show TaskSummary {row=row}
  form Step.create display=inline
  list Step as step columns=title,done
   edit
   pagination
 page /table title="Task table" group="Work"
  table Todo columns=title,status,starts,ends search=title filter=status order=starts display=split
   show TaskSummary {row=row}
   edit
   pagination
 page /board title="Task board" group="Work"
  board Todo by=status columns=title,starts order=starts
   show TaskSummary {row=row}
   edit
   pagination
 page /agenda title="Task agenda" group="Work"
  calendar Todo start=starts end=ends columns=title,status order=starts
   text row.title,row.status
   edit
   pagination
 page /photos title="Photos" group="Media"
  form Photo.create display=inline
  gallery Photo image=image columns=title search=title order=-created
   text row.title
   edit
   pagination
 page /steps title="Task steps" group="Work"
  list Todo as task order=title
   text task.title
   list Step as step columns=title,done
    text task.title,step.title,step.done
    edit
   pagination
 page /search/{search_text:text} data=find_tasks(search_text=search_text) title="Search results"
  list result columns=title,status
   pagination
 page /owner title="Owner overview" nav=none
  require owner
  text "Team owner overview"
  table Todo columns=title,status
   pagination
```

Run these commands from the directory containing the file:

```sh
can check TaskPages.can
can dev ui --root . --source TaskPages.can --app TaskPages
```

In the development terminal, enter `check`, wait for the serving revision, then use `open`. [Sign in and select a team](../01-Get-started/05-first-app.md#obtain-access-and-sign-in). The pages render that team's authorized data. The [collections lesson](03-collections-and-views.md) explains each collection and its verification steps; excerpts there belong to this complete app.

## Bind records through typed routes

The declaration `page /tasks/{Todo.id}` resolves a readable `Todo` and binds it as `row:Todo`. Its parent chain, if any, is retained. The page can pass `row` to `TaskSummary`, and `form Step.create` binds the new step's parent from the enclosing task.

The list's Open task link constructs a URL using the current task's identity. It does not call an operation. `Todo` is a type and collection name, not a record instance; use `row` or the explicit collection alias `task` to read a record's fields.

A missing, unreadable or expired record does not become a blank authorized record page. The dispatcher checks current access on full and partial requests. A copied URL grants no access. Team-scoped navigation requires the appropriate team context; public record routes resolve team from the record while still applying policy.

Route shapes must be unique after normalization. Changing only a placeholder's model does not make an overlapping shape unique: `/tasks/{Todo.id}` and `/tasks/{Other.id}` conflict. Untyped `{id}` and optional path segments are invalid. Use typed identities and escaped values when building destinations.

## Load a scalar route through a pure read

This complete handler-and-page excerpt is already included above; do not append it twice:

```can
scenario find_tasks(search_text:text) read=true -> Todo[] by=members
 do return (Todo as task where contains(task.title,search_text))
```

The scenario belongs in `When`. Its result is a bounded, viewer-authorized task query. The associated `Then` page is:

```can
page /search/{search_text:text} data=find_tasks(search_text=search_text) title="Search results"
 list result columns=title,status
  pagination
```

Opening `/search/Release` supplies the text `Release` and exposes the read result as page-level `result`. The parameter is typed input, not authority: `find_tasks` still requires membership and applies ordinary read access. An empty result renders an empty collection; it is not a denied page. GET and its `data=` read cannot mutate business state.

This differs from a read form, whose `result` exists only within that form's children. Siblings of a read form do not inherit its result.

## Control navigation with page metadata

| Attribute or declaration | Effect in this app |
| --- | --- |
| `title="Task table"` | Static destination caption; dynamic task details belong in the body |
| `group="Work"` | Groups the owning package's work destinations |
| `order=-1` on `/` | Places Tasks before pages with the default order of zero |
| `nav=none` on `/owner` | Omits the static page from navigation discovery |
| A typed record or scalar route | Automatically excluded from enumerated navigation |
| `breadcrumbs` | Presents ancestry derived from the declared route |

Title, attached description, group and order are static metadata. They cannot depend on a current row, caller, query result or preference. Explicit order ties preserve source order; composition traverses selected members in `uses` order and deduplicates canonical pages. An omitted group uses the owning group's eligible static title or explicit owner label. Empty groups are omitted, and identical translated captions do not merge different owners.

`nav=none` is not an access rule. An eligible team owner can visit `/owner` directly; another member cannot, because of the separate page guard. Record details retain the owning parent destination's highlight without becoming separate sidebar entries.

## Keep page guards separate from data policies

The owner page narrows admission with `require owner`. A failed page guard makes the page unavailable and removes any discoverable link. The same predicate inside a card or other container omits only that group and keeps its scope local.

Ordinary task collections inherit the authentication and team context required by `policy Todo read=members`. This admits an eligible member even when the team has no tasks. Row predicates, field grants and business roles continue to constrain individual reads; a page link is not a promise that every field or action is available.

A form or action does not execute during navigation discovery, and its mutation guard does not become a page-wide gate. This allows an accessible page to contain actions available only in particular states. The server rechecks each operation when submitted.

Discovery evaluates only dependencies needed for eligibility, rather than rendering every page. If a necessary read fails or exceeds its budget, eligibility is unavailable; the shell must not reuse an old allowed link. Current membership, team, source and data-gate changes invalidate earlier eligibility. Direct and partial requests repeat admission.

## Use the shared shell

The shell owns the collapsible sidebar, account menu, settings dialog, login and mobile drawer. `navbar`, `menu`, `megamenu`, `dock`, canonical `link` and `breadcrumbs` can present declared destinations within a page. They do not replace the shell or introduce a second route registry.

Use a page for a routable screen and an ordinary view for repeated presentation. Generated renderers return page content, not a competing document shell. See [layout components](../14-Component-reference/01-components-layout-and-navigation.md) and [ordinary views](03-collections-and-views.md#reuse-presentation-with-ordinary-view-and-show).

## Verify routes and admission

1. With an empty team, open Tasks. Confirm the page is available with an empty collection, rather than being denied for lacking rows.
2. Create `Release checklist` with valid start/end datetimes, then open its record link. Confirm the detail shows that task and its steps.
3. Open `/search/Release`. Confirm the read returns matching readable tasks without changing them.
4. As a regular member, request `/owner` directly. Confirm denial. As the team owner, confirm access; it remains absent from the sidebar because of `nav=none`.
5. Sign out or remove membership and request a copied task URL. Confirm current access is enforced rather than trusting the previously visible link.
6. Open a detail on a narrow screen and check navigation, breadcrumbs and return to the parent destination. Use the collection lesson to verify split-pane selection independently.
