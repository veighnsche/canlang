import json,pathlib,subprocess,hashlib
base=pathlib.Path(__file__).resolve().parent
root=base.parents[4]
fixtures={
'locale-simple':'app Dutch\ncontext\n locale default="nl"\nGiven\n message m="Hello"@{nl="Hallo"}\n derive g():text = format(m,locale=null)\nWhen\nThen\n',
'locale-shared':'app Dutch uses=[Shared]\ncontext\n locale default="nl"\napp German uses=[Shared]\ncontext\n locale default="de"\npackage Shared source="fr"\n Given\n  export message greeting="Bonjour"@{nl="Hallo",de="Hallo Deutsch"}\n  export derive g():text = format(greeting,locale=null)\n When\n Then\n',
'locale-conflicting-composition':'app Combined uses=[Dutch,German]\napp Dutch uses=[Shared]\ncontext\n locale default="nl"\napp German uses=[Shared]\ncontext\n locale default="de"\npackage Shared source="fr"\n Given\n  export message greeting="Bonjour"@{nl="Hallo",de="Hallo Deutsch"}\n  export derive g():text = format(greeting,locale=null)\n When\n Then\n',
'locale-identical-composition':'app Combined uses=[Dutch,DutchAlso]\napp Dutch uses=[Shared]\ncontext\n locale default="nl"\napp DutchAlso uses=[Shared]\ncontext\n locale default="nl"\npackage Shared source="fr"\n Given\n  export message greeting="Bonjour"@{nl="Hallo"}\n  export derive g():text = format(greeting,locale=null)\n When\n Then\n',
}
results=[]
for id,src in fixtures.items():
 sp=base/(id+'.can');sp.write_text(src)
 cmd=[str(root/'compiler/target/debug/can'),'compile','--format=json','--catalog='+str(root/'packages/values/dist/catalog.json'),str(sp)]
 p=subprocess.run(cmd,capture_output=True,text=True)
 (base/(id+'.stdout')).write_text(p.stdout);(base/(id+'.stderr')).write_text(p.stderr)
 artifact=json.loads(p.stdout)
 results.append({'id':id,'exit':p.returncode,'diagnostics':artifact.get('diagnostics',[]),'modules':[m['path'] for m in artifact.get('modules',[])]})
 for i,m in enumerate(artifact.get('modules',[])):(base/(id+f'-{i}.mjs')).write_text(m['js'])
(base/'observations.json').write_text(json.dumps(results,indent=2)+'\n')
files=['compiler/src/analysis/effects.rs','compiler/src/analysis/resolve.rs','compiler/src/analysis/types.rs','compiler/src/codegen/ir.rs','compiler/src/codegen/js.rs','packages/contracts/src/state.ts','packages/state/src/invocation/context.ts','packages/cloudflare/src/worker/assembly.ts','packages/cloudflare/src/runtime/context.ts','packages/cloudflare/src/runtime/invoke.ts','packages/cloudflare/src/runtime/executors.ts','packages/interfaces/src/ports.ts','packages/values/src/locale.ts']
(base/'pins.json').write_text(json.dumps({f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},indent=2)+'\n')
print(json.dumps(results,indent=2))
