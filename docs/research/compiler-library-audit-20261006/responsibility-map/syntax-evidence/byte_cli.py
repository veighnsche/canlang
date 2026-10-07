#!/usr/bin/env python3
"""Check the real CLI's malformed byte ingress, distinct from lex_bytes E1002."""
import json
import pathlib
import tempfile
from run import HERE, ROOT, digest, invoke

def main():
    case = next(c for c in json.loads((HERE/'cases.json').read_text()) if c['id']=='invalid-utf8')
    commands=[]
    with tempfile.TemporaryDirectory(prefix='can-step7-byte-') as temp:
        source=pathlib.Path(temp)/'invalid.can'
        source.write_bytes(bytes.fromhex(case['bytes_hex']))
        for command in ['check','compile']:
            done, receipt=invoke('cli-'+command+'-invalid-utf8',
                [str(ROOT/'compiler/target/debug/can'),command,'--format=json','--catalog',
                 str(ROOT/'packages/values/dist/catalog.json'),str(source)])
            receipt.update({'source_sha256':digest(source),'expected':{'exit':2,'stderr_code':'E7002'},
                'pass':done.returncode==2 and b'E7002' in done.stderr and not done.stdout})
            commands.append(receipt)
    (HERE/'byte-cli-admission.json').write_text(json.dumps({'scope':
        'CLI read_to_string rejects malformed UTF8 as E7002/exit2 stderr tool error, even with --format=json. Public lex_bytes separately returns E1002. No lossy replacement.',
        'initial_capture_correction':'First read-only capture assumed JSON stdout for a tool failure and its observer raised JSONDecodeError; actual CLI exited2 with empty stdout/E7002 stderr. Preserved first CLI output in byte-cli-attempt1.*; corrected capture checks the owning early tool error mapping.',
        'commands':commands},indent=2)+'\n')
    print(json.dumps({'checks':[c['pass'] for c in commands]}))

if __name__=='__main__':main()
