#compdef can

autoload -U is-at-least

_can() {
    typeset -A opt_args
    typeset -a _arguments_options
    local ret=1

    if is-at-least 5.2; then
        _arguments_options=(-s -S -C)
    else
        _arguments_options=(-s -C)
    fi

    local context curcontext="$curcontext" state line
    _arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
":: :_can_commands" \
"*::: :->can" \
&& ret=0
    case $state in
    (can)
        words=($line[1] "${words[@]}")
        (( CURRENT += 1 ))
        curcontext="${curcontext%:*:*}:can-command-$line[1]:"
        case $line[1] in
            (compile)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(check)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(lint)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'--fix[]' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(fmt)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'--check[]' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(explain)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(lsp)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
&& ret=0
;;
(policy)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(docs)
_arguments "${_arguments_options[@]}" : \
'--locale=[]: :_default' \
'--out=[]: :_default' \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(completions)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
':operands:(bash zsh fish)' \
&& ret=0
;;
(help)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'-h[Print help]' \
'--help[Print help]' \
'*::operands:_files' \
&& ret=0
;;
(run)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'*::operands:_files' \
&& ret=0
;;
(test)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'*::operands:_files' \
&& ret=0
;;
(build)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'*::operands:_files' \
&& ret=0
;;
(deploy)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'*::operands:_files' \
&& ret=0
;;
(activate)
_arguments "${_arguments_options[@]}" : \
'--format=[]: :(json text)' \
'--catalog=[]: :_default' \
'*::operands:_files' \
&& ret=0
;;
        esac
    ;;
esac
}

(( $+functions[_can_commands] )) ||
_can_commands() {
    local commands; commands=(
'compile:' \
'check:' \
'lint:' \
'fmt:' \
'explain:' \
'lsp:' \
'policy:' \
'docs:' \
'completions:' \
'help:' \
'run:' \
'test:' \
'build:' \
'deploy:' \
'activate:' \
    )
    _describe -t commands 'can commands' commands "$@"
}
(( $+functions[_can__subcmd__activate_commands] )) ||
_can__subcmd__activate_commands() {
    local commands; commands=()
    _describe -t commands 'can activate commands' commands "$@"
}
(( $+functions[_can__subcmd__build_commands] )) ||
_can__subcmd__build_commands() {
    local commands; commands=()
    _describe -t commands 'can build commands' commands "$@"
}
(( $+functions[_can__subcmd__check_commands] )) ||
_can__subcmd__check_commands() {
    local commands; commands=()
    _describe -t commands 'can check commands' commands "$@"
}
(( $+functions[_can__subcmd__compile_commands] )) ||
_can__subcmd__compile_commands() {
    local commands; commands=()
    _describe -t commands 'can compile commands' commands "$@"
}
(( $+functions[_can__subcmd__completions_commands] )) ||
_can__subcmd__completions_commands() {
    local commands; commands=()
    _describe -t commands 'can completions commands' commands "$@"
}
(( $+functions[_can__subcmd__deploy_commands] )) ||
_can__subcmd__deploy_commands() {
    local commands; commands=()
    _describe -t commands 'can deploy commands' commands "$@"
}
(( $+functions[_can__subcmd__docs_commands] )) ||
_can__subcmd__docs_commands() {
    local commands; commands=()
    _describe -t commands 'can docs commands' commands "$@"
}
(( $+functions[_can__subcmd__explain_commands] )) ||
_can__subcmd__explain_commands() {
    local commands; commands=()
    _describe -t commands 'can explain commands' commands "$@"
}
(( $+functions[_can__subcmd__fmt_commands] )) ||
_can__subcmd__fmt_commands() {
    local commands; commands=()
    _describe -t commands 'can fmt commands' commands "$@"
}
(( $+functions[_can__subcmd__help_commands] )) ||
_can__subcmd__help_commands() {
    local commands; commands=()
    _describe -t commands 'can help commands' commands "$@"
}
(( $+functions[_can__subcmd__lint_commands] )) ||
_can__subcmd__lint_commands() {
    local commands; commands=()
    _describe -t commands 'can lint commands' commands "$@"
}
(( $+functions[_can__subcmd__lsp_commands] )) ||
_can__subcmd__lsp_commands() {
    local commands; commands=()
    _describe -t commands 'can lsp commands' commands "$@"
}
(( $+functions[_can__subcmd__policy_commands] )) ||
_can__subcmd__policy_commands() {
    local commands; commands=()
    _describe -t commands 'can policy commands' commands "$@"
}
(( $+functions[_can__subcmd__run_commands] )) ||
_can__subcmd__run_commands() {
    local commands; commands=()
    _describe -t commands 'can run commands' commands "$@"
}
(( $+functions[_can__subcmd__test_commands] )) ||
_can__subcmd__test_commands() {
    local commands; commands=()
    _describe -t commands 'can test commands' commands "$@"
}

if [ "$funcstack[1]" = "_can" ]; then
    _can "$@"
else
    compdef _can can
fi
