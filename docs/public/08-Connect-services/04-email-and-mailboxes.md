# Email and mailboxes

Receive verified mailbox messages, prepare and review a reply, then retain its durable delivery and reconciliation receipts. Use synthetic mail to distinguish provider acceptance, proven non-send and uncertainty.

## Sending

Build a typed message from authorized business state, freeze the recipient and content at submission, and send it as durable work. A successful enqueue is not proof of delivery. Use the typed completion and provider reference; if the outcome is uncertain, reconcile before resending. Do not place secrets or private data in subject/body without an explicit disclosure decision.

## Incoming mail

A verified `received` event carries a typed envelope with sender, thread, subject, body, completeness indicators and finalized attachments. Treat every field and attachment as untrusted. The handler runs with its declared trusted event authority, not an impersonated browser principal; any business mutation still goes through its canonical owner and invariants.

A reviewed reply freezes source identity, recipient, message, subject, body and attachments. `accepted`, `not_sent` and `unknown` are distinct outcomes; unknown is never evidence that no send occurred. See [delivery recovery](02-deliveries-and-recovery.md) and [service contracts](../13-Language-reference/04-service-contracts.md).


## Configure a test mailbox

This complete `MailReplies` app uses `std.MailboxV1` through `deployment.inbox`. The operator must install a compatible mailbox adapter, map a documentation mailbox to the app/team, configure server-only credentials and authenticate its received-event ingress. Assign the declared agent role to the test member; team ownership alone does not grant that role. See [the binding walkthrough](01-contracts-and-service-bindings.md).

