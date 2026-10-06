#!/usr/bin/env python3
import pathlib,json,shutil
P=pathlib.Path(__file__).resolve().parent
S=pathlib.Path('/private/tmp/canlang-turbo-probe-20261006.89738Q/boundaries')
cases=json.loads((P/'cases.json').read_text())['cases']; rows=[]; structured=[]
for c in cases:
 name=c['name'];rpath=P/'results'/name/'boundary.json'
 if not rpath.exists():continue
 r=json.loads(rpath.read_text());status='Detected' if r['exit_code']==1 and ('cannot import package' in r['stderr'] or 'leaves the package' in r['stderr']) else 'Passed' if r['exit_code']==0 else 'CLI error'
 wanted='Allow' if name in ['allowed-root','fs-read-local-control'] else 'Reject'
 if name in ['fs-read-sibling','url-sibling']:wanted='Review owned API / reject producer bypass'
 note=''
 if name=='unexported-subpath':note='Bun runtime rejects (runtime.json); Turbo does not enforce exports here.'
 if name in ['dynamic-constant-undeclared','dynamic-concat-sibling','dynamic-computed-sibling','type-query-undeclared'] and status=='Passed':note='Coverage gap for proposed boundary gate.'
 if name.startswith('root-tool') and status=='Passed':note='Root-owned tooling not diagnosed.'
 if name in ['fs-read-sibling','url-sibling']:note='No semantic producer/data distinction; explicit ownership policy required.'
 rows.append(f'| {name} | {wanted} | {status} ({r["exit_code"]}) | {note} |'); structured.append({'case':name,'desired_policy':wanted,'turbo_result':status,'exit_code':r['exit_code'],'notes':note})
 for filename in ['bun.lock']:
  src=S/name/filename
  if src.exists():shutil.copy2(src,P/'fixtures'/name/filename)
(P/'results.json').write_text(json.dumps(structured,indent=2)+'\n')
(P/'RESULTS.md').write_text('# Isolated boundary coverage probe\n\nTurbo 2.11.7; Bun 1.4.2; macOS arm64. Telemetry disabled. All cases are separate registry-free Bun workspaces; `bun install --ignore-scripts` links local packages. Raw argv, cwd, exit, stdout/stderr live in `results/<case>/`. Version, help and launcher/native hashes are preserved separately.\n\nDesired policy is the proposed project gate, not a claim about Turbo capabilities. Filesystem reads and URLs need an explicit distinction between owned asset APIs and loading a sibling producer. A local-data read is the control. Fixtures and locks are saved in `fixtures/`; runtime export checks are separately labeled. No product source or manifests were changed.\n\n| Case | Desired policy | Turbo result | Interpretation |\n| --- | --- | --- | --- |\n'+'\n'.join(rows)+'\n\nReproduce preparation with `python3 probe.py`. Run with `python3 probe.py --run /absolute/path/to/turbo boundaries --no-color --no-update-notifier --skip-infer`. Summarize with `python3 summarize.py`. Environment uses scratch-local Bun/XDG caches. No `--ignore` suppressions were used.\n')
print(f'Summarized {len(structured)} cases')
