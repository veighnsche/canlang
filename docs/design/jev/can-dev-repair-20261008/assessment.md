# Jev consultation: first source-repair loop

**Status:** Historical advice on a patch-first interpretation, superseded by the user's keyword-help clarification. The three request/reply pairs ([1](01-request.json) / [reply](01-result.json), [2](02-request.json) / [reply](02-result.json), [3](03-request.json) / [reply](03-result.json)) preserve the complete submitted context, independently worded equivalent Choice questions, criteria, model output and usage. The current compiler facts were checked before asking: source-hashed diagnostics, lossless parse recovery and guarded edit transport exist, but no diagnostic syntax repairs ship. Jev is a typed decision model over supplied options, not a source-text generator ([TypeSafe description](https://typesafe.ai/blog/introducing-system-one-models-and-jev)).

| Route | Request 1 probability | Request 2 | Request 3 |
| --- | ---: | ---: | ---: |
| Compiler candidates, compiler validation, Jev ranking | 0.63 | 0.97 | 0.87 |
| Add a text-generating candidate fallback | 0.20 | 0.01 | 0.08 |
| Original agent repairs from focused error/examples | 0.17 | 0.02 | 0.05 |
| Silently normalize invalid source at compilation | 0.00 | 0.00 | 0.00 |

All three returned the first route (`jev-1.13.0`), with reported confidence 0.51, 0.96 and 0.83. The spread matters: the first response gives a substantial probability to a layered fallback and direct agent repair. These are judgments on a short synthetic comparison, not measurements of real unfamiliar agents, coverage of invented syntax, intent preservation, latency or token cost. The phrasing and supplied options can affect the result; the alternatives were kept equivalent across requests, but the consultation is not independent implementation evidence.

**Earlier patch-first interpretation (superseded):** Start with bounded grammar/declaration-derived candidate edits, reject candidates that fail their targeted check, and use Jev to rank plausible valid interpretations with a none/unclear choice. Return the exact revision-guarded patch in the development error. Preserve the original error if no trustworthy candidate exists. The original agent can use a canonical snippet to repair a guess outside candidate coverage; a future text-generating candidate source remains an option to evaluate against real failures. No candidate may silently grant permission, invent business effects, alter evaluation order, or change example expectations. Whether this workflow lets an unfamiliar agent complete a useful app with fewer tokens remains open and needs direct task evaluation. The current [dev-server draft](../../can-dev-server.md) uses keyword help as the primary error response.
