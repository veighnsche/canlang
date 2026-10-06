// Deliberate capture only: never regenerate expected data on a mismatch.
import { readFileSync } from 'node:fs';
export function observeNumber(inputBits) {
 const view = new DataView(new ArrayBuffer(8));
 view.setBigUint64(0, BigInt('0x' + inputBits), false);
 const n = view.getFloat64(0, false);
 const observed = new DataView(new ArrayBuffer(8)); observed.setFloat64(0, n, false);
 return {inputBits, observedBits:observed.getBigUint64(0,false).toString(16).padStart(16,'0'), stringText:String(n), jsonTokenText:JSON.stringify(n)};
}
if (process.argv[2]) console.log(JSON.stringify({engine:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch},numbers:JSON.parse(readFileSync(process.argv[2],'utf8')).map(observeNumber)}));
