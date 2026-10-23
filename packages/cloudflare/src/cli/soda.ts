#!/usr/bin/env node
/** Project tool entry; the production command has its own runtime-only graph. */
const argv=process.argv.slice(2);
if(argv[0]==='build'){
  try{await (await import('./soda-build.js')).build(argv);}catch(error){console.error('can-soda: '+(error instanceof Error?error.message:'build failed'));process.exitCode=1;}
}else{await import('./soda-runtime.js');}
