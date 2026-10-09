# Real compinit/ZLE engine; sentinel synchronization avoids timed transcript guesses.
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
p = subprocess.Popen([sys.argv[1], '-f'], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
def until(marker):
    data = b''
    deadline = time.monotonic() + 10
    while marker not in data:
        if b'\r\nBOOT_FAILED:' in data:
            raise AssertionError(('completion bootstrap failed', data))
        if time.monotonic() > deadline:
            raise AssertionError(('completion synchronization timeout', data))
        if select.select([master], [], [], .1)[0]:
            data += os.read(master, 65536)
    return data
# compinit -i audits fpath and ignores insecure directories without prompting.
# Split the ready sentinel in the command so terminal echo cannot signal readiness.
try:
    os.write(master, b"autoload -Uz compinit; compinit -i -D || { print -r -- BOOT_FAILED:compinit; exit 1; }; (( $+functions[compdef] )) || { print -r -- BOOT_FAILED:compdef; exit 1; }; PS1='READY> '; source ./completion.zsh && compdef _can can || { print -r -- BOOT_FAILED:can_completion; exit 1; }; bindkey '^I' expand-or-complete; report() { print -r -- RESULT:$BUFFER:END; zle reset-prompt; }; zle -N report; bindkey '^X' report; print BOOT''ED\n")
    until(b'BOOTED\r\n')
    cases = [
        ('can completions b', 'can completions bash'),
        ('can completions z', 'can completions zsh'),
        ('can completions f', 'can completions fish'),
        ('can lint --fi', 'can lint --fix'),
        ('can lint --fix', 'can lint --fix'),
        ('can check --fix', 'can check --fix'),
        ('can check --format=j', 'can check --format=json'),
        ('can check --format j', 'can check --format json'),
        ('can check -- --f', 'can check -- --f-file.can'),
        ('can check -- --format=j', 'can check -- --format=j'),
        ('can lint --catalog -- -- --f', 'can lint --catalog -- -- --f-file.can'),
        ('can check --catalog -- --fix', 'can check --catalog -- --fix'),
        ('can check --catalog -- --format=j', 'can check --catalog -- --format=json'),
        ('can docs --out uni', 'can docs --out unique.can'),
        ('can check --catalog uni', 'can check --catalog unique.can'),
        ('can docs --locale en', 'can docs --locale en'),
        ('can help li', 'can help lint'),
    ]
    for cmd in ('run', 'test', 'build', 'deploy', 'activate'):
        cases.extend([
            (f'can {cmd} --f', f'can {cmd} --f-file.can'),
            (f'can {cmd} --format=j', f'can {cmd} --format=j'),
            (f'can {cmd} --format uni', f'can {cmd} --format unique.can'),
            (f'can {cmd} --format --f', f'can {cmd} --format --f-file.can'),
            (f'can {cmd} --locale uni', f'can {cmd} --locale unique.can'),
            (f'can {cmd} --catalog -- --f', f'can {cmd} --catalog -- --f-file.can'),
        ])
    for before, expected in cases:
        os.write(master, b'\x15' + before.encode() + b'\t\x18')
        data = until(b':END\r\n')
        result = data.rsplit(b'RESULT:', 1)[1].split(b':END', 1)[0].decode().rstrip()
        assert result == expected, (before, result, expected, data)
        print(before, '=>', result)
finally:
    p.kill()
    p.wait(timeout=5)
    os.close(master)
