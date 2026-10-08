# Bounded enum contract — 2026-10-08

Selected: optional enum-only `match` with subject-owned single-name case
labels, complete unique coverage, an explicitly nonnull subject, separate
arm scopes, existing declared return checks and ordered owner execution.
Ordinary `if`/`else` retains deliberate fallback. Wildcards, OR-case lists,
guards, patterns, tagged unions and recovery are excluded. The compiler
lowers a once-evaluated subject through a JavaScript switch with scoped
arms; it adds no runtime invocation API or artifact capability.

The existing full-source comparison supplies no overall source savings.
The value is explicit opt-in rejection of newly added, omitted or duplicate
enum cases. Informational conditional analysis cannot provide that strict
guarantee; a strict conditional marker adds a public concept plus restricted
condition-shape and immutable-subject analysis. Match instead makes that
intent and finite domain explicit, while potentially repeating shared
effects. Existing boolean approval and localized UI authoring stay separate.

Three independently worded equivalent requests used the existing
preauthorized TypeSafe caller, without retry or source attachments. Surface
advice was split: strict conditional at confidence .51/probability .67;
match at .73/.82; strict conditional at .25/.50, with match .49. No rationale
was returned. Source investigation of the marker/shape obligation informs
the choice; probabilities do not establish a correctness or adoption win.
All three favored subject labels at confidence .83/.83/.88 and probability
.91/.91/.94. Existing expression lexical precedence remains unchanged.
Exact requests and replies are retained here.

`24b7e91d` passes the new genuine source/native enum case **1/1** and the
changed awaited delivery-state consumer **1/1**. Coverage, unknown cases,
nullable guards, branch scope, return types, unsupported wildcard, once,
permission order and failure propagation have direct outcomes. These native
hosts do not establish transaction rollback, installed forms, provider
execution or whole-app acceptance; the existing consumer owners retain
those duties. Canonical compiler completion remains **57/67**, with **10**
open references. No new review or proof packet was created.
