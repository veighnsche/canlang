#!/usr/bin/env python3
"""Join finite output views into the one existing coverage ledger."""
import json,re
from run import HERE,ROOT,save,digest
def main():
 ledger=HERE.parent/'coverage.jsonl';rows=[json.loads(l) for l in ledger.read_text().splitlines()]
 assert not any(r.get('record','').startswith('output_') for r in rows),'already integrated'
 duties=[]
 for view in ['serialization','transforms','coordinates']:
  for d in json.loads((HERE/(view+'.json')).read_text())['finite_duties']:
   nav=sorted(set(re.findall(r'compiler/[A-Za-z0-9_./-]+\.rs',' '.join(d['defining_declarations']))))
   duties.append({'record':'output_duty','id':'OUT-'+d['id'],'lane':view,'duty':d['duty'],'definition_navigation':nav,'source_view':'output-evidence/'+view+'.json','view_id':d['id'],'execution_join':'OUT-EXECUTION','review':'root serializer challenge + gpt-6.1-sol medium transforms/coordinates challenge','status':'bounded source trace and declared witness execution; defects/gates remain','limits':d['limits']})
 ids={d['id'] for d in duties};assert len(ids)==35
 specs=[
 ('OUT-R01','demonstrated compiler lexical binding defect','high',['compiler/src/codegen/js.rs'],['OUT-TR-13','OUT-SER-07'],['identifier-class','identifier-await','identifier-default','identifier-c','identifier-value'],'One resolved identity -> legal distinct JS binding mapping across scoped caller closure; retire conflicting independent sanitization; preserve authored wire/property names and attribution.','Existing contextual NAME contract; no new grammar/library architecture. Reserved-word-only patch leaves context/temporary collisions.'),
 ('OUT-R02','public API documented byte-determinism counterexample','bounded contract clarification',['compiler/src/diagnostic.rs'],['OUT-SER-03'],['diagnostics'],'Retain one canonical output order under actual supported caller contract, or narrow unsupported documentation; no additional tie adapter selected.','Tags-only public witness; actual CLI tied producer absent. New supported guarantee needs owner qualification.'),
 ('OUT-R03','standards-derived downstream Markdown escaping defect','package owner gated',['packages/interfaces/src/docs/reference.ts'],['OUT-SER-10'],['docs-backtick','docs-pipe','docs-backslash'],'Public renderer preserves exact inline/table default text with backtick delimiters, pipe cells and literal backslashes; retain separately sufficient fenced-example handling.','Compiler JSON preserves source values; no package implementation authorized. Official CommonMark/GFM interpretation, no Markdown parser execution.'),
 ('OUT-R04','observed attached-comment deletion; preservation policy gate','bounded owner decision',['compiler/src/lint/rules.rs'],['OUT-TR-08','OUT-TR-10'],['fix-comments'],'Release attached-comment ownership/preservation policy without rewriting unrelated declarations or another edit engine.','Runtime safe-removal and comment preservation distinct; DIAGNOSTICS29 vs31. Consequential new choice needs verified-context JEV.'),
 ('OUT-R05','explicit supported-profile and consumer qualification gaps','independent scoped followups',['compiler/src/cli.rs','compiler/src/codegen/sourcemap.rs','compiler/src/codegen/js.rs','compiler/src/lsp/server.rs'],['OUT-TR-07','OUT-CO-05','OUT-CO-06','OUT-SER-06'],[],'Qualify remaining supported file modes/hosts, actual browser/map attribution, production Decimal emission and client application at declared consumer scope.','Native4750 branch skipped; full release/runtime/GUI and Step9/11 remain unexecuted. No inferred host/policy/API change.')]
 findings=[]
 for id,kind,priority,writers,refs,cases,target,gate in specs:
  assert set(refs)<=ids,refs
  findings.append({'record':'output_finding','id':id,'classification':kind,'priority':priority,'defining_writers':writers,'duty_refs':refs,'case_refs':cases,'retirement_outcome':target,'implementation_gate':gate,'status':'open; planning only','allocation':'gpt-6.1-sol medium; low for released fixture checks; escalate only consequential unresolved policy','evidence_refs':['output-evidence/outcome-verification.json','output-evidence/review-transforms.json','outputs.md']})
 for r in rows:
  if r['record']=='path':r['output_refs']=[d['id'] for d in duties if r['path'] in d['definition_navigation']]
 rows+=duties+findings+[
 {'record':'output_registry','id':'OUT-REGISTRY','source_commit':'1fd07722090fe70228a6b661e3c6e136275ca84b','duty_ids':sorted(ids),'finding_ids':[f['id'] for f in findings],'scope':'35 finite output/transform/coordinate duties, explicit failures and gates; not complete runtime attribution or every semantic branch'},
 {'record':'output_inputs','id':'OUT-INPUTS','collection':'output-evidence/inputs.json','supplement':'output-evidence/support-inputs.json','scope':'Compiler/Cargo/catalog/normative and installed/current-source consumer pins; source/dist distinction preserved'},
 {'record':'output_execution','id':'OUT-EXECUTION','selected_integration_harnesses':18,'selected_passes':113,'reported_branch_skips':1,'cases':61,'corpus_cases':54,'real_cli_calls':18,'node_module_syntax_checks':5,'coordinate_forward_vectors':19,'coordinate_inverse_vectors':32,'later_checks':377,'later_passes':367,'later_nonpassing':10,'receipts':['output-evidence/observer-execution.json','output-evidence/suites-execution.json','output-evidence/cli-execution.json','output-evidence/outcome-verification.json'],'limits':'Separate compiler defects/public API tie/standards-derived package defects/comment policy/native fixture skip; no full suite/release/GUI/runtime closure/other host.'}]
 ledger.write_text(''.join(json.dumps(r,separators=(',',':'),ensure_ascii=False)+'\n' for r in rows))
 # Pin additional declarations/contracts/actual current-source consumer closure.
 text=' '.join((HERE/(v+'.json')).read_text() for v in ['serialization','transforms','coordinates'])
 paths=set(re.findall(r'(?:compiler|packages|docs/specification)/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+',text))
 paths.update(['implementation/DIAGNOSTICS.md','packages/cloudflare/src/runtime/sourcemap.ts','packages/cloudflare/src/runtime/invoke.ts','packages/cloudflare/src/runtime/artifact.ts','packages/cloudflare/src/runtime/context.ts','packages/testkit/src/reporting/report.ts'])
 pins=[{'path':p,'sha256':digest(ROOT/p),'bytes':(ROOT/p).stat().st_size} for p in sorted(paths) if (ROOT/p).is_file()]
 save('support-inputs.json',{'scope':'Final reviewed source/contract closure; tracked inputs unchanged from collection HEAD, current-source map consumer hashes captured independently in native stderr','pins':pins,'normative_web':[{'url':'https://spec.commonmark.org/0.31.2/#code-spans','version':'0.31.2','checked':'2026-10-07','claim':'backslashes literal; matching-length backtick delimiters'}, {'url':'https://github.github.com/gfm/#tables-extension-','checked':'2026-10-07','claim':'escape pipes in table cells including inline spans'}]})
 print(json.dumps({'ledger_records':len(rows),'duties':len(duties),'findings':len(findings),'support_pins':len(pins),'ledger_sha256':digest(ledger)}))
if __name__=='__main__':main()
