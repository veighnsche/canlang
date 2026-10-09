#compdef can
# Zsh completion for `can` (CanLang compiler and authoring tools).
# Install: save as `_can` on your fpath (e.g. `can completions zsh >
# ~/.zsh/completions/_can`), or eval it: `eval "$(can completions zsh)"`.
# Embedded in the binary too: `can completions zsh` prints this file.

_can() {
    local -a commands
    commands=(
        'activate:Thin lane-7 entry: exec can-platform activate (passthrough)'
        'build:Thin lane-7 entry: exec can-platform build (passthrough)'
        'check:Analyze sources and report diagnostics'
        'compile:Analyze sources and emit the compile artifact'
        'completions:Print a shell completion script'
        'deploy:Thin lane-7 entry: exec can-platform deploy (passthrough)'
        'dev:JSON control for the local development session'
        'docs:Generate the localized internal declaration reference'
        'explain:Print a diagnostic catalog entry'
        'fmt:Format sources in place (or check with --check)'
        'help:Show help (global or per command)'
        'lint:Run lint rules over sources (warnings only, never blocks)'
        'lsp:Run the language server over stdio'
        'policy:Dump the declared policy surface'
        'run:Thin lane-7 entry: exec can-platform run (passthrough)'
        'test:Thin lane-7 entry: exec can-platform test (passthrough)'
    )

    if (( CURRENT == 2 )); then
        _describe -t commands 'can command' commands
        return
    fi

    local cmd="$words[2]"
    # Ignore a separator consumed as a split option value.
    local i takes_value=0
    for (( i=3; i<CURRENT; i++ )); do
        if (( takes_value )); then
            takes_value=0
            continue
        fi
        case "$words[i]" in
            --) _files; return ;;
            --format|--catalog|--out|--locale) takes_value=1 ;;
        esac
    done

    # _arguments numbers operands relative to the command being completed.
    words=("$words[2]" "${words[@]:2}")
    (( CURRENT-- ))
    case "$cmd" in
        lint)
            _arguments \
                '--fix[apply safe lint fixes]' \
                '--format=[output format]:format:(json text)' \
                '--catalog=[producer catalog]:file:_files' \
                '(-h --help)'{-h,--help}'[show help]' \
                '*:source file:_files -g "*.can"'
            ;;
        check|compile|policy)
            _arguments \
                '--format=[output format]:format:(json text)' \
                '--catalog=[producer catalog]:file:_files' \
                '(-h --help)'{-h,--help}'[show help]' \
                '*:source file:_files -g "*.can"'
            ;;
        fmt)
            _arguments \
                '--check[write nothing; list files that differ]' \
                '(-h --help)'{-h,--help}'[show help]' \
                '*:source file:_files -g "*.can"'
            ;;
        docs)
            _arguments \
                '--locale=[reference locale]:tag:' \
                '--out=[reference output file]:file:_files' \
                '--format=[output format]:format:(json text)' \
                '--catalog=[producer catalog]:file:_files' \
                '(-h --help)'{-h,--help}'[show help]' \
                '*:source file:_files -g "*.can"'
            ;;
        explain)
            _arguments \
                '--format=[output format]:format:(json text)' \
                '(-h --help)'{-h,--help}'[show help]' \
                '1:diagnostic code:'
            ;;
        lsp)
            _arguments '(-h --help)'{-h,--help}'[show help]'
            ;;
        completions)
            _arguments '1:shell:(bash zsh fish)'
            ;;
        help)
            _describe -t commands 'can command' commands
            ;;
        run|test|build|deploy|activate|dev)
            # Delegated command: flags belong to its owning client.
            _files
            ;;
    esac
}

_can "$@"
