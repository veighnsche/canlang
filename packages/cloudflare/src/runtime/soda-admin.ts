/** Stopped, private Worker administration. No public application route imports it. */
import { bootstrapD1Owner, bootstrapD1SetupOwner, addD1TeamMember } from '@canlang/identity';
import type {D1OwnerSetupInput} from '@canlang/identity';
import type { D1Database } from '@cloudflare/workers-types';

export default {
  async fetch(request:Request,env:{DB:D1Database}):Promise<Response> {
    if(request.method!=='POST')return new Response(null,{status:404});
    try{
      let bytes=0;const parts:ArrayBuffer[]=[];
      for await(const part of request.body??[]){bytes+=part.byteLength;if(bytes>65536)throw new Error('bounded admin body');parts.push(new Uint8Array(part).buffer);}
      const secret=JSON.parse(await new Blob(parts).text()) as {email:string;password:string;timezone?:string;teamId?:string;setup?:D1OwnerSetupInput};
      const path=new URL(request.url).pathname;
      if(path==='/bootstrap')return Response.json(await bootstrapD1Owner(env.DB,secret));
      if(path==='/setup' && secret.setup!==undefined)return Response.json(await bootstrapD1SetupOwner(env.DB,secret,secret.setup));
      if(path==='/member' && typeof secret.teamId==='string')return Response.json(await addD1TeamMember(env.DB,{...secret,teamId:secret.teamId}));
      return new Response(null,{status:404});
    }catch{return Response.json({error:'identity administration failed; check private credentials and Identity storage'},{status:400});}
  },
};
