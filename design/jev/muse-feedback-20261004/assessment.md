# Feedback C4 consultation evidence

Scope: safe public operator-decision history and an in-page Product selector. Inspected baseline: `99a53f93d2e3cccd392a6f328b5347e7d96b3128`. Requests separate verified existing semantics from proposed alternatives. They contain repository design facts and synthetic example text, no credentials or personal records. The standing AGENTS.md authorization applies; all three exact calls were accepted and completed. No automatic-review rejection was bypassed.

Verified sources: `draft/CanFeedback.can` Given/When/Then (current grants, review hook, roadmap/moderate bodies, preference and pages); `draft/CanFeedback.md` requirement/source/desired-target closure (the two identified gaps); DESIGN §§2/4 (containment, field locks, read grants, authority reports and transactions), §5.1 (shared-state examples), §9 (typed reference filters, defaults, collection scope, history disclosure), §13 (desired target maps and callbacks). Target witnesses include `draft/CanFeedback.mjs` schemas/page/result rows and `draft/CanRent.mjs` pure array results and `list.rows`. These are draft contracts, not running implementations.

The typed `choice` question fits a bounded architectural tradeoff. Each request asks the same two choices with independently rewritten context, question and criteria. History alternatives remain: A private snapshots with explicit release/current selection/permanent withdrawal; B current-review-epoch-only public history; C new shared per-revision audit publication/redaction semantics. Selector alternatives remain: A ordinary typed Product projection/reference filter; B new model-self selector contract. None is presented as proof of correctness.

| Request/result | History distribution A/B/C | Confidence | Selector distribution A/B | Confidence |
| --- | --- | --- | --- | --- |
| [1 request](request-1.json), [1 result](result-1.json) | 1.00 / 0.00 / 0.00 | 1.00 | 0.99 / 0.01 | 0.98 |
| [2 request](request-2.json), [2 result](result-2.json) | 0.99 / 0.00 / 0.01 | 0.99 | 1.00 / 0.00 | 0.99 |
| [3 request](request-3.json), [3 result](result-3.json) | 0.98 / 0.00 / 0.02 | 0.96 | 0.99 / 0.01 | 0.98 |

All replies used `jev-1.13.0` through `tools/jev.py`/`jev-latest`. There is no inter-request choice disagreement to investigate. The nonzero alternatives and decreasing history confidence remain recorded; these are correlated advisory responses, not independent statistical evidence.

The authored decision chooses A for both. It costs one private child model, one current reference and two explicit scenarios, but preserves prior approved decisions through harmless contributor review while enabling selective withdrawal. The epoch alternative is simpler only by dropping public continuity after reapproval. A shared audit capability could be useful elsewhere, but this app is fully expressible with present constructs. The Product projection copies two presentation fields but avoids introducing a global filter grammar/API solely for one model's own identity.

The [handoff](../../muse-migration-20261004/feedback-design.md) fixes exact release, hidden-draft, Product-unpublication, current-withdrawal, legacy-history and preference-clear behavior. It is a proposal awaiting coordinator acceptance, not an app correction already applied.

[Syntax checks](syntax-checks.json) validate an in-memory application of the changed Can blocks through the initial parser with its existing sequence excluded, plus separately wrapped JavaScript derive/handler/UI/sequence snippets through `node --input-type=module --check`. No app `.can` or `.mjs` was edited. These checks do not establish symbol/types, imports, run policies, execute transactions/examples, enforce direct-ID denial or render the Product selector.
