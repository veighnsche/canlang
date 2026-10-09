# Construct-help ownership consultation (2026-10-09)

Three independently worded, equivalent Jev Choice requests compared the same four ownership models using verified Can context: [request 1](01-request.json), [request 2](02-request.json), [request 3](03-request.json). Complete [response 1](01-result.json), [response 2](02-result.json), and [response 3](03-result.json) are retained. The model was `jev-1.13.0` and returned choices/probabilities, not rationale.

| Request | Selected model | Probability for selected model | Confidence | Other material probability |
| --- | --- | ---: | ---: | --- |
| 1 | Compiler registry | 0.87 | 0.83 | Derived sources 0.08; documentation registry 0.05 |
| 2 | Documentation registry | 0.36 | 0.15 | Derived sources 0.33; compiler registry 0.30 |
| 3 | Compiler registry | 0.50 | 0.33 | Derived sources 0.42; documentation registry 0.08 |

The disagreement is material: request 2 nearly tied three approaches, and request 3 was close between compiler and derived ownership. None supplies a reason that would resolve the tradeoff. The response supports rejecting dynamic completion alone as the complete source of signatures, meaning, examples, IDs and links; it does not establish that a runtime registry already exists or that one location has been implementation-qualified.

**Selected design-stage choice:** keep one reviewable, anchored help entry per Can authoring construct in the proposed reference. The owning grammar, semantic design, UI catalog and builtin catalog remain normative for their respective syntax and behavior. At implementation, the compiler should own a structured, versioned projection of those cards and check it against the owning sources; the readable reference must then be generated from that one projection or retired as an authored catalog. The current document is not itself a shipped `can dev` API. Availability must be checked against the selected compiler/runtime profile before an entry is called a working suggestion.

**Remaining uncertainty:** exact serialization, generation direction, UI/builtin projection mechanics, complete parser/checker/runtime qualification and the measured advantage of Jev ranking remain open. A single manually maintained document is acceptable for the pre-planning review, but two independently edited catalogs are not.
