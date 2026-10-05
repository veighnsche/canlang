# Bash completion for `can` (CanLang compiler and authoring tools).
# Install: `can completions bash >> ~/.bash_completion` (or eval it in
# your shell rc: `eval "$(can completions bash)"`).
# Embedded in the binary too: `can completions bash` prints this file.

_can_complete() {
    local cur prev cmd
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    cmd="${COMP_WORDS[1]}"

    local commands="activate build check compile completions deploy explain fmt help lint lsp policy run test"

    # First operand: the subcommand.
    if (( COMP_CWORD == 1 )); then
        COMPREPLY=($(compgen -W "$commands --help --version" -- "$cur"))
        return 0
    fi

    case "$prev" in
        --format)
            COMPREPLY=($(compgen -W "json text" -- "$cur"))
            return 0
            ;;
        --catalog)
            COMPREPLY=($(compgen -f -- "$cur"))
            return 0
            ;;
    esac
    case "$cur" in
        --format=*)
            COMPREPLY=($(compgen -W "--format=json --format=text" -- "$cur"))
            return 0
            ;;
    esac

    case "$cmd" in
        check|compile|lint|policy)
            COMPREPLY=($(compgen -W "--format --format=json --format=text --catalog --help" -f -- "$cur"))
            ;;
        fmt)
            COMPREPLY=($(compgen -W "--check --help -" -f -- "$cur"))
            ;;
        explain)
            COMPREPLY=($(compgen -W "--format --format=json --format=text --help" -- "$cur"))
            ;;
        lsp)
            COMPREPLY=($(compgen -W "--help" -- "$cur"))
            ;;
        completions)
            COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur"))
            ;;
        help)
            COMPREPLY=($(compgen -W "$commands" -- "$cur"))
            ;;
        run|test|build|deploy|activate)
            # Thin lane-7 passthrough: complete local files only; flags
            # belong to can-platform.
            COMPREPLY=($(compgen -f -- "$cur"))
            ;;
        *)
            COMPREPLY=($(compgen -W "$commands --help --version" -- "$cur"))
            ;;
    esac
}

complete -F _can_complete can
