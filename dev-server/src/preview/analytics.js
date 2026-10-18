import workers from 'cloudflare-internal:workers';
export default env => ({ writeDataPoint(point = {}) {
  if (point === null || typeof point !== 'object' || Array.isArray(point)) throw new TypeError('analytics point must be an object');
  function values(name, limit) { const value=point[name]??[]; if(!Array.isArray(value)||value.length>limit)throw new TypeError('invalid analytics '+name);return value; }
  function bytes(value) { if(value===null||typeof value==='string')return value;if(value instanceof ArrayBuffer)return Array.from(new Uint8Array(value));throw new TypeError('analytics index/blob must be a string, ArrayBuffer or null'); }
  const indexes=values('indexes',1).map(bytes),blobs=values('blobs',20).map(bytes),doubles=values('doubles',20);
  if(doubles.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new TypeError('analytics doubles must be finite numbers');
  const size=value=>value===null?0:typeof value==='string'?new TextEncoder().encode(value).byteLength:value.length;
  if(indexes.some(value=>size(value)>96)||blobs.reduce((sum,value)=>sum+size(value),0)>16384)throw new RangeError('analytics point exceeds byte limits');
  workers.waitUntil(env.CAN_ANALYTICS_SINK.fetch(new Request('https://can-local-analytics/',{method:'POST',body:JSON.stringify({point:{indexes,blobs,doubles}}),headers:{'content-type':'application/json','x-dataset':env.dataset,'x-worker':env.workerName}})).then(response=>{if(!response.ok)throw new Error('local analytics sink refused the event');}));
} });
