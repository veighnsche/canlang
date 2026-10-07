# Final Pass6 parse-only release measurement

Initial copied engine/results preserved in initial/. Final new engine SHA256 672afd2b02d557e45db097766939a466182ffcae8f41b2ddbc7c803c0aaaae02. Same pinned offline crate, inputs, repetitions, two warmups and seven alternating measured rounds. Parse+drop equally; black_box input/result. No threshold selected.

| Input | Bytes | Old median µs | New median µs | Ratio |
| --- | ---: | ---: | ---: | ---: |
| actual_catalog | 22290 | 157.308 | 171.368 | 1.089 |
| initialize | 107 | 1.139 | 1.562 | 1.372 |
| mixed_360k | 367501 | 2941.390 | 3909.477 | 1.329 |
| mixed_multimb | 2205001 | 15641.675 | 20169.850 | 1.289 |

Source/input post-run drift checks: {'old': True, 'new': True, 'catalog': True}

Root broader checks/builds may run concurrently. No isolation or noise correction; raw rounds retained.

Reproduce with command.txt. Unchanged benchmark source and raw rounds in metrics.json; hashes and pinned manifest/lock retained.
