#!/bin/bash
# Actual Bash function execution, no installed completion framework needed.
source /Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass9/cli/candidate.bash
run() {
 COMP_WORDS=( "$@" ); COMP_CWORD=$((${#COMP_WORDS[@]}-1)); COMPREPLY=(); cur="${COMP_WORDS[COMP_CWORD]}"; prev="${COMP_WORDS[COMP_CWORD-1]}"; _can can "$cur" "$prev"
 printf 'input:'; printf ' <%s>' "${COMP_WORDS[@]}"; printf '\n'; printf 'reply: <%s>\n' "${COMPREPLY[@]}"
}
cd /private/tmp/canlang-pass9-cli
run can li
run can lint --f
run can lint --fix
run can check --format j
run can check --format=j
run can completions ''
run can help li
run can run --f
run can check -- --f
