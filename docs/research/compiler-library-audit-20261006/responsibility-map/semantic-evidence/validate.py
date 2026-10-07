#!/usr/bin/env python3
"""Validate the one extended ledger, frozen inputs, source projections and raw captures."""
import collections,contextlib,hashlib,io,json,pathlib,re,subprocess
from run import HERE,ROOT,digest
def main():
    directory=HERE.parent;out=directory/'semantic-validation.json';out.write_text('{"status":"validating"}\n')
    # Run the prior full inventory/syntax joins in memory, redirecting only new receipts.
    previous=directory/'syntax-evidence/validate.py';code=previous.read_text()
    code=code.replace('from run import HERE, ROOT, digest',
        'HERE=pathlib.Path(__file__).resolve().parent\nROOT=HERE.parents[4]\ndef digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()')
    code=code.replace('syntax-evidence/previous-ledger-validation.json','semantic-evidence/previous-ledger-validation.json')
    for name in ['previous-ledger-validation.stdout','previous-ledger-validation.json']:
        code=code.replace("(HERE/'"+name+"')","(directory/'semantic-evidence/"+name+"')")
    code=code.replace("(directory/'syntax-validation.json')","(directory/'semantic-evidence/prior-syntax-validation.json')")
    capture=io.StringIO()
    with contextlib.redirect_stdout(capture):exec(compile(code,str(previous),'exec'),{'__file__':str(previous),'__name__':'__main__'})
    (HERE/'prior-syntax-validation.stdout').write_text(capture.getvalue())
    errors=[];pin_count=0
    def pin(path,sha):
        nonlocal pin_count
        f=ROOT/path
        if sha is None:
            if f.exists():errors.append(['expected absent pin',path])
            return
        if not f.is_file() or digest(f)!=sha:errors.append(['changed pin',path])
        pin_count+=1
    inputs=json.loads((HERE/'inputs.json').read_text())
    for p in inputs['pins']:pin(p['path'],p['sha256'])
    for ref in inputs['reused_input_manifests']:
        pin(ref['path'],ref['sha256']);manifest=json.loads((ROOT/ref['path']).read_text())
        pins=manifest['pins'] if ref['path'].endswith('runtime-inputs.json') else [p for p in manifest['pins'] if p['path'].startswith('compiler/')]
        for p in pins:pin(p['path'],p['sha256'])
    assert pin_count==len(inputs['pins'])+2+657
    for name in ['resolution.json','authority.json','values.json','review-resolution.json','review-authority.json','review-values.json','final-review.json']:
        ps=json.loads((HERE/name).read_text())['pins']
        if isinstance(ps,dict):
            for p,sha in ps.items():pin(p,sha)
        else:
            for p in ps:
                if isinstance(p,dict) and 'path' in p and 'sha256' in p:
                    f=ROOT/p['path']
                    if not f.exists():f=HERE/p['path']
                    if not f.is_file() or digest(f)!=p['sha256']:errors.append(['review pin',name,p['path']])
                    pin_count+=1
    rows=[json.loads(l) for l in (directory/'coverage.jsonl').read_text().splitlines()]
    duties=[r for r in rows if r['record']=='semantic_duty'];findings=[r for r in rows if r['record']=='semantic_finding']
    ids={r['id'] for r in duties};fids={r['id'] for r in findings};registry=next(r for r in rows if r['record']=='semantic_registry')
    assert len(rows)==451 and len(duties)==len(ids)==44 and len(findings)==len(fids)==8
    assert ids==set(registry['duty_ids']) and fids==set(registry['finding_ids'])
    for r in duties:
        if 'view' in r:
            v=json.loads((directory/r['view']).read_text());key='slices' if r['lane']=='resolution' else 'responsibilities'
            assert r['source_review']==next(s for s in v[key] if s['id']==r['view_key'])
        for path in r['definition_navigation']:assert (ROOT/path).is_file(),path
        for anchor in r.get('anchors',[]):assert 1<=anchor['line']<=len((ROOT/anchor['path']).read_text().splitlines())
    cases=json.loads((HERE/'cases.json').read_text())+json.loads((HERE/'extra-cases.json').read_text());cids={c['id'] for c in cases}
    assert len(cases)==len(cids)==73 and digest(HERE/'cases.json')==inputs['cases_sha256']
    for r in findings:
        assert set(r['duty_refs'])<=ids and set(r['case_refs'])<=cids
        assert all((ROOT/p).is_file() for p in r['defining_writers'])
        assert all((directory/p).is_file() for p in r['evidence_refs'])
    for r in rows:
        if r['record']=='path':assert set(r.get('semantic_refs',[]))<=ids
    for c in cases:
        prefix='case-' if c['id'] in {c['id'] for c in json.loads((HERE/'cases.json').read_text())} else 'extra-'
        o=json.loads((HERE/(prefix+c['id']+'.stdout')).read_text())
        assert hashlib.sha256(c['source'].encode()).hexdigest()==o['analysis']['sources'][0]['sha256']
        assert o['coverage'] and not o['parse_codes']
    command_count=0
    for name in ['execution.json','extra-execution.json','generated-execution.json','cli-execution.json']:
        for c in json.loads((HERE/name).read_text())['commands']:
            command_count+=1
            for stream in ['stdout','stderr']:
                if digest(HERE/c[stream])!=c[stream+'_sha256']:errors.append(['capture changed',name,c['name'],stream])
    assert command_count==102
    owners=json.loads((HERE/'owner-observations.json').read_text());assert len(owners)==70
    assert owners==json.loads((HERE/'owner-public-exports.stdout').read_text())
    outcomes=json.loads((HERE/'outcome-verification.json').read_text())
    assert len(outcomes['checks'])==188 and outcomes['passed']==179 and outcomes['failed']==9
    assert outcomes['selected_harnesses']==8 and outcomes['selected_passes']==440 and outcomes['reported_skips']==0
    assert sum(c['pass'] for c in outcomes['checks'])==179
    assert len(json.loads((HERE/'graph-repeats.json').read_text()))==12
    assert len({json.dumps(x,sort_keys=True) for x in json.loads((HERE/'graph-repeats.json').read_text())})==2
    cli=json.loads((HERE/'cli-observations.json').read_text());assert len(cli)==8
    for c in cli:
        raw=json.loads((HERE/c['raw']).read_text());assert c['codes']==[d['code'] for d in raw.get('diagnostics',[])]
    assert not subprocess.check_output(['git','diff',registry['source_commit'],'--','compiler'],cwd=ROOT,text=True)
    link_count=0
    for doc in [directory/'semantics.md',HERE/'README.md',directory/'README.md',directory.parent/'README.md',directory.parent/'compiler-correctness-simplicity-audit.md']:
        for target in re.findall(r'\]\(([^)]+)\)',doc.read_text()):
            if target.startswith(('https:','http:','mailto:','#')):continue
            if not (doc.parent/target.split('#')[0]).exists():errors.append(['missing local link',str(doc.relative_to(ROOT)),target])
            link_count+=1
    result={'scope':'Mechanical shared inventory/source/view/fixture/pin/command/outcome validation, independent semantic review separate',
        'observed_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'compiler_source_commit':registry['source_commit'],'compiler_diff':'','ledger_records':451,'semantic_duties':44,'findings':8,
        'pin_references_checked':pin_count,'captured_commands':102,'retained_source_fixtures':73,'public_owner_calls':70,
        'selected_native_passes':440,'reported_skips':0,'later_outcomes':{'checks':188,'passes':179,'intentional_failures':9},
        'local_markdown_links_checked':link_count,'ledger_sha256':digest(directory/'coverage.jsonl'),
        'prior_ledger_receipt':'semantic-evidence/prior-syntax-validation.json','errors':errors,
        'limits':['finite semantic duties and sampled fixtures, not every branch/context/API','separate attempted-oracle corrections, owner policy gates and real defect failures',
            'controlled catalog version not producer release compatibility','installed dist/pure empty-context execution not activation/browser/application/release/other-host acceptance',
            'historical skill validator bundle unavailable; local joined validators used']}
    out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));assert not errors,errors
if __name__=='__main__':main()
