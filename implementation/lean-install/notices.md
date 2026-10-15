# Compiler notice reconciliation — 2026-10-15

Accepted: preserve all existing notice text and supplied alternatives; add exact packaged license texts for missing activated dependencies, then update input and bundle digests. No Cargo manifest, lock, dependency source, build flags, or build output was changed.

The last manifest checkpoint was `47b2a365` (exact money defaults). Its five numeric dependency additions remain covered. Since then, `b9d10ed6` added base64/TOML parsing, `c0a61560` added CSS parsing, and `a3707f6c` made the already-transitively-used getrandom dependency direct. These are real dependency additions, so changing only hashes would have been insufficient.

Read-only `cargo tree --locked --offline --target TARGET --edges normal,build --prefix none --format '{p}'` succeeds for both release targets without builds. Each now has 92 registry package/version pairs; every current pair has a notice heading after reconciliation. Ten missing pairs and sixteen supplied license files were added identically to both target bundles. Four other new locked packages (`equivalent`, `hashbrown`, `indexmap`, `toml_writer`) are not activated by the selected parse/serde features and need no additional release notice sections. Existing conservative normal/build and target-specific coverage remains intact.

For every addition, the cached `.crate` archive SHA-256 matched Cargo.lock. License bytes were read directly from that archive and compared with the unpacked Cargo source used by the build. All supplied alternatives were retained. MPL-2.0 components `cssparser` and `dtoa-short` now include source availability information and exact source archive URLs; all 24 cssparser and 6 dtoa-short packaged files were compared byte-for-byte with their cached build source and matched, confirming they are used without source modifications. The private project owner `values-semantics` and its numeric dependencies retain the existing money-defaults notice coverage. No new project licensing choice was made.

| Added component | Supplied license | Verified archive SHA-256 |
| --- | --- | --- |
| `base64 0.22.1` | MIT OR Apache-2.0 | `72b3254f16251a8381aa12e40e3c4d2f0199f8c6508fbecb9d91f575e0fbb8c6` |
| `cssparser 0.38.0` | MPL-2.0 | `11119743ad110e8c1bdccd930d7f5c30c99e5fc76a7b63ec9807e84eef0c5f59` |
| `dtoa 1.0.11` | MIT OR Apache-2.0 | `4c3cf4824e2d5f025c7b531afcb2325364084a16806f6d47fbc1f5fbd9960590` |
| `dtoa-short 0.3.5` | MPL-2.0 | `cd1511a7b6a56299bd043a9c167a6d2bfb37bf84a6dfceaba651168adfb43c87` |
| `serde_spanned 1.1.1` | MIT OR Apache-2.0 | `6662b5879511e06e8999a8a235d848113e942c9124f211511b16466ee2995f26` |
| `toml 0.9.12+spec-1.1.0` | MIT OR Apache-2.0 | `cf92845e79fc2e2def6a5d828f0801e29a2f8acc037becc5ab08595c7d5e9863` |
| `toml_datetime 0.7.5+spec-1.1.0` | MIT OR Apache-2.0 | `92e1cfed4a3038bc5a127e35a2d360f145e1f4b971b551a2ba5fd7aedf7e1347` |
| `toml_parser 1.1.3+spec-1.1.0` | MIT OR Apache-2.0 | `1d38ac1cf9b95face32296c0a3ede1fdc270627c9d9c02a7274dd6d960dc4d56` |
| `winnow 0.7.15` | MIT | `df79d97927682d2fd8adb29682d1140b343be4ac0f08fd68b7765d9c059d3945` |
| `winnow 1.0.4` | MIT | `23b97319f7b8343df12cc98938e5c3eb436064524c8d2b4e30a1d3a36eecdf81` |

Current pinned inputs:

- `compiler/Cargo.toml`: `1f7e8580767eb6a672ad0220420de723655730d1e79fc725d59fae0d538bed91`
- `compiler/Cargo.lock`: `84d1702b2299d53c8b2ac96d95c7b26d2e1b34029173510d297cd396515e8e0c`

Validation: the release notice guard passed for both advertised targets after the update, copying each frozen bundle to a temporary directory. No Cargo builds were run. The existing guard pins compiler/Cargo.toml and compiler/Cargo.lock; it does not independently pin the private path dependency manifest, so future changes to that owner still require dependency-closure reconciliation.
