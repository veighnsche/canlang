import hashlib,json,pathlib
repo=pathlib.Path('/Users/vince/Projects/canlang')
private=pathlib.Path('/private/tmp/canlang-rust-port-codex-step12-20261007T025830Z')
run=repo/'implementation/rust-port-orchestration/runs/codex-step12-20261007T025830Z'
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((run/'review-source-manifest.json').read_text())
sources=[]
for r in manifest['sources']:
 current=digest(repo/r['path']);sources.append({'path':r['path'],'frozen':r['sha256'],'current':current,'equal':current==r['sha256']})
raw=[]
for r in manifest['raw_receipts']:
 original=digest(pathlib.Path(r['original_path']));packet=digest(private/'critical-review-packet'/r['packet_path'])
 raw.append({'path':r['original_path'],'equal':original==packet==r['sha256'],'sha256':original})
corpora=[]
for name in ['native-frozen-witness.json','fresh-frozen-witness.json']:
 p=pathlib.Path('/private/tmp/canlang-rust-port-codex-step9-20261007T012914Z/values/corrected')/name
 rows=json.loads(p.read_text());mismatches=[r for r in rows if r.get('actual')!=r.get('expected')]
 corpora.append({'path':str(p),'sha256':digest(p),'rows':len(rows),'domains':{d:sum(r.get('domain')==d for r in rows) for d in ['number','string']},'mismatch_count':len(mismatches),'first_mismatch':mismatches[:1]})
generated=repo/'packages/values/bindings/generated'
build=json.loads((generated/'BUILD.json').read_text());assets=[]
for name,r in build['files'].items():
 current=digest(generated/name);assets.append({'name':name,'expected':r['sha256'],'current':current,'bytes':(generated/name).stat().st_size,'equal':current==r['sha256'] and (generated/name).stat().st_size==r['bytes']})
record=json.loads(pathlib.Path('/private/tmp/canlang-rust-port-codex-step9-20261007T012914Z/values/corrected/receipt.json').read_text())
successors={'BUILD.json':digest(generated/'BUILD.json')==record['fresh_BUILD_sha256'],'values_semantics_bg.wasm':digest(generated/'values_semantics_bg.wasm')==record['fresh_binary_sha256']}
result={'base':manifest['base'],'source_count':len(sources),'sources':sources,'raw_count':len(raw),'raw':raw,'actual_transport_corpora':corpora,'generated_assets':assets,'fresh_step9_successors_equal':successors,'performed':'Read-only source/receipt/corpus/inventory checks; no build or runtime rerun'}
(private/'sol/qualified-record-checks.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'sources':len(sources),'source_mismatches':[r for r in sources if not r['equal']],'raw':len(raw),'raw_mismatches':[r for r in raw if not r['equal']],'corpora':corpora,'asset_mismatches':[r for r in assets if not r['equal']],'successors':successors},indent=2))
