# Bash completion for `can` (CanLang compiler and authoring tools).
# Install: `can completions bash >> ~/.bash_completion` (or eval it in
# your shell rc: `eval "$(can completions bash)"`).
# Embedded in the binary too: `can completions bash` prints this file.

_can_complete() {
    local cur prev cmd
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    cmd="${COMP_WORDS[1]}"

    local commands="activate build check compile completions deploy docs explain fmt help lint lsp policy run test"

    # First operand: the subcommand.
    if (( COMP_CWORD == 1 )); then
        COMPREPLY=($(compgen -W "$commands --help --version" -- "$cur"))
        return 0
    fi

    # Thin commands pass every tail token to the platform, including flags.
    case "$cmd" in
        run|test|build|deploy|activate)
            COMPREPLY=($(compgen -f -- "$cur"))
            return 0
            ;;
    esac

    # Scan completed tokens: a separator used as an option value is data.
    local i takes_value=0
    for (( i=2; i<COMP_CWORD; i++ )); do
        if (( takes_value )); then
            takes_value=0
            continue
        fi
        case "${COMP_WORDS[i]}" in
            --)
                COMPREPLY=($(compgen -f -- "$cur"))
                return 0
                ;;
            --format|--catalog|--out|--locale) takes_value=1 ;;
        esac
    done

    case "$prev" in
        --format)
            COMPREPLY=($(compgen -W "json text" -- "$cur"))
            return 0
            ;;
        --catalog|--out)
            COMPREPLY=($(compgen -f -- "$cur"))
            return 0
            ;;
        --locale)
            # Free-form BCP 47 tag: nothing to complete.
            COMPREPLY=()
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
        lint)
            COMPREPLY=($(compgen -W "--fix --format --format=json --format=text --catalog --help" -f -- "$cur"))
            ;;
        check|compile|policy)
            COMPREPLY=($(compgen -W "--format --format=json --format=text --catalog --help" -f -- "$cur"))
            ;;
        fmt)
            COMPREPLY=($(compgen -W "--check --help -" -f -- "$cur"))
            ;;
        docs)
            COMPREPLY=($(compgen -W "--locale --out --format --format=json --format=text --catalog --help" -f -- "$cur"))
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
        *)
            COMPREPLY=($(compgen -W "$commands --help --version" -- "$cur"))
            ;;
    esac
}

complete -F _can_complete can
