# Translate task interfaces and outbound messages

Use inline translations, shared messages, typed parameters and plural forms without changing business values. Select viewer language for pages and recipient language for durable outbound notices.

## Start with the translated task app

The complete [TaskPreferences app](05-settings-and-preferences.md#start-with-the-complete-taskpreferences-app) contains English source text and Dutch translations. Run it first to try browser language selection; the complete outbound example below adds an explicit mail-service prerequisite.

Translation is presentation. It does not change record identities, enum values, policies, business comparisons or stored user text. A task titled Release checklist remains that stored title when its surrounding page becomes Dutch.

## Write inline translations with @{...}

```can
"Tasks"@{nl="Taken",de="Aufgaben"}
```

This expression is a message descriptor for a single caption, such as a page title. The `@{...}` suffix maps explicit locale keys to translations; it is not string interpolation. A simple key such as `nl` can be unquoted; a tag such as `"pt-BR"` uses a quoted key. Plain `{field=value}` constructs a value object and has a different purpose.

A string without the suffix remains literal text. `"Tasks"@{}` explicitly creates a source-only descriptor. A null variant is absent; an empty string is a valid empty translation. Reject duplicate canonical locale tags and a variant repeating the owner's source language.

Each app/package owns a source language, English by default. An actual different language is declared on its header, for example `app MijnTaken source="nl"` with its own complete body and Dutch description. This is distinct from `context` / `locale default="nl"`, which changes viewer fallback. Imports and file moves preserve the original message's owner and language.

## Reuse complete named messages

TaskPreferences declares these complete shared meanings in `Given`:

```can
message add_task = "Add task"@{nl="Taak toevoegen"}
message task_count(n:int) = "{n, plural, =0 {No tasks} one {# task} other {# tasks}}"@{nl="{n, plural, =0 {Geen taken} one {# taak} other {# taken}}"}
```

Use `add_task` directly; a static message has no parameter parentheses. Use `task_count(count(Todo))` for the typed message. Named messages require a descriptor on the right, even if only the source variant exists. Prefer inline wording for single-use captions and named messages when the complete wording is actually shared.

An exported message can be imported with `use Owner {add_task,task_count as count_tasks}` when that provider exports those names. That is a composition fragment, not an extra dependency needed by TaskPreferences. A message-only import brings pure message assets and reachable parameter schemas, not the provider's models, handlers, pages or app context. See [composition](../02-Language-foundations/04-apps-and-packages.md).

## Bind parameters and pluralize whole messages

TaskPreferences shows the following results for readable task counts:

| Count | English | Dutch |
| --- | --- | --- |
| 0 | No tasks | Geen taken |
| 1 | 1 task | 1 taak |
| 2 | 2 tasks | 2 taken |

Exact numeric cases such as `=0` take precedence, then the selected language's plural category, then mandatory `other`. `#` is the nearest enclosing plural's formatted number. Translate the entire sentence; do not concatenate translated words around a count.

Anonymous parameterized messages bind arguments explicitly too. This expression can replace the count expression within TaskPreferences's `text` leaf:

```can
"{n, plural, one {# task} other {# tasks}}"@{nl="{n, plural, one {# taak} other {# taken}}"}(n=count(Todo))
```

There is no implicit capture of a local variable named `n`. Every placeholder used by any variant must be bound and type-checked, even if another variant omits it. Nonnullable scalar display values are supported, including exact numbers, money, dates and datetimes. Records, files, secrets, arrays, JSON and objects are not message arguments; select a permitted readable scalar instead.

The bounded ICU profile includes named placeholders, number/integer formatting, date/time formatting, plural, selectordinal and select, with `other` branches. It excludes plural offsets, rich-tag handlers, arbitrary functions and custom skeletons. JSON escaping is the outer string layer; ICU uses apostrophe quoting and doubled apostrophes for literal apostrophes. A rendered message is escaped text, not executable markup.

## Label fields, cases and operations

The task model changes boolean captions without changing true/false values:

```can
Todo {title:text trim min=1,done:bool=false label={values={true="Finished"@{nl="Afgerond"},false="Open"@{nl="Open"}}}} label="Task"@{nl="Taak"}
```

This replaces the same declaration in the complete app, not a second model. A field label object can contain `text=caption`, `values={case=caption,...}`, or both. Exact enum/bool cases remain machine values. Omit an unchanged field caption rather than repeating it.

`label={create=add_task}` on CRUD supplies the create caption; update/delete retain their shared captions. Labels for declarations are static text/descriptors or static named messages, not parameterized messages. Runtime catalogs own standard Save/Cancel/Delete and common typed labels; applications author domain-specific wording rather than copying the base catalog.

An attached translated `#` description belongs to the next declaration. Ordinary `##` comments do not become UI text. Routes, resource keys and machine identifiers are never localized. MCP descriptions remain source-language text under the documented interface contract.

## Resolve viewer language and fallback

Browser selection uses the saved viewer preference, then the browser language priority list, then the application default. The implicit app default is English; omit an unchanged default. Offered locales come from the default and reachable authored source/variant tags, not unrelated files. Declaring a locale does not certify complete translation coverage.

Each complete message performs RFC 4647 locale lookup, then app-default lookup, then its owning source variant. Absent variants are skipped, but empty text is not missing. Formatting and plural rules follow the selected variant's language, including fallback. Native money/date/time presentation preserves exact amounts, currencies and instant/civil-date meaning; localization does not perform currency conversion.

Changing Language refreshes presentation while retaining stable identities and current access checks. Labels, descriptions and input shapes must not become a new authorization context.

## Send notices in the recipient's language

`TaskMail` is a separate complete application. It needs an operator-configured `deployment.mail` binding implementing `std.EmailV1`, using a test provider/mailbox and synthetic contacts for this exercise. Source checking does not configure or contact the provider. See [environments and secrets](../12-Deploy-and-operate/01-environments-and-secrets.md) and [email](../08-Connect-services/04-email-and-mailboxes.md).

Save this complete file as `TaskMail.can`, also available in the [handbook source](../examples/task-preferences/TaskMail.can):

```can
# Send task notices in the recipient's chosen language.
app TaskMail
use std {EmailV1 as Mail} from=deployment.mail
Given
 Contact {name:text trim min=1,email:email,preferred_locale:locale?}
 Todo {title:text trim min=1}
 message notice_subject = "Task reminder"@{nl="Taakherinnering"}
 message reminder(name:text,title:text) = "Hello {name}, please review {title}."@{nl="Hallo {name}, bekijk {title}."}
 policy Contact read=members
 policy Todo read=members
When
 crud Contact by=members fields=name,email,preferred_locale delete=none
 crud Todo by=members fields=title delete=none
 scenario notify(contact:Contact,task:Todo) by=members
  do
   send Mail.send {to=contact.email,subject=format(notice_subject,locale=contact.preferred_locale),body=format(reminder(contact.name,task.title),locale=contact.preferred_locale)} as notice
Then
 page / title="Task notices"
  form Contact.create display=inline
  form Todo.create display=inline
  form notify display=inline
```

Run `can check TaskMail.can`. With the test mail binding configured, start `can dev ui --root . --source TaskMail.can --app TaskMail`, check the revision and open the preview as a team member. Create a synthetic contact using a mailbox you control, set preferred locale to `nl`, create a task and submit notify once.

For contact name Alex and task title Release checklist, the Dutch body is `Hallo Alex, bekijk Release checklist.` The title is inserted as stored. `format(...,locale=contact.preferred_locale)` returns human text using that recipient preference; null selects the app default, never the sender's viewer locale. The mail app deliberately allows its team members to manage contacts and send notices; use narrower authored permissions for a different business requirement.

The localized `format` overload differs from machine-template `format(template,values)`. Localized text has presentation provenance and cannot drive authorization, business queries/transitions, correlation keys or ordinary business-model fields. Human outbound and diagnostic sinks can consume it; arbitrary adapter fields are not human-text sinks merely because they are named message.

The durable delivery intent freezes recipient, final text, selected locale and pinned formatting release before retries. Changing a contact's language or deploying a new translation must not re-render an already committed notice. A queued request is not proof of delivery. Unknown outcomes require [delivery reconciliation](../08-Connect-services/02-deliveries-and-recovery.md), not a second send under a new identity.

## Verify translations and outbound wording

1. In TaskPreferences, inspect counts at zero, one and two tasks in English and Dutch. Check plural branches and the preserved stored task title.
2. Change Language and inspect task/boolean/preference labels. Confirm wire values and saved tab selection do not change.
3. Inspect a message lacking the requested variant and confirm whole-message fallback; an empty translation must not be treated as absent.
4. In the configured TaskMail test environment, send a Dutch notice while the viewer uses English. Verify recipient-based wording in the test mailbox.
5. Clear the contact's preferred locale and make a new deliberate send. Verify app-default wording. A later locale change must leave the earlier committed delivery's text intact.
6. Verify delivered versus pending/failed/unknown status through the mail binding's diagnostics. Do not infer delivery from source checking or the form's accepted enqueue alone.
