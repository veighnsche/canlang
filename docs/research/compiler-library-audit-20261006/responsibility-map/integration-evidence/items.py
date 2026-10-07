#!/usr/bin/env python3
"""Parser-free Rust source declaration-range catalogue for responsibility closure.
Masks nested comments, quoted/raw strings and chars, then finds named fn/struct/enum
and balances declaration bodies. This is lexical evidence, not semantic call resolution
or a Rust parser; macro-generated items and unusual declarator forms need review.
"""
import importlib.util, json, re, bisect
from pathlib import Path
sp=importlib.util.spec_from_file_location('counter',str(Path(__file__).with_name('count.py'))); mod=importlib.util.module_from_spec(sp); sp.loader.exec_module(mod)
root=mod.ROOT
rows=[]; counts={'files':0,'physical_lines':0,'nonblank_lines':0,'decl_union_lines':0,'production_lines':0,'production_nonblank_lines':0,'production_decl_union_lines':0,'inline_test_lines':0}
for path in sorted(root.rglob('*.rs')):
 src=path.read_text(); clean=mod.mask(src); spans=mod.test_spans(src); lines=src.splitlines(keepends=True); offsets=[0]
 for line in lines: offsets.append(offsets[-1]+len(line))
 newlines=[i for i,c in enumerate(src) if c=='\n']
 def line_of(pos): return bisect.bisect_left(newlines,pos)+1
 def decl_end(pos):
  # Search first top-level body brace or declaration semicolon, respecting signature parens/brackets.
  par=br=0; i=pos
  while i<len(clean):
   c=clean[i]
   if c=='(': par+=1
   elif c==')': par=max(0,par-1)
   elif c=='[': br+=1
   elif c==']': br=max(0,br-1)
   elif par==0 and br==0 and c=='{':
    depth=1; j=i+1
    while j<len(clean) and depth:
     if clean[j]=='{': depth+=1
     elif clean[j]=='}': depth-=1
     j+=1
    return j
   elif par==0 and br==0 and c==';': return i+1
   i+=1
  return pos
 for m in re.finditer(r'\b(fn|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)',clean):
  start=m.start(); end=decl_end(m.end());
  if end<=start: continue
  a=line_of(start); b=line_of(max(start,end-1)); in_test=any(x<=start<y for x,y in spans)
  rows.append({'path':str(path.relative_to(root.parent.parent)),'kind':m.group(1),'name':m.group(2),'start_line':a,'end_line':b,'inline_cfg_test':in_test})
 counts['files']+=1; total=mod.physical(src); counts['physical_lines']+=total; counts['nonblank_lines']+=sum(bool(x.strip()) for x in lines)
 test=sum(mod.lines_in_span(src,a,b) for a,b in spans); counts['inline_test_lines']+=test; counts['production_lines']+=total-test
 counts['production_nonblank_lines']+=sum(bool(x.strip()) for i,x in enumerate(lines) if not any(a<=offsets[i]<b for a,b in spans))
 # Per-file union lines touched by declaration ranges; comments/blank retained in physical and separately countable.
 intervals=[]
 for m in re.finditer(r'\b(fn|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)',clean):
  e=decl_end(m.end()); intervals.append((line_of(m.start()),line_of(max(m.start(),e-1))))
 def union_len(iv):
  iv.sort(); end=0; n=0
  for a,b in iv:
   if b>end: n+=b-max(a,end+1)+1; end=b
  return n
 counts['decl_union_lines']+=union_len(intervals)
 prod_intervals=[]
 for m in re.finditer(r'\b(fn|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)',clean):
  e=decl_end(m.end()); s=m.start()
  if not any(a<=s< b for a,b in spans): prod_intervals.append((line_of(s),line_of(max(s,e-1))))
 counts['production_decl_union_lines']+=union_len(prod_intervals)
out={'method':'Lexical named declaration extraction using comment/string masking and delimiter balancing. Includes function/item bodies and retained comments/blanks in line intervals. Top-level exact cfg(test) spans tag inline tests. Not a Rust AST; macro-generated and unusual forms are not resolved.','counts':counts,'items':rows}
Path(__file__).with_name('items-replay.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(counts))
