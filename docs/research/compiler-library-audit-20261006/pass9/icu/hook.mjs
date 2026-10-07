import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root='/private/tmp/canlang-pass9-icu/pinned';
registerHooks({resolve(spec,ctx,next){
 if(spec==='@canlang/values')return {url:pathToFileURL(root+'/packages/values/src/index.ts').href,shortCircuit:true};
 if(spec==='@canlang/contracts/values')return {url:pathToFileURL(root+'/packages/contracts/src/values.ts').href,shortCircuit:true};
 if(spec.startsWith('.')&&spec.endsWith('.js')&&ctx.parentURL?.startsWith(pathToFileURL(root+'/').href)){const url=new URL(spec.slice(0,-3)+'.ts',ctx.parentURL);if(existsSync(fileURLToPath(url)))return {url:url.href,shortCircuit:true};}
 return next(spec,ctx);
}});
