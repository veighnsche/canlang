# C09C executed correctness queue

## C09C-F01 — missing lint `--fix` completion

Status: concrete, production repair awaits root release. Source writers: `compiler/can-completions.bash`, `.zsh`, `.fish`. Acceptance-test writer: `compiler/tests/exe.rs` for shared metadata coverage; a bounded actual Bash invocation should supplement byte embedding goldens. No parser/production dependency change required.

Independent expected outcome: `command_help("lint")` declares `Usage: can lint [--fix] ...`; parser accepts `--fix` only for lint; `command_help("completions")` promises scripts for every command, flag and operand. Real binary `can lint --help` confirms this owner surface. Actual Bash 3.2.57 sourcing shipped file returns only `--format`, `--format=json`, `--format=text` for `can lint --f`, and no candidate for `can lint --fix`. Zsh/fish scripts omit the flag literally; their full engine behavior is qualified separately.

Acceptance: lint flag completion includes `--fix`; other compiler command surfaces do not gain it; exact `can completions SHELL` stdout remains equal to the shipped script for all three shells. The accepted parser, output conventions and platform passthrough stay unchanged. Uncertainty: fish unavailable on the local host, so any fish behavioral acceptance requires an available fish host; declaration-level coverage is still finite and testable.

## C09C-G01 — separator completion semantics gap

Status: characterized gap, separate repair decision. Real Bash execution of `can check -- --f` suggests `--format*`. Parser/help passthrough treats `--` as flag termination for compiler commands, so those strings are filenames in this position. Existing completion text states source/file operand completion, but there is no published strict exclusion promise for all suggestions. A bounded repair could offer files only after separator; acceptance must cover dash-leading filenames and avoid applying Can flags to thin platform arguments. This is not a justification for global CLI redesign.

## C09C-F02 — Zsh shell operand is not completed

Status: concrete, production repair awaits root release. Source writer: `compiler/can-completions.zsh`, specifically the completions branch positional indexing. Acceptance-test writer: bounded actual Zsh PTY script or compiler test invoking that script when Zsh is available.

Independent expected outcome: `can completions --help` declares one `bash|zsh|fish` shell operand; shipped `_arguments '1:shell:(bash zsh fish)'` explicitly promises these candidates. Actual Zsh 5.9 with `compinit -D`, registered `compdef _can can`, and tab-bound `expand-or-complete`: `can completions b<TAB>` remains `b` and emits BEL. Positive control in the same PTY: `can check --format=j<TAB>` expands to `--format=json`. `words` still includes `completions`, so shell input is the second positional argument for `_arguments`. Acceptance: b/z/f expand to bash/zsh/fish; format value control continues working; passthrough remains file completion. No platform spawn required.
