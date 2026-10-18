// File-backed SDK arguments/results. Native code owns their lifetime.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,lstat,unlink} from 'node:fs/promises';
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
    const buffer=Buffer.alloc(ref.bytes+1);let length=0;
    while(length<buffer.length){const read=await fd.read(buffer,length,buffer.length-length);if(read.bytesRead===0)break;length+=read.bytesRead;}
    const after=await fd.stat(),current=await lstat(ref.path),bytes=buffer.subarray(0,length);
    if(after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.size!==before.size||current.dev!==before.dev||current.ino!==before.ino||length!==ref.bytes||digest(bytes)!==ref.sha256||await realpath(ref.path)!==ref.path)throw Error('private file changed');
    return bytes;
  }finally{await fd.close();}
}
export class Outputs{
  #files=new Map();#bytes=0;#sequence=0;#reserved=0;
  constructor(directory){this.directory=directory;}
  async json(value,operationId,generationId){
    const bytes=Buffer.from(JSON.stringify(value));
    if(bytes.length>MAX_FILE||this.#files.size+this.#reserved>=128||this.#bytes+bytes.length>128*1024*1024)throw Error('SDK result spool limit');
    const path=join(this.directory,`${this.#sequence++}.json`);
    this.#reserved++;this.#bytes+=bytes.length;
    let fd,created=false;
    try{
      fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
      await fd.writeFile(bytes);await fd.close();fd=undefined;
      const ref={path,bytes:bytes.length,sha256:digest(bytes)};this.#files.set(path,{...ref,operationId,generationId});return ref;
    }catch(error){this.#bytes-=bytes.length;if(fd)await fd.close().catch(()=>{});if(created)await unlink(path).catch(()=>{});throw error;}
    finally{this.#reserved--;}
  }
  async discard(operationId,generationId){
    const refs=[...this.#files.values()].filter(ref=>ref.operationId===operationId&&ref.generationId===generationId).map(({path,bytes,sha256})=>({path,bytes,sha256}));
    if(refs.length)await this.consume(refs);
  }
  async consume(refs){
    if(!Array.isArray(refs)||refs.length>128)throw Error('invalid output acknowledgment');
    for(const ref of refs){
      if(dirname(ref.path)!==this.directory)throw Error('foreign output acknowledgment');
      const known=this.#files.get(ref.path);
      if(!known){try{await readReference(ref);}catch(e){if(e.code==='ENOENT')continue;throw e;}throw Error('unknown output acknowledgment');}
      if(known.bytes!==ref.bytes||known.sha256!==ref.sha256)throw Error('output identity mismatch');
      await readReference(ref);await unlink(ref.path).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(this.#files.delete(ref.path))this.#bytes-=known.bytes;
    }
    return {consumed:true};
  }
}
export function request(frame,session){
  if(frame.length>MAX_FRAME)throw Error('SDK frame limit');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame));
  const id=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u0020]/.test(value);
  if(value.protocol!==PROTOCOL||value.sessionId!==session||!id(value.command,96)||!id(value.operationId,256)||!(value.generationId===null||id(value.generationId,512))||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload))throw Error('invalid SDK request');
  return value;
}
