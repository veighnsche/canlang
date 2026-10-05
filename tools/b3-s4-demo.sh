#!/bin/sh
# B3 S4 demo: compact agent fix-JSON + stale-edit rejection, real binary only.
#
#   lint -> fix JSON -> apply -> stale re-apply fails loud -> LSP leg
#
# Runs from a clean checkout with the real catalog
# (`packages/values/dist/catalog.json`; build it with `npm run catalog` in
# `packages/values`). Needs: cargo, python3. Exits 0 when every step
# demonstrates its point; step 4's inner re-apply command exits nonzero
# (that failure IS the demonstrated behavior) and its code is asserted.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CAN="$ROOT/compiler/target/debug/can"
CATALOG="$ROOT/packages/values/dist/catalog.json"
FIXTURE="$ROOT/compiler/tests/data/s4_fix.can"

say() { printf '\n=== %s ===\n' "$*"; }

if [ ! -f "$CATALOG" ]; then
  echo "error: no $CATALOG (run \`npm run catalog\` in packages/values)" >&2
  exit 2
fi
if [ ! -f "$FIXTURE" ]; then
  echo "error: no $FIXTURE" >&2
  exit 2
fi
command -v python3 >/dev/null 2>&1 || { echo "error: python3 required" >&2; exit 2; }

say "build the real binary"
cargo build --manifest-path "$ROOT/compiler/Cargo.toml" -q 2>&1 | tail -2

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
cp "$FIXTURE" "$WORK/s4_fix.can"
FILE="$WORK/s4_fix.can"

say "1. can lint --format=json (finding, no fixes key)"
"$CAN" lint --format=json --catalog="$CATALOG" "$FILE" | tee "$WORK/lint.json" | python3 -c "
import json, sys
env = json.load(sys.stdin)
print('diagnostics:', [(d['code'], d['severity']) for d in env['diagnostics']])
assert 'fixes' not in env, 'plain lint must carry no fixes key'
assert any(d['code'] == 'I1002' for d in env['diagnostics']), 'want the I1002 site'
"

say "2. can lint --fix --format=json (fix JSON, rerun byte-identical)"
"$CAN" lint --fix --format=json --catalog="$CATALOG" "$FILE" | tee "$WORK/fix1.json" | python3 -c "
import json, sys
env = json.load(sys.stdin)
fixes = env['fixes']
print('fixes:', [(f['rule'], f['span'], repr(f['replacement'])) for f in fixes])
assert len(fixes) == 1 and fixes[0]['rule'] == 'redundant-null-marker'
print('expected_sha256:', fixes[0]['expected_sha256'][:16] + '...')
"
"$CAN" lint --fix --format=json --catalog="$CATALOG" "$FILE" > "$WORK/fix2.json"
cmp "$WORK/fix1.json" "$WORK/fix2.json" && echo "rerun: byte-identical"

say "3. apply the fix (sha-verified splice)"
python3 - "$WORK/fix1.json" "$FILE" <<'EOF'
import hashlib, json, sys
env = json.load(open(sys.argv[1]))
path = sys.argv[2]
fix = env['fixes'][0]
text = open(path, 'rb').read()
sha = hashlib.sha256(text).hexdigest()
assert sha == fix['expected_sha256'], f"refusing apply: {sha} != {fix['expected_sha256']}"
start, end = fix['span']['start'], fix['span']['end']
assert text[start:end] == b'?.', text[start:end]
open(path, 'wb').write(text[:start] + fix['replacement'].encode() + text[end:])
print(f"applied {fix['rule']} at bytes {start}..{end}: {text[start:end]!r} -> {fix['replacement']!r}")
EOF
echo "--- fixed file ---"
cat "$FILE"

say "4. stale re-apply of the SAME fix JSON fails loud (nonzero exit)"
set +e
python3 - "$WORK/fix1.json" "$FILE" <<'EOF'
import hashlib, json, sys
env = json.load(open(sys.argv[1]))
path = sys.argv[2]
fix = env['fixes'][0]
found = hashlib.sha256(open(path, 'rb').read()).hexdigest()
# Same shape as lint::driver::rejected_to_json(Stale{..}): fixed key order.
stale = {"status": "rejected", "reason": "stale",
         "expected": fix['expected_sha256'], "found": found}
print(json.dumps(stale, separators=(',', ':')))
if found != fix['expected_sha256']:
    print(f"STALE: content changed since the fix was computed", file=sys.stderr)
    sys.exit(1)
EOF
CODE=$?
set -e
echo "re-apply exit code: $CODE"
if [ "$CODE" -eq 0 ]; then
  echo "error: stale re-apply unexpectedly succeeded" >&2
  exit 1
fi

say "5. LSP leg: codeAction before/after didChange through can lsp"
CAN_BIN="$CAN" python3 - "$FIXTURE" <<'EOF'
import json, os, re, subprocess, sys
binpath = os.environ['CAN_BIN']
text = open(sys.argv[1]).read()
uri = 'file:///s4_fix.can'
p = subprocess.Popen([binpath, 'lsp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

def send(obj):
    body = json.dumps(obj).encode()
    p.stdin.write(f'Content-Length: {len(body)}\r\n\r\n'.encode() + body)
    p.stdin.flush()

def read_msg():
    headers = b''
    while b'\r\n\r\n' not in headers:
        chunk = p.stdout.read(1)
        assert chunk, 'server closed stdout'
        headers += chunk
    n = int(re.search(rb'Content-Length: (\d+)', headers).group(1))
    body = b''
    while len(body) < n:
        body += p.stdout.read(n - len(body))
    return json.loads(body)

def request(i, method, params):
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    while True:
        m = read_msg()
        if m.get('id') == i:
            return m

request(1, 'initialize', {})
send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
send({"jsonrpc": "2.0", "method": "textDocument/didOpen",
      "params": {"textDocument": {"uri": uri, "version": 1, "text": text}}})
at = text.index('?.')
line = text.count('\n', 0, at)
col = at - (text.rfind('\n', 0, at) + 1)
rng = {"start": {"line": line, "character": col},
       "end": {"line": line, "character": col + 2}}
before = request(2, 'textDocument/codeAction',
                 {"textDocument": {"uri": uri}, "range": rng})['result']
print(f"codeAction before didChange: {len(before)} action(s): {[a['title'] for a in before]}")
assert len(before) == 1 and 'redundant' in before[0]['title']
send({"jsonrpc": "2.0", "method": "textDocument/didChange",
      "params": {"textDocument": {"uri": uri, "version": 2},
                 "contentChanges": [{"text": text.replace('?.', '.')}]}})
after = request(3, 'textDocument/codeAction',
                {"textDocument": {"uri": uri}, "range": rng})['result']
print(f"codeAction after didChange: {len(after)} action(s)")
assert after == []
request(4, 'shutdown', {})
send({"jsonrpc": "2.0", "method": "exit", "params": {}})
assert p.wait(timeout=10) == 0
print('LSP leg OK (shutdown/exit clean)')
EOF

say "B3-S4 DEMO OK"
