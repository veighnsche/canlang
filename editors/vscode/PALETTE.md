# Can palette

The optional rules in [token-colors.json](token-colors.json) use familiar Dark+ colors:

| Category | Color and style |
| --- | --- |
| Given / When / Then | White, bold italic |
| app / package / scenario / do / require / page / examples | White, bold |
| Other keywords | Purple `#C586C0` |
| Types | Teal `#4EC9B0` |
| Functions and operation references | Pale yellow `#DCDCAA` |
| Bindings, fields, identities, and parameters | Light blue `#9CDCFE` |
| Literals | Muted green `#B5CEA8` |
| Frontend components | Blue `#569CD6` |
| Localization punctuation | Neutral `#D6D6DD` |

The grammar supplies contextual token scopes. Can-specific semantic token types have no inherited theme styles or TextMate fallback, so explicit semantic styling is opt-in. See [README.md](README.md).

`check-highlighting.cjs` checks token roles and this palette, then tokenizes the draft and example sources. Set `VSCODE_RESOURCES` to an editor's application resources directory to use its TextMate/Oniguruma runtime.
