#!/usr/bin/env python3
"""Reproduce the bounded docs support inventory; no compiler writes."""
import hashlib,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
OUT=Path(__file__).resolve().parent
paths=['AGENTS.md','compiler/src/docs.rs','compiler/src/json.rs','compiler/src/lib.rs','compiler/src/cli.rs','compiler/src/main.rs','compiler/Cargo.toml','compiler/Cargo.lock','compiler/tests/typed_references.rs','compiler/tests/docs.rs','compiler/tests/typed_reference_policy_consumers.rs','packages/contracts/src/reference.ts','packages/interfaces/src/index.ts','packages/interfaces/src/docs/reference.ts','packages/interfaces/test/docs-reference.test.ts','packages/cloudflare/src/cli/docs.ts','packages/cloudflare/src/cli/platform.ts','packages/cloudflare/package.json','docs/research/compiler-library-audit-20261006/responsibility-map/integrations.md','docs/research/compiler-library-audit-20261006/resumption/audit-costs-and-oracles.md']
pins={p: {'sha256':hashlib.sha256((ROOT/p).read_bytes()).hexdigest(),'bytes':(ROOT/p).stat().st_size} for p in paths}
text=(ROOT/'compiler/src/docs.rs').read_text()
methods=[]
for m in re.finditer(r'impl (Reference\w+) \{([\s\S]*?)\n\}',text):
    method=re.search(r'    pub fn to_json\(&self\) -> Json \{\n        reference_json\(self\)\n    \}',m[2])
    if method:
        start=m.start(2)+method.start()
        line=text[:start].count('\n')+1
        methods.append({'owner':m[1],'method':'to_json(&self) -> Json','start':line,'end':line+2,'body_lines':3})
helper=re.search(r'fn reference_json<T: serde::Serialize>\(value: &T\) -> Json \{[\s\S]*?\n\}',text)
assert helper and len(methods)==13
helper_lines=helper[0].count('\n')+1
assert helper_lines==5
# Lexical calls need the source-level typed receiver trace in README; no claim
# that a text search is a Rust semantic call graph or external-user census.
cmd=['rg','-n','to_json_string|reference_json|extract_reference|renderReferenceMarkdown','compiler/src/docs.rs','compiler/src/cli.rs','compiler/tests/docs.rs','compiler/tests/typed_references.rs','compiler/tests/typed_reference_policy_consumers.rs','packages/interfaces/src/index.ts','packages/interfaces/src/docs/reference.ts','packages/cloudflare/src/cli/docs.ts','packages/cloudflare/src/cli/platform.ts']
r=subprocess.run(cmd,cwd=ROOT,text=True,capture_output=True,check=True)
(OUT/'caller-search.txt').write_text(r.stdout)
data={'scope':'bounded docs compatibility views; source inventory, not external support census','methods':methods,'helper':{'name':'reference_json','start':text[:helper.start()].count('\n')+1,'physical_lines':helper_lines},'counts':{'public_view_entrypoints':13,'public_method_lines':sum(m['body_lines'] for m in methods),'helper_lines':helper_lines,'total_target_body_lines':44,'serialize_parse_sites':1,'retain_net_production_deletion':0,'retain_mechanisms_retired':0},'pins':pins,'head_navigation_only':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'search_command':cmd,'result':'RETAIN'}
(OUT/'inventory.json').write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(data['counts']))
