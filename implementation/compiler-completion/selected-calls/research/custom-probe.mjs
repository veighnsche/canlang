import {writeFileSync} from 'node:fs';
const observations=[];
for(const id of ['same-arity-later','same-arity-selected-order','same-arity-awaited']){
 try {const e=await import('./'+id+'.mjs'); observations.push({id,result:await e.canApp()['T.g']({})})}
 catch(e){observations.push({id,error:{name:e.name,code:e.code,message:e.message}})}
}
const reads=[];
const values={get a(){reads.push('a');return 'A'},get b(){reads.push('b');return 'AB'}};
const e=await import('./ordinary-eval-order.mjs');
const result=await e.canApp()['T.g']({},values);
observations.push({id:'ordinary-eval-order',expectedSourceReads:['a','b'],actualReads:reads,result,scope:'Direct production callable expression-order witness with getter-backed contract input; no generated-app admission claim and no facade mocking.'});
const failedReads=[];try{await e.canApp()['T.g']({},{get a(){failedReads.push('a');throw new Error('first')},get b(){failedReads.push('b');throw new Error('second')}})}catch(error){observations.push({id:'ordinary-eval-failure-order',expectedSourceReads:['a'],actualReads:failedReads,error:error.message,scope:'Same direct callable getter-input boundary.'})}
writeFileSync(new URL('./custom-runtime-observations.json',import.meta.url),JSON.stringify(observations,null,2)+'\n');
console.log(JSON.stringify(observations,null,2));
