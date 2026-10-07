from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3]
JS=ROOT/'compiler/src/codegen/js.rs'
text=JS.read_text()
markers=[('public_default_surface','/// One source-derived field default','// This tree never introduces'),('literal_tree','// This tree never introduces','/// Extract the dot path'),('literal_serialize','impl Serialize for JsFieldDefault','#[derive(Serialize)]\nstruct ArrayMarker')]
frozen=subprocess.check_output(['git','show','bc2b7d05:compiler/src/codegen/js.rs'],cwd=ROOT).decode()
segments={}
for name,start,end in markers:
    assert text.count(start)==text.count(end)==1
    chunk=text[text.index(start):text.index(end)].encode()
    prior=frozen[frozen.index(start):frozen.index(end)].encode()
    segments[name]={'sha256':hashlib.sha256(chunk).hexdigest(),'matches_frozen_1152_profile':chunk==prior}
callers=subprocess.run(['rg','-n','JsFieldDefault|literal_json|js_field_default', 'compiler/src','compiler/tests'],cwd=ROOT,check=True,capture_output=True,text=True).stdout
(Path(__file__).parent/'caller-search.txt').write_text(callers)
files=['compiler/src/codegen/js.rs','compiler/src/codegen/ir.rs','compiler/src/codegen/artifact.rs','compiler/src/codegen/mod.rs','compiler/tests/typed_descriptors.rs','compiler/tests/typed_artifact.rs']
result={'status':'current_source_inventory','reference':'integration:default-json-string-bridge','source_sha256':{f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files},'selected_segments':segments,'raw_value_parse_sites_in_default_serialize':text[text.index('impl Serialize for JsFieldDefault'):text.index('#[derive(Serialize)]\nstruct ArrayMarker')].count('serde_json::from_str'),'public_surface':['JsFieldDefault::Literal(String)','JsFieldDefault::to_json','Serialize for JsFieldDefault','literal_json','js_field_default'],'net_production_deletion':0,'retired_bridge_sites':0,'limits':'Raw member/number preservation and malformed literal rejection are public behavior; selected-segment equality is bounded historical evidence only, not complete current compiler equivalence or runtime/default/browser qualification.'}
(Path(__file__).parent/'inventory.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'sites':result['raw_value_parse_sites_in_default_serialize'],'frozen_segments_match':all(x['matches_frozen_1152_profile'] for x in segments.values())}))
