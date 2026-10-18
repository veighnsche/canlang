import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startSodaWorker } from "./soda-workerd.js";

test("Soda SDK transport preserves origin, strips its private credential and retains D1 across owned restarts", async()=>{
  const directory=await mkdtemp(join(tmpdir(),"can-soda-sdk-"));
  const d1Persist=join(directory,"d1"); await mkdir(d1Persist,{mode:0o700});
  const options={workerName:`soda-test-${randomUUID()}`,compatibilityDate:"2026-07-15",d1Persist,
    d1Databases:[{binding:"DB",id:"retained-identity"}],mainModule:"main.js",modules:{"main.js":`
export default {async fetch(request,env){
 return Response.json({url:request.url,privateHeader:request.headers.get('x-soda-dispatch'),
 count:(await env.DB.prepare('SELECT COUNT(*) AS count FROM saved').first()).count});
}};`}};
  let worker:Awaited<ReturnType<typeof startSodaWorker>>|undefined;
  try{
    worker=await startSodaWorker(options);
    const db=await worker.getD1Database("DB");
    await db.prepare("CREATE TABLE saved(value TEXT NOT NULL)").run();
    await db.prepare("INSERT INTO saved(value) VALUES (?)").bind("retained").run();
    assert.deepEqual(await(await worker.dispatchUrl("https://soda.example.test/actual/path")).json(),
      {url:"https://soda.example.test/actual/path",privateHeader:null,count:1});
    await worker.dispose(); worker=undefined;
    worker=await startSodaWorker(options);
    assert.equal((await(await worker.dispatchUrl("https://soda.example.test/")).json() as {count:number}).count,1);
  }finally{await worker?.dispose();await rm(directory,{recursive:true,force:true});}
});
