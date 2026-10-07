#!/usr/bin/env python3
"""Independent later outcome checks, with oracle corrections kept distinct from defects."""
import json,hashlib,re
from run import HERE,digest
def main():
    cases=json.loads((HERE/'cases.json').read_text())+json.loads((HERE/'extra-cases.json').read_text())
    cs={c['id']:c for c in cases};checks=[]
    def check(id,description,ok,classification='control'):
        checks.append({'id':id,'contract':description,'pass':bool(ok),'classification':classification})
    def observed(id):
        prefix='case-' if id in {c['id'] for c in json.loads((HERE/'cases.json').read_text())} else 'extra-'
        return json.loads((HERE/(prefix+id+'.stdout')).read_text())
    for c in cases:
        o=observed(c['id']);source=hashlib.sha256(c['source'].encode()).hexdigest()
        check(c['id'],'Retained source bytes match observed compiler input hash',o['analysis']['sources'][0]['sha256']==source)
        check(c['id'],'All semantic fixtures are syntax qualified',not o['parse_codes'] and o['coverage'])
    for id in ['array-fixed-first','array-nullable-first']:
        check(id,'Nullable array elements rejected independent of element order',any(d['code']=='E3001' for d in observed(id)['analysis']['diagnostics']),'compiler-defect')
    for id in ['scope-direct','scope-derived','scope-scenario']:
        c=cs[id];anchor=c['source'].encode().find(b'every(5m)');ds=observed(id)['analysis']['diagnostics']
        check(id,'Mixed owner scope diagnoses E4051 at every(5m)',any(d['code']=='E4051' and d['primary']['start']==anchor and d['primary']['end']==anchor+9 for d in ds),'compiler-defect' if id=='scope-derived' else 'control')
    for id in ['format-message-positional','format-message-named','format-plain-positional','format-plain-named']:
        o=observed(id)
        check(id,'Real-catalog positional/named overload checking succeeds',not o['analysis']['diagnostics'])
        check(id,'Supported format overload lowers without E6008',isinstance(o['emission'],dict) and not o['emission']['diagnostics'],'compiler-defect')
    owner={o['id']:o for o in json.loads((HERE/'owner-observations.json').read_text())}
    for id,expected in [('int-9223372036854775807',True),('int-9223372036854775808',False),('int--9223372036854775808',True),('int--9223372036854775809',False),('decimal-0',True),('decimal-1',True),('decimal-2',False),('decimal-3',True),('decimal-4',False),('date-2000-02-29',True),('date-1900-02-29',False)]:
        check(id,'Independent exact scalar/Gregorian boundary',owner[id]['accepted']==expected)
    for name,expected in [('number',True),('integer',False),('ordinal',False),('cardinal',True)]:
        for impl in ['values','ui']:
            id='icu-'+impl+'-'+name;check(id,'DESIGN895 decimal number/cardinal allowed; integer/ordinal rejected',owner[id]['accepted']==expected,'package-profile-defect' if impl=='ui' else 'control')
    for j in range(6):
        check('email-'+str(j),'Actual public encode/decode admit identically',owner['email-'+str(j)]['accepted']==owner['email-encode-'+str(j)]['accepted'])
    repeats=json.loads((HERE/'graph-repeats.json').read_text())
    check('call-cycle-upstream','Same input yields identical message/span/multiplicity across fresh processes',len({json.dumps(x,sort_keys=True) for x in repeats})==1,'existing-compiler-defect')
    generated=json.loads((HERE/'generated-observations.json').read_text())['observations']
    for o in generated:
        if o['id'].startswith('public-'):check(o['id'],'Public plain-format control returns independent Hi Bo result',o['value']=='Hi Bo')
        else:check(o['id'],'Actual emitted supported format call does not throw invalid-construction',o['success'],'compiler-runtime-defect')
    raw=(HERE/'focused-suites.stdout').read_text();summaries=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored',raw)
    result={'scope':'Later independently assessed outcome checks; not rewritten initial expectations or full compiler/runtime acceptance',
        'checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),
        'suite_summaries':summaries,'selected_harnesses':len(summaries),'selected_passes':sum(int(s[0]) for s in summaries),
        'reported_skips':sum('SKIP' in l for f in ['focused-suites.stdout','focused-suites.stderr'] for l in (HERE/f).read_text().splitlines()),
        'expectation_corrections':[
            {'cases':['array-fixed-first','array-nullable-first'],'original':'required E3005','corrected':'E3001 assignment/nullability failure after valid binding','reason':'Original exact code was a probe expectation mistake; reverse case correctly rejects. Fixed-first still wrongly admits unsupported nullable array.'},
            {'cases':['decimal-1'],'original':'38integer digits+.0 accepted','corrected':'39significant authored digits rejected','reason':'Scale-preserving decimal fixture differs from owner integral38-digit input; not a compiler defect. Original assertions retained.'}],
        'controlled_catalog_limit':'Initial overrides also replace catalog_version with non-semver audit label; E6007 version pin failure is synthetic and not evidence against real producer. Checking availability tests are still meaningful; no emission compatibility claim.'}
    (HERE/'outcome-verification.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ['passed','failed','selected_harnesses','selected_passes','reported_skips']}))
if __name__=='__main__':main()
