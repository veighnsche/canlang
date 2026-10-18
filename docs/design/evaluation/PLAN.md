# Can adoption evaluation

Evaluate whether the proposed CanLang product is designed to make it economical for a company to replace selected SaaS subscriptions with AI-generated applications tailored to its own operations. The intended company owns the application and its business rules. Its staff would use the browser or an authorized chatbot; they are not expected to author Can or maintain a conventional application stack.

The primary outcome is adoption. Token efficiency, reliable generation and editing, adequate interfaces, trustworthy behavior, operating cost and maintainability contribute to that outcome. A shorter source file is useful only when it preserves the required behavior. A feature-rich language is useful only when its complexity earns its place.

User clarification, 2026-10-04: one large SaaS subscription may be replaced by several smaller, composed Can apps. Evaluate the complete replacement of the company's required workflows, including cross-app work, rather than treating each app as an independent subscription saving or requiring parity with unused suite features. Include shared records and identity, permission continuity, navigation, reporting, migration, coordinated changes and recovery, integration upkeep, and any subscriptions the company must retain. Smaller business modules do not inherently require separate deployments. Composition's benefits and costs both need evidence; this clarification extends the evaluation framing without changing the captured source baseline.

This is an evaluation plan, not a decision to add features, rewrite the drafts or implement tooling. The existing design is reviewable. The evaluation must challenge assistant-created restrictions as well as proposed extensions. “Perfect” means pursuing the strongest defensible design for this audience; the audit cannot prove universal fitness or predict adoption from source inspection alone.


## Results and limits

The October 2026 evaluation considered authored design drafts and desired JavaScript examples. Those examples describe intended output; they do not establish compiler translation, running application behavior, production economics or adoption.

The retained [adoption report](ADOPTION.md), [language report](LANGUAGE.md) and [interface report](INTERFACES.md) explain the conclusions, concrete design problems and useful alternatives. [Remaining work](../../implementation/REMAINING-WORK.md) tracks current functional gaps. The original assessment checklist and coordinator protocol are complete historical process, not prerequisites for development.
