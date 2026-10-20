# Ask a private handbook and verify its evidence

Publish immutable handbook content, ask bounded questions as its designated reader, review protected evidence and verify that withdrawing a used source withholds the entire answer.

## Source and prerequisites

Download the complete [KnowledgeReview.can](../examples/runtime-ai/KnowledgeReview.can). Configure `deployment.knowledge`, profile `handbook` and policy revision `policy-1`, or replace the latter two with your configured values. Use synthetic text and a test team.

```sh
can check KnowledgeReview.can
can dev ui --source KnowledgeReview.can --preview-roles '{"Ava":["editor"],"Ben":[]}'
```

Ava publishes source content; Ben is the selected topic reader. The example gives one reader to each topic and keeps questions private to their requester. It is not an unrestricted shared chatbot.

## Publish a source and wait for indexing

As Ava, create topic “Demo office” with Ben as reader. Create its revision titled “Friday hours” with body “The demo office closes at 16:00 on Fridays.” Set `published=true`. The content is immutable: correction uses another revision and withdrawal of the old one, not an in-place body edit.

The actual corpus declaration is:

```can
corpus Handbook model=Revision scope=parent title=title content=body where=row.published and row.parent.active from=deployment.knowledge
```

Observe the source's `index` state. **Refresh** requests repair of that exact eligible revision subject to the rate limit; it does not immediately make the source searchable. Row policy still decides source access.

## Ask and review as the designated reader

As Ben, choose **Ask** on the topic and enter “When does the office close on Friday?” Observe `state`, `coverage` and safe detail separately. A succeeded run with no supported answer is valid; do not fill its absence with invented text.

Read the answer through `content row.answer` and inspect its evidence. The result is opaque `Handbook.Answer`, not a plain string with public `.text` or `.citations` fields. **Review** requires a currently available successful answer and stores Ben's own note; it does not certify the model's claims or make its evidence public.

## Verify withdrawal, scope and recovery

Withdraw the used revision as Ava. Reopen Ben's question: the whole answer and citations must be withheld even if the run still says succeeded. Every supplied source is rechecked, including uncited context. Changing topic access or removing membership likewise cannot leave cached permissions usable.

Ask a question the source does not answer, such as “What are the weekend hours?” Inspect unsupported evidence/coverage rather than assuming every successful request yields an answer. Try asking as a different ordinary member: the designated-reader guard refuses it. Editors do not inherit the originating reader's right to view grounded answers.

**Stop** requests cancellation; **Reconcile** observes the retained request identity after uncertainty. Neither submits another question. For a correction, publish a new revision, withdraw the old one and explicitly ask again. Publishing a second revision alone does not supersede the first in this simple app.

The [knowledge contract](../09-Runtime-AI/03-knowledge-corpora.md) supplies bounds, disclosure rules and historical/as-of behavior. Escalate a question through a separately authorized workflow; do not copy protected answer text to another principal to bypass those checks.
