import json, pathlib, subprocess
base=pathlib.Path(__file__).resolve().parent
root=base.parents[3]
original=json.loads((root/'packages/values/dist/catalog.json').read_text())
variants={
'same-arity-later':('starts_with','starts_with(value:int,prefix:text)->bool; starts_with(prefix:text,value:text)->bool','pure','derive g():bool = starts_with(prefix="A",value="AB")'),
'same-arity-selected-order':('starts_with','starts_with(value:text,prefix:int)->bool; starts_with(prefix:text,value:text)->bool','pure','derive g():bool = starts_with(value="AB",prefix="A")'),
'same-arity-awaited':('starts_with','starts_with(value:int,prefix:text)->bool; starts_with(prefix:text,value:text)->bool','state-read','__read_scenario__'),
'ordinary-eval-order':('starts_with','starts_with(value:text,prefix:text)->bool','pure','contract C {a:text,b:text}\n derive g(v:C):bool = starts_with(prefix=v.a,value=v.b)'),
}
results=[]
for name,(id,sig,effects,body) in variants.items():
 cat=json.loads(json.dumps(original))
 for e in cat['entries']:
  if e['id']==id:e['signature']=sig;e['effects']=effects
 cp=base/(name+'.catalog.json');cp.write_text(json.dumps(cat,indent=2)+'\n')
 sp=base/(name+'.can');sp.write_text('app T\nGiven\nWhen\n scenario g() read=true -> bool by=members\n  do\n   return starts_with(prefix="A",value="AB")\nThen\n' if body=='__read_scenario__' else 'app T\nGiven\n '+body+'\nWhen\nThen\n')
 p=subprocess.run([str(root/'compiler/target/debug/can'),'compile','--format=json','--catalog='+str(cp),str(sp)],capture_output=True,text=True)
 (base/(name+'.stdout')).write_text(p.stdout);(base/(name+'.stderr')).write_text(p.stderr)
 artifact=json.loads(p.stdout)
 if artifact.get('modules'):(base/(name+'.mjs')).write_text(artifact['modules'][0]['js'])
 results.append({'id':name,'exit':p.returncode,'diagnostics':artifact.get('diagnostics',[]),'emitted':bool(artifact.get('modules'))})
# Actual imported declaration alias, not a purported builtin alias.
name='message-import-alias'
sp=base/(name+'.can');sp.write_text('app T\nuse P {m as alias}\nGiven\n derive g():text = format(alias(name="Bo"),locale=null)\nWhen\nThen\npackage P\n Given\n  export message m(name:text="Default")="Hi {name}"@{}\n When\n Then\n')
p=subprocess.run([str(root/'compiler/target/debug/can'),'compile','--format=json','--catalog='+str(root/'packages/values/dist/catalog.json'),str(sp)],capture_output=True,text=True)
(base/(name+'.stdout')).write_text(p.stdout);(base/(name+'.stderr')).write_text(p.stderr)
artifact=json.loads(p.stdout)
results.append({'id':name,'exit':p.returncode,'diagnostics':artifact.get('diagnostics',[]),'emitted':bool(artifact.get('modules'))})
(base/'custom-compile-observations.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
