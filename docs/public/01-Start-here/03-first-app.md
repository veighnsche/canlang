# Build your first app

This tutorial builds a complete small `Tasks` app: users create tasks, see only tasks readable to them, edit permitted fields, and use a generated page. The `Tasks` app owns its records and routes; it is not a fragment for another package. Start after [installing CanLang](02-installation.md). See [models](../03-Data/01-models-and-relationships.md) and [operation permissions](../04-Access-and-rules/02-roles-and-operation-permissions.md) for the full semantics.

```can
# Manage team tasks.
app Tasks
Given
 Todo { title:text trim, done:bool=false }
 policy Todo read=members
When
 crud Todo by=members fields=title,done
Then
 page / title="Tasks"
  form Todo.create display=inline
  list Todo columns=title,done
   edit
   delete
```

The app identity comes from `app Tasks`. `Todo` is a stored model. `crud` derives create, update, and archive-delete operations whose call eligibility is restricted to current members. The policy grants members reads of this team's tasks and ordinary fields; a page or hidden button is never the authority. `fields` is the mutation allowlist, so an update cannot assign another field by submitting extra data. `list` uses the authorized model query.

Check the source before emitting or previewing it using the commands for your installed CLI in the [CLI reference](../12-Reference/01-cli.md). This is a complete app source example, but local preview still needs the configured runtime and identity context described in [local development](../09-Development/01-local-development.md). To add a business action with its own guard, continue to the [first workflow](04-first-workflow.md).
