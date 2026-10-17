// n01 JS-only planning oracle v1; no repository imports, tests, Rust or builds.
const MASK = (1n << 64n) - 1n;
const SEED = 0x6a09e667f3bcc909n;
const dv = new DataView(new ArrayBuffer(8));
const hex = b => b.toString(16).padStart(16, '0');
const valueOf = b => { dv.setBigUint64(0,b,false); return dv.getFloat64(0,false); };
const bitsOf = n => { dv.setFloat64(0,n,false); return dv.getBigUint64(0,false); };
const classify = n => Number.isNaN(n) ? 'nan' : Number.isFinite(n) ? 'finite' : 'infinity';
const observe = (b,id) => { const n=valueOf(b); return {id,inputBits:hex(b),observedBits:hex(bitsOf(n)),isNegativeZero:Object.is(n,-0),classification:classify(n),stringText:String(n),jsonTokenText:JSON.stringify(n)}; };
let x=SEED;
const seen=new Set(), seeded=[];
while(seeded.length<10000) {
  x=(x ^ (x << 13n)) & MASK;
  x=(x ^ (x >> 7n)) & MASK;
  x=(x ^ (x << 17n)) & MASK;
  const h=hex(x);
  if(!seen.has(h)){seen.add(h);seeded.push(observe(x,`seed:${seeded.length}`));}
}
const fixed=new Map();
function add(b,id){b &= MASK;const h=hex(b);if(!fixed.has(h))fixed.set(h,{b,ids:[]});fixed.get(h).ids.push(id);}
const special=['0000000000000000','8000000000000000','0000000000000001','0000000000000002','000fffffffffffff','0010000000000000','0010000000000001','8000000000000001','8000000000000002','800fffffffffffff','8010000000000000','8010000000000001','7fefffffffffffff','7feffffffffffffe','ffefffffffffffff','ffeffffffffffffe','7ff0000000000000','fff0000000000000','7ff8000000000000','fff8000000000000','7ff8000000000001','fff8000000000001','7ff0000000000001','fff0000000000001','7fffffffffffffff','ffffffffffffffff'];
for(const h of special)add(BigInt('0x'+h),'special:'+h);
const anchors=[1,-1,0.1,-0.1,0.3,-0.3,1e-6,-1e-6,1e21,-1e21,1e20,-1e20,2**53,-(2**53),2**63,-(2**63),1000000000000000128,-1000000000000000128];
for(const e of [-324,-308,-7,-6,-5,-1,0,1,15,16,19,20,21,22,308])anchors.push(Number('1e'+e),-Number('1e'+e));
for(const e of [-1074,-1022,-53,-20,-1,0,1,20,52,53,54,62,63,64,69,70,71,1023])anchors.push(2**e,-(2**e));
for(const t of ['-9223372036854775809','-9223372036854775808','-9223372036854775807','9223372036854775806','9223372036854775807','9223372036854775808','9007199254740990','9007199254740991','9007199254740992','9007199254740993']) {const n=Number(t);add(bitsOf(n),'decimal-conversion:'+t);}
for(let i=0;i<anchors.length;i++){const b=bitsOf(anchors[i]);for(const off of [-1n,0n,1n])add(b+off,`anchor:${i}:bit-offset:${off}`);}
const boundaries=Array.from(fixed.values(),({b,ids})=>({...observe(b,ids[0]),ids}));
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
function scalarValid(s){for(let i=0;i<s.length;i++){const u=s.charCodeAt(i);if(u>=0xd800&&u<=0xdbff){if(++i>=s.length)return false;const v=s.charCodeAt(i);if(v<0xdc00||v>0xdfff)return false;}else if(u>=0xdc00&&u<=0xdfff)return false;}return true;}
function utf8Hex(s){if(!scalarValid(s))return null;return Array.from(new TextEncoder().encode(s),b=>b.toString(16).padStart(2,'0')).join('');}
const strings=[];
function stringCase(id,input,excludedReason=null){const q=JSON.stringify(input),tr=q.length>64?q.slice(0,64)+'...':q;const split=!scalarValid(tr);strings.push({id,inputUnits:units(input),inputUtf8Hex:utf8Hex(input),quotedUnits:units(q),quotedUtf8Hex:utf8Hex(q),actualWireUnits:units(tr),actualWireUtf8Hex:utf8Hex(tr),rustStrInputAdmitted:scalarValid(input),helperParityAdmitted:scalarValid(input),actualWireParityAdmitted:scalarValid(input)&&!split,excludedReason:excludedReason??(split?'64-unit-surrogate-split':null)});}
stringCase('empty','');
for(let u=0;u<32;u++){const c=String.fromCharCode(u);stringCase('c0:'+u,c);stringCase('c0-surrounded:'+u,'A'+c+'é😀Z');}
for(const [id,text] of [['quote','"'],['backslash','\\'],['slash','/'],['del','\u007f'],['c1','\u0080\u009f'],['separators','\u2028\u2029'],['bmp-boundaries','\ud7ff\ue000\uffff'],['astral-boundaries','\u{10000}\u{10ffff}'],['combining','e\u0301é'],['bom','\ufeff'],['emoji','😀🧑🏽‍🚀'],['all-c0',Array.from({length:32},(_,i)=>String.fromCharCode(i)).join('')]])stringCase(id,text);
for(const n of [61,62,63])stringCase('quoted-len:'+String(n+2),'a'.repeat(n));
for(const prefix of [61,62,63])stringCase('astral-cut:'+prefix,'a'.repeat(prefix)+'😀');
for(const n of [59,60,61])stringCase('short-escape-cut:'+n,'a'.repeat(n)+'\nZ');
for(const n of [55,56,57])stringCase('long-escape-cut:'+n,'a'.repeat(n)+'\u0000Z');
for(const [id,s] of [['lone-high','\ud800'],['lone-low','\udc00'],['reversed-pair','\udc00\ud800'],['unpaired-middle','\ud800A']])stringCase(id,s,'unpaired-JS-UTF16-input');
const out={schemaVersion:1,stage:'JS-only planning observations; no adapter/target acceptance',recipe:'n01.oracle.v1',seed:hex(SEED),algorithm:'xorshift64 left13 right7 left17 masked after each xor',engine:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch},seededDistinctCount:seeded.length,boundaryDistinctCount:boundaries.length,seeded,boundaries,strings};
process.stdout.write(JSON.stringify(out,null,2)+'\n');
