# Conventional Canlang palette

The October 4, 2026 palette-only follow-up uses familiar VS Code Dark Modern/Dark+ category colors, shared by the locally installed Rust, Go and TypeScript grammars. Cursor retains Cursor Dark High Contrast; Antigravity retains its bundled Default Dark Modern theme. Only existing Canlang token-rule foregrounds changed. Grammar bytes, scope selectors, word categories, strings, descriptions and static message-reference roles remain unchanged. A subsequent style-only follow-up makes Given/When/Then bold italic white; other structural words remain bold white.

| Established category | Previous | Current | Local reference |
| --- | --- | --- | --- |
| Given/When/Then | `#FFFFFF` bold | `#FFFFFF` bold italic | Explicit user preference |
| app/package/scenario/do/require/page/examples | `#FFFFFF` bold | `#FFFFFF` bold | Explicit user preference |
| Other keywords | `#67E8F9` cyan | `#C586C0` purple | Dark+ `keyword.control` |
| Types | `#A5AEB8` gray | `#4EC9B0` teal | Dark+ `entity.name.type`, `support.type`, Go primitive type scopes |
| Functions and operation references | `#FBBF24` amber | `#DCDCAA` pale yellow | Dark+ `entity.name.function`, `support.function` |
| Bindings, identities and parameters | `#93C5FD` blue | `#9CDCFE` light blue | Dark+ `variable` and parameter names |
| Fields, keys and locale keys | `#D8B4FE` lavender | `#9CDCFE` light blue | Dark+ TypeScript object keys and variables; Dark base attribute names |
| Literals | `#F9A8D4` pink | `#B5CEA8` muted green | Dark base numeric literals |
| Frontend components | `#C7AD8E` tan | `#569CD6` blue | Dark base `entity.name.tag` |
| Localization punctuation | `#D6D6DD` neutral | `#D6D6DD` neutral | Cursor's existing neutral punctuation color, retained for consistent suffix punctuation |

The references provide a coherent approximation, rather than identical coloring of every token in every language. Dark+ distinguishes control words from declaration/storage words and numeric from boolean literals. Canlang's established keyword and literal groups remain intact: their shared colors follow control words and numeric literals respectively. Variables and fields now share the familiar light blue; frontend components keep their dedicated tag scopes and blue, independently of purple language keywords. No category was split, merged or reassigned to obtain a hue.

The inspected local references are Antigravity's `theme-defaults/themes/dark_modern.json`, its included `dark_plus.json` and `dark_vs.json`, and Cursor's `theme-cursor/themes/cursor-dark-hc-color-theme.json`. Rust, Go and TypeScript's bundled grammar files confirm the corresponding function/type/parameter/control/numeric scope families. Exact paths, hashes, relevant rules and scope examples are in [palette-evidence.json](palette-evidence.json).

The palette-only portion of the existing checker passed with each editor's own TextMate/Oniguruma runtime. It checks all requested white words, representative category colors, authored field/member roles, and matching localization punctuation after raw descriptions and quoted strings. It also confirms the saved Canlang rules exactly match [token-colors.json](token-colors.json). At the palette follow-up the grammar SHA-256 was `5b81968086d429b8b5156badc7efd712b0016f37aaaf576cd4489beed0214ea3` and both installed extensions were 0.1.5. Version 0.1.6 subsequently adopts the Given `invariant` spelling. Version 0.1.7 places its introducer in the regular declaration-keyword category (`keyword.declaration.invariant.can`), purple `#C586C0` with normal style. Require guards remain bold white. All other palette categories remain unchanged. The preservation check compares all non-Canlang settings before and after, including theme selection and unrelated token rules.

These settings normally take effect immediately: both installed workbench configuration handlers call `setCustomTokenColors` when `editor.tokenColorCustomizations` changes. This palette update needs no extension reinstall or window reload. No UI was inspected or reloaded, so actual running-window rendering is unverified. Historical grammar-audit palette captures remain preserved and describe their earlier colors.

The marker-style check resolves Given/When/Then to font-style bits 3 (bold plus italic), all other structural words and inline/page guards to bits 2 (bold only), and a field named Given to plain style in both editor engines. [section-style-evidence.json](section-style-evidence.json) records the narrowly scoped settings preservation check.
