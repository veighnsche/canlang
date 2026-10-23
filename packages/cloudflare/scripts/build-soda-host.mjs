/** Produce static Worker/admin bytes and the native exec guard before packaging. */
import {buildSync} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {chmodSync,copyFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('../..');
const output=resolve('dist/host');
mkdirSync(output,{recursive:true});
buildSync({entryPoints:['src/runtime/soda-admin.ts'],outfile:resolve(output,'soda-admin.worker.js'),
  bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],target:'es2022'});
const target=process.env.CARGO_TARGET_DIR??resolve(root,'host/target');
execFileSync('cargo',['build','--locked','--release','--manifest-path',resolve(root,'host/Cargo.toml')],
  {env:{...process.env,CARGO_TARGET_DIR:target},stdio:'inherit'});
copyFileSync(resolve(target,'release/can-workerd-exec'),resolve(output,'can-workerd-exec'));
chmodSync(resolve(output,'can-workerd-exec'),0o755);
