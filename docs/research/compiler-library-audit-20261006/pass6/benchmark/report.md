# Final Pass6 parse-only release measurement

Prior initial engine/results preserved in initial/; prior loaded correction preserved in loaded-correction/. Final engine SHA256 6f6b067e3a57c4cb50596712cab981eea199c1774150b1b946042492685f4244. Same pinned offline crate, inputs, repetitions, two warmups and seven alternating measured rounds. Parse+drop equally; black_box input/result. No threshold selected.

| Input | Bytes | Old median µs | New median µs | Ratio |
| --- | ---: | ---: | ---: | ---: |
| actual_catalog | 22290 | 60.722 | 81.480 | 1.342 |
| initialize | 107 | 0.356 | 0.575 | 1.614 |
| mixed_360k | 367501 | 1276.305 | 1865.747 | 1.462 |
| mixed_multimb | 2205001 | 7748.742 | 11261.675 | 1.453 |

Source/input post-run drift checks: {'old': True, 'new': True, 'catalog': True}

Root native/Linux builds completed before this rerun. Other system activity not guaranteed isolated; raw rounds retained without correction.

Reproduce with command.txt. Unchanged benchmark source and raw rounds in metrics.json; hashes and pinned manifest/lock retained.
