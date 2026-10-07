import pathlib, subprocess, json, hashlib, os
repo=pathlib.Path.cwd(); out=repo/'docs/research/compiler-library-audit-20261006/pass9/positions-medium'; tmp=pathlib.Path('/private/tmp/canlang-pass9-positions-medium'); tmp.mkdir(exist_ok=True)
files=['compiler/src/source.rs','compiler/src/ide/queries.rs','compiler/src/docs.rs','compiler/src/lsp/server.rs','compiler/src/ide/tokens.rs','compiler/src/codegen/sourcemap.rs','compiler/src/diagnostic.rs','compiler/src/cli.rs','compiler/tests/docs.rs','compiler/tests/ide.rs','docs/research/compiler-library-audit-20261006/pass8/CONTRACT.md']
pins={p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in files}
s=(repo/files[0]).read_text(); q=(repo/files[1]).read_text(); d=(repo/files[2]).read_text()
def function(text,name):
 start=text.index('fn '+name+'('); start=text.rfind('\n',0,start)+1; brace=text.index('{',start); depth=1; end=brace+1
 while depth:
  depth += (text[end]=='{')-(text[end]=='}'); end+=1
 return text[start:end]
line=s[s.index('#[derive(Debug, Clone)]',s.index('/// Maps byte offsets')):s.index('/// Lowercase hex SHA-256',s.index('pub struct LineIndex'))]
source='use std::path::{Path,PathBuf};\n'+line+'\n'+function(q,'offset_at_position')+'\n'+function(d,'portable_source_id')+'\n'+function(d,'lexical_normalize')+'\n'+function(d,'rel_to_portable')
vectors=[('',0,(1,1),(0,0),(0,0)),('é😀x',6,(1,7),(0,3),(0,6)),('é😀x',4,(1,5),(0,1),(0,2)),('é😀x',99,(1,8),(0,4),(0,7)),('ab\r\nc',2,(1,3),(0,2),(0,2)),('ab\r\nc',3,(1,3),(0,2),(0,2)),('ab\r\nc',4,(2,1),(1,0),(1,0)),('a\rb',2,(1,3),(0,2),(0,2)),('a\r',2,(1,3),(0,2),(0,2)),('a\n',2,(2,1),(1,0),(1,0))]
reverse=[('é😀x',0,2,2),('é😀x',0,3,6),('é😀x',0,99,7),('ab\r\nc',0,99,2),('a\r',0,2,2),('a\r',0,99,2),('a\n',1,0,2),('a\n',2,0,None)]
def rs(s):return json.dumps(s,ensure_ascii=False)
body='fn main(){\n'
for n,(t,o,b,u,v) in enumerate(vectors):body+=f'{{let t={rs(t)};let i=LineIndex::new(t);println!("forward {n}: {{:?}} {{:?}} {{:?}}",i.line_col(t,{o}),i.to_lsp(t,{o},true),i.to_lsp(t,{o},false));}}\n'
for n,(t,l,c,e) in enumerate(reverse):body+=f'println!("reverse {n}: {{:?}}",offset_at_position({rs(t)},{l},{c}));\n'
root=tmp/'fs/root';root.mkdir(parents=True,exist_ok=True);(root/'real.can').write_text('x'); link=root/'link.can'
if not link.exists():link.symlink_to('real.can')
paths=[('real.can',str(root),'real.can'),('./real.can',str(root),'real.can'),('link.can',str(root),'real.can'),(str(root/'real.can'),str(root),'real.can'),('a/../absent.can',str(root),'absent.can'),('../outside.can',str(root),'external:'+str(root.parent/'outside.can')),('../../x','../missing','external:../../x'),('../../x','../../missing','external:../../../x'),(str(tmp/'missing/root/x'),str(tmp/'missing/root'),'x')]
for n,(p,r,e) in enumerate(paths):body+=f'println!("path {n}: {{}}",portable_source_id({rs(p)},Path::new({rs(r)})));\n'
body+='}'
(tmp/'current.rs').write_text(source+'\n'+body);subprocess.run(['rustc','--edition=2024',str(tmp/'current.rs'),'-o',str(tmp/'current')],check=True)
raw=subprocess.check_output([str(tmp/'current')],text=True);(out/'current-source-results.txt').write_text(raw)
rlib=max((repo/'compiler/target/debug/deps').glob('libcanlang_compiler-*.rlib'),key=lambda p:p.stat().st_mtime)
(tmp/'rlib.rs').write_text('extern crate canlang_compiler;use canlang_compiler::{source::LineIndex,ide::queries::offset_at_position,docs::portable_source_id};use std::path::Path;\n'+body)
subprocess.run(['rustc','--edition=2024',str(tmp/'rlib.rs'),'--extern','canlang_compiler='+str(rlib),'-L','dependency='+str(rlib.parent),'-o',str(tmp/'rlib')],check=True)
rr=subprocess.check_output([str(tmp/'rlib')],text=True);(out/'rlib-results.txt').write_text(rr)
expected=[]
for n,(_,_,b,u,v) in enumerate(vectors):expected.append(f'forward {n}: {b} {u} {v}')
for n,(_,_,_,e) in enumerate(reverse):expected.append(f'reverse {n}: '+('None' if e is None else f'Some({e})'))
for n,(_,_,e) in enumerate(paths):expected.append(f'path {n}: {e}')
actual=raw.splitlines(); mismatch=[{'expected':e,'actual':a} for e,a in zip(expected,actual) if e!=a]
(out/'vectors.json').write_text(json.dumps({'forward':vectors,'reverse':reverse,'paths':paths,'mismatches':mismatch,'rlib_matches_current_source':raw==rr},indent=2,ensure_ascii=False)+'\n')
pins[str(rlib.relative_to(repo))]=hashlib.sha256(rlib.read_bytes()).hexdigest();(out/'pins.json').write_text(json.dumps(pins,indent=2)+'\n')
print(json.dumps({'forward':len(vectors),'reverse':len(reverse),'paths':len(paths),'mismatches':mismatch,'rlib_matches_current_source':raw==rr},indent=2))
