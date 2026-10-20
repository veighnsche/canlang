# Service contracts

Look up standard service operations, typed request and result schemas, and delivery constraints before binding files, mail, payments or runtime AI to an application environment.

## Standard capabilities

Source names the capability and operation; deployment binds it to an implementation. An operation input is frozen at send time. `std.OperationOutcome` is the shared structural result `{source:text,revision:int,state:enum(pending,confirmed,unavailable,failed,unknown,released),reference:text?,detail:text?}`; it reports business workflow state and does not automatically change records.

The `-> Result` type describes the eventual provider result, not the enqueue receipt. `delivery(Capability.operation)` is the observable association; completion carries its typed result or safe error. Queues likewise publish declared payload types and consume typed messages through their declared handler.

The accepted standard capabilities include EmailV1, PaymentsV1, ErrorsV1, MailboxV1, TextGenerationV1 and ImagesV1 in std. Typed analytics is a native resource declaration, not an invented standard capability. Their source-owned names and wire shapes come from the capability owner; deployment-specific provider adapters do not redefine the public contract.

For example, an image request freezes source/revision, validated workflow, prompt, dimensions, output count and duration bound; progress reports sequenced state and finalized file outputs. Mailbox reply freezes recipient and content; `unknown` outcome requires reconciliation, not blind resend.

## Native resources and limits

D1 is the default business store; an explicit model at= can route its owner to a declared Durable Object binding. Declared queues carry typed work and may redeliver; consumers must be idempotent. Native KV is only a cache for explicitly public, reconstructible values. Analytics is telemetry, not authoritative audit or billing. These bindings cannot grant permissions or change transaction ownership. Resource quotas and adapter mappings belong to deployment configuration.

Use [contracts and bindings](../08-Connect-services/01-contracts-and-service-bindings.md) for authoring, [deliveries](../08-Connect-services/02-deliveries-and-recovery.md) for failure and retry, and [instrumentation](../12-Deploy-and-operate/06-instrumentation.md) for analytics handling.

## Exact operation surfaces

Use `use std {EmailV1 as Mail} from=deployment.mail` in the consuming owner; the same bound import applies to the other versioned interfaces. These signatures describe standard contracts, not complete app declarations. All fields are required/nonnullable unless marked `?` or given a default. Every send requires `as attempt`; the eventual result types below are separate from the enqueue association.

| Capability | Operations and verified events |
| --- | --- |
| `std.EmailV1` | `send(to:email,subject:text,body:text,attachments:file[]=[]) -> EmailAccepted`; `send_user(to:user,subject:text,body:text,attachments:file[]=[]) -> EmailAccepted` |
| `std.PaymentsV1` | `collect(customer:text,amount:money,reference:text,consent:text?=null) -> PaymentState`; `refund(payment:text,amount:money,reference:text) -> PaymentState`; `cancel(reference:text) -> PaymentState`; `reconcile(reference:text) -> PaymentState`; `changed` with the fields of `PaymentState` directly |
| `std.ErrorsV1` | `report(event:ErrorReport) -> ErrorAccepted` |
| `std.MailboxV1` | `reply(value:MailReply) -> MailReplyOutcome`; `reconcile(source:MailReply.source) -> MailReplyOutcome`; `event received {value:IncomingEmail}` |
| `std.TextGenerationV1` | `generate(value:TextRequest) -> TextRun`; `cancel(source:text,revision:int) -> TextRun`; `reconcile(source:text,revision:int) -> TextRun`; `event changed {value:TextRun}` |
| `std.ImagesV1` | `inspect(graph:file) -> WorkflowInspection`; `validate(value:WorkflowDefinition) -> WorkflowValidation`; `submit(value:ImageRequest) -> ImageRun`; `cancel(source:text,revision:int) -> ImageRun`; `reconcile(source:text,revision:int) -> ImageRun`; `event changed {value:ImageRun}` |

Judgments derive their own versioned evaluate interface and generated result from the authored question set; there is no second generic judgment API to author. See [judgments](../09-Runtime-AI/02-judgments.md). Corpus declarations similarly derive their answer/cancel/reconcile/refresh and pure reads; see [knowledge corpora](../09-Runtime-AI/03-knowledge-corpora.md). Historical adapter package names such as ai.ChatV1 and ai.SystemOneV1 are not replacements for these source-owned interfaces.

## Mail, payments and errors

`EmailAccepted` and `ErrorAccepted` each contain `reference:text`. `ErrorReport` contains `id:text`, `message:text`, `occurred_at:datetime`, `stack:text?`, `release:text?` and `environment:text?`. Error reporting must not expose secrets or confidential payloads.

