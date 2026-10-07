# Pass 9 promoted correctness queue

Executed evidence promotes repairs without waiting for all mechanism comparisons. Library adoption remains a separate gate. Production writers are released per entry; no package changes or new language policy are authorized here.

| Packet | Executed defect | Exact writer / witnesses | Status |
| --- | --- | --- | --- |
| C09I-1 | Decimal ordinary number fails compiler E5007 while DESIGN9.1/current public value owner accepts; decimal ordinal passes compiler while owner rejects | compiler/src/analysis/examples.rs IcuParser::parse_argument; compiler/tests/check.rs focused type matrix; pass9/icu/type-parity.json/replay | Implemented and independently reviewed; committed with numeric repair |
| C09C-1 | All shipped shell scripts omit supported lint --fix | compiler/can-completions.{bash,zsh,fish}; new compiler/tests/completion_contract.rs and isolated shell fixture if needed; actual embedded scripts and Bash/Zsh outcomes | Implemented and independently reviewed; committed with completion repair |
| C09C-2 | Bash/Zsh suggest compiler flags after -- even though parse_args treats them as operands | Same scripts/test seam; fixed separator/filename expectations and actual shell probes | Implemented and independently reviewed on Bash/Zsh; Fish terminator unqualified |
| C09C-3 | Actual Zsh completions b<TAB> does not expand to bash; format positive control works | compiler/can-completions.zsh operand position/word handling; actual PTY/compinit witness | Implemented and independently reviewed; committed with completion repair |
| P09-1/P09-2 | Reverse LSP drops bare EOF CR; public missing-relative-root IDs cancel retained parents | queries.rs/docs.rs with IDE/docs fixed regressions; pass9/positions-medium | Implemented and independently reviewed; committed with position/path repair |
| G09-1 | Identical actual call-cycle programs vary witness/message/span/set between processes | types.rs::check_cycles and analysis.rs tests | Promoted; stable origin policy consultation before release |
| C09I-next | Additional syntax/disclosure/depth observations exist | Worker must classify explicit owner/spec obligations and distinct types.rs/examples.rs boundaries in pass9/icu before release | Classified: 11 syntax rows (10 correction rows across6mechanisms + top-level#policy); see pass9/icu/correctness-packets.md; no broad rewrite selected |

## C09I-1 released type repair

Existing accepted DESIGN9.1 and actual current public owner agree: ordinary number accepts int or decimal; integer-number style accepts int only; cardinal plural accepts int or decimal; ordinal accepts int only. Preserve unsupported styles/grammar, all other scalar/nullable rules, error code E5007 and original decoded-literal source anchor. Parse the explicit style before selecting numeric admissibility; do not make all number styles decimal-compatible or change plural syntax/selectors. Split cardinal/ordinal argument sets without a new grammar or library.

Sole production writer owns only compiler/src/analysis/examples.rs and compiler/tests/check.rs. Focused independently fixed matrix covers all8type/style combinations, positive/negative controls, descriptions/translation variants as live routes where feasible, and invalid style/source-anchor behavior. Root owns fresh real CLI/owner rerun, independent review, shared decisions and commits. Runtime decimal constructor/format observations qualify the owner; existing production decimal literal lowering limitations are not repaired by this type check. Retain bounded parse-time depth/scanner until its own packet is qualified. No JEV consultation is needed for this correction of an unambiguous already accepted rule.
