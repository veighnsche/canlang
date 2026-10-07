#!/usr/bin/env python3
"""Bounded matched CLI + persistent framed LSP workload, not a general benchmark."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import re
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--before', type=Path, required=True)
parser.add_argument('--after', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
bins = {'before': args.before.resolve(), 'after': args.after.resolve()}
fixture = HERE.parent / 'pass10/workload/ExpenseFlow.can'
catalog = HERE.parent / 'pass10/workload/catalog.json'
live_catalog = ROOT / 'packages/values/dist/catalog.json'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def projection(artifact):
    value = json.loads(json.dumps(artifact))
    # Changed implementation locations/JS/maps are explicitly excluded. All
    # remaining artifact facts, including exact authored schemas/defaults,
    # identities, test metadata and source hashes, must stay equal.
    value.pop('modules')
    for item in value['callables']:
        for key in ['module', 'export', 'member']:
            item.pop(key)
    for item in value['pages']:
        for key in ['module', 'export']:
            item.pop(key)
    for item in value['tests']:
        if 'module' in item:
            item.pop('module')
    return value

artifacts = {}
cli = {side: [] for side in bins}
def compile_one(side):
    start = time.perf_counter_ns()
    run = subprocess.run([str(bins[side]), 'compile', '--format=json', '--catalog',
                          str(catalog), str(fixture)], cwd=ROOT, capture_output=True, timeout=10)
    elapsed = (time.perf_counter_ns() - start) / 1e6
    assert run.returncode == 0, run.stderr.decode()
    parsed = json.loads(run.stdout)
    if side not in artifacts:
        artifacts[side] = parsed
        (args.output / f'{side}-artifact.json').write_bytes(run.stdout)
        (args.output / f'{side}-compile.stderr').write_bytes(run.stderr)
    assert parsed == artifacts[side], 'same-side artifact determinism'
    return elapsed

class Session:
    def __init__(self, side):
        self.side, self.buffer, self.frames, self.next_id = side, b'', [], 1
        env = dict(os.environ, CAN_CATALOG=str(live_catalog))
        self.child = subprocess.Popen([str(bins[side]), 'lsp'], cwd=ROOT, env=env,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.ready = selectors.DefaultSelector()
        self.ready.register(self.child.stdout, selectors.EVENT_READ)
        self.request('initialize', {'processId': None, 'rootUri': None,
                     'capabilities': {'workspace': {'workspaceEdit': {'documentChanges': True}}}})
        self.send('initialized', {})

    def send(self, method, params, ident=None):
        value = {'jsonrpc': '2.0', 'method': method, 'params': params}
        if ident is not None:
            value['id'] = ident
        body = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        self.child.stdin.write(f'Content-Length: {len(body)}\r\n\r\n'.encode() + body)
        self.child.stdin.flush()

    def frame(self):
        deadline = time.monotonic() + 5
        while True:
            split = self.buffer.find(b'\r\n\r\n')
            if split >= 0:
                header = self.buffer[:split].decode('ascii')
                assert header.startswith('Content-Length: '), header
                size = int(header.split(': ')[1])
                assert 0 <= size <= 2 * 1024 * 1024
                if len(self.buffer) >= split + 4 + size:
                    body, self.buffer = self.buffer[split+4:split+4+size], self.buffer[split+4+size:]
                    value = json.loads(body)
                    self.frames.append(value)
                    return value
            remaining = deadline - time.monotonic()
            assert remaining > 0 and self.ready.select(remaining), 'framed read deadline'
            chunk = os.read(self.child.stdout.fileno(), 65536)
            assert chunk, 'unexpected LSP EOF'
            self.buffer += chunk

    def request(self, method, params):
        ident = self.next_id
        self.next_id += 1
        self.send(method, params, ident)
        value = self.frame()
        assert value.get('id') == ident and 'error' not in value, value
        return value['result']

    def edit_queries(self, revision):
        text = (ROOT / 'editors/vscode/test/lsp-capabilities.can').read_text()
        text = text.replace('   let', f'   ## é😀 revision{revision}\n   let').replace('\n', '\r\n')
        byte = text.index('task.title')
        before = text[:byte]
        position = {'line': before.count('\n'),
                    'character': len(before.rsplit('\n', 1)[-1].encode('utf-16-le')) // 2}
        uri = 'untitled:é😀-cost'
        start = time.perf_counter_ns()
        if revision == 1:
            self.send('textDocument/didOpen', {'textDocument': {
                'uri': uri, 'languageId': 'can', 'version': revision, 'text': text}})
        else:
            self.send('textDocument/didChange', {'textDocument': {'uri': uri, 'version': revision},
                                               'contentChanges': [{'text': text}]})
        publication = self.frame()
        assert publication['params'] == {'uri': uri, 'version': revision, 'diagnostics': []}, publication
        params = {'textDocument': {'uri': uri}, 'position': position}
        hover = self.request('textDocument/hover', params)
        completion = self.request('textDocument/completion', params)
        definition = self.request('textDocument/definition', params)
        references = self.request('textDocument/references', dict(params, context={'includeDeclaration': False}))
        rename = self.request('textDocument/rename', dict(params, newName='job'))
        tokens = self.request('textDocument/semanticTokens/full', {'textDocument': {'uri': uri}})
        actions = self.request('textDocument/codeAction', {'textDocument': {'uri': uri},
            'range': {'start': position, 'end': position}, 'context': {'diagnostics': []}})
        assert hover and isinstance(completion, list) and len(definition) == 1
        # Expected repair differences are explicit; timing is not an equivalence oracle.
        def at(offset):
            prefix = text[:offset]
            return {'line': prefix.count('\n'),
                    'character': len(prefix.rsplit('\n', 1)[-1].encode('utf-16-le')) // 2}
        ranges = [{'start': at(hit.start()), 'end': at(hit.end())}
                  for hit in re.finditer(r'\btask\b', text)]
        assert len(ranges) == 3
        expected_refs = ranges[:2] if self.side == 'before' else ranges[1:]
        assert references == [{'uri': uri, 'range': item} for item in expected_refs]
        change = rename['documentChanges'][0]
        assert change['textDocument'] == {'uri': uri, 'version': revision}
        expected_edits = ranges[:2] if self.side == 'before' else ranges
        assert change['edits'] == [{'range': item, 'newText': 'job'} for item in expected_edits]
        assert all(edit['newText'] == 'job' for edit in change['edits'])
        assert tokens['data'] and isinstance(actions, list)
        return (time.perf_counter_ns() - start) / 1e6

    def close(self):
        self.request('shutdown', None)
        self.send('exit', None)
        self.child.stdin.close()
        assert self.child.wait(timeout=5) == 0
        (args.output / f'{self.side}-lsp.frames.json').write_text(json.dumps(self.frames, indent=2) + '\n')
        (args.output / f'{self.side}-lsp.stderr').write_bytes(self.child.stderr.read())
        self.ready.close()

sessions = {side: Session(side) for side in bins}
lsp = {side: [] for side in bins}
order = []
try:
    for revision in range(1, 24):
        sides = ['before', 'after'] if revision % 2 else ['after', 'before']
        for side in sides:
            compile_ms = compile_one(side)
            lsp_ms = sessions[side].edit_queries(revision)
            if revision > 3:
                order.append(side)
                cli[side].append(compile_ms)
                lsp[side].append(lsp_ms)
    assert projection(artifacts['before']) == projection(artifacts['after'])
    for session in sessions.values():
        session.close()
finally:
    for session in sessions.values():
        if session.child.poll() is None:
            session.child.kill()
            session.child.wait(timeout=5)
            (args.output / f'{session.side}-failed-lsp.frames.json').write_text(json.dumps(session.frames, indent=2) + '\n')
            (args.output / f'{session.side}-failed-lsp.stderr').write_bytes(session.child.stderr.read())

result = {'scope': 'Native warm cache/process CLI compile and persistent single-document compiler LSP edit+7-query cycles; not VSCode GUI/client overhead or a general speed claim',
          'warmups_per_side': 3, 'samples_per_side': 20, 'alternating_order': order,
          'cli_compile_ms': cli, 'lsp_edit_seven_queries_ms': lsp,
          'median_ms': {'cli': {side: statistics.median(values) for side, values in cli.items()},
                        'lsp': {side: statistics.median(values) for side, values in lsp.items()}},
          'artifact_projection_equal': True,
          'projection_exclusions': ['modules (JS/maps/path)', 'callables module/export/member',
                                   'pages module/export', 'tests.module (JS/maps/path)'],
          'pins': {str(path): sha(path) for path in [*bins.values(), fixture, catalog, live_catalog,
                   ROOT / 'editors/vscode/test/lsp-capabilities.can', Path(__file__)]},
          'limits': ['explicit expected rename/reference count change', 'source history retained',
                     'no cold build/install, RSS/heap, GUI, full application or other-host measurement']}
(args.output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result['median_ms']))
