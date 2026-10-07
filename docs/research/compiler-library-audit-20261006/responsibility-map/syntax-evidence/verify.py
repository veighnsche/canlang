#!/usr/bin/env python3
"""Outcome checks added after independent challenge; expectations come from language contracts."""
import hashlib
import json
import pathlib
import re
from run import HERE, ROOT, digest

def main():
    cases = json.loads((HERE / 'cases.json').read_text())
    extra = json.loads((HERE / 'extra-cases.json').read_text())
    checks = []
    def check(case, contract, passed, authority):
        checks.append({'case': case, 'contract': contract, 'pass': bool(passed), 'authority': authority})
    # These expectations are authored from GRAMMAR Tokens/layout and syntax/mod.rs
    # diagnostic catalog, after initial observations and reviewer challenge. They
    # are separate from the pre-execution sentinel contracts in cases.json.
    required = {'sibling-policy':'E1200', 'sibling-token':'E1007', 'sibling-numeric-unit':'E1005',
        'sibling-unknown-escape':'E1006', 'sibling-lone-surrogate':'E1006',
        'sibling-unterminated-string':'E1006', 'sibling-closer':'E1101',
        'sibling-open-schema':'E1102', 'sibling-open-call':'E1102', 'sibling-open-list':'E1102',
        'sibling-desc-ref':'E1122', 'sibling-indent':'E1103', 'sibling-policy-crlf':'E1200',
        'sibling-policy-eof':'E1200', 'independent-module-after-bad-owner':'E1203',
        'independent-module-after-open-schema':'E1102', 'malformed-app-policy':'E1200',
        'malformed-secret-return':'E1200', 'malformed-actor-subject':'E1200',
        'malformed-icu-sibling':'E1200', 'cross-module-actor':'E1200',
        'invalid-unicode-name':'E1007', 'string-physical-control':'E1006',
        'eof-unclosed-string':'E1006', 'eof-unclosed-delimiter':'E1102',
        'dangling-description-eof':'E1125', 'bare-cr':'E1001'}
    for case in cases:
        j = json.loads((HERE / ('case-' + case['id'] + '.stdout')).read_text())
        if j['byte_admission'] != 'accepted':
            check(case['id'], 'invalid UTF8 exact byte anchor', j['code'] == 'E1002' and
                j['span'] == [12,13], 'GRAMMAR UTF8; lex_bytes valid_up_to contract')
            continue
        ds = j['analysis']['diagnostics']
        if case['id'] in required:
            check(case['id'], 'required rejection code ' + required[case['id']],
                required[case['id']] in j['parse_codes'], 'GRAMMAR + syntax/mod.rs diagnostic catalog')
        if case.get('clean'):
            check(case['id'], 'clean-result emission has no diagnostics', isinstance(j['emission'],dict)
                and not j['emission']['codes'], 'Production error-gated emission; source forms independently declared valid')
        if case.get('decoded'):
            artifact = j['emission']['artifact']
            field = artifact['models'][0]['fields'][0]
            check(case['id'], 'schema default preserves code points', [ord(c) for c in field['default']['value']]
                == [8,12,128512], 'JSON STRING token value; Can field default semantics')
            check(case['id'], 'schema description retains Unicode', field['description'] == 'é😀',
                'GRAMMAR desc= metadata slot')
            js = '\n'.join(m['js'] for m in artifact['modules'])
            check(case['id'], 'emitted default preserves controls and scalar',
                'default:"\\u0008\\u000c😀"' in js, 'Fixed JS string value spelling, independent scalar expectation')
        if case['id'] == 'invalid-unicode-name':
            for scalar in ['é','😀']:
                at = case['source'].encode().index(scalar.encode())
                check(case['id'], 'E1007 spans complete scalar ' + scalar,
                    any(d['code']=='E1007' and d['primary']['start']==at and
                        d['primary']['end']==at+len(scalar.encode()) for d in ds),
                    'ASCII NAME + byte span contract')
        if case['id'] == 'valid-description':
            js = '\n'.join(m['js'] for m in j['emission']['artifact']['modules'])
            check(case['id'], 'attached owner prose preserves raw Unicode',
                'description:message("A raw é😀 description.")' in js,
                'GRAMMAR description attachment and literal raw prose; executable metadata only')
    for case in extra:
        j = json.loads((HERE / ('extra-' + case['id'] + '.stdout')).read_text())
        check(case['id'], 'lossless-byte-coverage', j['coverage'], 'Lossless CST contract')
        ds = j['analysis']['diagnostics']
        if case.get('clean'):
            check(case['id'], 'parse and check clean', not j['parse_codes'] and not ds, 'Independently authored valid source')
            check(case['id'], 'emission clean', isinstance(j['emission'],dict) and not j['emission']['codes'],
                'Production error-gated emission')
        for code in case.get('forbidden_codes',[]):
            check(case['id'], 'no fabricated ' + code, all(d['code']!=code for d in ds),
                'Existing valid policy, local syntax-error suppression only')
        for value in case.get('required_emitted_strings',[]):
            js = '\n'.join(m['js'] for m in j['emission']['artifact']['modules'])
            check(case['id'], 'emitted UI retains ' + value, value in js,
                'GRAMMAR tab caption and child semantics; search executable JS only, exclude source-map contents')
        if case['id'].startswith('source-fr-fr-'):
            check(case['id'], 'source=fr repetition still diagnoses', any(d['code']=='E3016' and
                "source language 'fr'" in d['message'] for d in ds), 'Owner source language is unchanged by a malformed sibling')
        if case['id'].startswith('source-fr-en-'):
            check(case['id'], 'en variant is not owner-source repetition', all(d['code']!='E3016' for d in ds),
                'Valid app source=fr, independent en translation')
        if case['id']=='preference-order':
            e=j['emission'];js='\n'.join(m['js'] for m in e['artifact']['modules']) if isinstance(e,dict) else ''
            check(case['id'], 'nonempty structured ordering does not silently become []',
                bool(ds) or (isinstance(e,dict) and bool(e['codes'])) or 'order:[]' not in js,
                'Authored by/default/cases with nonempty selectors must survive or reject explicitly')
        if case['id']=='corpus-unresolved-owners':
            check(case['id'], 'missing corpus owner checked or explicit unsupported', bool(ds) or
                (isinstance(j['emission'],dict) and bool(j['emission']['codes'])),
                'Normative corpus declaration requires semantic owner; unknown Missing model cannot be complete valid input')
    log=(HERE/'focused-suites.stdout').read_text();err=(HERE/'focused-suites.stderr').read_text()
    tests=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed',log)
    check('focused-suites','8 harnesses,330passes,no failures',len(tests)==8 and
        sum(int(p) for p,f in tests)==330 and all(int(f)==0 for p,f in tests),'Actual Cargo harness results')
    check('focused-suites','no reported SKIP', 'SKIP' not in log+err,'Reported body skips; not proof all optional branches tested')
    check('string-runtime','six executed codepoint witness lines',len(re.findall(r'C01 witness \d: production CLI, runtime metadata, testkit closures passed',log+err))==6,'Actual fixture success output')
    compiler_pins=[p for p in json.loads((HERE/'inputs.json').read_text())['pins'] if p['path'].startswith('compiler/')]
    check('inputs','all107compilerinputs unchanged',len(compiler_pins)==107 and
        all(digest(ROOT/p['path'])==p['sha256'] for p in compiler_pins),'Frozen source/manifest/test/config pins')
    runtime=json.loads((HERE/'runtime-inputs.json').read_text())['pins']
    check('inputs','all550recordedruntimepins unchanged',len(runtime)==550 and
        all(digest(ROOT/p['path'])==p['sha256'] for p in runtime),'Installed workspace dist prerequisites, source/build parity not asserted')
    (HERE/'outcome-verification.json').write_text(json.dumps({'scope':
        'Post-observation independent grammar/diagnostic/artifact checks; earlier sentinels remain pre-execution. Failures intentionally record defects or open recovery boundaries, not rewritten expectations.',
        'checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks)},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'checks':len(checks),'failed':[(c['case'],c['contract']) for c in checks if not c['pass']]},ensure_ascii=False))

if __name__=='__main__':main()
