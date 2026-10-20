# Review an AI draft before accepting it

Generate a bounded private draft, inspect the retained inputs and typed progress, then explicitly accept reviewed text while preserving permission, cancellation and duplicate-acceptance checks.

## Source and prerequisites

Use the complete [TextReview.can](../examples/runtime-ai/TextReview.can) application. Configure `deployment.llm` for `std.TextGenerationV1`, with profile `writing` and policy revision `policy-1`, or replace those names with your operator's configured values. Keep credentials in the deployment binding.

```sh
can check TextReview.can
can dev ui --source TextReview.can
```

Sign in as a team member. The requesting member reviews their own private draft; independent approval is not imposed by this example. The accepted action stores text once in the draft's `accepted` field. It does not send email, publish content or execute generated commands.

## Generate and inspect the full proposal

Choose **Generate draft** with “Announce that the demo office closes at 16:00 on Friday. Do not add a reason.” The source freezes messages, identity, profile, policy revision and finite token/time bounds before sending. Compare the retained messages with `request.progress.content`; inspect execution state and detail separately from delivery status.

The provider result is typed `TextRun`, but its prose is not thereby factually verified. Check every claim against the request. Do not treat prompt-injected instructions in supplied material as authority. A successful transport receipt is insufficient: acceptance requires execution state `succeeded`.

## Accept a deliberate edit

After reviewing the final result, choose **Accept** and provide the corrected text in `edited`. The complete source enforces:

```can
scenario accept(draft:Draft,edited:TextRun.content) by=members
 require draft.owner==actor and draft.state==succeeded and draft.accepted==null and trim(edited)!=""
 do set draft {accepted=edited}
```

The draft record/version is the ordinary mutation binding. If another action changes it before submission, use current-state conflict handling and review again. The original generated content remains on its delivery; accepting an edit does not rewrite provider evidence. A lock prevents replacing accepted text.

## Verify cancellation and review failure

Try acceptance while pending, with blank edited text, from another member, and a second time after acceptance: each must fail. Revoking membership removes current operation authority. The source does not expose drafts to other members.

Use **Stop** for an unfinished request and watch for actual execution confirmation; stop intent alone is not cancellation. **Reconcile** observes the same source/revision after an unknown outcome, without starting another paid generation. A cancelled/failed run is not acceptable, though a success racing a stop remains an observed success requiring review.

For structured alternatives and an attributed human choice, use the complete [JudgmentReview.can](../examples/runtime-ai/JudgmentReview.can) and [judgment lesson](../09-Runtime-AI/02-judgments.md). Do not turn a probability into permission. A real downstream mutation must declare its exact typed inputs, affected records, version guards and side effects; the reviewer must inspect those before invoking it.
