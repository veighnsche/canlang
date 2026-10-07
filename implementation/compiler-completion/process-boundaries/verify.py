#!/usr/bin/env python3
"""Finite actual executable probes. All altered descriptors/files are owned fixtures."""
import argparse, hashlib, json, os, pathlib, platform, resource, signal, subprocess, tempfile

p = argparse.ArgumentParser()
p.add_argument('binary', type=pathlib.Path)
p.add_argument('receipt', type=pathlib.Path)
p.add_argument('--expect-repaired', action='store_true')
a = p.parse_args()
binary = a.binary.resolve()
rows = []
def limit_file_writes():
    signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
with tempfile.TemporaryDirectory(prefix='can-process-boundaries-') as tmp:
    root = pathlib.Path(tmp)
    fixture = root / 'read-only-fd'
    fixture.write_bytes(b'owned fixture')
    def observe(name, args, stdout='capture', stderr='capture', env=None, ignore_sigchld=False):
        handles = []
        def sink(kind):
            if kind == 'capture': return subprocess.PIPE
            if kind == 'readonly':
                fd = os.open(fixture, os.O_RDONLY)
                handles.append(fd)
                return fd
            if kind == 'limitedfile':
                fd = os.open(root / (name + '-' + str(len(handles))), os.O_WRONLY | os.O_CREAT, 0o600)
                handles.append(fd)
                return fd
            if kind == 'brokenpipe':
                read, write = os.pipe()
                os.close(read)
                handles.append(write)
                return write
            raise ValueError(kind)
        try:
            result = subprocess.run([str(binary), *args], stdin=subprocess.DEVNULL,
                stdout=sink(stdout), stderr=sink(stderr), timeout=15,
                preexec_fn=(lambda: signal.signal(signal.SIGCHLD, signal.SIG_IGN)) if ignore_sigchld
                    else limit_file_writes if 'limitedfile' in (stdout, stderr) else None,
                env={**os.environ, 'CAN_INTERNAL_TEST_PANIC': '0', **(env or {})})
        finally:
            for fd in handles: os.close(fd)
        out, err = result.stdout or b'', result.stderr or b''
        row = dict(name=name, args=args, stdout_sink=stdout, stderr_sink=stderr,
                   code=result.returncode, stdout_bytes=len(out), stderr_bytes=len(err),
                   stdout_sha256=hashlib.sha256(out).hexdigest(), stderr_sha256=hashlib.sha256(err).hexdigest(),
                   stderr=err.decode(errors='replace'))
        rows.append(row)
        return result
    observe('normal-help', ['--help'])
    observe('normal-error', ['unknown-command'])
    observe('stdout-epipe-success', ['--help'], stdout='brokenpipe')
    broken = root / 'broken.can'
    broken.write_text('this is not {.can syntax !!!\n')
    observe('stdout-epipe-diagnostics', ['fmt', str(broken)], stdout='brokenpipe')
    observe('stderr-epipe-tool-error', ['unknown-command'], stderr='brokenpipe')
    observe('stdout-readonly', ['--help'], stdout='readonly')
    observe('stderr-readonly', ['unknown-command'], stderr='readonly')
    observe('both-readonly', ['--help'], stdout='readonly', stderr='readonly')
    observe('stdout-efbig', ['--help'], stdout='limitedfile')
    observe('stderr-efbig', ['unknown-command'], stderr='limitedfile')
    observe('both-efbig', ['--help'], stdout='limitedfile', stderr='limitedfile')
    for kind in ['capture', 'brokenpipe', 'readonly', 'limitedfile']:
        observe('forced-panic-stderr-' + kind, ['--help'], stderr=kind,
                env={'CAN_INTERNAL_TEST_PANIC': '1'})
    for name, body in [('exit37', 'printf out; printf err >&2; exit 37'),
                       ('signal', 'kill -TERM $$'),
                       ('finite-output', 'head -c 262144 /dev/zero; head -c 262144 /dev/zero >&2')]:
        pid_path = root / (name + '.pid')
        stub = root / name
        stub.write_text('#!/bin/sh\nprintf "%s" $$ > "' + str(pid_path) + '"\n' + body + '\n')
        stub.chmod(0o755)
        result = observe('thin-' + name, ['run', '--literal', 'space value'], env={'CAN_PLATFORM_BIN': str(stub)})
        if name == 'finite-output':
            assert result.stdout == b'\0' * 262144 and result.stderr == b'\0' * 262144
        if name == 'exit37':
            assert result.stdout == b'out' and result.stderr == b'err'
        pid = int(pid_path.read_text())
        try:
            os.kill(pid, 0)
            alive = True
        except ProcessLookupError:
            alive = False
        rows[-1]['child_alive_after_return'] = alive
        rows[-1]['stub_body'] = body
        if name == 'exit37':
            wait_error = observe('thin-inherited-sigchld-ignore', ['run'], env={'CAN_PLATFORM_BIN': str(stub)}, ignore_sigchld=True)
            pid = int(pid_path.read_text())
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            rows[-1]['child_alive_after_return'] = alive
            rows[-1]['inherited_sigchld'] = 'SIG_IGN'
            rows[-1]['wait_error_hypothesis'] = 'Inherited SIGCHLD ignore may make wait fail; outcome retained without assuming ECHILD'
            (a.receipt.parent / 'sigchld-observation.json').write_text(json.dumps(rows[-1], indent=2) + '\n')
    missing = root / 'absent'
    observe('thin-missing', ['run'], env={'CAN_PLATFORM_BIN': str(missing)})
    not_executable = root / 'not-executable'
    not_executable.write_text('owned nonexecutable fixture')
    observe('thin-unexecutable', ['run'], env={'CAN_PLATFORM_BIN': str(not_executable)})
    assert fixture.read_bytes() == b'owned fixture'
receipt = dict(platform=platform.platform(), binary=str(binary),
               binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
               supervisor_timeout_seconds=15, observations=rows)
a.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
if a.expect_repaired:
    expected = {'normal-help': 0, 'normal-error': 2, 'stdout-epipe-success': 0,
        'stdout-epipe-diagnostics': 10, 'stderr-epipe-tool-error': 2,
        'stdout-readonly': 0, 'stderr-readonly': 2, 'both-readonly': 0,
        'stdout-efbig': 2, 'stderr-efbig': 2, 'both-efbig': 2,
        'forced-panic-stderr-capture': 2, 'forced-panic-stderr-brokenpipe': 2,
        'forced-panic-stderr-readonly': 2, 'forced-panic-stderr-limitedfile': 2,
        'thin-exit37': 37, 'thin-signal': 2, 'thin-finite-output': 0,
        'thin-missing': 2, 'thin-unexecutable': 2, 'thin-inherited-sigchld-ignore': 37}
    assert {r['name']:r['code'] for r in rows} == expected
    assert all(not r.get('child_alive_after_return', False) for r in rows)
    for row in rows:
        if row['name'] in ('stdout-efbig', 'forced-panic-stderr-capture'):
            assert 'error[E7005]' in row['stderr'] and 'panicked' not in row['stderr']
print(json.dumps({r['name']:r['code'] for r in rows}, indent=2))
