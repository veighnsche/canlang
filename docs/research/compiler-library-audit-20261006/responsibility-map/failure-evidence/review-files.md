# Step12 independent filesystem review

The primary 14-duty filesystem view agrees with adopted C04F guarantees and the fresh controlled receipts. The reviewer read source, tests, exact observations and all raw receipt streams; it ran no tests or mutations. All 82 stdout/stderr hashes from 41 commands match. The 21 cases include two unqualified 4750 fixtures.

Eight replacement and nine ownership tests report 17 harness passes with no ignored tests. Ownership stderr explicitly skips the 4750 body because the host retains 0750 instead. The two additional fresh changed/equal 4750 fixtures likewise fail fixture establishment. Special-bit preservation remains unqualified on this host; prior Linux evidence stays separate.

Established 0600 and 0640 changed files preserve modes and produce expected formatted hashes. Equal fmt outputs keep inode and bytes. Changed symlink and hardlink inputs replace only the requested entry; the other name’s recorded mode, inode, kind and bytes remain identical. Existing ownership tests additionally exercise readonly, umask and repeated/alias noops. This matches C04F’s requested-entry replacement and equal-output exception.

A later parse failure leaves the first input untouched and exits 10. A controlled second-parent write failure exits 2/E7007 after the first operand is committed, with the second unchanged. The private callback tests qualify ordinary write/persist failure cleanup and deterministic detected races. They establish neither a multi-file transaction nor compare-and-swap, hostile-parent safety, universal cleanup, durable sync or abnormal-termination guarantees.

Docs with an explicit disposable renderer stub preserves existing 0600 mode, creates an ordinary 0644 output in the current environment, and replaces equal-output inode. Directory and missing-parent failures report E7007; controlled staging scans are empty. These are writer/interface witnesses, not installed-renderer or universal umask/ACL/owner evidence. Path identity checks provide no locking authority.

The copied build script is byte-identical to current `compiler/build.rs`. Its actual environment consumer always matches independently obtained Git HEAD across ordinary,packed-ref and gitfile worktree controls. The stale-hash hypothesis is falsified in these fixtures. Cargo logs instead show repeated same-HEAD rebuilds: the packed layout watches a missing loose ref, and the gitfile layout watches missing `.git/HEAD`. This is observed rebuild work, not a benchmark or universal metadata guarantee.

The independent JSON checks cover 25 state/contract comparisons; all pass. Pure lint guards,output/producer behavior and other-host/resource gaps retain their declared source/earlier-evidence limits. There is no new blocker within the accepted C04F policy. The4750 native qualification gap remains explicit.
