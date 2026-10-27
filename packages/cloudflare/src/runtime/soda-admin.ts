/** Stopped, private Worker administration. No public application route imports it. */
import { bootstrapD1Owner, bootstrapD1SetupOwner, addD1TeamMember, readD1SetupReceipt, IdentityError } from '@canlang/identity';
import type {D1OwnerSetupInput, D1SetupReceiptQuery} from '@canlang/identity';
import type { D1Database } from '@cloudflare/workers-types';

export default {
  async fetch(request:Request,env:{DB:D1Database}):Promise<Response> {
    if(request.method!=='POST')return new Response(null,{status:404});
    try{
      let bytes=0;const parts:ArrayBuffer[]=[];
      for await(const part of request.body??[]){bytes+=part.byteLength;if(bytes>65536)throw new Error('bounded admin body');parts.push(new Uint8Array(part).buffer);}
      const secret=JSON.parse(await new Blob(parts).text()) as {email:string;password:string;timezone?:string;teamId?:string;setup?:D1OwnerSetupInput;receipt?:D1SetupReceiptQuery};
      const path=new URL(request.url).pathname;
      if(path==='/bootstrap')return Response.json(await bootstrapD1Owner(env.DB,secret));
      if(path==='/setup' && secret.setup!==undefined)return Response.json(await bootstrapD1SetupOwner(env.DB,secret,secret.setup));
      if(path==='/member' && typeof secret.teamId==='string')return Response.json(await addD1TeamMember(env.DB,{...secret,teamId:secret.teamId}));
      // Receipt reconstruction is structurally separated from admission: this
      // route reaches only the read-only inspection above — no owner-creation
      // and no claim-rewrite primitive is callable from it. It takes no
      // credentials and applies no expiry gate; the caller re-derives proof
      // from retained artifacts and validates the returned completion.
      if(path==='/setup/receipt' && typeof secret.receipt==='object' && secret.receipt!==null){
        try{return Response.json(await readD1SetupReceipt(env.DB,secret.receipt));}
        catch(error){
          if(error instanceof IdentityError && error.code==='not_found')
            return Response.json({error:'Setup receipt has no committed claim.'},{status:404});
          return Response.json({error:'Setup reconciliation refused.'},{status:409});
        }
      }
      return new Response(null,{status:404});
    }catch{return Response.json({error:'identity administration failed; check private credentials and Identity storage'},{status:400});}
  },
};
