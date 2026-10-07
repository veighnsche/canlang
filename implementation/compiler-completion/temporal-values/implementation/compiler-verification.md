SEM-R05 static ICU correction only. Date accepts date/datetime; time accepts datetime. Existing diagnostic precedence and text remain. No runtime conversion or timezone behavior added.

All commands used `cargo test --manifest-path compiler/Cargo.toml --locked --offline`:
- `--test temporal_message_types`: 3 passed.
- `--test check icu_`: 4 passed.
- `--test check message_`: 1 passed.
- `--test b4_check t35r25`: 9 passed.
- `--test b4_examples`: 25 passed.

The existing valid selector fixture now declares datetime because its unchanged templates include time. Source diff and before/after hashes cover the three authorized source files; before contents reconstructed by reversing only this leaf's exact edits (no Git command used).

A parameterless message bypasses parameter coverage in the existing checker; the unknown-argument regression exercises a declared parameter map. Other SEM06/UI carriers, Decimal and timezone staging remain open.