`PaymentState` contains `reference:text`, `revision:int`, `provider_reference:text?`, `amount:money`, `status:enum(pending,unknown,succeeded,failed)`, `checkout_url:url?` and `failure:enum(transient,action_required,permanent,cancelled)?`. Failure classification is present only for definite failed outcomes. Revision is monotone per attempt; the same revision has identical business content.

Collection/refund amounts are positive. Reusing a reference with changed arguments fails. Consent text requests off-session collection but is not proof of a current suitable mandate; binding validation remains required. Without consent, collection requests ordinary checkout. Cancel disables new checkout use; it is not a refund and does not erase possible prior collection.

Success remains success, and uncertain collection requires reconciliation.

Mailbox types have these closed fields and bounds:

```can
contract IncomingEmail {mailbox:text min=1 max=200,source:text min=1 max=1000,thread:text? max=1000,sender:email,reply_to:email?,subject:text max=300,body:text max=30000,body_complete:bool,attachments:file[]!,attachment_count:int min=0,attachments_complete:bool,received:datetime}
contract MailReply {source:text min=1 max=1000,mailbox:IncomingEmail.mailbox,message:IncomingEmail.source,to:email,subject:text max=300,body:text max=30000,attachments:file[]!}
contract MailReplyOutcome {source:MailReply.source,state:enum(accepted,not_sent,unknown),reference:text?,detail:text?}
```

These are schema witnesses, not declarations to copy into an app. Sender/reply-to and thread IDs are untrusted evidence. Accepted means provider acceptance of the exact frozen reply, with a nonnull reference. Not_sent requires authoritative proof that this logical reply has not sent and an earlier uncertain request cannot later send; timeouts/failed delivery do not prove it. Reconcile never resends. Retrying after proven not_sent keeps the same frozen source and payload; changing the request under that source fails.

`send_user` privately resolves a verified address only for a current active same-team user after the dispatch guard/claim succeeds, then pins that address and user/team. Later transport retries recheck membership but never substitute a changed address. Directory failure is an operational failure, not an ineligible-user fact. Reconcile uses the original provider identity without resolving or resending.

## Text and image request/result types

These schema witnesses are the standard payloads referenced by the operation table. Bounds reject excess instead of truncating.

```can
contract TextMessage {role:enum(system,user,assistant),content:text max=65536,attachments:file[] max=8}
contract TextRequest {source:text,revision:int min=1,profile:text,policy_revision:text,messages:TextMessage[]! min=1 max=128,max_input_tokens:int min=1,max_output_tokens:int min=1,max_duration:duration}
contract TextRun {source:text,revision:int min=1,sequence:int min=1,state:enum(queued,running,succeeded,failed,unknown,cancelled),content:text max=65536,used_tokens:int? min=0,detail:text?}
contract WorkflowInput {node:text,key:text}
contract WorkflowField {node:text,key:text,kind:enum(text,int),label:text}
contract WorkflowInspection {fields:WorkflowField[]! max=256,detail:text?}
contract WorkflowDefinition {graph:file,prompt:WorkflowInput,negative:WorkflowInput,width:WorkflowInput,height:WorkflowInput}
contract WorkflowValidation {valid:bool,digest:text?,detail:text?}
contract ImageRequest {source:text,revision:int min=1,workflow:WorkflowDefinition,validation:text,prompt:text max=8192,negative:text max=8192,width:int min=256 max=1536,height:int min=256 max=1536,max_outputs:int min=1 max=4,max_duration:duration}
contract GeneratedImage {position:int min=0 max=3,image:file}
contract ImageRun {source:text,revision:int min=1,sequence:int min=1,state:TextRun.state,outputs:GeneratedImage[]! max=4,charged_jobs:int? min=0 max=1,detail:text?}
```

Positive sequence increases per binding/source/revision; equal-sequence bodies must match. Queued/running/unknown snapshots retain null usage. Succeeded/failed/cancelled execution and final content/output identities are immutable; initially null terminal usage may settle once in a later sequence. Text usage counts input plus output within frozen limits. Image charged_jobs is zero only with proof of no charge, one for the admitted job, or null while unsettled. These are resource allocations, not monetary invoices.

Inspect/validate never queue generation. Validation binds graph bytes, four distinct mappings, permitted node/input/model/resource definitions, destination policy and binding revision. Submit rejects mismatching digest/graph/mappings and unsafe graph behavior. Images transfer supported PNG/JPEG bytes into receiving-app finalized file references; positions remain unique and never change bytes.

A successful run has at least one output within its requested maximum. Failed/unknown partial recovery outputs remain explicit and private. Cancel records run-specific intent, including before submit, and never invokes a global interrupt against other users; reconcile observes without starting a replacement.
