# Changed-rule inline require verification

Captured **2026-10-04T02:03:15.428Z UTC**. Tested only the frozen grammar SHA-256 **5b81968086d429b8b5156badc7efd712b0016f37aaaf576cd4489beed0214ea3** and the promised inline require case in a complete app/Given Item/When scenario/Then page context. Current relevant user rules were captured once. No installed grammar inspection, broader palette/corpus replay, source chasing, UI actions, installation, settings, or source changes were performed.

`do require item.ready; require item.ready`

| Editor | Occurrence | Actual scope | Foreground | Style | Result |
|---|---|---|---|---|---|
| Cursor | after do | `keyword.control.structure.can` | #FFFFFF | bold | passes |
| Cursor | after semicolon | `keyword.control.structure.can` | #FFFFFF | bold | passes |
| Antigravity IDE | after do | `keyword.control.structure.can` | #FFFFFF | bold | passes |
| Antigravity IDE | after semicolon | `keyword.control.structure.can` | #FFFFFF | bold | passes |

Full authored context, token stacks, colors/styles, relevant captured settings, engine versions, and source/theme/settings hashes are preserved in `inline-require-theme-evidence.json`. This verifies resolved TextMate metadata; runtime editor rendering is visually unverified.
