#!/usr/bin/env python3
"""Read-only policy support inventory; write evidence only beside this script."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3]
OUT=Path(__file__).resolve().parent
RAW=OUT/'raw'
RAW.mkdir(exist_ok=True)
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def emit(name,data): (OUT/name).write_text(json.dumps(data,indent=2)+'\n')
def capture(path,name,start=None,end=None):
    p=ROOT/path if not Path(path).is_absolute() else Path(path)
    lines=p.read_text().splitlines(keepends=True)
    a=start or 1;b=end or len(lines)
    (RAW/name).write_text(''.join(lines[a-1:b]))
    return {'path':str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p),'sha256':sha(p),'span':[a,b],'inclusive_physical_lines':b-a+1,'raw':f'raw/{name}'}
profile='implementation/compiler-completion/integration-after-bindings/after-decimal-materialization/'
manifests={k:json.loads((ROOT/profile/p).read_text()) for k,p in [('compiler','before-compiler-inputs.json'),('packages','before-package-producers.json'),('can','before-external-can-fixtures.json')]}
files=['AGENTS.md','compiler/src/policy.rs','compiler/src/json.rs','compiler/src/cli.rs','compiler/src/lib.rs','compiler/Cargo.toml','compiler/Cargo.lock','compiler/tests/typed_policy.rs','compiler/tests/typed_reference_policy_consumers.rs','packages/ui/src/policyPage.ts','packages/ui/dist/src/policyPage.js','packages/ui/src/index.ts','packages/ui/dist/src/index.js','packages/values/dist/catalog.json']
pins=[]
for f in files:
    item=capture(f,f.replace('/','__'))
    candidates={k:m[f] for k,m in manifests.items() if f in m}
    item['historical_profile_pins']=candidates
    item['matches_historical_profile']=all(h==item['sha256'] for h in candidates.values()) if candidates else None
    pins.append(item)
emit('source-pins.json',pins)
spans=[('policy DTOs','compiler/src/policy.rs',29,120),('public extractor','compiler/src/policy.rs',128,142),('public serializer and private Envelope','compiler/src/policy.rs',144,163),('entire retirement region incl owning comments','compiler/src/policy.rs',165,306),('PolicyFormatter derive and declaration','compiler/src/policy.rs',167,173),('Layout declaration','compiler/src/policy.rs',175,183),('indent','compiler/src/policy.rs',185,191),('Formatter implementation','compiler/src/policy.rs',193,306),('shared compact public adapter and layout adapter','compiler/src/json.rs',11,35),('shared compatible escape owner and compact formatter','compiler/src/json.rs',37,60),('CLI owned policy path','compiler/src/cli.rs',787,866),('public module export','compiler/src/lib.rs',19,19),('actual UI sections and page','packages/ui/src/policyPage.ts',153,214)]
entries=[]
for i,(label,f,a,b) in enumerate(spans):
    item=capture(f,f'span-{i:02d}.txt',a,b);item['owner']=label;entries.append(item)
emit('declaration-spans.json',entries)
queries={'policy-callers':['rg','-n','policy_dump_json|policy_dump\\(|PolicyFormatter|Layout|fn indent','compiler/src/policy.rs','compiler/src/cli.rs','compiler/tests/typed_policy.rs','compiler/tests/typed_reference_policy_consumers.rs'], 'shared-adapter-callers':['rg','-n','to_string_with_formatter|to_compact_string|write_compatible_escape','compiler/src','--glob','*.rs']}
for name,cmd in queries.items():
    result=subprocess.run(cmd,cwd=ROOT,text=True,capture_output=True,check=False)
    (RAW/f'{name}.txt').write_text(result.stdout+result.stderr)
    assert result.returncode==0
ser=Path('/Users/vince/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/serde_json-1.0.151/src/ser.rs')
upstream=[capture(str(ser),'serde-default-escape.txt',1763,1798),capture(str(ser),'serde-compact-pretty.txt',1937,2067),capture(str(ser),'serde-public-string-adapters.txt',2228,2274)]
emit('standard-public-serializer.json',upstream)
history=[capture(profile+'full-suite.log','historical-policy-results.txt',1734,1753),capture(profile+'profile-accounting/final-run.json','historical-profile-receipt.json'),capture('docs/research/compiler-library-audit-20261006/pass5/families/policy.md','historical-policy-contract.md'),capture('docs/research/compiler-library-audit-20261006/pass5/families/reference-policy-consumers.log','historical-actual-consumers.log'),capture('docs/research/compiler-library-audit-20261006/pass5/family-review.md','historical-family-review.md'),capture('docs/research/compiler-library-audit-20261006/pass5/fmt-comparison.json','historical-rustfmt-comparison.json'),capture('docs/research/compiler-library-audit-20261006/responsibility-map/integrations.md','original-requirement-row.txt',47,47)]
emit('historical-evidence.json',history)
# Reuse only exact named current production/test/actual-consumer input pins.
reused=[p for p in pins if p['historical_profile_pins']]
assert all(p['matches_historical_profile'] for p in reused), 'Relevant historical input mismatch: requalify before reuse'
summary={'reference':'integration:policy-layout-engine','head_observed':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'profile_manifest_counts':{k:len(m) for k,m in manifests.items()},'matched_relevant_profile_inputs':len(reused),'historical_scope':'Relevant matching source/test/actual built UI consumer bodies only; full 121/1770/5 profile is historical, not current whole-source qualification.','retirement_count':142,'retirement_span':[165,306],'conditional_net_target':120,'maximum_replacement_closure_growth_if_only_retirement_region_removed':22,'deleted_production_lines':0,'deleted_mechanisms':0,'new_tests_or_test_runs':0,'outcome':'RETAIN current supported formatter and byte/helper contract; no new API/layout policy selected','future_revision':'Conditional cleanup remains proposed and needs owning byte/readability/layout revision plus actual-consumer qualification and full net count.'}
emit('inventory.json',summary)
print(json.dumps(summary,indent=2))
