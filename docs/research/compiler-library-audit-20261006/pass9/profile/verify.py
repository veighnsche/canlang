import pathlib, hashlib, json, datetime, re, subprocess
root=pathlib.Path('/Users/vince/Projects/canlang'); out=root/'docs/research/compiler-library-audit-20261006/pass9/profile'
snapshot=pathlib.Path('/private/tmp/canlang-pass9-profile/current')
manifest=json.loads((out/'source-manifest.json').read_text()); differences=[]
for path,pin in manifest.items():
    for side,base in [('live',root),('snapshot',snapshot)]:
        p=base/path; sha=hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
        if sha!=pin['sha256']: differences.append({'path':path,'side':side,'expected':pin['sha256'],'actual':sha})
all_live=[str(p.relative_to(root)) for p in (root/'compiler').rglob('*') if p.is_file() and not any(x in {'target','.git','.DS_Store'} for x in p.relative_to(root).parts)]
new_paths=sorted(set(all_live)-set(manifest))
parity={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'input_count':len(manifest),'snapshot_hashes_match':not any(d['side']=='snapshot' for d in differences),'live_hashes_match':not any(d['side']=='live' for d in differences),'differences':differences,'new_live_compiler_inputs':new_paths}
(out/'source-parity.json').write_text(json.dumps(parity,indent=2)+'\n')
log=(out/'linux-tests.log').read_text(); suites=[]
for name,block in re.findall(r'Running (\S+).*?\n(.*?test result:[^\n]+)',log,re.S):
    summary=re.search(r'test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out',block)
    if summary:
        state,*numbers=summary.groups(); passed,failed,ignored,measured,filtered=map(int,numbers)
        suites.append({'target':name,'status':state,'passed':passed,'failed':failed,'ignored':ignored,'measured':measured,'filtered_out':filtered,'executed_tests':re.findall(r'^test (.+) \.\.\. ok$',block,re.M)})
result={'image':'rust@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273','platform':'linux/amd64','network':'none','pull':'never','cargo_build_jobs':1,'cargo_incremental':0,'cargo_flags':['--offline','--locked'],'new_target_directories':0,'suites':suites,'passed':sum(s['passed'] for s in suites),'failed':sum(s['failed'] for s in suites),'ignored':sum(s['ignored'] for s in suites),'filtered_out':sum(s['filtered_out'] for s in suites),'in_body_skips':0,'runtime_scope':'ICU admission, IDE and docs only; shell completion engines and package-dependent runtime suites not executed or qualified by this receipt','cargo_lock_unchanged_from_pass8':(out/'Cargo.lock.txt').read_bytes()==(out.parent.parent/'pass8/profile/Cargo.lock.txt').read_bytes(),'cargo_manifest_unchanged_from_pass8':(out/'Cargo.toml.txt').read_bytes()==(out.parent.parent/'pass8/profile/Cargo.toml.txt').read_bytes()}
(out/'results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'parity':parity,'results':{k:v for k,v in result.items() if k!='suites'}},indent=2))
