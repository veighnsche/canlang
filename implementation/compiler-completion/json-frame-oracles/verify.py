"""Read-only current-body qualification; save evidence only in this packet."""
import hashlib,json,pathlib,re
ROOT=pathlib.Path(__file__).resolve().parents[3]
OUT=pathlib.Path(__file__).resolve().parent
NATIVE=ROOT/'implementation/compiler-completion/integration-after-bindings/after-action-invocation/native-run'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p): return json.loads(p.read_text())
relevant=['compiler/Cargo.toml','compiler/Cargo.lock','compiler/src/json.rs','compiler/src/docs.rs','compiler/src/lsp/transport.rs','compiler/src/lsp/server.rs','compiler/src/analysis/catalog.rs','compiler/tests/json_input_contract.rs','compiler/tests/catalog_input_contract.rs','compiler/tests/lsp_admission.rs','compiler/tests/lsp_frame_reader.rs','compiler/tests/common/lsp_driver.rs']
before=load(NATIVE/'before-compiler-inputs.json'); after=load(NATIVE/'after-compiler-inputs.json')
pins={p:{'current':sha(ROOT/p),'captured_before':before[p],'captured_after':after[p],'exact_current_match':sha(ROOT/p)==before[p]==after[p]} for p in relevant}
raw=(NATIVE/'full-suite.log').read_text()
# Extract actual test bodies named by the four owning integration suites.
suites={}
for name in ['catalog_input_contract','json_input_contract','lsp_admission','lsp_frame_reader']:
 pattern=r'Running tests/'+name+r'\.rs .*?(?=\n\s*Running |\n\s*Doc-tests |\Z)'
 match=re.search(pattern,raw,re.S); assert match,name
 section=match.group(0); assert 'SKIP ' not in section,name; (OUT/(name+'-retained.log')).write_text(section)
 result=re.search(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',section)
 assert result,name
 suites[name]={'passed':int(result[1]),'failed':int(result[2]),'ignored':int(result[3]),'logged_ok_bodies':len(re.findall(r'^test .+ \.\.\. ok$',section,re.M)),'retained_section_sha256':sha(OUT/(name+'-retained.log'))}
profile_checks={}
for path,size,h in re.findall(r'^PROFILE (.*?): bytes=(\d+) sha256=([0-9a-f]+)$',raw,re.M):
 if path.startswith('packages/values/'):
  current=ROOT/path
  profile_checks[path]={'captured_sha256':h,'current_sha256':sha(current),'captured_bytes':int(size),'current_bytes':current.stat().st_size,'exact_current_match':sha(current)==h and current.stat().st_size==int(size)}
assert len(profile_checks)==5 and all(x['exact_current_match'] for x in profile_checks.values()),profile_checks
json_controls=load(ROOT/'implementation/compiler-completion/json-reader/independent-review/controls.json')
frame_review=load(ROOT/'implementation/compiler-completion/frame-admission/independent-review/final-receipt.json')
receipt_paths=['docs/research/compiler-library-audit-20261006/resumption/audit-costs-and-oracles.md','implementation/compiler-completion/json-reader/independent-review/controls.json','implementation/compiler-completion/json-reader/independent-review/review.json','implementation/compiler-completion/json-reader/independent-review/README.md','implementation/compiler-completion/json-reader/independent-review/author-finite-tests.stdout','implementation/compiler-completion/json-reader/finite.rs','implementation/compiler-completion/frame-admission/independent-review/final-receipt.json','implementation/compiler-completion/frame-admission/independent-review/report.md','implementation/compiler-completion/frame-admission/independent-review/reader-controls.rs','implementation/compiler-completion/frame-admission/independent-review/reader-controls.log','implementation/compiler-completion/integration-after-bindings/after-action-invocation/native-run/profile-accounting/final-run.json','implementation/compiler-completion/integration-after-bindings/after-action-invocation/native-run/profile-accounting/independent-verification.json']
checks={p:{'recorded':h,'current':sha(ROOT/p),'exact_current_match':sha(ROOT/p)==h} for p,h in json_controls['pins_before'].items() if p in relevant}
frame_checks={x['path']:{'recorded':x['sha256'],'current':sha(ROOT/x['path']),'exact_current_match':sha(ROOT/x['path'])==x['sha256']} for x in frame_review['source_files']}
log_hash=sha(NATIVE/'full-suite.log'); expected=load(NATIVE/'completion.json')['log_sha256']
assert all(v['exact_current_match'] for v in pins.values()),pins
assert log_hash==expected
assert all(s['failed']==s['ignored']==0 and s['passed']==s['logged_ok_bodies'] for s in suites.values()),suites
receipt={'scope':'OR-05 bounded retained-current-oracle qualification; no implementation edits or test reruns','allocation':{'model':'Sol','reasoning':'medium','purpose':'finite source/outcome review; no pricing estimate'},'original_disposition':'Retain current tests; defer generic framework.','relevant_native_input_pins':pins,'native_log':{'path':str((NATIVE/'full-suite.log').relative_to(ROOT)),'sha256':log_hash,'completion_hash_matches':log_hash==expected,'source_commit':'83d40be0'},'retained_real_public_consumer_suites':suites,'available_catalog_producer_profile_checks':profile_checks,'narrow_json_independent_source_checks':checks,'narrow_frame_independent_source_checks':frame_checks,'raw_independent_dependency_pins_reused':{'upstream_pins':json_controls['upstream_pins'],'upstream_archive':json_controls['upstream_archive'],'artifact_pins':json_controls['artifact_pins']},'read_receipt_hashes':{p:sha(ROOT/p) for p in receipt_paths},'qualification':'accepted at original finite retention scope; distinct missing outcomes or production defects not identified','new_tests':0,'production_changes':0,'fresh_execution':'read-only exact hash and raw body-result verification only; no repeated green test run','scope_limits':['Not exhaustive JSON grammar or malformed-stream state exploration.','No full 64 MiB payload, RSS, slow-peer, whole-session budget, OS distribution or unusual peer qualification.','Complete invalid JSON or UTF-8 frame recovers; framing refusal closes. No arbitrary malformed-stream resynchronization promise.','Dependency upgrade needs requalification; no universal supported replacement impossibility claim.']}
(OUT/'verification.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'native_exact_matches':len(pins),'suites':suites,'historical_json_nonmatching':[p for p,v in checks.items() if not v['exact_current_match']],'historical_frame_nonmatching':[p for p,v in frame_checks.items() if not v['exact_current_match']]},indent=2))
