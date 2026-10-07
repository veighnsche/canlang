import json, pathlib, subprocess, hashlib
base=pathlib.Path(__file__).resolve().parent
root=base.parents[3]
catalog=root/'packages/values/dist/catalog.json'
cases={
 'plain-positional':'derive g():text = format("Hi {n}",{n="Bo"})',
 'plain-named':'derive g():text = format(template="Hi {n}",values={n="Bo"})',
 'plain-reversed':'derive g():text = format(values={n="Bo"},template="Hi {n}")',
 'plain-missing-reversed':'derive g():text = format(values={other="Bo"},template="Hi {n}")',
 'message-positional':'message m="Hi"@{nl="Hoi"}\n derive g():text = format(m,null)',
 'message-named':'message m="Hi"@{nl="Hoi"}\n derive g():text = format(descriptor=m,locale="nl")',
 'message-reversed':'message m="Hi"@{nl="Hoi"}\n derive g():text = format(locale="nl",descriptor=m)',
 'message-dynamic':'message m="Hi"@{nl="Hoi"}\n derive g(target:locale?):text = format(m,locale=target)',
 'message-param-named':'message m(name:text)="Hi {name}"@{}\n derive g():text = format(m(name="Bo"),locale=null)',
 'message-param-default':'message m(name:text="Bo")="Hi {name}"@{}\n derive g():text = format(m(),locale=null)',
 'derive-default':'derive f(a:text="Default"):text = a\n derive g():text = f()',
 'derive-named':'derive f(a:text,b:text):text = a\n derive g():text = f(b="B",a="A")',
 'alias-call':'export derive f(a:text,b:text):text = a\n derive g():text = f(b="B",a="A")',
 'unknown-name':'derive g():text = format(bad="Hi",values={})',
 'duplicate-name':'derive g():text = format(template="Hi",template="Ho")',
 'missing-arg':'derive g():text = format("Hi")',
 'plain-eval-order':'derive a():text = "A"\n derive b():text = "B"\n derive g():text = format(values={n=b()},template=a())',
}
results=[]
for name,body in cases.items():
 src='app T\nGiven\n '+body+'\nWhen\nThen\n'
 path=base/(name+'.can');path.write_text(src)
 cmd=[str(root/'compiler/target/debug/can'),'compile','--format=json','--catalog='+str(catalog),str(path)]
 p=subprocess.run(cmd,capture_output=True,text=True)
 (base/(name+'.stdout')).write_text(p.stdout);(base/(name+'.stderr')).write_text(p.stderr)
 try:artifact=json.loads(p.stdout)
 except Exception:artifact={}
 modules=artifact.get('modules',[])
 if modules:
  (base/(name+'.mjs')).write_text(modules[0]['js'])
 results.append({'id':name,'command':cmd,'exit':p.returncode,'diagnostics':artifact.get('diagnostics',[]),'emitted':bool(modules)})
(base/'compile-observations.json').write_text(json.dumps({'catalog_sha256':hashlib.sha256(catalog.read_bytes()).hexdigest(),'cases':results},indent=2)+'\n')
print(json.dumps(results,indent=2))
