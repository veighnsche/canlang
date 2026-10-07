# C04F verified-context policy consultation

Three independently worded equivalent `choice` requests compared the same caller closure, published candidate APIs, macOS/Linux profile, observed old behavior and balanced alternatives. They used `jev-latest`, returned `jev-1.13.0`, and are saved as request/response 1–3 beside this assessment. Their advice selects project policy; it is not regression or library-qualification evidence.

| Boundary | Requests 1 / 2 / 3 | Reported confidence | Selected policy |
| --- | --- | --- | --- |
| Symlink | entry / entry / entry replacement | .51 / .49 / .38 | Keep changed-write requested-entry replacement; readable regular target supplies mode, target bytes stay unchanged. Equal-byte fmt remains a no-op. |
| Hardlink | entry / entry / entry replacement | .99 / .99 / 1.00 | Replace only requested entry; other names retain old inode and bytes. |
| Missing docs output | ordinary / ordinary / private creation | .28 / .27 / .49 | Ordinary `0666 & !umask`, matching the old `fs::write` workflow. |
| Concurrent changes | detect / detect / detect observable changes | .89 / .96 / .93 | Recheck entry/regular-target metadata and fmt expected bytes; missing output uses noclobber. Residual race remains. |
| Readonly | directory / directory / directory entry permissions | .96 / .98 / .96 | Replace if OS permits directory operation; retain resulting readonly mode. |
| Existing permissions | exact / exact / exact captured permissions | .90 / .70 / .80 | Apply `std::fs::Permissions` to open staged handle after writing. |

## Disagreement and uncertainty

The missing-output vote is split and every confidence is low. Inspection establishes that the old path-based `fs::write` created ordinary umask-filtered output, whereas the candidate defaults to private `0600`. Preserve the existing creation workflow: the calling process's umask decides whether new docs are shared. Explicit builder permissions select this policy; existing targets instead receive their captured mode after staging. A future private-by-default docs policy would be a separate accepted product change.

The unanimous symlink answer also has low confidence. An independent reviewer initially favored refusing changed symlinks as a possible policy; inspection confirms that the released helper already read through the link and replaced its entry. Retain that behavior deliberately for this bounded repair, with tests showing unchanged target bytes. Following targets would move destination selection and race rules into this pass; refusal would remove an accepted workflow. Neither alternative is silently selected by `tempfile`.

Exact mode preservation does not imply inode, owner, ACL, xattr, timestamp or crash-durability preservation. Metadata is first observed at replacement-helper entry, after formatting/rendering, not at the initial read. Byte checks detect stale fmt content, but equal-content inode or mode changes before helper entry are not universally detected. The final check-to-persist interval remains a race; parent directories are trusted. Missing-output noclobber is qualified on the recorded hosts, not every fallback filesystem.

The implemented policy was independently reviewed after adding witnesses for same-byte/mode/mtime inode replacement and symlink-target permission changes. No blocking correctness issue was reported under this policy. See the [file receipt](../files/README.md) for executed evidence and limitations.
