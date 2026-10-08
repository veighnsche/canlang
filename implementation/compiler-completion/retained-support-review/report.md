# Retained compiler support decisions

**Accept RETAIN** for docs views (`ARCH-02`), map extraction (`DEP-02`), and the public map decoder (`ARCH-02`). Each has zero production mechanisms retired and zero net production lines removed. Their public contracts remain supported; no replacement was selected.

The direct docs results and original failed CLI attempt remain in `../docs-support/`; its extraction, typed wire, actual renderer consumer, and corrected CLI checks retain their own scope. The original map checks and expected E0603/E0599/E0277 API refusal witnesses remain in `../map-support/`, with `replay.py`, source controls, raw output, and `receipts.json`. Use those original direct checks rather than replaying their receipts through another review packet.

The map writer owns token selection, deltas, rows, and identities; the public numeric VLQ function alone does not replace it. The public decoder also preserves signed coordinates, authored order, and empty/trailing rows. The docs views remain supported entrypoints even where internal callers use the string route. A future replacement needs focused checks against whichever public behavior it changes.

These bounded decisions do not claim exhaustive external-consumer equivalence, GUI navigation, deployment, every profile, or qualification of later source changes.
