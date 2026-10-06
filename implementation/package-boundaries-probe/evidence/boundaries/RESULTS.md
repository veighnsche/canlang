# Isolated boundary coverage probe

Turbo 2.11.7; Bun 1.4.2; macOS arm64. Telemetry disabled. All cases are separate registry-free Bun workspaces; `bun install --ignore-scripts` links local packages. Raw argv, cwd, exit, stdout/stderr live in `results/<case>/`. Version, help and launcher/native hashes are preserved separately.

Desired policy is the proposed project gate, not a claim about Turbo capabilities. Filesystem reads and URLs need an explicit distinction between owned asset APIs and loading a sibling producer. A local-data read is the control. Fixtures and locks are saved in `fixtures/`; runtime export checks are separately labeled. No product source or manifests were changed.

| Case | Desired policy | Turbo result | Interpretation |
| --- | --- | --- | --- |
| allowed-root | Allow | Passed (0) |  |
| undeclared-root | Reject | Detected (1) |  |
| sibling-source-declared | Reject | Detected (1) |  |
| sibling-source-undeclared | Reject | Detected (1) |  |
| sibling-dist-declared | Reject | Detected (1) |  |
| unexported-subpath | Reject | Passed (0) | Bun runtime rejects (runtime.json); Turbo does not enforce exports here. |
| alias-source-declared | Reject | Detected (1) |  |
| alias-source-undeclared | Reject | Detected (1) |  |
| type-only-import-undeclared | Reject | Detected (1) |  |
| type-only-export-undeclared | Reject | Detected (1) |  |
| type-query-undeclared | Reject | Passed (0) | Coverage gap for proposed boundary gate. |
| reexport-undeclared | Reject | Detected (1) |  |
| reexport-sibling | Reject | Detected (1) |  |
| dynamic-literal-undeclared | Reject | Detected (1) |  |
| dynamic-constant-undeclared | Reject | Passed (0) | Coverage gap for proposed boundary gate. |
| dynamic-concat-sibling | Reject | Passed (0) | Coverage gap for proposed boundary gate. |
| dynamic-computed-sibling | Reject | Passed (0) | Coverage gap for proposed boundary gate. |
| fs-read-sibling | Review owned API / reject producer bypass | Passed (0) | No semantic producer/data distinction; explicit ownership policy required. |
| url-sibling | Review owned API / reject producer bypass | Passed (0) | No semantic producer/data distinction; explicit ownership policy required. |
| fs-read-local-control | Allow | Passed (0) |  |
| test-undeclared | Reject | Detected (1) |  |
| test-sibling | Reject | Detected (1) |  |
| root-tool-undeclared | Reject | Passed (0) | Root-owned tooling not diagnosed. |
| root-tool-sibling | Reject | Passed (0) | Root-owned tooling not diagnosed. |

Reproduce preparation with `python3 probe.py`. Run with `python3 probe.py --run /absolute/path/to/turbo boundaries --no-color --no-update-notifier --skip-infer`. Summarize with `python3 summarize.py`. Environment uses scratch-local Bun/XDG caches. No `--ignore` suppressions were used.
