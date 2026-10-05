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
    case "$cmd" in
        check|compile|lint|policy)
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
        run|test|build|deploy|activate)
            # Thin lane-7 passthrough: flags belong to can-platform.
            _files
            ;;
    esac
}

_can "$@"
