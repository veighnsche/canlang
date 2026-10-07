#!/usr/bin/env python3
import json,pathlib,tempfile
from run import HERE,ROOT,digest,invoke
def main():
    cases=json.loads((HERE/'cases.json').read_text())+json.loads((HERE/'extra-cases.json').read_text());receipts=[];out=[]
    with tempfile.TemporaryDirectory(prefix='can-step8-cli-') as t:
        for id in ['array-fixed-first','array-nullable-first','scope-derived','format-message-named']:
            c=next(c for c in cases if c['id']==id);p=pathlib.Path(t)/(id+'.can');p.write_text(c['source'])
            for cmd in ['check','compile']:
                d,r=invoke('cli-'+cmd+'-'+id,[ROOT/'compiler/target/debug/can',cmd,'--format=json',
                    '--catalog',ROOT/'packages/values/dist/catalog.json',p]);receipts.append(r)
                x=json.loads(d.stdout);out.append({'case':id,'command':cmd,'exit':d.returncode,
                    'source_sha256':digest(p),'raw':r['stdout'],'codes':[d['code'] for d in x.get('diagnostics',[])],
                    'has_modules':bool(x.get('modules'))})
    (HERE/'cli-observations.json').write_text(json.dumps(out,indent=2)+'\n')
    (HERE/'cli-execution.json').write_text(json.dumps({'commands':receipts,'binary':{'path':'compiler/target/debug/can','sha256':digest(ROOT/'compiler/target/debug/can')}},indent=2)+'\n')
    print(json.dumps(out,indent=2))
if __name__=='__main__':main()
