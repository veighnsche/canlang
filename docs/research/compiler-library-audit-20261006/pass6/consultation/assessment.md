# Advisory assessment and investigation

Three fresh independently worded context/question/criteria requests ran through the preauthorized JEV API after initial sandboxed network failures. Saved model: jev-1.13.0. Advice is uncertain, not an oracle.

| Request | Engine choice (confidence; probabilities A/B/C) | Error choice (confidence; probabilities owned/static/mapped) |
| --- | --- | --- |
| 1 | retain_bounded (.36; .42/.01/.57) | owned_native_reason (.34; .55/.39/.06) |
| 2 | pinned_cursor (.78; .85/.01/.14) | static_categories (.76; .13/.84/.03) |
| 3 | pinned_cursor (.65; .76/.00/.24) | owned_native_reason (.49; .66/.33/.01) |

Engine alternatives: A small single-pass bounded cursor/visitor, B bounded validation plus raw reconstruction (not qualified), C existing proven bounded grammar. Error alternatives: keep static coarse categories, own library reason, or maintain static detailed string mappings. A two-vote majority does not erase the substantial retain-parser probability in request1 or static-message advice in request2.

Investigation: the verified prototype is roughly90 compatibility lines replacing roughly280 grammar/UTF-8 lines. It preserves numeric lexemes without arbitrary_precision/sentinel translation, stops deep input after66bytes and adds no features. It also relies on pinned reader lookahead and measured about2x parser time. Production22KB catalog/real-process server qualification and actual elapsed-cost measurements are required before adoption; throughput cost and upgrade witnesses stay explicit. Existing bounded parsing remains the fallback if complexity/cost or outcomes fail. The current parser has no newly demonstrated defect that independently mandates removal.

Error inspection found no production field readers or external struct constructors; all actual callers use Display or discard details. Native owned reasons preserve useful catalog explanations with a small adapter, whereas coarse static reasons reduce specificity and a detailed static table adds more private-string coupling. Proceed with an owned reason only after explicit byte-offset/error-matrix tests retain E6003 anchors and fixed LSP mapping. This intentionally changes the public Rust field type and diagnostic details; external source consumers were not qualified. No attempt will reproduce old grammar solely to preserve old prose.

Implementation choice is a qualification decision, with final acceptance pending actual consumers, independent review, measured costs and integration checks.
