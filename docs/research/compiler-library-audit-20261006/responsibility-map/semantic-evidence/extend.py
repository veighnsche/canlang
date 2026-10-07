#!/usr/bin/env python3
"""Execute added semantic/value witnesses without rerunning unchanged passing suites."""
import json,pathlib,subprocess,tempfile
from run import HERE,ROOT,digest,invoke
def main():
    original=json.loads((HERE/'execution.json').read_text());libs=original['libraries']
    assert all(digest(pathlib.Path(p['path']))==p['sha256'] for p in libs)
    receipts=[];observations=[]
    with tempfile.TemporaryDirectory(prefix='can-step8-extra-') as scratch:
        scratch=pathlib.Path(scratch);exe=scratch/'probe'
        d,r=invoke('extra-compile-probe',['rustc','--edition=2024',HERE/'probe.rs','--extern',
            'canlang_compiler='+libs[0]['path'],'--extern','serde_json='+libs[1]['path'],'-L',
            'dependency='+str(ROOT/'compiler/target/debug/deps'),'-o',exe]);receipts.append(r);assert not d.returncode,r
        for c in json.loads((HERE/'extra-cases.json').read_text()):
            src=scratch/(c['id']+'.can');src.write_text(c['source']);cat=ROOT/'packages/values/dist/catalog.json'
            d,r=invoke('extra-'+c['id'],[exe,src,cat,ROOT]);receipts.append(r);assert not d.returncode,r
            o=json.loads(d.stdout);ds=o['analysis']['diagnostics'];codes=[d['code'] for d in ds]
            checks=[{'contract':'syntax-qualified','pass':not o['parse_codes'] and o['coverage']}]
            if 'accepted' in c:checks.append({'contract':'independent-source-admission','pass':(not ds)==c['accepted']})
            if c.get('emit_clean'):
                checks.append({'contract':'emission-accepted','pass':isinstance(o['emission'],dict) and not o['emission']['diagnostics']})
            observations.append({'id':c['id'],'source_sha256':digest(src),'catalog_sha256':digest(cat),'codes':codes,'assertions':checks,'observation':'extra-'+c['id']+'.stdout'})
        # Root imports resolve to the same installed workspace packages used by generated modules.
        (scratch/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
        runner=scratch/'owner.mjs';runner.write_bytes((HERE/'owner.mjs').read_bytes())
        d,r=invoke('owner-public-exports',['node',runner]);receipts.append(r);assert not d.returncode,r
        (HERE/'owner-observations.json').write_text(json.dumps(json.loads(d.stdout),ensure_ascii=False,indent=2)+'\n')
    (HERE/'extra-observations.json').write_text(json.dumps(observations,indent=2)+'\n')
    (HERE/'extra-execution.json').write_text(json.dumps({'commands':receipts,'fresh_library_receipt':'execution.json','libraries_rechecked':True},indent=2)+'\n')
    print(json.dumps({'extra_cases':len(observations),'mismatches':[o['id'] for o in observations if any(not a['pass'] for a in o['assertions'])]}))
if __name__=='__main__':main()
