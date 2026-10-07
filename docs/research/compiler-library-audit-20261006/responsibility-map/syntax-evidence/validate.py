#!/usr/bin/env python3
"""Validate shared syntax joins/pins and replay prior ledger checks without overwriting old receipts."""
import collections
import contextlib
import hashlib
import io
import json
import pathlib
import re
import subprocess
from run import HERE, ROOT, digest

def main():
    directory=HERE.parent
    errors=[]
    previous=directory/'integration-evidence/validate.py'
    capture=io.StringIO()
    with contextlib.redirect_stdout(capture):
        code=previous.read_text().replace("D/'integration-validation.json'",
            "D/'syntax-evidence/previous-ledger-validation.json'")
        exec(compile(code,str(previous),'exec'),{'__file__':str(previous)})
    (HERE/'previous-ledger-validation.stdout').write_text(capture.getvalue())
    rows=[json.loads(line) for line in (directory/'coverage.jsonl').read_text().splitlines()]
    families=[r for r in rows if r['record']=='syntax_family']
    findings=[r for r in rows if r['record']=='syntax_finding']
    registry=next(r for r in rows if r['record']=='syntax_registry')
    forms=json.loads((HERE/'forms.json').read_text())
    inventory=json.loads((HERE/'inventory.json').read_text())
    family_ids={r['id'] for r in families};finding_ids={r['id'] for r in findings}
    assert len(families)==len(family_ids)==27 and len(findings)==len(finding_ids)==8
    assert family_ids==set(registry['family_ids']) and finding_ids==set(registry['finding_ids'])
    names={p['name'] for p in inventory['grammar']['productions']}
    kinds={p['name'] for p in inventory['cst']['syntax_kind']}
    assert len(names)==186 and len(kinds)==119
    assert names=={n for f in families for n in f['grammar_productions']}
    assert kinds=={n for f in families for n in f['syntax_kinds']}
    for family in families:
        view=next(f for f in forms['families'] if f['id']==family['family_key'])
        for k,v in view.items():
            if k!='id' and family[k]!=v:errors.append(['family view mismatch',family['id'],k])
    valid_refs=family_ids|finding_ids|{'SYN-REGISTRY','SYN-EXECUTION'}
    for row in rows:
        if row['record']=='path' and any(r not in valid_refs for r in row.get('syntax_refs',[])):
            errors.append(['unknown path syntax ref',row['path']])
    all_cases=json.loads((HERE/'cases.json').read_text())+json.loads((HERE/'extra-cases.json').read_text())
    case_ids={c['id'] for c in all_cases}
    for finding in findings:
        if not set(finding['family_refs'])<=family_ids or not set(finding['case_refs'])<=case_ids:
            errors.append(['finding joins',finding['id']])
    def walk(x):
        if isinstance(x,dict):
            yield x
            for v in x.values():yield from walk(v)
        elif isinstance(x,list):
            for v in x:yield from walk(v)
    pin_count=anchor_count=0
    for filename in ['inputs.json','inventory.json','forms.json','recovery.json','runtime-inputs.json']:
        for item in walk(json.loads((HERE/filename).read_text())):
            if 'path' not in item:continue
            path=ROOT/item['path']
            if not path.exists():
                # Evidence-relative raw paths are also explicitly allowed.
                path=HERE/item['path']
            if not path.is_file():continue
            if 'sha256' in item:
                raw=path.read_bytes()
                if item.get('pin_kind')=='context_prefix_before_Step7_append':raw=raw[:item['bytes']]
                if hashlib.sha256(raw).hexdigest()!=item['sha256']:errors.append(['changed pin',filename,item['path']])
                pin_count+=1
            bounds=item.get('lines')
            if not isinstance(bounds,list):
                lo=item.get('start_line');hi=item.get('end_line',lo)
                bounds=[lo,hi] if lo is not None else None
            if bounds and all(isinstance(n,int) for n in bounds):
                if not 1<=bounds[0]<=bounds[-1]<=len(path.read_text().splitlines()):errors.append(['anchor bounds',filename,item])
                anchor_count+=1
    assert digest(HERE/'inventory.json')==forms['derived_inventory_alignment']['sha256']
    for receipt in ['execution.json','extra-execution.json','byte-cli-admission.json']:
        for command in json.loads((HERE/receipt).read_text())['commands']:
            for stream in ['stdout','stderr']:
                if digest(HERE/command[stream])!=command[stream+'_sha256']:
                    errors.append(['command raw stream changed',receipt,command['name'],stream])
    observations=json.loads((HERE/'observations.json').read_text())
    initial=[a for o in observations for a in o['assertions']]
    assert len(observations)==40 and len(initial)==94 and sum(a['pass'] for a in initial)==81
    outcomes=json.loads((HERE/'outcome-verification.json').read_text())
    assert len(outcomes['checks'])==76 and outcomes['passed']==69 and outcomes['failed']==7
    corpus=json.loads((HERE/'corpus-observations.json').read_text())['files']
    assert len(corpus)==54 and all(c['exit']==0 and c['coverage'] for c in corpus)
    assert all(digest(ROOT/c['path'])==c['source_sha256'] for c in corpus)
    assert sum(not c['parse_codes'] for c in corpus)==52
    assert sum(not c['analysis']['diagnostics'] for c in corpus)==2
    assert sum(isinstance(c['emission'],dict) and not c['emission']['codes'] for c in corpus)==1
    link_count=0
    docs=[directory/'syntax.md',HERE/'README.md',HERE/'inventory-notes.md',HERE/'forms-review-notes.md',
        HERE/'recovery-notes.md',HERE/'cross-review-notes.md',directory/'README.md',
        directory.parent/'README.md',directory.parent/'compiler-correctness-simplicity-audit.md']
    for doc in docs:
        for target in re.findall(r'\]\(([^)]+)\)',doc.read_text()):
            if target.startswith(('http:','https:','mailto:','#')):continue
            path=target.split('#',1)[0]
            if not (doc.parent/path).exists():errors.append(['Markdown missing file',str(doc.relative_to(ROOT)),target])
            link_count+=1
    diff=subprocess.check_output(['git','diff','1fd07722090fe70228a6b661e3c6e136275ca84b','--','compiler'],cwd=ROOT,text=True)
    assert not diff
    previous_receipt=json.loads((HERE/'previous-ledger-validation.json').read_text())
    assert not previous_receipt['errors']
    receipt={'scope':'Mechanical shared ledger, source/pin/range/view joins, raw command captures and native outcome arithmetic. Independent semantic review/actual execution separate.',
        'source_commit':rows[0]['source_commit'],'observed_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'compiler_diff':'','families':27,'findings':8,'grammar_productions':186,'syntax_kinds':119,
        'node_details':4,'source_and_runtime_pin_references_checked':pin_count,'anchor_bounds_checked':anchor_count,
        'local_markdown_links_checked':link_count,'ledger_sha256':digest(directory/'coverage.jsonl'),
        'previous_ledger_checks':'syntax-evidence/previous-ledger-validation.json','errors':errors,
        'case_results':{'initial':{'assertions':94,'passes':81,'mismatches':13},
            'later':{'assertions':76,'passes':69,'mismatches':7}},
        'limitations':['finite source mapping is not every cross-product/branch executed',
            'intentional outcome mismatches remain demonstrated defects or policy-gated admission boundaries',
            'corp output projection not retained full artifacts/JS, no corpus execution',
            '345 selected native passes not full suite/other-host/application release acceptance']}
    (directory/'syntax-validation.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2));assert not errors,errors

if __name__=='__main__':main()
