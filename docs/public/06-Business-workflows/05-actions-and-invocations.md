# Actions and invocations

Use typed action references to bind records for a form, or complete invocation values to carry an entire local call. Both retain canonical operation rules, protected versions and current caller authority.

## Choose the right call value

An `action(...)` value is a typed reference to one or more enabled canonical user mutations. An `invocation(...)` is a complete typed call value for enabled local user mutations with operation identity and all required inputs. `action(target,{recordParameter=row})` binds every record parameter, preserving identity and expected version, and leaves non-record inputs to the form. An invocation instead supplies its owning input object with `invocation(target,{arguments})`. Arbitrary partial argument binding or conversion from text/JSON is invalid. Binding an action in a page or form does not create a second mutation implementation; the canonical operation still checks admission, current versions, guards, and rules.

## Review the complete proposed call

A reviewed invocation must show the complete operation and argument set, including target identity and expected version where relevant. Present that proposal to the authorized user and require explicit confirmation before execution. Tool or UI selection does not grant authority, and a model-generated suggestion is not consent. Never let an agent construct a privileged arbitrary call or bypass the operation schema.

The server validates the invocation again at execution and applies ordinary receipt/replay rules. See [scenarios](02-scenarios-and-effects.md), [operation permissions](../05-Permissions-and-policy/03-roles-and-operation-permissions.md), and the [reviewed AI recipe](../10-Recipes/05-reviewed-ai-actions.md).


## Follow a complete example

The [TaskForms tutorial](../07-Build-interfaces/04-forms-and-inputs.md) supplies the complete models, scenarios and page controls for both forms. Within its task list, this excerpt binds records and leaves the scalar note to the form:

```can
form action(complete_task,{project=task.project,task=task}) display=inline
 textarea note
 primary "Complete with note" submit=true
```

The `TaskForms.complete_from_invocation` scenario instead constructs all inputs and invokes the resulting value:

```can
let request=invocation(complete_task,{project=task.project,task,note})
call request {}
```

The latter is a `do`-body excerpt, not a page declaration or standalone program. It runs only after the user submits that scenario. `call request {}` supplies no substitute arguments. Both routes reach the same `complete_task` guard; an already-completed task is refused.

## Preserve local and remote boundaries

Local action calls and complete invocation values stay within the applicable owner transaction and run as the actual current caller. A bound remote action uses asynchronous `send` or its canonical form, with separate owner admission and correlated delivery receipts. Complete invocation values are for enabled local user mutations; they do not create remote transaction atomicity.

Remote projected actions carry runtime-validated bindings, compatible interface identity, principal/team, protected records/versions and expiry. Display text cannot route the call, and an adapter cannot fabricate authority. Null, expired or invalidated references have no submit control. Pending, failed, unknown and fulfilled remain distinct; fulfilled means the owning operation committed, not that a surrounding business workflow is finished.

Read forms remain static canonical reads. Trusted handlers, arbitrary target strings and runtime-discovered schemas cannot become action or invocation targets. An action type listing several targets is a closed allowlist; a supplied argument object must fit every possible target's remaining schema. Invalid schema combinations are diagnostics, not opaque JSON editors.

See [delivery recovery](../08-Connect-services/02-deliveries-and-recovery.md) for remote outcomes and [form conflicts](../07-Build-interfaces/04-forms-and-inputs.md#submission-outcomes) for keeping a draft separate from an uncertain request's identity.
