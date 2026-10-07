#!/usr/bin/env python3
import json,pathlib,subprocess
out=pathlib.Path('/Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass9/cli')
rows=[]
for row in json.loads((out/'process-results.json').read_text())['cases']+json.loads((out/'process-results.json').read_text())['characterization']:
 p=subprocess.run(['/private/tmp/canlang-pass5-profile/current-native-target/debug/canlang-pass9-cli-candidate']+row['argv'],capture_output=True,text=True,timeout=5)
 rows.append(dict(argv=row['argv'],exit=p.returncode,stdout=p.stdout,stderr=p.stderr,current_exit=row['exit'],note='parser/metadata prototype only; no business dispatch'))
(out/'clap-results.json').write_text(json.dumps(rows,indent=2)+'\n')
