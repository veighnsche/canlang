# Print an optspec for argparse to handle cmd's options that are independent of any subcommand.
function __fish_can_global_optspecs
    string join \n format= catalog= h/help
end

function __fish_can_needs_command
    # Figure out if the current invocation already has a command.
    set -l cmd (commandline -opc)
    set -e cmd[1]
    argparse -s (__fish_can_global_optspecs) -- $cmd 2>/dev/null
    or return
    if set -q argv[1]
        # Also print the command, so this can be used to figure out what it is.
        echo $argv[1]
        return 1
    end
    return 0
end

function __fish_can_using_subcommand
    set -l cmd (__fish_can_needs_command)
    test -z "$cmd"
    and return 1
    contains -- $cmd[1] $argv
end

complete -c can -n "__fish_can_needs_command" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_needs_command" -l catalog -r
complete -c can -n "__fish_can_needs_command" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_needs_command" -f -a "compile"
complete -c can -n "__fish_can_needs_command" -f -a "check"
complete -c can -n "__fish_can_needs_command" -f -a "lint"
complete -c can -n "__fish_can_needs_command" -f -a "fmt"
complete -c can -n "__fish_can_needs_command" -f -a "explain"
complete -c can -n "__fish_can_needs_command" -f -a "lsp"
complete -c can -n "__fish_can_needs_command" -f -a "policy"
complete -c can -n "__fish_can_needs_command" -f -a "docs"
complete -c can -n "__fish_can_needs_command" -f -a "completions"
complete -c can -n "__fish_can_needs_command" -f -a "help"
complete -c can -n "__fish_can_needs_command" -f -a "run"
complete -c can -n "__fish_can_needs_command" -f -a "test"
complete -c can -n "__fish_can_needs_command" -f -a "build"
complete -c can -n "__fish_can_needs_command" -f -a "deploy"
complete -c can -n "__fish_can_needs_command" -f -a "activate"
complete -c can -n "__fish_can_using_subcommand compile" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand compile" -l catalog -r
complete -c can -n "__fish_can_using_subcommand compile" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand check" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand check" -l catalog -r
complete -c can -n "__fish_can_using_subcommand check" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand lint" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand lint" -l catalog -r
complete -c can -n "__fish_can_using_subcommand lint" -l fix
complete -c can -n "__fish_can_using_subcommand lint" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand fmt" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand fmt" -l catalog -r
complete -c can -n "__fish_can_using_subcommand fmt" -l check
complete -c can -n "__fish_can_using_subcommand fmt" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand explain" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand explain" -l catalog -r
complete -c can -n "__fish_can_using_subcommand explain" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand lsp" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand lsp" -l catalog -r
complete -c can -n "__fish_can_using_subcommand lsp" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand policy" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand policy" -l catalog -r
complete -c can -n "__fish_can_using_subcommand policy" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand docs" -l locale -r
complete -c can -n "__fish_can_using_subcommand docs" -l out -r
complete -c can -n "__fish_can_using_subcommand docs" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand docs" -l catalog -r
complete -c can -n "__fish_can_using_subcommand docs" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand completions" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand completions" -l catalog -r
complete -c can -n "__fish_can_using_subcommand completions" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand help" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand help" -l catalog -r
complete -c can -n "__fish_can_using_subcommand help" -s h -l help -d 'Print help'
complete -c can -n "__fish_can_using_subcommand run" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand run" -l catalog -r
complete -c can -n "__fish_can_using_subcommand test" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand test" -l catalog -r
complete -c can -n "__fish_can_using_subcommand build" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand build" -l catalog -r
complete -c can -n "__fish_can_using_subcommand deploy" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand deploy" -l catalog -r
complete -c can -n "__fish_can_using_subcommand activate" -l format -r -f -a "json\t''
text\t''"
complete -c can -n "__fish_can_using_subcommand activate" -l catalog -r
