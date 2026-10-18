// File-backed SDK arguments/results. Native code owns their lifetime.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,writeFile,unlink} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
export const PROTOCOL='can.dev.runtime.v1', MAX_FRAME=64*1024;
const MAX_FILE=32*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function readReference(ref){
  if(!ref||typeof ref.path!=='string'||!isAbsolute(ref.path)||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>MAX_FILE||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('invalid private file reference');
  if(await realpath(ref.path)!==ref.path)throw Error('private file alias refused');
  const fd=await open(ref.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await fd.stat();
    if(!before.isFile()||before.uid!==process.getuid()||(before.mode&0o077)!==0||before.size!==ref.bytes)throw Error('private file ownership refused');
    const bytes=await fd.readFile(),after=await fd.stat();
    if(after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.size!==before.size||bytes.length!==ref.bytes||digest(bytes)!==ref.sha256)throw Error('private file changed');
    return bytes;
  }finally{await fd.close();}
}
export class Outputs{
  #files=new Map();#bytes=0;#sequence=0;
  constructor(directory){this.directory=directory;}
  async json(value){
    const bytes=Buffer.from(JSON.stringify(value));
    if(bytes.length>MAX_FILE||this.#files.size>=128||this.#bytes+bytes.length>128*1024*1024)throw Error('SDK result spool limit');
    const path=join(this.directory,`${this.#sequence++}.json`);
    await writeFile(path,bytes,{flag:'wx',mode:0o600});
    const ref={path,bytes:bytes.length,sha256:digest(bytes)};this.#files.set(path,ref);this.#bytes+=bytes.length;return ref;
  }
  async consume(refs){
    if(!Array.isArray(refs)||refs.length>128)throw Error('invalid output acknowledgment');
    for(const ref of refs){
      if(dirname(ref.path)!==this.directory)throw Error('foreign output acknowledgment');
      const known=this.#files.get(ref.path);
      if(!known){try{await readReference(ref);}catch(e){if(e.code==='ENOENT')continue;throw e;}throw Error('unknown output acknowledgment');}
      if(known.bytes!==ref.bytes||known.sha256!==ref.sha256)throw Error('output identity mismatch');
      await readReference(ref);await unlink(ref.path);this.#files.delete(ref.path);this.#bytes-=known.bytes;
    }
    return {consumed:true};
  }
}
export function request(frame,session){
  if(frame.length>MAX_FRAME)throw Error('SDK frame limit');
  const value=JSON.parse(frame.toString('utf8'));
  if(value.protocol!==PROTOCOL||value.sessionId!==session||typeof value.command!=='string'||typeof value.operationId!=='string'||value.operationId.length>256||!(value.generationId===null||typeof value.generationId==='string')||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload))throw Error('invalid SDK request');
  return value;
}
