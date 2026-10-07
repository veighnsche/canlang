#!/usr/bin/env python3
"""Idempotent join into the existing ledger; supporting source views remain unchanged."""
import json
from run import HERE,digest
def main():
    d=HERE.parent;path=d/'coverage.jsonl';rows=[json.loads(l) for l in path.read_text().splitlines()]
    rows=[r for r in rows if not r['record'].startswith('semantic_')];added=[]
    for file,key,lane,prefix,owners in [
        ('resolution.json','slices','resolution','',['compiler/src/analysis/resolve.rs','compiler/src/analysis/types.rs','compiler/src/analysis/catalog.rs']),
        ('authority.json','responsibilities','authority','SEM-AUTH-',['compiler/src/analysis/effects.rs','compiler/src/analysis/resolve.rs','compiler/src/analysis/examples.rs','compiler/src/analysis/migrate_check.rs','compiler/src/analysis/check.rs']),
        ('values.json','responsibilities','values','SEM-VALUE-',['compiler/src/analysis/types.rs','compiler/src/analysis/examples.rs','compiler/src/analysis/catalog.rs','compiler/src/codegen/js.rs'])]:
        for view in json.loads((HERE/file).read_text())[key]:
            added.append({'record':'semantic_duty','id':prefix+view['id'],'lane':lane,'view':'semantic-evidence/'+file,
                'view_key':view['id'],'definition_navigation':owners,'source_review':view,
                'execution_join':'SEM-EXECUTION','status':'bounded source-reviewed; sampled execution separate',
                'limits':'Definition navigation is not every branch in each owner; lane source/test witnesses do not themselves claim fresh execution.'})
    added += [
        {'record':'semantic_duty','id':'SEM-ORCHESTRATION','lane':'root','definition_navigation':['compiler/src/analysis/check.rs','compiler/src/analysis/mod.rs','compiler/src/diagnostic.rs'],
            'duty':'Dedup/sort/readiness and whole check error aggregation',
            'anchors':[{'path':'compiler/src/analysis/check.rs','line':64},{'path':'compiler/src/analysis/mod.rs','line':108}],
            'acceptance':'Exact file/start/end/code/message repeats collapse first; different end/message remain; deterministic output content must exist before sorting.',
            'execution_join':'SEM-EXECUTION','status':'source reviewed plus existing check tests executed',
            'limits':'Related/severity/tags outside identity; no demonstrated production metadata loss; complete flag does not certify every fact.'},
        {'record':'semantic_duty','id':'SEM-GENERATED-BOUNDARY','lane':'root','definition_navigation':['compiler/src/codegen/ir.rs','compiler/src/codegen/js.rs','compiler/src/codegen/mod.rs'],
            'duty':'Real format overload binding through actual emitted public imports',
            'anchors':[{'path':'compiler/src/codegen/ir.rs','line':2932},{'path':'compiler/src/codegen/js.rs','line':1723}],
            'acceptance':'Supported named and positional bindings preserve values/options and actual public runtime calling convention.',
            'execution_join':'SEM-EXECUTION','status':'paired stage witnesses and selected emitted pure calls executed',
            'limits':'Wider evaluation/authority/temporal carrier/activation/app runtime closure belongs Step9; no package edits.'}]
    ids={r['id'] for r in added};assert len(ids)==44
    specs=[
      ('SEM-R01','demonstrated-compiler-type-defect','high',['compiler/src/analysis/types.rs'],['SEM-RES-09','SEM-RES-10'],['array-fixed-first','array-nullable-first'],
       'One array element-join policy rejects unsupported nullable elements independent of first position; focused expected-array and source-anchor witnesses.','Existing DESIGN139; no new coercion/type policy.'),
      ('SEM-R02','demonstrated-compiler-scope-check-defect','high',['compiler/src/analysis/effects.rs'],['SEM-AUTH-A12','SEM-AUTH-A05'],['scope-direct','scope-derived','scope-scenario'],
       'Recurring scope follows bound derived queries/local dependencies and diagnoses mixed scope at handler; no second source/query parser.','Derived mode/design scope already specified; default/server dependencies separate.'),
      ('SEM-R03','demonstrated-compiler-binding-defect-and-installed-owner-seam-mismatch','high',['compiler/src/codegen/ir.rs','compiler/src/codegen/js.rs','packages/stdlib/src/index.ts','packages/values/src/stdlib-pure.ts'],['SEM-RES-08','SEM-GENERATED-BOUNDARY'],['format-message-positional','format-message-named','format-plain-positional','format-plain-named'],
       'Consume checked selected binding once; preserve ordinary values/options and evaluation; qualify generated/facade signature with owners before retiring reconstruction.','DESIGN1085 proposes context signature; installed facade takes two arguments. Evidence chooses no API change. IR owns binding loss; JS/stdlib/values owner seam and wider Step9 release are separate gates; no package edits authorized.'),
      ('SEM-R04','executed-owner-admission-disagreement','policy-gated',['compiler/src/analysis/types.rs'],['SEM-VALUE-VAL-email'],['value-email-'+str(i) for i in range(6)],
       'Agree explicit validated email floor; one owning policy, differential error/anchor witnesses, no parallel compatibility validator.','Consequential floor choice needs verified-context JEV; no new choice or transmission here.'),
      ('SEM-R05','executed-profile-and-data-admission-gap','qualification-gated',['compiler/src/analysis/examples.rs','compiler/src/analysis/types.rs'],['SEM-VALUE-ICU-types','SEM-VALUE-VAL-timezone'],['icu-date-time']+['value-timezone-'+str(i) for i in range(5)],
       'Release formatter date/datetime partition and timezone staging/data contract; qualify actual owning profile without midnight or new shape heuristics.','Existing timezone data pins; unresolved temporal-format type partition remains explicit.'),
      ('SEM-R06','executed-package-profile-and-public-carrier-findings','package-owner-gated',['packages/ui/src/messages.ts','compiler/src/codegen/js.rs'],['SEM-VALUE-VAL-generated-ui-seam','SEM-VALUE-ICU-types','SEM-VALUE-VAL-temporal'],['icu-decimal-integer','icu-decimal-ordinal','date-2','date-3'],
       'UI owner handles integer/ordinal/year validation; compiler-runtime carrier handoff requires actual generated witnesses before adapter/API choice.','Compiler audit authorizes no package implementation; direct joined APIs are not complete generated temporal/Decimal execution.'),
      ('SEM-R07','reproduced-existing-graph-witness-defect','existing-policy-gated',['compiler/src/analysis/types.rs'],['SEM-AUTH-A13','SEM-ORCHESTRATION'],['call-cycle-upstream','ownership-cycle-upstream'],
       'Release deterministic G09-1 origin/witness policy preserving each graph edge scope/upstream/multiplicity/anchor/seed order.','Prior graph/JEV gate retained; no unified SCC diagnostic rule selected.'),
      ('SEM-R08','source-leads-and-explicit-coverage-gaps','bounded-next-witnesses',['compiler/src/analysis/types.rs','compiler/src/analysis/catalog.rs','compiler/src/analysis/effects.rs','compiler/src/codegen/ir.rs'],['SEM-RES-08','SEM-RES-11','SEM-AUTH-A04','SEM-AUTH-A11','SEM-VALUE-VAL-bytes','SEM-VALUE-CATALOG-nominal'],[],
       'Separate witnessed packets for trial-type state, unknown nominals, authority scalar/default dependencies, missing bytes owner and full handoffs.','No broad rewrite authorized; Step9/resource/oracle and released owner contracts determine acceptance.')]
    findings=[]
    for id,kind,priority,writers,refs,cases,target,gate in specs:
        findings.append({'record':'semantic_finding','id':id,'classification':kind,'priority':priority,
            'defining_writers':writers,'duty_refs':refs,'case_refs':cases,'retirement_outcome':target,
            'implementation_gate':gate,'status':'open; planning only','allocation':'gpt-6.1-sol medium; high only for released consequential policy dispute',
            'evidence_refs':['semantic-evidence/outcome-verification.json','semantic-evidence/owner-observations.json','semantic-evidence/review-resolution.json','semantic-evidence/review-authority.json','semantic-evidence/review-values.json']})
    assert all(set(f['duty_refs'])<=ids for f in findings)
    for r in rows:
        if r['record']=='path':r['semantic_refs']=[a['id'] for a in added if r['path'] in a['definition_navigation']]
    rows+=added+findings+[
        {'record':'semantic_registry','id':'SEM-REGISTRY','source_commit':'1fd07722090fe70228a6b661e3c6e136275ca84b','duty_ids':sorted(ids),'finding_ids':[f['id'] for f in findings],
         'scope':'44 finite named semantic duties with gaps and42 derivative source-review joins; not every branch/API/cross-product or runtime qualification.'},
        {'record':'semantic_inputs','id':'SEM-INPUTS','collection':'semantic-evidence/inputs.json','compiler_and_installed_runtime_rechecked_references':657,
         'source_support_collections':['semantic-evidence/resolution.json','semantic-evidence/authority.json','semantic-evidence/values.json'],
         'scope':'Pinned compiler/contracts/catalog and installed dist; actual source/dist/host/product release boundaries explicit.'},
        {'record':'semantic_execution','id':'SEM-EXECUTION','selected_harnesses':8,'selected_passes':440,'reported_skips':0,'public_api_initial_cases':47,'public_api_extra_cases':26,
         'fresh_graph_processes':12,'distinct_graph_diagnostic_sets':2,'public_owner_calls':70,'real_cli_calls':8,'emitted_pure_calls':2,'public_plain_format_controls':1,
         'later_outcome_checks':188,'later_outcome_passes':179,'later_outcome_failures':9,
         'receipts':['semantic-evidence/execution.json','semantic-evidence/extra-execution.json','semantic-evidence/cli-execution.json','semantic-evidence/generated-execution.json','semantic-evidence/outcome-verification.json'],
         'limits':'Two attempted-oracle corrections separate from defects; copied availability catalogs synthetic and non-semver; no full suite, permission bypass, temporal generated execution, activation/browser/installed app/other-host claim.'}]
    path.write_text(''.join(json.dumps(r,separators=(',',':'),ensure_ascii=False)+'\n' for r in rows))
    print(json.dumps({'ledger_records':len(rows),'semantic_duties':44,'findings':8,'sha256':digest(path)}))
if __name__=='__main__':main()
