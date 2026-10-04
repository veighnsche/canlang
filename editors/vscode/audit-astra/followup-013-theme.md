# 0.1.3 focused description theme verification

Captured **2026-10-04T01:11:17.670Z** (UTC). No UI actions, installs, settings/source/extension writes, or baseline report/evidence overwrites were performed. Only new follow-up audit artifacts were written.

Both editor registries identify **canlang.canlang-draft-highlighting 0.1.3**. Live source, both installed grammars, and the immutable capture `followup-013/syntaxes/can.tmLanguage.json` match byte-for-byte: SHA-256 **c3c3ee53094d0a81b355eff9feb1cff1d3168e0a967845e94a0af73fcfd1c782**. Tokenization below uses the immutable grammar with each editor's captured current theme/user rules and bundled TextMate library (Cursor 9.2.0; Antigravity 9.3.1; both Oniguruma 1.7.0).

**The description-vs-quoted-source marker color discrepancy is resolved in the captured token metadata.** Actual `@{` and closing `}` resolve to the same neutral **#D6D6DD** in both editors and all tested contexts. Bare and quoted locale-key text resolves to the same lavender **#D8B4FE**.

| Tested context, both editors | `@{` | Closing `}` | Locale-key text |
|---|---|---|---|
| unquoted-description-bare-key | #D6D6DD | #D6D6DD | #D8B4FE |
| quoted-source-bare-key | #D6D6DD | #D6D6DD | #D8B4FE |
| unquoted-description-quoted-key | #D6D6DD | #D6D6DD | #D8B4FE |
| quoted-source-quoted-key | #D6D6DD | #D6D6DD | #D8B4FE |
| mixed-locales | #D6D6DD | #D6D6DD | #D8B4FE |
| quoted-source-mixed-locales | #D6D6DD | #D6D6DD | #D8B4FE |

The delimiter scope for both ends is `punctuation.definition.message.can`; the locale-key text scope is `entity.other.attribute-name.locale.can`. Quote delimiters surrounding quoted locale keys remain theme-dependent: Cursor #E394DC, Antigravity #D6D6DD. This does not change the locale-key text color, but the entire quoted key is not uniformly lavender.

Installed manifests retain syntax-only language/grammar registration and indentation defaults, with no `main` or `activationEvents`. The evidence includes actual manifest contributions and registry entries. Source/theme/settings/manifests are hashed; only relevant editor settings were retained. Exact test strings, full token stacks, colors, styles, selected rules, and hashes are saved in `followup-013-theme-evidence.json`; the reproducible focused probe is `followup-013-theme-probe.cjs`.

Runtime editor rendering is **visually unverified**. This focused follow-up establishes the captured grammar/theme result and does not re-audit unrelated outstanding findings.
