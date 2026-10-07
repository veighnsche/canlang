#!/usr/bin/env python3
"""Reproduce bounded LSP disposition inventory without mutating source."""
import hashlib,json,pathlib,re,subprocess
root=pathlib.Path(__file__).resolve().parents[3]
out=pathlib.Path(__file__).resolve().parent
frozen=root/'implementation/compiler-completion/integration-after-bindings/after-message-coverage'
manifest=json.loads((frozen/'before-compiler-inputs.json').read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
paths=['compiler/Cargo.toml','compiler/Cargo.lock','compiler/src/lib.rs','compiler/src/lsp/mod.rs','compiler/src/lsp/output.rs','compiler/src/lsp/server.rs','compiler/src/lsp/transport.rs','compiler/src/lsp/uri.rs','compiler/src/json.rs','compiler/src/diagnostic.rs','compiler/src/source.rs','compiler/src/ide/queries.rs','compiler/tests/lsp_admission.rs','compiler/tests/lsp_frame_reader.rs','compiler/tests/lsp_typed_output.rs','compiler/tests/common/lsp_driver.rs']
pins={p:{'sha256':sha(root/p),'frozen_sha256':manifest.get(p),'matches_frozen':sha(root/p)==manifest.get(p)} for p in paths}
changed=[p for p,h in manifest.items() if (root/p).exists() and sha(root/p)!=h]
# Extract complete public textual declarations, including trait callback signatures.
public={}
for p in ['compiler/src/lsp/mod.rs','compiler/src/lsp/server.rs','compiler/src/lsp/transport.rs','compiler/src/json.rs']:
 lines=(root/p).read_text().splitlines(); entries=[]
 for i,line in enumerate(lines):
  if re.match(r'\s*pub(?:\([^)]*\))? (?:mod|use|const|struct|enum|trait|fn)\b|\s*pub [A-Za-z_][A-Za-z_0-9]*:',line):
   declaration=[line]; j=i
   if 'fn ' in line or 'const ' in line:
    while '{' not in declaration[-1] and ';' not in declaration[-1] and j+1<len(lines): j+=1; declaration.append(lines[j])
   entries.append({'line':i+1,'declaration':'\n'.join(declaration)})
 public[p]=entries
 if p.endswith('/server.rs'):
  start=next(i for i,l in enumerate(lines) if l.startswith('pub trait LanguageAnalysis'))
  end=next(i for i in range(start+1,len(lines)) if lines[i]=='}')
  public['LanguageAnalysis_complete_signature']='\n'.join(lines[start:end+1])
# Current source's top-level braces are sufficient for these six declaration spans.
specs=[('compiler/src/lsp/transport.rs','pub fn response_ok'),('compiler/src/lsp/transport.rs','pub fn response_err'),('compiler/src/lsp/transport.rs','pub fn notification'),('compiler/src/lsp/server.rs','pub struct TextPos'),('compiler/src/lsp/server.rs','pub struct LspRange'),('compiler/src/lsp/output.rs','pub(super) fn range')]
counts=[]
for p,needle in specs:
 lines=(root/p).read_text().splitlines(); start=next(i for i,l in enumerate(lines) if l.startswith(needle)); end=next(i for i in range(start+1,len(lines)) if lines[i]=='}')
 # physical declaration lines from signature through close; derive attributes and doc comments excluded
 counts.append({'file':p,'symbol':needle,'start':start+1,'end':end+1,'physical_declaration_lines':end-start+1})
patterns=r'\b(response_ok|response_err|notification|TextPos|LspRange|LanguageAnalysis)\b'
raw=subprocess.run(['rg','-n',patterns,'compiler','editors','packages','examples','--glob','!target/**','--glob','!**/target/**','--glob','!**/node_modules/**','--glob','!**/dist/**'],cwd=root,text=True,capture_output=True)
(out/'raw-callers.txt').write_text(raw.stdout)
log=(frozen/'full-suite.log').read_text(); selected=[]
for line in log.splitlines():
 if line.startswith('test lsp::') or line.startswith('test source::tests::line_index') or any(n in line for n in ['accepted_integral_ids_preserve','valid_unicode_string_id','real_all_output_families','real_opaque_uri','real_version_increment','real_supported_reference','real_clean_rename','public_queued_work']): selected.append(line)
(out/'selected-bodies.log').write_text('\n'.join(selected)+'\n')
result={'scope':'read-only production audit; declarations count signature through closing brace, excluding preceding derive/doc lines','public_declarations':public,'target_counts':counts,'render_target_total':sum(c['physical_declaration_lines'] for c in counts[:3]),'carrier_target_total':sum(c['physical_declaration_lines'] for c in counts[3:]),'selected_pins':pins,'all_frozen_manifest_current_drift':changed,'receipt_pins':{str(p.relative_to(root)):sha(p) for p in [frozen/'full-suite.log',frozen/'clippy.log',frozen/'before-compiler-inputs.json',frozen/'profile-accounting/final-run.json']},'selected_test_body_count':len(selected),'raw_search_exit':raw.returncode}
(out/'inventory.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['render_target_total','carrier_target_total','all_frozen_manifest_current_drift','selected_test_body_count']}))
