#!/usr/bin/env python3
"""Independent finite review: owned children, anonymous pipes and files only."""
import errno, hashlib, json, os, pathlib, resource, shutil, signal, subprocess, sys, tempfile

repo = pathlib.Path(__file__).resolve().parents[4]
folder = pathlib.Path(__file__).resolve().parent
target = pathlib.Path('/private/tmp/can-process-boundaries-target/debug')
sha = lambda b: hashlib.sha256(b).hexdigest()
pins = {str(p): sha((repo / p).read_bytes()) for p in map(pathlib.Path, [
    'compiler/src/main.rs', 'compiler/src/cli.rs', 'compiler/tests/process_boundaries.rs',
    'compiler/tests/exe.rs', 'compiler/Cargo.toml', 'compiler/Cargo.lock'])}
original = subprocess.check_output(['git', 'show', 'HEAD:compiler/src/main.rs'], cwd=repo)
rows = []
with tempfile.TemporaryDirectory(prefix='can-independent-boundary-review-') as scratch:
    scratch = pathlib.Path(scratch)
    base_source = scratch / 'baseline-main.rs'
    base_source.write_bytes(original)
    baseline = scratch / 'baseline-can'
    repaired = scratch / 'repaired-can'
    shutil.copy2(target / 'can', repaired)
    libraries = list((target / 'deps').glob('libcanlang_compiler-*.rlib'))
    assert len(libraries) == 1, libraries
    subprocess.run(['rustc', '--edition=2024', '--crate-name', 'can_boundary_review_baseline',
        str(base_source), '--extern', 'canlang_compiler=' + str(libraries[0]),
        '-L', 'dependency=' + str(target / 'deps'), '-o', str(baseline)], check=True)
    binaries = {'baseline_main_with_current_library': sha(baseline.read_bytes()),
                'owned_repaired_copy': sha(repaired.read_bytes())}
    def child_limits():
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Establish the actual errno of both independent sink controls.
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    try:
        os.write(write_fd, b'x')
        raise AssertionError('closed anonymous pipe unexpectedly accepted data')
    except OSError as error:
        assert error.errno == errno.EPIPE
        pipe_errno = error.errno
    finally:
        os.close(write_fd)
    preflight = subprocess.run([sys.executable, '-c',
        'import errno,os,sys; f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT,0o600);'
        '\ntry: os.write(f,b"x")\nexcept OSError as e: print(e.errno); assert e.errno == errno.EFBIG'
        '\nelse: raise AssertionError("write succeeded")\nfinally: os.close(f)',
        str(scratch / 'errno-preflight')], preexec_fn=child_limits, capture_output=True, timeout=10)
    assert preflight.returncode == 0, preflight
    file_errno = int(preflight.stdout)
    invalid = scratch / 'invalid.can'
    invalid.write_text('this is not {.can syntax !!!\n')
    cases = [
        ('ordinary_help', ['--help'], 'capture', 'capture', False, 0),
        ('ordinary_tool_error', ['unknown-command'], 'capture', 'capture', False, 2),
        ('ordinary_unwind', ['--help'], 'capture', 'capture', True, 2),
        ('unwind_closed_stderr', ['--help'], 'capture', 'pipe', True, 2),
        ('unwind_efbig_stderr', ['--help'], 'capture', 'file', True, 2),
        ('help_closed_stdout', ['--help'], 'pipe', 'capture', False, 0),
        ('diagnostic_closed_stdout', ['fmt', str(invalid)], 'pipe', 'capture', False, 10),
        ('tool_error_closed_stderr', ['unknown-command'], 'capture', 'pipe', False, 2),
        ('help_efbig_stdout', ['--help'], 'file', 'capture', False, 2),
        ('tool_error_efbig_stderr', ['unknown-command'], 'capture', 'file', False, 2),
        ('help_efbig_both', ['--help'], 'file', 'file', False, 2),
    ]
    for version, binary in [('baseline', baseline), ('repaired', repaired)]:
        for name, args, out_kind, err_kind, forced, expected in cases:
            fds = []
            def sink(kind):
                if kind == 'capture': return subprocess.PIPE
                if kind == 'pipe':
                    r, w = os.pipe(); os.close(r); fds.append(w); return w
                fd = os.open(scratch / (version + '-' + name + '-' + str(len(fds))),
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                fds.append(fd)
                return fd
            try:
                result = subprocess.run([str(binary), *args], stdin=subprocess.DEVNULL,
                    stdout=sink(out_kind), stderr=sink(err_kind), preexec_fn=child_limits,
                    env={**os.environ, 'CAN_INTERNAL_TEST_PANIC': '1' if forced else '0'}, timeout=10)
            finally:
                for fd in fds: os.close(fd)
            out, err = result.stdout or b'', result.stderr or b''
            rows.append(dict(version=version, name=name, args=args, stdout_sink=out_kind,
                stderr_sink=err_kind, code=result.returncode, stdout_hex=out.hex(),
                stderr_hex=err.hex(), stdout_sha256=sha(out), stderr_sha256=sha(err)))
            if version == 'repaired':
                assert result.returncode == expected, rows[-1]
                if name in ('ordinary_unwind', 'help_efbig_stdout'):
                    assert err.count(b'error[E7005]') == 1
                    assert all(word not in err for word in [b'panicked', b'backtrace', b"thread 'main'"])
            elif name in ('unwind_closed_stderr', 'unwind_efbig_stderr',
                          'tool_error_efbig_stderr', 'help_efbig_both'):
                assert result.returncode == -signal.SIGABRT, rows[-1]
    receipt = dict(source_pins=pins, baseline_main_sha256=sha(original), binary_pins=binaries,
        library_pin={str(libraries[0]): sha(libraries[0].read_bytes())},
        errno_controls={'anonymous_pipe': pipe_errno, 'child_owned_limited_file': file_errno},
        child_only_limits={'RLIMIT_FSIZE': [0, 0], 'SIGXFSZ': 'SIG_IGN', 'RLIMIT_CORE': [0, 0]},
        supervisor_timeout_seconds=10, observations=rows)
    (folder / 'raw.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({r['version'] + '/' + r['name']: r['code'] for r in rows}, indent=2))
