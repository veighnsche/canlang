# Fish completion for `can` (CanLang compiler and authoring tools).
# Install: `can completions fish > ~/.config/fish/completions/can.fish`
# (or eval it: `can completions fish | source`).
# Embedded in the binary too: `can completions fish` prints this file.

set -l commands activate build check compile completions deploy explain fmt help lint lsp policy run test

complete -c can -f -n __fish_use_subcommand -a activate -d 'Thin lane-7 entry: exec can-platform activate (passthrough)'
complete -c can -f -n __fish_use_subcommand -a build -d 'Thin lane-7 entry: exec can-platform build (passthrough)'
complete -c can -f -n __fish_use_subcommand -a check -d 'Analyze sources and report diagnostics'
complete -c can -f -n __fish_use_subcommand -a compile -d 'Analyze sources and emit the compile artifact'
complete -c can -f -n __fish_use_subcommand -a completions -d 'Print a shell completion script'
complete -c can -f -n __fish_use_subcommand -a deploy -d 'Thin lane-7 entry: exec can-platform deploy (passthrough)'
complete -c can -f -n __fish_use_subcommand -a explain -d 'Print a diagnostic catalog entry'
complete -c can -f -n __fish_use_subcommand -a fmt -d 'Format sources in place (or check with --check)'
complete -c can -f -n __fish_use_subcommand -a help -d 'Show help (global or per command)'
complete -c can -f -n __fish_use_subcommand -a lint -d 'Run lint rules over sources (warnings only, never blocks)'
complete -c can -f -n __fish_use_subcommand -a lsp -d 'Run the language server over stdio'
complete -c can -f -n __fish_use_subcommand -a policy -d 'Dump the declared policy surface'
complete -c can -f -n __fish_use_subcommand -a run -d 'Thin lane-7 entry: exec can-platform run (passthrough)'
complete -c can -f -n __fish_use_subcommand -a test -d 'Thin lane-7 entry: exec can-platform test (passthrough)'
complete -c can -f -n __fish_use_subcommand -s h -l help -d 'Show help'
complete -c can -f -n __fish_use_subcommand -s V -l version -d 'Show version'

# check|compile|lint|policy: format, catalog, .can operands.
for cmd in check compile lint policy
    complete -c can -f -n "__fish_seen_subcommand_from $cmd" -l format -x -a 'json text' -d 'Machine or human output'
    complete -c can -f -n "__fish_seen_subcommand_from $cmd" -l catalog -r -d 'Producer catalog path'
    complete -c can -f -n "__fish_seen_subcommand_from $cmd" -s h -l help -d 'Show help'
end

# fmt: --check plus .can operands.
complete -c can -f -n '__fish_seen_subcommand_from fmt' -l check -d 'Write nothing; list files that differ'
complete -c can -f -n '__fish_seen_subcommand_from fmt' -s h -l help -d 'Show help'

# explain: format plus a code operand.
complete -c can -f -n '__fish_seen_subcommand_from explain' -l format -x -a 'json text' -d 'Machine or human output'
complete -c can -f -n '__fish_seen_subcommand_from explain' -s h -l help -d 'Show help'

# lsp takes no operands.
complete -c can -f -n '__fish_seen_subcommand_from lsp' -s h -l help -d 'Show help'

# completions: the three shells.
complete -c can -f -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish' -d 'Shell'

# help: every command.
complete -c can -f -n '__fish_seen_subcommand_from help' -a "$commands"
