# Step 2 contract decisions

2026-10-07. Frozen planning choices for separately released contract packets. Implementation remains deferred; these choices do not qualify installed libraries, targets or larger port tasks.

## Import semantics and first faults

Select lexical import records with decoded JavaScript literal identity for resolution, original UTF-16 edit spans and quote-safe replacement. Keep the original from/reexport, literal-dynamic, side-effect group order and complete error envelopes for formerly recognized real imports. Removing comment/string false positives, recognizing additional real import forms and handling escaped literals by their JavaScript meaning are explicit planned corrections, not byte-neutral claims. Artifact-authored computed imports are refused by a named new admission error; parsing failure precedes per-module import policy. Exact new messages and old envelopes belong to the import packet.

Opposing evidence: a pure source-order policy would be simpler, and preserving raw literal spelling would minimize some old refusals. The selected direction keeps existing first-fault grouping while resolving actual JavaScript identity without permanent regex/lexer profiles. Its actual compatibility and new syntax/error behavior require finite fixtures and target qualification before adoption.

The existing trusted runtime intentionally uses computed imports (`runtime/invoke.ts`, `worker/main.ts`, `worker/assembly.ts`, `runtime/env-assembly.ts`), and `deploy/bundle.ts` has an explicit constant-specifier rewrite seam. Therefore the new computed-import refusal is limited to artifact-authored modules. Trusted runtime/worker/vendor computed imports remain `dynamic_unchecked` under their existing owning host gates; they are never certified by literal-link closure. No AST/data-flow evaluator or invoke rewrite is selected here. This source counterevidence narrows the JEV advice; it does not justify a blanket import ban.

## Raw maps and library adoption

Freeze the actual current external raw-map observations as the compatibility oracle. Pin candidate libraries and recipes, but hold D03 substitution on the concrete sorting, duplicate selection, signed-zero/overflow and raw-source-identity differences. Keep the current decoder until a bounded qualification demonstrates a small sufficient adapter or a separately justified profile/semantic correction. Do not build another complete decoder merely to force a library adoption claim.

Opposing evidence: a canonical-only library profile could simplify the implementation, and explicit legacy routing could preserve older inputs. Both change the maintenance/admission seam. Current code does not already enforce strict ordering, nonnegative coordinates or overflow refusal. Such new restrictions require their own decision and consumer witnesses. The map contract releases independently of that adoption verdict; numeric and import packets continue without waiting.

## Advisory process and uncertainty

Three independently worded equivalent two-question JEV requests are preserved in [jev/](jev/). All three recommend decoded-compatible lexical imports (reported confidence 0.84, 0.84, 0.71) and retaining the raw contract with an adoption gate (0.99, 0.95, 0.98). The responses are advice, not a target test or three independent product implementations. Remaining uncertainty includes actual bundled computed-import coverage, map compatibility adapter cost and composition through raw identities. No library is accepted merely from upstream documentation or these responses.

## Shared decision-record handoff

`docs/specification/DECISIONS.md` has a concurrent foreign writer and dirty changes. This owned record retains the choice, rationale and uncertainty without modifying that writer's bytes. Copying/linking these entries into the shared record is a pending exact-file handoff before affected implementation activation. This planning step neither advances the living file-tree checkpoint nor grants permission to implement its broader backlog.
