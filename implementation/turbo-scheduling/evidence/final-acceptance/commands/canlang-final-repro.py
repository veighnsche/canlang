import hashlib,json,os,pathlib,subprocess
root=pathlib.Path('/Users/vince/Projects/canlang')
env=dict(os.environ,PATH='/Users/vince/.vite-plus/bin:'+os.environ['PATH'])
runs=[]
for index in (1,2):
    log=pathlib.Path(f'/private/tmp/canlang-final-uncached-{index}.log')
    with log.open('wb') as stream:
        result=subprocess.run(['bun','run','build:uncached'],cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT)
    assert result.returncode == 0, str(log)
    inventory={}
    for directory in sorted((root/'packages').glob('*/dist')):
        for file in sorted(directory.rglob('*')):
            if file.is_file() and (file.name.endswith('.js') or file.name.endswith('.d.ts') or file.name.endswith('.map')):
                data=file.read_bytes()
                inventory[str(file.relative_to(root))]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    assert inventory
    text=log.read_text()
    assert '0 cached, 26 total' in text and '26 successful, 26 total' in text
    runs.append({'command':['bun','run','build:uncached'],'exit':result.returncode,'log':str(log),'logSha256':hashlib.sha256(log.read_bytes()).hexdigest(),'inventory':inventory})
assert runs[0]['inventory']==runs[1]['inventory']
report={'status':'success','scope':'Two actual cache-read/write-disabled builds; existing CI JS/declaration/map subset. Complete inventory/cache mode proof is separate.','files':len(runs[0]['inventory']),'runs':runs,'equal':True}
pathlib.Path('/private/tmp/canlang-final-repro.json').write_text(json.dumps(report,indent=2)+'\n')
print('Two uncached builds match:',report['files'],'files')
