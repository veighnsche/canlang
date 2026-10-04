# Full daisyUI vocabulary for Can

Status: approved source-language design, October 4, 2026. The user approved the full catalog and its direct contextual keywords. This adopts the component and binding contracts; it does not claim parser, highlighter, compiler or renderer implementation. Existing `.can` sources are deliberately unchanged in this adoption round. The checked per-component appearance matrix remains an implementation deliverable, not permission to guess options.

The earlier small component subset was a design mistake. It unnecessarily restricted authoring agents and prevented Can from expressing the full frontend vocabulary already available in daisyUI. That subset is no longer the language boundary: **all 68 components in the pinned catalog are required**, including components unused by the initial drafts. Every implementer and authoring agent must use this contract rather than treating older examples or short mapping tables as an exhaustive allowlist. Full availability does not require every app to use every component.

## Outcome

Make every component in the pinned daisyUI catalog discoverable and selectable from Can source. Use familiar, contextual component keywords rather than forcing agents to translate every presentation into `card`, `details`, `text` and `metrics`. Keep standard generated forms and the shared shell concise: authors select components and actual differences, without having to spell out default controls.

The [official catalog](https://daisyui.com/components/) was researched on October 4, 2026: 68 components at 5.7.47. That is the approved baseline, not an automatic dependency upgrade or a promise to follow every future upstream release. A language release must pin its supported component contracts and assets together.

The language contract, compiler-owned catalog, authoring diagnostics/completion, highlighting and shared renderer must agree. REQUIREMENTS, DESIGN §9 and GRAMMAR incorporate this approved catalog. An implementation still needs real parser/checker/renderer support; a prompt or a colorized header alone cannot provide it. Component contracts remain finite and typed, but the finite set is the entire pinned upstream catalog.

## Approved authoring model

Use a direct contextual word for each component. Keep its value types, child slots, allowed parents and attributes finite and component-specific. No raw HTML, CSS classes, JavaScript handlers, free-form props, component imports or per-app dependency configuration.

The following illustrates the approved source design; implementation support must be checked separately. `approve` and `submit_review` stand for existing owning operations; `score` and `comment` stand for their existing declared inputs. No operation or input schema is created by this presentation:

```can
Then
 page /reviews title="Reviews"
  list Review
   badge row.status
   tooltip "Review this submission"
    action approve
  form submit_review display=inline
   rating score
   textarea comment
```

New display groups retain the enclosing row/result context and current guards. `badge` displays a readable typed value; `tooltip` annotates the existing canonical action. A form control changes the presentation of a field already declared by its operation. It does not create a new field, broaden an input allowlist, change constraints or submit through another API. Unspecified inputs retain their generated controls. The placement and binding rules below make those defaults explicit; the checker must implement them.

Names below are approved source spellings, not evidence of installed APIs. A role identifies how a component connects to Can; **it does not exclude that component from author selection**.

## Complete inventory

| daisyUI component | Can word | Binding contract |
| --- | --- | --- |
| Accordion | `accordion` | Disclosure group with one open child; retain enclosing scopes |
| Alert | `alert` | Readable notice or canonical operation feedback |
| Aura | `aura` | Decoration around existing content |
| Avatar | `avatar` | Authorized image or explicit safe fallback; no inferred user directory |
| Badge | `badge` | Readable typed value and its owning caption |
| Breadcrumbs | `breadcrumbs` | Current declared route ancestry and authorized destinations |
| Button | `button` | Existing action, form submit, disclosure or destination; distinguish these bindings explicitly |
| Calendar | `calendar` | Form-bound date control; distinguish the existing agenda collection by enclosing grammar |
| Card | `card` | Existing scope-transparent content group |
| Carousel | `carousel` | Ordered readable content with explicit item slots |
| Chat bubble | `chat_bubble` | Explicit readable message, author and time; no messaging behavior inferred |
| Checkbox | `checkbox` | Existing boolean input |
| Collapse | `collapse` | Same disclosure behavior currently supplied by `details` |
| Countdown | `countdown` | Readable numeric/time presentation; no schedule or state transition |
| Diff | `diff` | Two authorized presentation slots; no automatic business comparison |
| Divider | `divider` | Separation with an optional authored caption |
| Dock | `dock` | Presentation of canonical authorized destinations |
| Drawer sidebar | `drawer` | Existing shared shell or explicitly activated scoped content |
| Dropdown | `dropdown` | Explicit trigger and content slots with shared focus behavior |
| FAB / Speed Dial | `fab` | Presentation of existing canonical actions |
| Fieldset | `fieldset` | Group existing form fields without duplicating their schemas |
| File Input | `file_input` | Existing writable file input and authorized upload/finalization path |
| Filter | `filter` | Existing typed view/query selection, not a new mutation mechanism |
| Footer | `footer` | Page content or shared-shell presentation |
| Hero | `hero` | Prominent scoped content group |
| Hover 3D Card | `hover_3d` | Decorative wrapper with upstream restrictions on interactive children |
| Hover Gallery | `hover_gallery` | Authorized images with touch/keyboard alternatives |
| Indicator | `indicator` | Explicit indicator/content slots |
| Text Input | `input` | Existing writable text or appropriate scalar input |
| Join (group items) | `join` | Visual grouping of existing controls |
| Kbd | `kbd` | Shortcut notation; does not register a keyboard handler |
| Label | `label` | Caption from the existing owning input; no separate schema |
| Link | `link` | Checked destination or authorized file URL; no invented route or access |
| List | `list` | Existing authorized collection and row binding |
| Loading | `loading` | Actual runtime loading feedback or explicitly readable application state |
| Mask | `mask` | Visual shape around existing content |
| Megamenu | `megamenu` | Authorized page descriptors with shared responsive behavior |
| Menu | `menu` | Declared destinations or canonical action controls |
| Browser mockup | `mockup_browser` | Presentation wrapper; no browsing engine |
| Code mockup | `mockup_code` | Escaped text; no code execution |
| Phone mockup | `mockup_phone` | Presentation wrapper |
| Window mockup | `mockup_window` | Presentation wrapper |
| Modal | `modal` | Activated scoped content with shared dialog behavior |
| Navbar | `navbar` | Shared navigation presentation and explicit content slots |
| OTP | `otp` | Existing constrained text input; preserve leading zeros |
| Pagination | `pagination` | Existing collection cursor, filters and ordering |
| Progress | `progress` | Readable numeric progress with checked bounds |
| Radial progress | `radial_progress` | Same progress data in a circular presentation |
| Radio | `radio` | Existing finite-choice input |
| Range slider | `range` | Existing numeric input with suitable owning bounds |
| Rating | `rating` | Existing bounded numeric or finite-choice input |
| Select | `select` | Existing enum/reference selection with its current read grants |
| Skeleton | `skeleton` | Existing loading state or an explicitly authored placeholder |
| Stack | `stack` | Visual stacking of scoped content |
| Stat | `stat` | Typed metric presentation, sharing existing metric semantics |
| Status | `status` | Explicit readable state with a text alternative |
| Steps | `steps` | Readable process stages; does not define or execute a workflow |
| Swap | `swap` | Two presentation slots selected by explicit view state |
| Tabs | `tabs` | Existing transient panels or owned enum preference selection |
| Table | `table` | Existing authorized collection, selectors and row context |
| Text Rotate | `text_rotate` | Readable text sequence with reduced-motion behavior |
| Textarea | `textarea` | Existing writable text input |
| Theme Controller | `theme_controller` | Existing shared Appearance path, finite theme choices and persistence |
| Timeline | `timeline` | Ordered authorized events or explicit readable entries |
| Toast | `toast` | Notice placement; retain real feedback and accessible announcements |
| Toggle | `toggle` | Existing boolean input, including permitted view settings |
| Tooltip | `tooltip` | Annotation of existing content/control with accessible alternatives |
| Validator | `validator` | Existing input constraints and feedback, without a second rule language |

Keep `page`, `form`, `action`, `edit`, `delete`, `copy`, `history`, `board` and `gallery` as semantic constructs where they own behavior. Their existence does not limit the component vocabulary. Component selection must lower into those same authoritative bindings rather than creating independent event handlers or copied argument declarations.

## Binding contracts

### Forms and field placement

`input path`, `textarea path`, `checkbox path`, `toggle path`, `radio path`, `select path`, `range path`, `rating path`, `file_input path` and `otp path` name an existing writable input selector within their nearest canonical form/edit/preferences owner. Only scope-transparent groups may intervene between the control and that owner; a collection/result scope ends that field-placement context unless it contains another explicit field owner. Nested structural input paths use the same owning schema. Controls cannot create parameters or restate types, options, bounds, defaults or validation. The field must be eligible under the owner's existing allowlist and explicit `fields=` selection; bound/server-owned/unavailable fields cannot become editable.

Explicit controls render in source order, including through nested fieldsets/groups. Unmentioned eligible fields follow in the order specified by `fields=`, or owner declaration order when it is omitted. The generated remainder excludes explicitly placed fields. A selector may have only one writable control, even across nested groups. Every required unbound input must remain present; a bare form remains complete. Correctable errors retain the same owning form draft. `edit` may have a presentation suite under this approved contract, but its canonical update schema and version contract do not change.

`label path [caption=expr]` places the existing field's label, moving rather than duplicating its generated label. A caption override supplies a real presentation difference and uses ordinary localized text. `validator path` similarly places the owning validation outlet; it accepts no new constraints or executable predicates. The field, label and feedback remain associated by generated identities. There may be at most one explicit label and one explicit feedback outlet per field.

Input suitability is checked: checkbox/toggle require bool; radio requires finite choices; select uses existing choices or authorized reference lookup; textarea requires text; file input retains canonical file authority; OTP requires constrained text and preserves leading zeros. Range/rating require finite numeric bounds or a finite ordered-choice schema. `calendar expr start=... end=...` always selects the existing agenda production, even inside a read form's result. Bare `calendar selector` is a date field control only in field-placement context and cannot own collection children. A hybrid with only one endpoint, input options on an agenda, or agenda options on a field control fails. Written header shape and enclosing syntax choose the production before name/type lookup; no inferred date field or calendar engine is created.

For preferences, a page-body `preferences` suite presents the current owning package's already declared extension through its existing self-only save/reset/version path. It accepts controls/grouping but no new schema or business action. Omitted controls still render completely. This is an optional inline presentation of the same settings available in the shared dialog; authors do not need it to expose their declared preferences. `theme_controller` uses shared Appearance directly and does not require a copied extension field.

`filter path` within a field owner selects the same finite-choice input with Filter presentation. Elsewhere it may reference an owned finite-choice view preference, invoking the existing self-only preference save path. It cannot be an unbound arbitrary query predicate or a write to a business field.

### Buttons and local activation

Use one checked binding on an explicit `button`:

```can
button action=approve
button submit=true
button target=app_url("/reviews")
button opens=review_details
```

These headers follow the approved design. Exactly one of `action`, `submit`, `target`, `opens` is allowed. `action=expr` resolves the same enabled canonical operation/action value as the existing `action expr`; optional `arguments={...}` uses the same protected form-binding rules and never changes that operation's schema. Missing required arguments open the canonical generated form. `submit=true` is legal only in an owning canonical form/edit/preferences panel and presents its existing submit/save control. `target=expr` requires a safe URL or authorized finalized file; internal navigation retains declared-route admission. `opens=NAME` activates one declared local panel, not a mutation or new route. Omitted captions derive from the operation, owning form, destination or local panel. An optional `caption=expr` is only a presentation override.

Existing `action`/`actions`, implicit submits and `copy`/`delete` remain concise canonical compositions. The checker lowers explicit action buttons into their existing binding node; it does not implement a second invocation path. Multiple submit presentations may share one form draft and one operation identity per submitted invocation. A button cannot contain another interactive binding or attach an arbitrary callback.

`modal "Caption" id=NAME` and `drawer "Caption" id=NAME` declare optional local activation identities; an external `button opens=NAME` requires the matching declaration to supply `id`. Identities are unique per lexical page scope; repeated rows get runtime-owned instance identities from the existing row chain. A trigger resolves a visible declaration in that same render context, never an arbitrary DOM id or another row's private content. An admitted `slot trigger` or matching external opener suppresses the implicit opener for that instance; otherwise the runtime generates a captioned opener. A trigger slot receives its enclosing component's activation binding automatically and cannot also submit, navigate or invoke a business operation. One active record detail, dismissal, focus containment/return, accepted input preservation and revocation handling remain shared obligations.

### Groups, slots and repetition

Ordinary groups include `card`, `hero`, `footer`, `fieldset`, `join`, `stack`, `aura`, `mask`, `hover_3d`, `tooltip` and `collapse`. A group owns one nonempty presentation suite, inherits the current row/result/form chain, and creates no business scope. Heading/annotation text is required for `tooltip` and disclosure; other wrappers need no invented caption. `collapse` uses the existing `details` disclosure contract; `details` remains its documented compatibility spelling, including the existing drawer exception. `stat expr,...` and `metrics expr,...` likewise share one typed metric contract. No separate state, permission or data model follows from these presentation spellings.

Multi-part components use the single contextual child header `slot NAME`. It is not a reusable app declaration or an arbitrary named fragment. Unknown/duplicate slots fail, except where the catalog explicitly permits repeatable items. Slots preserve all enclosing bindings and guards. The finite slot schemas are:

| Component family | Required slots | Optional/repeated slots |
| --- | --- | --- |
| `dropdown` | `trigger`, `content` | none |
| `modal`, `drawer` | `content` | `trigger`, `actions`; missing trigger generates the canonical opener |
| `diff` | `before`, `after` | none |
| `swap` | `off`, `on` | none |
| `indicator` | `content`, `indicator` | none |
| `chat_bubble` | `content` | `avatar`, `header`, `footer` |
| `stat` with a suite | `value` | `title`, `description`, `icon` |
| `carousel`, `hover_gallery`, `steps`, `timeline`, `text_rotate` | exactly one `item` template with a sequence operand; otherwise at least one authored `item` | repeated `item` only without a sequence operand |
| `navbar`, `footer`, `hero` with slots | `content` | `start`, `end`; ordinary grouping remains the compact alternative |

`accordion` contains one or more `collapse` groups and enforces single-open presentation state. Menu/action-group and FAB children remain canonical action or destination controls; visual grouping is not operation batching. Tabs retain `tab` children and their current preference/transient-panel meanings.

Repeated item components may take an existing query or typed readable sequence as their header expression. They reuse the current collection evaluator and bind `row` with its existing enclosing record chain. With a sequence/query operand there must be exactly one `slot item` template, rendered once for each admitted item; repeated templates are invalid. Without an operand, repeated authored `slot item` suites are distinct explicit items. This is a collection renderer choice, not another expression/query grammar. Without a sequence expression, each authored `slot item` is one explicit item. Existing bounds, field grants, stable order and empty/error states apply before any child is rendered. Hover Gallery admits at most ten images and Text Rotate at most six items, following the pinned upstream limits; excess is a diagnostic/visible bounded-data error, not silent truncation. A component cannot broaden a query by ignoring a parent gate or select private fields through a slot.

`avatar` consumes an authorized image expression, optionally nullable, and optional `caption=expr` and `fallback=expr`. Both attributes require localized text/message values, rendered as escaped plain text, never HTML, image URLs or arbitrary coercions. `fallback` supplies an explicit placeholder such as initials when an admitted image is null or unavailable; omission uses the shared unavailable-image placeholder. Its accessible name derives from the admitted caption, fallback or shared unavailable label. Field/image authority is checked before display; fallback cannot reveal an unreadable field or bypass denied content. Badge/status consume readable typed values, deriving available enum/bool captions. `kbd` and `mockup_code` consume escaped text. Divider may omit its caption. Loading and skeleton may be selected as explicitly authored placeholders, while generated operation feedback still obtains its state from the runtime. None of these leaves accepts arbitrary child handlers.

### Navigation and shared state

Bare `menu`, `navbar`, `dock` and `megamenu` consume the canonical authorized page descriptors; bare `breadcrumbs` consumes the current declared destination ancestry. Actual subsets/order differences can supply a `pages=["/route",...]` attribute using declared static route shapes. Their titles, URLs, admission and locale variants remain owner-derived. This is a checked presentation selector, not a second route registry. Dynamic destinations use an explicit `link target=expr` in their current authorized context; no model id or access grant is inferred. `caption=expr` is optional when a safe destination caption already exists and required otherwise.

Every app uses the same static shell: a collapsible **right sidebar page menu**, the **user menu at the bottom right**, the common **user configuration dialog**, and the canonical **login screen**. Static describes the shared structure, not frozen permissions, captions or state: destinations still derive from admitted page descriptors. Mobile adapts this same shell to an accessible dismissible drawer. Apps do not select a different shell layout or author replacement account/settings/authentication controls. `menu`, `navbar`, `dock` and `megamenu` remain available as page-local presentations of canonical destinations; their availability is not a shell override. No `shell navigation=...` source setting is adopted.

`theme_controller` consumes the one existing Appearance setting and its finite theme mapping, previews, cancel/save and self-only persistence. `pagination` inside a collection consumes that collection's admitted cursor/filter/order state; elsewhere it is an error. Neither control invents an independent state store. `swap` without a selector owns only transient local view state; an explicit owned bool preference reuses canonical preference persistence. A readable business bool selects display only and cannot be toggled by the widget.

`progress expr max=expr` and `radial_progress expr max=expr` require readable numeric values with a finite positive maximum and compatible units. Out-of-range/unknown values are explicit invalid/unavailable presentation, never clamped into a successful business outcome. `countdown expr` displays a readable nonnegative numeric value or remaining duration using the pinned supported range; its optional shared clock update is view-only and cannot schedule or complete work. `toast` contains notice content and uses shared announcement/dismissal behavior. Authored text and actual invocation/delivery feedback remain distinct; no component fabricates receipt success.

### Grammar and option boundaries

The catalog assigns every word above one or more explicit contextual profiles: readable leaf, scope-transparent group, slotted group, collection renderer, field control, bound control or shared-state/navigation presentation. Existing sections, one-space suites and expression/attribute boundary rules remain. The following EBNF summarizes the approved profiles; it is not evidence of parser implementation:

```ebnf
catalog_item    = catalog_leaf | catalog_group | catalog_collection
                | field_control | bound_control | shared_control ;
catalog_leaf    = line(leaf_word [observations] component_attributes) ;
catalog_group   = group_word [expr] component_attributes suite(component_body) ;
catalog_collection = item_word [expr] component_attributes suite(slot_items) ;
field_control   = line(field_word selector component_attributes) ;
bound_control   = line("button" button_binding component_attributes) ;
button_binding  = "action" "=" expr | "submit" "=" "true"
                | "target" "=" expr | "opens" "=" NAME ;
slot_item       = "slot" NAME suite(ui_body) ;
```

`leaf_word`, `group_word`, `item_word`, `field_word` and `shared_control` expand through the following exhaustive profile table. The same declaration word is not globally reserved in field/parameter/expression name positions. Illegal parent contexts and mismatched payload/child shapes receive component-specific errors.

| Words | Header payload | Source/body profile |
| --- | --- | --- |
| `avatar` | image expression; optional `caption=expr`/`fallback=expr` | Leaf, no children; authorized image/fallback |
| `badge`, `status` | one readable typed value | Leaf; text-bearing state presentation |
| `kbd`, `mockup_code` | one text expression | Leaf; escaped display |
| `countdown` | one numeric/duration expression | Leaf; bounded view-only value |
| `progress`, `radial_progress` | one numeric expression and required `max=` | Leaf; checked compatible range |
| `divider` | optional caption | Leaf; omission is an uncaptioned divider |
| `loading`, `skeleton` | optional readable state expression | Leaf; omission is an explicitly authored placeholder, not inferred provider state |
| `card`, `hero`, `footer` | optional caption | Nonempty regular content suite; Hero/Footer may instead use their closed slot schema |
| `fieldset` | optional caption | Nonempty grouping suite within a field owner; no new fields |
| `aura`, `mask`, `join`, `stack`, `mockup_browser`, `mockup_phone`, `mockup_window` | none | Nonempty scope-transparent content suite |
| `hover_3d` | none | Nonempty noninteractive content suite; controls and interactive descendants are invalid |
| `tooltip`, `collapse` | required caption | Nonempty scoped content suite; Collapse shares current Details state |
| `accordion` | none | Nonempty suite of Collapse children only |
| `alert`, `toast` | optional readable notice expression | Expression-only leaf, or nonempty readable-content suite; no business invocation/activation children |
| `diff`, `indicator`, `chat_bubble` | none | Their required named-slot suite; optional slots exactly as specified above |
| `dropdown` | none | Required trigger/content slots with local activation binding |
| `modal`, `drawer` | required caption; optional `id=` | Required content slot; optional trigger/actions slots |
| `swap` | optional readable bool or owned bool preference | Required off/on slots; selection rules above |
| `carousel`, `hover_gallery`, `steps`, `timeline`, `text_rotate` | optional query/readable sequence | Required item-slot suite, repeated authored items or one per admitted row |
| `fab` | none | Nonempty canonical action-control suite; no batch transaction or independent handlers |
| `menu`, `navbar`, `dock`, `megamenu` | no positional expression; optional checked `pages=` | Bare derived-navigation leaf, or authored presentation suite; Navbar may use its slot schema |
| `breadcrumbs` | none | Derived-ancestry leaf; no manually authored alternative ancestry |
| `link` | required `target=expr`; optional `caption=` | Leaf with checked destination/file contract |
| `theme_controller` | none | Shared Appearance leaf |
| `pagination` | none | Leaf only within current collection context |
| `button` | exactly one binding as specified above | Leaf; canonical bound control |
| `input`, `textarea`, `checkbox`, `toggle`, `radio`, `select`, `range`, `rating`, `file_input`, `otp` | required input selector | Field-placement leaf; no copied schemas or child handlers |
| `filter` | required input selector or owned view preference | Context-checked selection leaf |
| `label` | required input selector; optional `caption=` | Field-placement leaf moving its generated label |
| `validator` | required input selector | Field-placement leaf moving its validation outlet |
| `calendar` | selector with no endpoints, or query with both endpoints | Field-control leaf or current agenda collection; written-shape dispatch above |
| `stat` | observations, or no positional value when slotted | Typed metric leaf or required value-slot suite |
| `list`, `table` | current query and required current attributes | Existing collection profile and scope rules |
| `tabs` | current optional owned enum preference | Existing selector leaf or nonempty Tab-child suite |

Menu/navigation children may contain canonical links/actions or scoped display groups, never route declarations or raw handlers. Bare navigation continues to derive authorized destinations. If a suite has direct `slot` children, its component must admit that slot schema and all direct children must be slots; otherwise it uses its ordinary content profile. There is no mixed regular/slot-body interpretation. An omitted body is legal only for an expressly listed leaf/default profile.

The outline above uses existing `expr`, `selector`, `observations` and ordinary `ui_item` definitions from GRAMMAR. New connections are:

```ebnf
ui_item        = core_ui_item | catalog_item | preference_panel | edit_group ;
component_body = ui_body | slot_items ;
slot_items     = slot_item {slot_item} ;
ui_body        = {ui_item} ;
preference_panel = "preferences" suite(ui_body) ;
edit_group     = "edit" attributes suite(ui_body) ;
```

`core_ui_item` denotes GRAMMAR's existing core UI productions, including the leaf edit control; `edit_group` adds its optional presentation suite. These are not a second runtime. Present suites remain nonempty. The profile table supplies the finite alternatives in `shared_control`, and each catalog entry expands `component_attributes` to its closed binding/structural options plus its checked appearance subset. Thus `pages=` is admitted only by the listed navigation profiles, `id=` only by activation components, `fallback=` only by Avatar with its safe-text contract, and `max=` only by compatible numeric displays. `slot_items` may repeat only a repeatable slot; cardinality and payload types are checked against the entry. `preference_panel` is legal only for an owner with a declared extension. No app-context shell-layout production is added.

Common appearance options are finite semantic tokens: `tone=neutral|primary|secondary|accent|info|success|warning|error`, `size=xs|sm|md|lg|xl`, `variant=solid|outline|soft|ghost`, and `orientation=horizontal|vertical`. Only components with the corresponding upstream/presentation capability admit an option; these are not universal accepted attributes or raw class strings. Ordinary text-bearing components may accept a localized `caption=expr`; input captions continue to derive from their fields. Component-specific bounds, slots and defaults belong in the same compiler-owned catalog. The full per-component appearance-option matrix remains to be checked against the pinned individual component documentation before those modifiers are advertised as supported; approval does not authorize guessed modifiers.

No component introduces `onclick`, operation schemas, CSS/HTML/JS payloads, arbitrary option bags or a second permission declaration. Unknown words, options, children, unsuitable field types and unsafe bindings must fail specifically. The catalog supplies source diagnostics/completion and renderer contracts from the same owning definition; it is not an authored app manifest. Highlighting alone cannot establish support.

### Complete design example

This example includes the owning model, grants, constrained operation inputs and inline behavior cases. Its presentation uses the approved design; neither parser acceptance nor execution is claimed. All team members can score these team-owned reviews under the explicit operation rule; a different audience would need its actual owning policy and guards.

```can
# Let teammates score and annotate review items.
app ReviewBoard
Given
 Review { title:text, score:int=1 min=1 max=5, note:text? }
 policy Review read=members
 fixture sample=Review {title="Opening checklist"}
When
 crud Review by=members fields=title
 # Record your score and an optional note for a team review.
 scenario score_review(review:Review,value:Review.score,note:Review.note) by=members
  do set review {score=value,note}
  examples review=sample
   value -> review.score
   5 -> 5
   6 -> error(validation)
Then
 page / title="Reviews"
  list Review
   badge row.score
   button opens=review_details
   modal "Score review" id=review_details
    slot content
     form score_review arguments={review=row} display=inline
      rating value
      ## note keeps its generated text control, caption and validation.
```

The button and modal retain the same current row; the protected review argument includes the canonical record/version binding. Rating obtains bounds from `Review.score`. The unplaced note remains present through the default remainder, and submit is generated. The modal's named external opener suppresses its default opener. No source copies the operation's input types into the UI.

These fragments are intentionally invalid under the approved contract:

```can
form score_review arguments={review=row}
 rating value
 range value
## Two writable controls for the same input: reject rather than choose one.

button action=score_review target=app_url("/")
## Two distinct bindings on one control: reject.

calendar row.due start=from
## Incomplete agenda header cannot become an inferred field control.
```

## Upstream behavior boundaries

Some names need more than stylesheet coverage:

- [Calendar](https://daisyui.com/components/calendar/) styles date-picker libraries; it does not supply their behavior. The existing Can agenda remains distinct. Select and pin an adapter during implementation, preserving canonical date/time input semantics; this design does not select a renderer/library.
- [OTP](https://daisyui.com/components/otp/) presents one input with visual segments. Code issuance, delivery, verification, expiry and rate limiting remain canonical authentication or explicitly declared business behavior.
- [Theme Controller](https://daisyui.com/components/theme-controller/) provides theme switching through CSS/input state. Can must connect it to the existing shared settings/persistence and preview/cancel behavior.
- [Validator](https://daisyui.com/components/validator/) presents input validity. Server schemas, ordered guards, authorization, versions and business rejections remain authoritative.
- [Dropdown](https://daisyui.com/components/dropdown/) and [Modal](https://daisyui.com/components/modal/) offer several markup/interaction patterns. Can must provide one shared accessible interaction contract rather than make every app choose a mechanism.
- [Hover 3D](https://daisyui.com/components/hover-3d/), [Hover Gallery](https://daisyui.com/components/hover-gallery/) and [Megamenu](https://daisyui.com/components/megamenu/) have component-specific child, image-count or placement constraints. Their Can contracts need those bounds plus keyboard, touch and reduced-motion handling.

Mockups, effects and navigation components are not excluded merely because the first drafts did not use them. Exposing them does not itself add a code editor, messaging backend, chart engine, new authentication method or arbitrary visual editor.

## Review and implementation sequence

The approved direct-keyword design matches the user's requested discoverability and authoring model. [Three JEV consultations](jev/daisyui-catalog-20261004/assessment.md) compared direct headers, a single typed component header and semantic display selections with a residual header. All selected direct names; their distributions differ materially, particularly the first near split. This is advice, not approval or proof.

Implement the approved binding contracts and finish the pinned appearance-option matrix against small complete source examples, retaining complete default forms and existing authority. Lane 5 owns the presentation catalog and shared UI library; lane 1 consumes that catalog for syntax/checking, emission, diagnostics/completion and highlighting. The migration coordinator replans each app's entire frontend against the full vocabulary and writes complete active authored sources and faithful desired-output witnesses first. A badge-insertion pass or minimal wrapper substitution is not that design process. Those reviewed drafts drive lane 5's UI contracts/renderers and lane 1's compiler; missing implementation is a downstream task, not a restriction on drafting. Check representative parent/field/slot errors and real accessible rendering as those implementations land. Track approved-but-unimplemented profiles explicitly; never substitute the old small subset for the completion criteria.

This adoption changes the documented language contract and implementation instructions. It changes no `.can` source, installed extension, parser or runtime. Current implementation evidence must be inspected in the owning lanes and merged PRs; this document does not certify their delivery. A complete inventory is required design scope, not executable component coverage. The [UI library prompt](../implementation/prompts/05-ui.md) owns rendering and the [frontend migration prompt](../implementation/prompts/08-frontend-catalog-migration.md) owns the app source design and migration.
