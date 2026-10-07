#!/usr/bin/env python3
"""Fresh native analysis and bounded real-package probes; retain failures verbatim."""
import hashlib, json, pathlib, platform, subprocess, tempfile, time
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[4]
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def invoke(name, argv, cwd=ROOT):
    start=time.time(); d=subprocess.run([str(a) for a in argv],cwd=cwd,capture_output=True)
    for stream in ['stdout','stderr']:(HERE/(name+'.'+stream)).write_bytes(getattr(d,stream))
    return d, {'name':name,'argv':[str(a) for a in argv],'cwd':str(cwd),'exit':d.returncode,
        'elapsed_seconds':round(time.time()-start,3),**{s:name+'.'+s for s in ['stdout','stderr']},
        **{s+'_sha256':hashlib.sha256(getattr(d,s)).hexdigest() for s in ['stdout','stderr']}}
def main():
    receipts=[]
    for name,argv in [('rustc-version',['rustc','-Vv']),('cargo-version',['cargo','-V']),('node-version',['node','--version'])]:
        d,r=invoke(name,argv);receipts.append(r);assert d.returncode==0,r
    d,r=invoke('fresh-build',['cargo','build','--locked','--offline','--manifest-path','compiler/Cargo.toml',
        '--lib','--bin','can','--message-format=json']);receipts.append(r);assert d.returncode==0,r
    reported=[json.loads(l) for l in d.stdout.splitlines() if l.startswith(b'{')]
    def rlib(name):return next(f for a in reported if a.get('reason')=='compiler-artifact' and
        a['target']['name']==name for f in a['filenames'] if f.endswith('.rlib'))
    lib=rlib('canlang_compiler');ser=rlib('serde_json');observations=[]
    with tempfile.TemporaryDirectory(prefix='can-step8-') as scratch:
        scratch=pathlib.Path(scratch);exe=scratch/'probe'
        d,r=invoke('compile-probe',['rustc','--edition=2024',HERE/'probe.rs','--extern',
            'canlang_compiler='+lib,'--extern','serde_json='+ser,'-L',
            'dependency='+str(ROOT/'compiler/target/debug/deps'),'-o',exe]);receipts.append(r)
        assert d.returncode==0,r
        for c in json.loads((HERE/'cases.json').read_text()):
            src=scratch/(c['id']+'.can');src.write_text(c['source'])
            catalog=ROOT/'packages/values/dist/catalog.json'
            if c.get('catalog_override'):
                cat=json.loads(catalog.read_text());cat['catalog_version']='step8-controlled-'+c['id']
                for entry in cat['entries']:
                    if entry['id']=='lower':entry.update(c['catalog_override'])
                catalog=scratch/(c['id']+'-catalog.json');catalog.write_text(json.dumps(cat))
                (HERE/(c['id']+'-catalog.json')).write_bytes(catalog.read_bytes())
            d,r=invoke('case-'+c['id'],[exe,src,catalog,ROOT]);receipts.append(r)
            o=json.loads(d.stdout) if d.returncode==0 else None;checks=[]
            if o:
                ds=o['analysis']['diagnostics'];codes=[x['code'] for x in ds]
                checks.append({'contract':'syntax-qualified','pass':not o['parse_codes'] and o['coverage']})
                if c.get('clean'):checks.append({'contract':'analysis-clean','pass':not ds})
                for code in c.get('required_codes',[]):checks.append({'contract':code,'pass':code in codes})
                for code in c.get('forbidden_codes',[]):checks.append({'contract':'absent '+code,'pass':code not in codes})
            observations.append({'id':c['id'],'source_sha256':digest(src),'catalog_sha256':digest(catalog),
                'process_exit':d.returncode,'codes':codes if o else [],'assertions':checks,'observation':'case-'+c['id']+'.stdout'})
        (HERE/'observations.json').write_text(json.dumps(observations,indent=2)+'\n')
        # Repeated fresh processes qualify existing graph nondeterminism with this source build.
        c=next(c for c in json.loads((HERE/'cases.json').read_text()) if c['id']=='call-cycle-upstream')
        src=scratch/'call-cycle-upstream.can';src.write_text(c['source']);repeat=[]
        for i in range(12):
            d,r=invoke('graph-repeat-'+str(i),[exe,src,ROOT/'packages/values/dist/catalog.json',ROOT]);receipts.append(r)
            assert d.returncode==0,r
            repeat.append(json.loads(d.stdout)['analysis']['diagnostics'])
        (HERE/'graph-repeats.json').write_text(json.dumps(repeat,indent=2)+'\n')
    d,r=invoke('focused-suites',['cargo','test','--locked','--offline','--manifest-path','compiler/Cargo.toml',
        '--test','analysis','--test','b4_resolve','--test','b4_check','--test','effects','--test','check',
        '--test','b4_examples','--test','catalog_input_contract','--test','value_admission','--','--nocapture'])
    receipts.append(r)
    (HERE/'execution.json').write_text(json.dumps({'host':platform.platform(),'machine':platform.machine(),
        'commands':receipts,'libraries':[{'path':p,'sha256':digest(pathlib.Path(p))} for p in [lib,ser]],
        'suite_exit':d.returncode,'note':'Expected outcome mismatches are audit findings; process failures retained separately.'},indent=2)+'\n')
    print(json.dumps({'cases':len(observations),'mismatches':[o['id'] for o in observations if
        o['process_exit'] or any(not a['pass'] for a in o['assertions'])],'suite_exit':d.returncode}))
if __name__=='__main__':main()
