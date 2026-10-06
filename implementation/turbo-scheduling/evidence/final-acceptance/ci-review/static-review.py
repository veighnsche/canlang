from pathlib import Path
import json,re,hashlib
out=Path('implementation/turbo-scheduling/evidence/final-acceptance/ci-review')
workflows=json.loads((out/'workflows-parsed.json').read_text()); assert len(workflows)==12
root=json.loads(Path('package.json').read_text());turbo=json.loads(Path('turbo.json').read_text());pkgs={json.loads(p.read_text())['name']:json.loads(p.read_text()) for p in Path('packages').glob('*/package.json')}
checks=[]
def check(label,condition):
 assert condition,label
 checks.append(label)
for f,d in workflows.items():
 for jobname,job in d['jobs'].items():
  for step in job.get('steps',[]):
   action=step.get('uses','');withs=step.get('with',{})
   if action.startswith('actions/setup-node@'):check(f'{f}/{jobname}: Node24',str(withs['node-version'])=='24')
   if action.startswith('oven-sh/setup-bun@'):check(f'{f}/{jobname}: Bun1.4.2',withs['bun-version']=='1.4.2')
   if action.startswith('dtolnay/rust-toolchain@'):check(f'{f}/{jobname}: Rust1.99 SHA',action=='dtolnay/rust-toolchain@89b12181fb390509a0842a86cc55eeb8eb928c1d' and withs['toolchain']=='1.99.0')
   for version in re.findall(r'typescript@([\w.]+)',step.get('run','')):check(f'{f}/{jobname}: explicit TS5.9.3',version=='5.9.3')
steps=workflows['.github/workflows/integration.yml']['jobs']['workspace']['steps']; runs=[step.get('run','') for step in steps]
e2e=workflows['.github/workflows/e2e.yml']; e2esteps=e2e['jobs']['playwright']['steps']; e2eruns=[step.get('run','') for step in e2esteps]
check('E2e public compiler preparation follows producers/precedes harness',e2eruns.index('bun run build')<e2eruns.index('bun run build:compiler')<e2eruns.index('bun run typecheck:e2e') and e2eruns.index('bun run build:compiler')<next(i for i,r in enumerate(e2eruns) if 'bun run test:e2e' in r))
check('E2e Rust setup precedes compiler preparation',next(i for i,step in enumerate(e2esteps) if step.get('uses','').startswith('dtolnay/rust-toolchain@'))<e2eruns.index('bun run build:compiler'))
events=e2e.get('on',e2e.get('true'))
for event in ['pull_request','push']:
 check(f'E2e {event} filters producer/compiler/graph owners',set(['compiler/**','packages/**','scripts/**','turbo.json','bunfig.toml','tsconfig*.json']).issubset(events[event]['paths']))
