# Judgments

Judgments evaluate an authored, versioned question set and return typed probabilities or choices. Business policy decides which results require human review and which authorized operation may act on them.

## Authored specification

Define NOUL questions with instructions and optional paired yes/no criteria, choice questions with declaration-ordered options, and score questions with ordered levels. The compiler derives result fields from the declaration; retain the specification revision and language with every evaluation. Display wording may be localized, but inference uses the frozen source-language specification.

A result contains `specification_revision`, actual model identity, input/output token accounting and each typed answer. NOUL yields a probability; choice yields the selected option, option distribution and confidence; score yields a value, ordered level distribution and confidence. These outputs are estimates, not authorization, verified facts or automatic state transitions. Apply an outcome only through a separately authorized operation with human review where the business policy requires it. See [reviewed AI actions](../11-Recipes/05-reviewed-ai-actions.md).

## Source and derived interface

This Given fragment defines a static question set, requiring a containing source owner:

```can
judgment Triage version=1
 relevant noul "Does this concern the current request?" yes="Directly relevant." no="Unrelated."
 route choice "Choose the destination." {support="Support",sales="Sales"}
 urgency score "Assess urgency." [routine="Routine",soon="Soon",immediate="Immediate"]
```

NOUL `yes` and `no` are both present or both absent. A static judgment derives `evaluate(state:text) -> Triage`, the immutable `Triage.specification:std.JudgmentSpec`, choice enum `Triage.route.choice` and ordered level enum `Triage.urgency.level`. Import an exported judgment with the ordinary bound `use` form and invoke its derived evaluate operation through `send ... as attempt`; do not redeclare an `ai.SystemOneV1` capability around it.

Runtime-choice questions use the accepted `options=runtime` form, optionally beside authored fixed choices. Such a declaration derives `Name.options`, `evaluate(state:text,options:Name.options)` and the pure `Name.specification(options)` function; request-local candidates use checked text IDs rather than fabricated dynamic enums. Static declarations retain their constant and original evaluate signature.

State is limited to 40,000 Unicode scalars. The portable profile allows 1–32 questions, 2–26 choice options, 2–10 score levels, at most 2,000 scalars per instruction/criterion and 24,000 combined specification scalars. Unsupported capacity fails before invocation, without truncation. Results must contain each question exactly once, exact option/level identities, bounded finite decimals and nonnegative integer usage. Distribution sums, selected maximum and score expectation use tolerance `0.000001`; score is the weighted zero-based level index in `[0,N-1]`, not a chosen level. Invalid or partial answers fail the delivery. Confidence has no guaranteed calibration.
