from pathlib import Path
import re,json,hashlib,subprocess
can=Path('draft/CanInbox.can');js=Path('draft/CanInbox.mjs');s=can.read_text();j=js.read_text();lines=s.splitlines();out=[];excluded=[];i=0
while i<len(lines):
 line=lines[i]
 if line.startswith('  # Evaluate message content') or line.startswith('  export judgment') or (line.startswith('   ') and not line.startswith('    ') and re.match(r'   (reply noul|route choice|urgency score)',line)):
  excluded.append(f'{i+1}: judgment declaration/attached description');i+=1;continue
 if line.startswith('   examples') and i+1<len(lines) and lines[i+1]=='    do':
  start=i+1;i+=1
  while i<len(lines) and (not lines[i].strip() or len(lines[i])-len(lines[i].lstrip())>=4):i+=1
  excluded.append(f'{start}–{i}: shared-state sequence');continue
 replacement=re.sub(r'delivery\([^)]*\)','text',line)
 if replacement!=line:excluded.append(f'{i+1}: typed delivery associations replaced with text for syntax only')
 if ' poll=5s' in replacement:excluded.append(f'{i+1}: page poll attribute omitted');replacement=replacement.replace(' poll=5s','')
 out.append(replacement);i+=1
projection=Path('/tmp/caninbox-business-projection.can');projection.write_text('\n'.join(out)+'\n')
commands=[['node','--check',str(js)],['python3','tools/can_parser.py',str(can)],['python3','tools/can_parser.py',str(projection)]]
results=[]
for command in commands:
 run=subprocess.run(command,text=True,capture_output=True);results.append({'command':' '.join(command),'exit':run.returncode,'output':(run.stdout+run.stderr).strip()})
scenarios=re.findall(r'^  scenario (\w+)',s,re.M)
assert len(scenarios)==13
assert all(re.search(r'async '+x+r'\(c,',j) for x in scenarios)
assert all(f'"inbox.{x}": {{ handler: "{x}"' in j for x in scenarios)
models=re.findall(r'^  ([A-Z]\w+)(?: in \w+)? \{',s,re.M)
assert len(models)==10 and all(f'"inbox.{m}": {{' in j for m in models)
fixtures=re.findall(r'^  fixture (\w+)=',s,re.M)
assert len(fixtures)==21 and all(f'const {f} = ' in j for f in fixtures)
source_examples=len(re.findall(r'^   examples',s,re.M))
# Every JS example opening is indented exactly eight spaces; step calls are deeper.
target_examples=len(re.findall(r'^        operation: "inbox\.',j,re.M))
assert source_examples==target_examples,(source_examples,target_examples)
rows=0;sequence=False
for line in lines:
 if line.startswith('   examples'):sequence=False
 if line=='    do':sequence=True
 if re.match(r'^    \S',line) and ' -> ' in line and not sequence and not re.match(r'^    (as|event|incoming|uncertain|parcel)',line):rows+=1
assert 'kind: "sequence"' not in j and '        sequence: [' in j
assert len(re.findall(r'async (?:received|assessed|sent|reconciled)\(c, \{ event \}\)',j))==4
assert not re.search(r'by: "[^"\n]+ or ',j)
assert not re.search(r'^\s+(?:table|list|gallery)\(\{[^\n]*\brows:',j,re.M)
assert len(re.findall(r'export async function \w+Page\(',j))==2
assert all(r['exit']==expected for r,expected in zip(results,[0,1,0])),results
hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [can,js,Path('draft/CanInbox.md')]}
report={'checks':results,'static':{'models':len(models),'scenarios':len(scenarios),'fixtures':len(fixtures),'example_blocks':source_examples,'sequence_blocks':1,'pages':2,'table_rows':rows},'projection_exclusions':excluded,'sha256':hashes}
Path('design/jev/complex-inbox-20261004/static-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