Use a mailbox and recipient address controlled by the documentation operator. Addresses below are reserved synthetic examples, not destinations to send real mail. For ordinary one-way email and explicit recipient-language formatting, follow the complete [TaskMail example](../07-Build-interfaces/06-localization.md#send-notices-in-the-recipients-language).

## Receive, review and send with complete source

Save [MailReplies.can](../examples/files-mail-payments/MailReplies.can):

```can
# Review and send replies through a configured test mailbox.
app MailReplies
use std {MailboxV1 as Post,IncomingEmail,MailReply} from=deployment.inbox
Given
 role agent
 Message {mailbox:text,source:text,envelope:IncomingEmail,reply:Reply?}
 Reply in Message {request:MailReply,delivery:delivery(Post.reply)?,reconciliation:delivery(Post.reconcile)?}
 policy Message read=agent
 policy Reply read=agent
 unique Message fields=mailbox,source
 lock Message fields=mailbox,source,envelope
 lock Reply fields=request when=row.delivery!=null
 lock Reply fields=delivery when=row.delivery!=null
When
 scenario receive on=Post.received
  do
   let existing=first(Message as message where message.envelope.mailbox==event.value.mailbox and message.envelope.source==event.value.source)
   if existing==null
    create Message {mailbox=event.value.mailbox,source=event.value.source,envelope=event.value} as message
   else
    require existing.envelope==event.value
 scenario prepare(message:Message,to:MailReply.to,subject:text,body:text,attachments:file[]=[]) by=agent
  require message.reply==null and message.envelope.body_complete and message.envelope.attachments_complete
  require trim(body)!=""
  do
   let request=MailReply {source=operation.id,mailbox=message.envelope.mailbox,message=message.envelope.source,to,subject,body,attachments}
   create Reply {parent=message,request} as reply
   set message {reply}
 scenario revise(reply:Reply,to:MailReply.to,subject:text,body:text,attachments:file[]=[]) by=agent
  require reply.delivery==null and trim(body)!=""
  do
   let request=MailReply {source=reply.request.source,mailbox=reply.request.mailbox,message=reply.request.message,to,subject,body,attachments}
   set reply {request}
 scenario send_reply(reply:Reply) by=agent
  require reply.delivery==null
  do
   send Post.reply {value=reply.request} as delivery
   set reply {delivery}
 scenario reconcile(reply:Reply) by=agent
  require reply.delivery!=null and reply.delivery.result?.state!=accepted
  require reply.reconciliation==null or (reply.reconciliation.status!=pending and reply.reconciliation.result?.state!=accepted)
  do
   send Post.reconcile {source=reply.request.source} as reconciliation
   set reply {reconciliation}
Then
 page / title="Incoming messages"
  list Message
   text row.envelope.sender,row.envelope.subject
   text row.envelope.body,row.envelope.body_complete,row.envelope.attachments_complete
   action prepare
 page /replies title="Reviewed replies" poll=2s
  list Reply columns=delivery.status,reconciliation.status
   text row.request.to,row.request.subject
   text row.request.body,row.request.attachments
   text row.delivery?.result?.state,row.reconciliation?.result?.state
   action revise
   action send_reply
   action reconcile
```

Run `can check MailReplies.can`. Once the test binding and agent grant exist, launch `can dev ui --root . --source MailReplies.can --app MailReplies`, check its revision and open the preview as that agent.

The handler deduplicates mailbox/source identity and rejects changed content under that identity. It creates no fabricated signed-in actor. All inbound text and addresses are untrusted, even though the ingress source is authenticated. Received attachments must already have receiving-app finalization/provenance; raw foreign file IDs never become trusted files merely because the event type says file.

## Exercise a synthetic received message

Have the adapter's test facility emit a verified received envelope with these values. This JSON illustrates the declared `IncomingEmail` payload, not an unauthenticated browser endpoint or a command for forging ingress:

```json
{
  "mailbox": "documentation-inbox",
  "source": "demo-message-001",
  "thread": "demo-thread-001",
  "sender": "customer@example.test",
  "reply_to": null,
  "subject": "Receipt DEMO-001",
  "body": "Could you confirm receipt of my sample document?",
  "body_complete": true,
  "attachments": [],
  "attachment_count": "0",
  "attachments_complete": true,
  "received": "2026-10-20T09:00:00.000Z"
}
```

The integer count is a canonical wire string. Empty attachments are deliberate; a subsequent attachment exercise must transfer and finalize actual bytes through the verified adapter path.

1. Confirm the message appears once. Redeliver the identical occurrence and a duplicate with the same mailbox/source; no extra message or reply should be created. Changed content under that identity is refused.
2. Choose prepare. Enter the controlled test recipient, subject `Re: Receipt DEMO-001` and body `We received your synthetic receipt. No payment was taken.` Attach a public-safe finalized sample only if needed.
3. Open Reviewed replies. Check the exact recipient, subject, body and attachments. If necessary, use revise while no delivery exists; revise supplies the complete intended recipient/content again, retaining the logical reply source.
4. Choose send_reply once. This freezes the request into durable work. The draft and original association can no longer be changed through these operations.
5. Observe delivery status and the typed result. `accepted` establishes provider acceptance of that frozen reply, not proof that the recipient opened or even received it.

The prepare guard rejects incomplete bodies or attachments instead of presenting partial mail as complete. It allows one reply record per message in this lesson. The reply address is explicitly reviewed rather than automatically trusting sender/reply-to headers. The app intentionally exposes received mail only to agents in the configured team.

## Reconcile instead of guessing whether mail sent

If delivery is unknown or its transport fails, use reconcile. It sends `Post.reconcile` with the original reply source and retains a separate receipt. It does not call reply again or change the recipient/content. A pending reconciliation blocks another one; known acceptance also blocks unnecessary repeated reconciliation through this source flow.

| MailReplyOutcome state | Meaning | Consequence |
| --- | --- | --- |
| accepted | Provider accepted the exact frozen reply, with its reference | Do not resend merely because transport feedback was delayed |
| not_sent | Authoritative proof that it has not sent and old uncertainty cannot later send | Any retry policy must preserve the frozen source/payload; this focused app has no resend operation |
| unknown | Acceptance is unresolved | Keep uncertainty visible and reconcile original work |

A failed delivery alone is not not_sent. Reconciliation's transport status and domain outcome are separately displayed, as are the original send's status and result. Provider callbacks and receipt changes do not silently rewrite message content or invent a successful send. Changing the reviewed request after a committed send is a different business intent, not a retry.

Test lost responses and repeated reconciliation using the sandbox adapter. Confirm another ordinary team member cannot read message/reply content or send through agent-only operations. Never display raw provider errors, credentials or private headers as troubleshooting text.