check('Integration public full-build/check/test aliases', all(f'bun run {s}' in runs for s in ['build','check:boundaries','test:boundaries','test:ci','typecheck','catalog','test:all']))
prep=next(i for i,s in enumerate(steps) if '--bin can-preparation' in s.get('run',''));test=runs.index('bun run test:all');cat=runs.index('bun run catalog')
check('Private preparation + catalog precede testall',prep<test and cat<test)
check('Private preparation pinned/locked temporary target', 'cargo +1.99.0 build --locked' in runs[prep] and 'runner.temp' in steps[prep]['env']['CARGO_TARGET_DIR'])
check('Testall receives exact private binary environment',steps[test]['env']['CAN_PREPARATION_BIN']==steps[prep]['env']['CARGO_TARGET_DIR']+'/debug/can-preparation')
check('Catalog is blocking not continue-on-error',not steps[cat].get('continue-on-error') and not steps[cat].get('if'))
check('Installed acceptance follows suites with skip-build',all(f'bun run {s} --skip-build' in runs and runs.index(f'bun run {s} --skip-build')>test for s in ['verify:installed-types','verify:installed-worker']))
check('Graph has13 producers',len(pkgs)==13 and all('build' in p['scripts'] and 'typecheck:check' in p['scripts'] for p in pkgs.values()))
typ=json.loads((out/'typecheck-dry.json').read_text());typ_tasks={t['taskId']:t for t in typ['tasks']}
check('Dry typecheck contains all13 owner checks/builds',all(f'{n}#build' in typ_tasks and f'{n}#typecheck:check' in typ_tasks for n in pkgs))
unit={n for n,p in pkgs.items() if 'test:unit' in p['scripts']};check('Ten package-unit owners',len(unit)==10)
testdry=json.loads((out/'test-all-dry.json').read_text());testtasks={t['taskId']:t for t in testdry['tasks']}
check('Testall contains every unit + emitted runtime + root',all(f'{n}#test:unit' in testtasks for n in unit) and '@canlang/cloudflare#test:runtime' in testtasks and '//#test:root' in testtasks)
check('Tests/typechecks/catalog are uncached',all(turbo['tasks'][n]['cache'] is False for n in ['typecheck:check','test:unit','test:runtime','catalog:emit','//#test:root','//#typecheck:root']))
release=json.loads((out/'release-pack-dry.json').read_text());reltasks={t['taskId']:t for t in release['tasks']}
check('Releasepack full13producer closure',all(f'{n}#build' in reltasks for n in pkgs))
check('Release validation and packing uncached dependency chain',all(turbo['tasks'][n]['cache'] is False for n in ['//#release:stamp','//#release:manifest','//#release:verify','//#release:pack:run']) and '//#release:verify' in reltasks['//#release:pack:run']['dependencies'] and '//#release:manifest' in reltasks['//#release:verify']['dependencies'] and '//#release:stamp' in reltasks['//#release:manifest']['dependencies'])
check('Releaseworkflow complete artifacts upload',any(s.get('run')=='bun run release:pack' for s in workflows['.github/workflows/release.yml']['jobs']['node-libraries']['steps']) and any(s.get('with',{}).get('path')=='output/release-artifacts/*' for s in workflows['.github/workflows/release.yml']['jobs']['node-libraries']['steps']))
plans=json.loads((out/'finite-gate-plans.json').read_text())
for profile,plan in plans.items():
 ids=[s['id'] for s in plan]
 check(f'Finite {profile}: install/build ordered + explicit test identity',ids.index('install')<ids.index('build')<ids.index('tests') and next(s for s in plan if s['id']=='tests')['isTest'])
 if profile in ['cloudflare','workspace']:
  check(f'Finite {profile}: native prerequisite precedes tests',ids.index('native-build')<ids.index('tests') and '--locked' in next(s for s in plan if s['id']=='native-build')['argv'] and 'CAN_PREPARATION_BIN' in next(s for s in plan if s['id']=='tests')['env'])
check('Finite values includes catalog',any(s['id']=='catalog' for s in plans['values']))
logfacts=[]
for name,count in [('boundary-tests',12),('ci-tests',32)]:
 p=Path(f'/private/tmp/canlang-final-{name}.log');s=p.read_text();check(f'Provided local {name} log reports {count} pass zero fail',bool(re.search(rf'(?:#|ℹ)\s*tests\s+{count}\b',s)) and bool(re.search(rf'(?:#|ℹ)\s*pass\s+{count}\b',s)) and bool(re.search(r'(?:#|ℹ)\s*fail\s+0\b',s)))
 logfacts.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'tests':count,'pass':count,'fail':0,'scope':'Provided local run log; not independently rerun or hosted evidence'})
alllog=Path('/private/tmp/canlang-final-test-all.log'); alltext=alllog.read_text()
nodepasses=[int(n) for n in re.findall(r'ℹ pass (\d+)',alltext)]; rootpasses=int(re.search(r'Tests\s+(\d+) passed',alltext).group(1))
check('Provided local complete suites report5541 passing zero skips',sum(nodepasses)+rootpasses==5541 and len(nodepasses)==11 and not re.search(r'ℹ (?:fail|skipped) [1-9]',alltext) and '38 successful, 38 total' in alltext)
logfacts.append({'path':str(alllog),'sha256':hashlib.sha256(alllog.read_bytes()).hexdigest(),'pass':5541,'scope':'Provided local log; not independently rerun or hosted evidence'})
for filename,tasks in [('typecheck',40),('e2e-types',27)]:
 p=Path(f'/private/tmp/canlang-final-{filename}.log');check(f'Provided local {filename} log complete {tasks}tasks',f'{tasks} successful, {tasks} total' in p.read_text());logfacts.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'successfulTasks':tasks,'scope':'Provided local log; no browser journey claim'})
files=[*Path('.github/workflows').glob('*.yml'),*Path('.github/ci').glob('*.mjs'),Path('package.json'),Path('turbo.json'),Path('bun.lock'),Path('bunfig.toml'),*Path('packages').glob('*/package.json'),Path('scripts/run-tasks.mjs'),Path('scripts/pack-release.mjs')]
(out/'sourcepins.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)},indent=2)+'\n')
(out/'static-report.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'units':sorted(unit),'providedLocalLogs':logfacts,'scope':'Independent static wiring and actual dry-run graph review; no builds, live suites or hosted CI executed.'},indent=2)+'\n')
print(len(checks),'static checks passed')
