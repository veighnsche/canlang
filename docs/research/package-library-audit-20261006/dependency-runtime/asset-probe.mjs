import { gatherDeploymentAssets,gatherBrowserAssets } from '@canlang/cloudflare/deploy/package-assets';
const scenario=process.argv[2];
try{
 const r=scenario==='packed-good'?gatherDeploymentAssets({browser:true,valuesWasm:true}):gatherBrowserAssets(new URL(`./${scenario}/`,import.meta.url));
 console.log(JSON.stringify({scenario,status:'gathered',modules:Object.keys(r.modules).length,binaries:Object.entries(r.binaries).map(([name,b])=>({name,bytes:b.length})),resources:Object.entries(r.resources).map(([name,r])=>({name,bytes:r.bytes.length,contentType:r.contentType}))}));
}catch(e){console.log(JSON.stringify({scenario,status:'refused',name:e.name,message:String(e.message).slice(0,900)}));process.exitCode=1;}
