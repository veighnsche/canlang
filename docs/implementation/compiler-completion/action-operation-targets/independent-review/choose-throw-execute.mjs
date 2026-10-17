import assert from "node:assert/strict";
import {canApp} from "./generated/$can$m$54.mjs";
const registry=canApp();
const c={memberships:["members"],actor:{id:"actor"}};
await assert.rejects(()=>registry["T.predicate"](c,{}), /Division by zero/);
const result=await registry["T.descriptors"](c,{});
assert.equal(result.target,"T.mutate");
console.log("Predicate control throws Division by zero; the same predicate inside constructor target is erased and returns a descriptor.");
