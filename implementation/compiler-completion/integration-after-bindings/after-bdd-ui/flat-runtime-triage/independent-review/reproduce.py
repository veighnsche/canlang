from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[6]
base=Path(__file__).resolve().parent.parent
sha=lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
index=json.loads((base/'evidence-index.json').read_text())
for name,digest in index.items(): assert sha(base/name)==digest,name
before=(base/'source-before.rs').read_text()
after=(base/'source-after.rs').read_text()
current=root/'compiler/tests/flat_expression_runtime.rs'
assert current.read_text()==after
assert sha(current)==json.loads((base/'all-six.status.json').read_text())['source_sha256']
old_body=before[before.index('fn root()'):]
new_body=after[after.index('fn root()'):]
expected=old_body.replace('&scratch.0','scratch.0.path()').replace('scratch.0.join(', 'scratch.0.path().join(')
assert expected==new_body,'change beyond owned scratch path projections'
assert 'SystemTime' not in after and 'impl Drop for Scratch' not in after
assert 'struct Scratch(tempfile::TempDir);' in after
manifest=root/'compiler/Cargo.toml'
assert 'tempfile = { version = "=3.27.0"' in manifest.read_text()
stdout=(base/'all-six.stdout').read_text()
stderr=(base/'all-six.stderr').read_text()
assert '6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out' in stdout
assert 'SKIP' not in stdout+stderr
assert json.loads((base/'all-six.status.json').read_text())['exit']==0
out={'sourceMatchesAfterPin':True,'allReceiptHashesMatch':True,'allBodiesAfterRootMatchOnlyPathProjection':True,'focusedReceipt':'6/6 actual controls, no SKIP','sourceSha256':sha(current),'cargoManifestSha256':sha(manifest),'limits':'test isolation only; historical collision inferred, no full-suite proof'}
(Path(__file__).resolve().parent/'pins.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out))
