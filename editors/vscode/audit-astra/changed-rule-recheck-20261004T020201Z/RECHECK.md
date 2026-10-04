# Final focused changed-rule rerun

All four remaining groups pass their focused reproductions on this frozen source. No survivor was reproduced.

Captured **2026-10-04 02:02:01.899789 UTC / 04:02:01.899789 Europe/Brussels**. The captured package manifest reports **0.1.4**. Packaging/version finalization was concurrent; this result is tied to grammar SHA-256 **`5b81968086d429b8b5156badc7efd712b0016f37aaaf576cd4489beed0214ea3`**, not to a later version label or installed copy. Other captured hashes are in [manifest.json](manifest.json).

| Remaining group | Status | Independent observed result |
|---|---|---|
| F1: owned contextual model names | Fixed in tested cases | Six separate complete app/Given/When/Then probes cover `app`, `package`, `event`, `contract`, `role`, and `capability` in `<name> in app {title:text}`. Every model name receives `entity.name.type.can`; `in` receives `keyword.control.ownership.can`. The actual app header retains its declaration scope. |
| F10: inline guard after `do` | Fixed in tested case | In `do require item.ready; require item.ready`, both `require` occurrences receive `keyword.control.structure.can`. Independent Cursor and Antigravity engine/theme resolution gives both occurrences **#FFFFFF, bold**. |
| F5: multiline parenthesized form target | Fixed in tested case | In a complete page context, `form (` followed by `change` and `)` on separate lines assigns `entity.name.function.reference.can` to `change` and group punctuation scopes to both parentheses. |
| F8: qualified migration targets | Fixed in tested cases | `rename before.Task to pkg.Work` separates `pkg.` as `variable.other.readwrite.namespace.can` and `Work` as `entity.name.type.can`. `rename before.Task.title to pkg.Work.name` additionally assigns final `name` the scope `variable.other.property.can`. |

## Evidence and limits

Nine focused source probes were independently tokenized with TextMate/Oniguruma against the frozen grammar. [Readable token results](results.txt), [full scope stacks](probe-results.json), [probe definitions](probes.json), and the [runner](tokenize.cjs) are retained beside the exact [source cases](sources/). The separate [inline guard theme result](inline-require-theme-result.md) and [theme evidence](inline-require-theme-evidence.json) record the one-time relevant user-rule capture at **02:03:15.428 UTC**, engine versions, token metadata, and hashes.

This was the promised single rerun of the four surviving groups only. No broader corpus replay, source chasing, UI inspection, reload, installation, settings edit, or implementation edit was performed. Earlier audit evidence and snapshots remain unchanged. These results establish the scopes and resolved theme metadata of the tested cases; they do not establish executable language correctness, complete grammar coverage, or the rendering of a running editor.
