#!/bin/bash
# Actual Bash function execution, no installed completion framework needed.
source /Users/vince/Projects/canlang/compiler/can-completions.bash
run() {
 COMP_WORDS=( "$@" ); COMP_CWORD=$((${#COMP_WORDS[@]}-1)); COMPREPLY=(); _can_complete
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
