#!/usr/bin/env python3
import json,pathlib,tempfile
from run import HERE,ROOT,invoke
def main():
    with tempfile.TemporaryDirectory(prefix='can-step8-generated-') as t:
        t=pathlib.Path(t);(t/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
        (t/'generated-format.mjs').write_bytes((HERE/'generated-format.mjs').read_bytes())
        d,r=invoke('generated-format',['node',t/'generated-format.mjs',HERE],cwd=t)
        assert not d.returncode,r
        (HERE/'generated-observations.json').write_text(json.dumps(json.loads(d.stdout),indent=2)+'\n')
        (HERE/'generated-execution.json').write_text(json.dumps({'commands':[r]},indent=2)+'\n')
        print(d.stdout.decode())
if __name__=='__main__':main()
