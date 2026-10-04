from pathlib import Path
import hashlib,json,os
import tiktoken
root=Path('design/evaluation/baseline-20261004T041647Z/snapshot')
p=root/'draft/CanCRM.can'
before=p.read_text()
key='label_Deal_outcome_reference'
decl='  message label_Deal_outcome_reference = "Confirmed outcome reference"@{nl="Referentie bevestigde uitkomst"}\n'
assert before.count(key)==2 and decl in before
assert not any(key in q.read_text() for q in root.rglob('*.can') if q!=p)
after=before.replace('label='+key,'label="Confirmed outcome reference"@{nl="Referentie bevestigde uitkomst"}').replace(decl,'')
out=Path('design/evaluation/evidence/interfaces')
(out/'CanCRM-inline-caption.can').write_text(after)
def measure(s):
 return {'utf8_bytes':len(s.encode()),'lines':len(s.splitlines()),'tokens':{e:len(tiktoken.get_encoding(e).encode(s)) for e in ['o200k_base','cl100k_base']}}
result={'baseline':str(p),'baseline_sha256':hashlib.sha256(before.encode()).hexdigest(),'method':'Static single-use private message substitution using existing inline caption syntax; tiktoken 0.12.0 reference encodings, not actual GPT-6 billing or executed behavior.','private_declaration_line':40,'only_use_line':17,'cross_source_import_reference_count':0,'literal_english':'Confirmed outcome reference','literal_dutch':'Referentie bevestigde uitkomst','before':measure(before),'after':measure(after),'changed_label_or_translations':False,'runtime_verified':False}
result['reduction']={'utf8_bytes':result['before']['utf8_bytes']-result['after']['utf8_bytes'],'lines':result['before']['lines']-result['after']['lines'],'tokens':{e:result['before']['tokens'][e]-result['after']['tokens'][e] for e in ['o200k_base','cl100k_base']}}
(out/'inline-caption-measurements.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
