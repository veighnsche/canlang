import argparse, subprocess, tempfile, time, statistics, json, hashlib
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('root',type=Path); parser.add_argument('profile',type=Path);args=parser.parse_args()
p=args.profile
catalog=args.root/'packages/values/dist/catalog.json'
source_text='app Shop\nGiven\n Gadget { title:text }\nWhen\nThen\n'
results={'old':[],'new':[]}
binaries={'old':p/'artifacts/baseline-native-can','new':p/'artifacts/current-native-can'}
with tempfile.TemporaryDirectory(prefix='can-pass6-cli-') as directory:
 source=Path(directory)/'source.can';source.write_text(source_text)
 commands={name:[str(binary),'check','--format=json','--catalog',str(catalog),str(source)] for name,binary in binaries.items()}
 def once(name):
  start=time.perf_counter_ns(); out=subprocess.run(commands[name],cwd=directory,capture_output=True,check=True);elapsed=(time.perf_counter_ns()-start)/1e6
  value=json.loads(out.stdout);assert value['complete'] is True and value['diagnostics']==[]
  return elapsed
 for name in binaries:
  for _ in range(3): once(name)
 for n in range(40):
  for name in (['old','new'] if n%2==0 else ['new','old']):results[name].append(once(name))
medians={name:statistics.median(times) for name,times in results.items()}
report={'method':'fresh actual release CLI subprocess per sample; complete=true diagnostics=[] independent Python JSON assertions; 3 warmups each, 40 alternating rounds, after own builds completed; host not globally isolated','catalog_sha256':hashlib.sha256(catalog.read_bytes()).hexdigest(),'source_text':source_text,'source_sha256':hashlib.sha256(source_text.encode()).hexdigest(),'milliseconds':results,'median_ms':medians,'ratio_new_over_old':medians['new']/medians['old'],'command_patterns':{name:command[:-1]+['<temp-source.can>'] for name,command in commands.items()}}
(p/'cli-cost.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'median_ms':medians,'ratio':report['ratio_new_over_old']}))
