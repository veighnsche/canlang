# Independent FAIL-R03 frame admission review

**Accepted for the scoped framing contract; no remaining owned blocker.** Reviewed the source/diff before reading author conclusions. Only review evidence was written. No production/shared documentation changes, commits, full suite, exhaustion probe, or global OS configuration changes were made by this reviewer.

## Reviewed source pins

Final source SHA-256 pins (rechecked after controls):

| Source | SHA-256 |
| --- | --- |
| `compiler/src/lsp/transport.rs` | `519dab281392b9030df82aff2b1cb8818785034b190060913a28f61fbcaab987` |
| `compiler/src/lsp/server.rs` | `ebaac2788ac817f562f12d2e27cfcc2dc4f7bd7ff70edd8e039be6de053c168a` |
| `compiler/tests/lsp_admission.rs` | `b5a8d3f4fd35f421585c899e6f9f5720a2764a27c0469fe523442a3ba29f083e` |
| `compiler/tests/lsp_frame_reader.rs` | `79f85a4dc8c39cf40b71c90a3bfe25d1ebf45a2d96b6a45f1112084c47129a74` |

`reviewed-files.json` records these pins. The original author freeze pins also matched at review start. The coordinator subsequently changed header growth and added one allocation-count regression; the final transport and reader-test pins above supersede their original pins. Other two pins remain unchanged. Concurrent foreign production edits receive no review credit here.

## Source reasoning and policy accuracy

Header acquisition slices each available buffer to the remaining aggregate budget before searching for newline, reserving or consuming. The completed separator counts toward 65,536 bytes. An exact-budget completed separator is accepted; any still-incomplete header at that boundary fails without consuming an excess byte. Long lines and many short lines share the same bound. Revised storage grows geometrically from 64 bytes and is capped at the header budget, while each line reuses the existing vector.

Every Content-Length value is parsed and checked against the existing 67,108,864-byte cap before body acquisition. Equal parsed values are accepted; differing, malformed and oversized declarations fail immediately. Existing case, whitespace/numeric parsing, bare-LF and ignored extension behavior is preserved. This is a scoped framing policy, not full validation of header syntax or Content-Type.

Body acquisition starts from an empty vector; each retained acquisition is at most 8 KiB and stops at the declared boundary even when the caller exposes pipelined bytes. Growth is fallible and geometric, bounded by the accepted declaration, with the first growth at most 16 KiB. No absent payload triggers a body storage request. Header/body allocation errors propagate; Interrupted is retried; other input errors propagate without continued reading. Prior output is flushed and stdio exits 1 for non-EOF errors, including after shutdown. Clean/torn EOF retains the existing lifecycle path. Complete invalid UTF-8/JSON is still a single null-ID parse error followed by continued frame handling.

The selected support budgets, equal-only duplicate rule and failed-transport exit are honestly labelled local choices. The [primary LSP 3.17 header/content text](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/specification.md) was independently checked (lines 21–38): it specifies byte lengths, CRLF, ASCII headers and UTF-8 content, without those numeric budgets or a malformed-stream resynchronization instruction in that framing section. The local peer source writes a single CRLF Content-Length header using `utf8Length(body)` (`editors/vscode/src/client.ts` lines 704/885). A live editor launch was not tested.

Saved JEV responses accurately support the author's report: all three choose the resource and equal-only duplicate policies; lifecycle choices split two close_failure / one close_lifecycle at confidence 0.32/0.27/0.21. Request b has a displayed 0.45/0.45 closure tie; c has 0.41 lifecycle versus 0.40 failure. The decision explicitly retains this uncertainty and gives a local rationale for exit 1. It does not turn advice into unanimous or normative evidence.

## Checks and outcomes

Reused focused author receipts after inspecting their tests/logs: 32 actual stdio admission tests, original 10 reader tests and 30 LSP unit tests pass. They cover legal extension headers, equal/conflicting declarations, UTF-8 bytes, partial I/O, exact/pipelined boundaries, parse recovery, clean/torn EOF, held-open malformed-stream closure, missing/oversize declarations, absent/partial declared payload and scoped allocation refusal. Original strict Clippy receipt fails only on four separately owned `codegen/js.rs` needless_borrow findings; this review does not claim a successful strict Clippy run from that receipt. Original scoped formatting passes.

Independent commands, all exit 0:

- `rustc --edition 2024 -Awarnings implementation/compiler-completion/frame-admission/independent-review/reader-controls.rs -o /tmp/canlang-frame-independent-reader`, then the binary. The framing fragment is extracted mechanically from the pinned transport source, with only the unused JSON re-export removed; framing functions are unchanged. Both header threshold outcomes and body growth were exercised through a direct one-byte BufRead. PermissionDenied injected at byte positions 0/5/25/26/125 propagates immediately, with exactly position+1 fill calls and no further consumption.
- `cargo test --manifest-path compiler/Cargo.toml --locked --test lsp_frame_reader`: **11 passed**, including header/body allocation refusal and the coordinator's new one-byte request-count regression (`owning-reader-rerun.log`).
- `cargo build --manifest-path compiler/Cargo.toml --locked --bin can`, then `python3 implementation/compiler-completion/frame-admission/independent-review/process-controls.py`: **7 independent actual-process controls passed**, rerun after the header revision. Each has a five-second deadline, concurrent input/output, 32 KiB per-pipe output budget and kill/reap on timeout. `process-controls.json` records binary hash and complete framed output.

The process controls establish: separator-only budget overrun after shutdown exits 1 while stdin stays open, preserving exactly the two prior replies; exact-budget bare-LF headers plus Unicode and pipelined shutdown succeed; complete truncated UTF-8 and invalid JSON each yield one parse error then successful initialize/shutdown/exit; torn body/header EOF after shutdown returns lifecycle 0; a directory stdin descriptor produces a real native non-EOF OS input error and silent exit 1. No OS state was changed for that descriptor test.

The original one-byte header control observed 65,515 allocation/reallocation requests and a sum of requested sizes 2,146,140,370 bytes, with a largest request of 65,515 bytes. The coordinator replaced per-chunk exact growth with geometric header growth. The final identical control observes **11 requests**, **131,008 summed requested bytes**, largest **65,536 bytes**; exact boundary/refusal behavior is preserved. Original results and fragment remain in `reader-controls-original.log` / `transport-fragment-original.rs`. The sum is an allocation-request work observation, **not** RSS, retained memory, cumulative actual allocation, or bytes copied by the allocator. Native elapsed times are diagnostic, not portable performance guarantees.

## Remaining limits

No complete 64 MiB payload was materialized; declaration acceptance and smaller complete/prefix boundaries are separate witnesses. No unusual peer compatibility survey, live VS Code session, Linux/Windows distribution qualification, reader-owned-buffer/RSS/realloc-copy bound, time deadline/slow-peer protection, JSON/session memory budget, new encoding support, signal handling or original application acceptance claim is established. Scope remains finite local frame admission and the native stdio disposition. No new peer guarantee is inferred.
