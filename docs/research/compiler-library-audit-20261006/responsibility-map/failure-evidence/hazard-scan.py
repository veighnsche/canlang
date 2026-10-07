#!/usr/bin/env python3
"""Lexical candidate index, explicitly not reachability or an AST analysis."""
import pathlib,re,json,hashlib,subprocess,collections
ROOT=pathlib.Path(__file__).resolve().parents[5];HERE=pathlib.Path(__file__).resolve().parent
patterns={
 'explicit_panic':r'\b(?:panic|todo|unimplemented|unreachable)!\s*\(',
 'unwrap_expect':r'\.(?:unwrap|expect)\s*\(',
 'unchecked_cast':r'\bas\s+(?:u8|u16|u32|i8|i16|i32|usize|isize)\b',
 'growing_allocation_or_read':r'\b(?:read_to_string|read_to_end|read_until|with_capacity|reserve|resize|repeat)\s*\(|\bvec!\s*\[',
 'index_or_counter_arithmetic':r'\[[^\]\n]{0,70}(?:\+|\-|\bas\s+)[^\]\n]{0,70}\]|\b(?:depth|offset|pos|next_id|index|count|length|len|column)\s*(?:\+=|-=|\+|\-)\s*\d+'
}
def main():
 paths=subprocess.check_output(['git','ls-files','compiler/src','compiler/build.rs'],cwd=ROOT,text=True).splitlines();files=[];sites=[]
 for name in paths:
  if not name.endswith('.rs'):continue
  data=(ROOT/name).read_bytes();lines=data.decode().splitlines();cut=next((i+1 for i,l in enumerate(lines)if re.match(r'^#\[cfg\(test\)\]',l)),None);found=[]
  for i,line in enumerate(lines,1):
   if line.lstrip().startswith(('//','/*','*')):continue
   for cat,pat in patterns.items():
    if re.search(pat,line):
     item={'id':f'{name}:{i}:{cat}','path':name,'line':i,'category':cat,'region':'production-prefix'if cut is None or i<cut else 'test-tail-or-uncertain','snippet':line.strip()[:180]};sites.append(item);found.append(item['id'])
  files.append({'path':name,'sha256':hashlib.sha256(data).hexdigest(),'lines':len(lines),'first_top_level_cfg_test':cut,'candidate_ids':found,'empty':not found})
 summary={k:dict(collections.Counter(x['region']for x in sites if x['category']==k))for k in patterns}
 value={'scope':'All tracked compiler/src Rust files plus build.rs lexical candidates; no reachability/bug/AST proof','method':'rg source discovery followed by regex line scan, comment-leading lines excluded; first top-level cfg(test) marks a conservative suffix','patterns':patterns,'limitations':['multiline calls/strings/macros and production after a test gate need source review','unwrap_or/checked arithmetic not equivalent to panicking unwrap; no inference that every indexed cast/index fails','recursion/complexity reviewed separately by named caller closure; not guessed from regex'],'files':files,'sites':sites,'counts':summary,'covered_files':len(files),'candidate_sites':len(sites)}
 (HERE/'hazard-index.json').write_text(json.dumps(value,indent=2)+'\n');print(json.dumps({'covered_files':len(files),'sites':len(sites),'counts':summary}))
if __name__=='__main__':main()
