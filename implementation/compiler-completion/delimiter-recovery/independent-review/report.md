# Independent HIGH review: SYN-R06 EOF delimiter recovery

Verdict: accept the frozen layout change within its declared bounded support. No blocking example found. Source/diff review preceded author conclusions. Review changes are confined to this evidence directory; no production, package, shared-documentation or Git mutation occurred.

## Pins and verification

- `compiler/src/syntax/layout.rs`: `2f0bf7a120109f3221bf52852ca8a7e0bae4723461b9ce3ffafa1975d23c8a4d`.
- `compiler/tests/delimiter_recovery.rs`: `a03d6709dd1d89058f85860b4cd3b69222998e887268b77aa075ec5851345e4c`.
- All 32 production/receipt/report pins in the author freeze match; `receipt-verification.json` independently checks them.
- The five stored balanced controls match baseline **complete node kind/span arrays** and parse diagnostic arrays, with coverage retained. Existing 26 private checks, six permanent delimiter tests, 54 syntax tests and three state-machine static/type/formatter checks are reused rather than rerun.
- Seven distinct new review tests pass, compiled directly against the parent's current archive `compiler/target/debug/deps/libcanlang_compiler-7ac8439fc564dd9b.rlib`, SHA-256 `bdd0ad99d020bdb338c71fa1ca25a80888b7a58cad58e662671c57602f53e1fa`. No redundant Cargo build. Source, compile logs, raw test output and archive/source pins are retained here.
- Parent refreshed the actual Cloudflare producer and passed the real state-machine runtime body. That integrated receipt is `../../producer-refresh/state-machine.log`; the earlier stale-dist missing-`transition` failure remains in the author evidence. This review does not replace either receipt or claim independent runtime validation.

## Distinct survivor matrix

Byte spans below are half-open; each relevant parse control also asserts complete CST coverage and byte-for-byte leaf reconstruction.

| New control | Exact outcome |
| --- | --- |
| Mixed matched/mismatched/unclosed delimiters, nested deeper openers, then another failed call/list | E1101 once at `)` `[30,31)`; E1102 at `nested(` opener `[40,41)` and the later list opener `[98,99)`; exactly two independent derives; E3002 `[123,131)`, E2001 `[151,155)` and `T.a`/`T.b` survive. |
| Deeper description in unfinished schema, same-column comment, same-column independent description | E1102 `[15,16)`; deeper description stays in failed line tokens; independent description attaches to derive `a`; one comment; E3002 `[142,150)`, E2001 `[170,174)`, both symbols. |
| Balanced nested Point value/list/string subjoin during replay, including a dedented physical field description | Only E1102 `[15,16)`; `N` remains one logical line with inline field description and list continuation tokens, no artificial child suite; exactly two derives; E3002 `[163,171)`, E2001 `[191,195)`, both symbols. Escaped newline and delimiter/comment punctuation inside a valid string stay string-owned. |
| CRLF unterminated string plus Unicode EOF comment | E1102 `[17,18)`; E1006 anchors the complete `"abc}` string token; Unicode comment occurs once and excludes CRLF; exact reconstruction; E3002 `[55,63)`, E2001 `[84,88)`, both symbols. |
| NBSP, EM SPACE and Unicode LINE SEPARATOR on otherwise blank-looking physical code lines | Each remains an error token with its full UTF-8 byte span, so it is a physical code boundary rather than an ASCII blank line. E1102 anchors the failed schema; both derives, sentinel spans and symbols survive; exact reconstruction in all three variants. |
| Failed opener within a nested scenario after an earlier failed schema | E1102 `[15,16)` and `[211,212)`; Scenario, If, Transition and Return CST nodes survive; E3002 `[91,99)`, E2001 `[119,123)`, both symbols. |
| 128, 1024 and 4096 active openers over 4096 deeper physical lines | Layout-only control avoids unrelated expression-parser recursion. Exactly one E1102 at the innermost opener, 4096 continuation integers stay in the failed line, no child suite is invented, and both independent derive lines survive. Largest fixture is under 21 KiB; no giant allocation, adversarial host stress or runtime-performance claim. |

`controls.rs` contains the handwritten oracles, including survivor counts and anchor computations. Raw `controls.stdout` records 7 passed, 0 failed. Unsupported catalog function names on failed lines do not masquerade as clean semantic programs; the assertions specifically require the independent sentinel findings and owning symbols.

## Algorithm assessment

The ordinary scanner is preserved in `join_lines`. For a balanced source, no replay occurs; ordinary comments, descriptions, mismatch-pop behavior and logical-line emission follow the original ordering. Only the final incomplete suffix is retained. Its pending-line index and comment/diagnostic checkpoints are captured before scanning that owning code line; suffix-only truncation prevents repeated mismatch findings and comments during replay while preserving the prefix.

Replay uses that same scanner and a set of original unmatched opener byte starts. `unclosed_depth` maintains the number of marked openers in the current stack: increment on push, decrement for the popped opener in either matched or mismatched-closer branches, reset with stack clearing. Thus a nonzero count implies a nonempty stack and authorizes E1102's innermost anchor without an empty-stack panic or subtraction underflow. A same/dedented code or description physical line is a reset boundary only while this count is positive; deeper lines retain ownership. Comments and blank lines are handled before boundary checking. Balanced subjoins have no marked opener and retain arbitrary indentation, including descriptions and list/schema continuations at column one.

The new scanner work is expected O(tokens + physical lines) with HashSet membership, plus at most one replay of the failed suffix. There is no per-line delimiter-stack scan, parser reentry, keyword classifier, or unconditional indentation reset. Stack clears sum to at most pushed tokens. Set construction is O(unmatched openers), state and temporary retained-tail allocations are O(source tokens); replay increases the constant factor but not the asymptotic source-sized bound. Existing indentation-tree work and recursion limits are unchanged. The small deep-stack control supplements this source-bound argument; it is not a benchmark.

## Limits retained

This accepts EOF-unclosed suffix recovery only. More-indented independent-looking declarations can remain swallowed, and same/dedented expressions that an editor author intended as unfinished continuations can be split into additional error lines. Malformed joins accidentally balanced by later unrelated closers do not enter replay. An opener removed by the ordinary mismatch-pop rule is not proved unclosed. These cases do not justify a universal malformed-source recovery claim.

Strings cannot span physical lines under the current lexer. The multiline-join string control uses a valid escaped newline and punctuation; it does not assert support for raw multiline string tokens. The JEV responses are advisory and are not counted as correctness evidence. Acceptance applies to the frozen syntax change and focused evidence, not a repository-wide or release certification.
