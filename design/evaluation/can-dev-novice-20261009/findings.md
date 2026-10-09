# First-draft Can guesses from unfamiliar agents

**Status:** Small observed corpus, 2026-10-09. This is input evidence for the [Can dev server design](../../can-dev-server.md), not a language benchmark or a claim that keyword help fixes these drafts.

## Collection

Two coding-agent model configurations each received one of the three [business tasks](../../can-dev-agent-tasks.md): office supplies, staff shifts and expense review. Each run began with no conversation history and only this language introduction: “Can builds business apps from .can source. Given declares data and rules. When declares permitted actions. Then declares pages. Write your best draft.” Agents were instructed to return their first `.can` guess without inspecting files, examples, docs, tools or compiler output. A follow-up copied each returned code block verbatim to the raw files below; it did not request revision.

| Task | Luna Medium first draft | Sol Low first draft |
| --- | --- | --- |
| Office supplies | [raw source](raw/supplies-luna.can) | [raw source](raw/supplies-sol.can) |
| Staff shifts | [raw source](raw/shifts-luna.can) | [raw source](raw/shifts-sol.can) |
| Expense review | [raw source](raw/expenses-luna.can) | [raw source](raw/expenses-sol.can) |

An existing local `can` debug binary (`0.1.0`) rejected all six first drafts with complete diagnostic output. Four began with `E1211` (“expected app, package or migration”); two began with `E1103` (indentation). All six had indentation diagnostics. This is a spot check using that local binary, not a source-current compiler qualification. The drafts and their exact words are the primary evidence.

## Observed forms and likely help

| Actual first-draft form | Where observed | What help could be useful |
| --- | --- | --- |
| Repeated prose headers such as `Given OfficeSupplies`, `When member adds a supply`, `Then Office Supplies` | [supplies-luna](raw/supplies-luna.can), [shifts-luna](raw/shifts-luna.can) | Show the canonical app and section shape before recommending a local keyword; the whole header is not one misspelled token. |
| Type spellings `Text`, `Boolean`, `DateTime` and `none` | [supplies-sol](raw/supplies-sol.can), [shifts-sol](raw/shifts-sol.can), [expenses-luna](raw/expenses-luna.can) | Contextual type/literal help may point to `text`, `bool`, `datetime` or `null`. `Number` needs a type choice (`int` or `decimal`), not a blind replacement. |
| `rule` for read access, value validity, locks and callable helpers | [supplies-sol](raw/supplies-sol.can), [shifts-sol](raw/shifts-sol.can), [expenses-sol](raw/expenses-sol.can) | Explain the distinct Can constructs (`policy`, `invariant`, `lock`, `derive`) and use the surrounding intent to narrow them. |
| `permit` inside operations and pages | [supplies-sol](raw/supplies-sol.can), [shifts-sol](raw/shifts-sol.can), [expenses-sol](raw/expenses-sol.can) | Explain operation `by=` and record `policy` in their respective positions; the same invented word expresses different authority questions. |
| `state`, `searchInput`, `show`, function-shaped `page Supplies(team)` | [supplies-sol](raw/supplies-sol.can), [shifts-sol](raw/shifts-sol.can) | Return page/list/form/preference signatures and a small legal snippet. Several lines need structural revision, not a single keyword swap. |
| `example`/`expect` blocks or behavior written only as `##` comments | [supplies-sol](raw/supplies-sol.can), [shifts-sol](raw/shifts-sol.can), [expenses-sol](raw/expenses-sol.can) | Point to executable `examples` syntax and explain that `##` prose does not assert behavior. The block must be authored, not renamed. |

## Cases for none/unclear instead of one keyword

These are actual corpus excerpts where returning one “closest keyword” as a correction would imply more certainty than the source supports:

| Excerpt | Why one keyword is unsafe | Better response |
| --- | --- | --- |
| [`rule team_member(team)`](raw/supplies-sol.can) | It is reused for page visibility and mutation admission. `policy` and operation `by=` cover different contracts, so the whole helper has no one-word replacement. | `none/unclear`; show both contracts and ask which access the author is defining. |
| [`Given visibleExpenses`](raw/expenses-sol.can) | A computed collection might be a pure derivation, a read operation, or a page-local query. The intended scope and exposure are unstated. | `none/unclear`; show the relevant construct choices and their signatures without selecting one. |
| [`atomic`](raw/shifts-sol.can) inside `do` | The author is asking for transaction semantics, not spelling a near Can source word. A keyword substitution could promise behavior it has not checked. | No keyword replacement; explain the supported effect/transaction contract and require the revised source to be checked. |
| [`Given TeamMember:`](raw/shifts-luna.can) | This could be extra business data or an attempted reimplementation of built-in team identity and roles. A `model` or `role` suggestion alone may change intent. | `none/unclear`; point to team/member defaults and ask what extra data must be stored. |
| [`## Behavior examples`](raw/expenses-sol.can) | These are ignored comments, not test assertions. Replacing `##` with `examples` would still leave prose without fixtures or expected results. | Explain executable example structure; do not offer a one-token edit. |

## What this small sample changes in the design discussion

The tiny introduction led to broad invented *source shapes*, not just near-miss keywords. Top-level app/section layout and indentation errors can mask more useful construct errors deeper in the file. The help study should therefore score structural guidance and abstention as well as top-choice keyword accuracy. A candidate help card may be valuable for `crud`, `scenario` or `page`, but the server must not present a complete workflow as repaired because one word was ranked.

Six first drafts from two model configurations and three fixed tasks are not a representative sample of all coding agents. No agent received feedback or attempted a second edit, so this corpus says nothing about convergence speed, eventual app correctness or Jev's incremental value. An interactive study with the same prompts and controlled help conditions is still required.
