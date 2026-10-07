# Pass6 parse-only release measurement

Pinned offline crate; unchanged complete old/new json.rs copied. Parse+drop timed equally; diagnostic shim never measured. Fixed repetitions, two warmups per engine and seven rounds alternating order. No performance policy selected.

| Input | Bytes | Old median µs | New median µs | Ratio |
| --- | ---: | ---: | ---: | ---: |
| actual_catalog | 22290 | 80.212 | 105.985 | 1.321 |
| initialize | 107 | 0.455 | 0.707 | 1.554 |
| mixed_360k | 367501 | 2443.610 | 3404.795 | 1.393 |
| mixed_multimb | 2205001 | 17048.775 | 17217.958 | 1.010 |

Post-run source/input drift: checks['old']['matches_copied']=True, checks['new']['matches_copied']=True, checks['catalog']['matches_copied']=True

Reproduce with command.txt; Cargo.toml/Cargo.lock, copied src modules, main.rs, input fixtures, manifest, raw metrics and run.log retained here.
