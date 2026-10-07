import pathlib,json,hashlib,subprocess,tomllib
root=pathlib.Path('/Users/vince/Projects/canlang');out=root/'docs/research/compiler-library-audit-20261006/pass9/cli';reg=pathlib.Path.home()/'.cargo/registry';src=next((reg/'src').iterdir());cache=next((reg/'cache').iterdir());lock=tomllib.loads((out/'candidate-Cargo.lock').read_text())
pins={'host':subprocess.check_output(['uname','-sm'],text=True).strip(),'rustc':subprocess.check_output(['rustc','-Vv'],text=True),'inputs':{},'dependencies':[],'features':{'clap':['std','help','usage','error-context','string'],'clap_complete':[]},'default_features':False,'build_profile':'dev unoptimized + debuginfo, CARGO_INCREMENTAL=0, cargo --offline -j1, shared target /private/tmp/canlang-pass5-profile/current-native-target'}
for p in ['compiler/src/cli.rs','compiler/can-completions.bash','compiler/can-completions.zsh','compiler/can-completions.fish','compiler/tests/exe.rs','docs/install.md','packages/cloudflare/src/cli/platform.ts','packages/cloudflare/src/preparation/host.ts','compiler/src/lib.rs','compiler/src/main.rs']:
 pins['inputs'][p]=hashlib.sha256((root/p).read_bytes()).hexdigest()
for p in lock['package']:
 if 'checksum' not in p:continue
 archive=cache/f"{p['name']}-{p['version']}.crate";package=src/f"{p['name']}-{p['version']}";rs=list(package.rglob('*.rs'));pins['dependencies'].append({'name':p['name'],'version':p['version'],'registry_checksum':p['checksum'],'actual_archive_sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'archive_bytes':archive.stat().st_size,'rust_source_bytes':sum(x.stat().st_size for x in rs)})
pins['primary_api_refs']=['https://docs.rs/clap/4.6.7/clap/struct.Command.html','https://docs.rs/clap/4.6.7/clap/struct.Arg.html','https://docs.rs/clap_complete/4.6.7/clap_complete/aot/fn.generate.html']
(out/'pins.json').write_text(json.dumps(pins,indent=2)+'\n')
print(json.dumps(pins['dependencies'],indent=2))
