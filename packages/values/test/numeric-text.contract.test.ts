import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeDate, makeMoney } from "../src/kinds.js";
import { round } from "../src/decimal.js";
import { decodeValue } from "../src/wire.js";

type Row = { inputBits: string; stringText: string; jsonTokenText: string };
type Caller = { id: string; operation: string; args: unknown[]; observation: unknown };
// Explicit override supports private staged output without mutating the package dist.
const file = process.env.CAN_NUMERIC_TEXT_FIXTURE ?? path.resolve(import.meta.dirname, "../../conformance/numeric-text.json");
const fixture = JSON.parse(readFileSync(file, "utf8")) as { numbers: Row[]; callers: Caller[] };
function number(bits: string): number {
  const v = new DataView(new ArrayBuffer(8)); v.setBigUint64(0, BigInt(`0x${bits}`), false); return v.getFloat64(0, false);
}
function bits(n: number): string {
  const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, n, false); return v.getBigUint64(0, false).toString(16).padStart(16,"0");
}
function argument(v: unknown): unknown {
  if (v && typeof v === "object") {
    if ("numberBits" in v) return number(String(v.numberBits));
    if ("bigint" in v) return BigInt(String(v.bigint));
    if ("invalidOperand" in v) return null;
  }
  return v;
}
function observation(run: () => unknown): unknown {
  try {
    const value=run() as Record<string,unknown>;
    return {outcome:"return",value:Object.fromEntries(Object.entries(value).map(([key,v])=>[key,typeof v==="bigint"?{bigint:String(v)}:typeof v==="number"?{numberBits:bits(v)}:v]))};
  } catch (error) {
    const e=error as Record<string,unknown>;
    const result: Record<string,unknown>={outcome:"throw",fields:["name","kind","code","message","violations"].map(key=>({key,present:key in e,...(key in e?{value:e[key]}:{})}))};
    if ("violations" in e) result.violationFields=(e.violations as Record<string,unknown>[]).map(v=>["path","code","message","expected","actual"].map(key=>({key,present:Object.hasOwn(v,key),...(Object.hasOwn(v,key)?{value:v[key]}:{})})));
    return result;
  }
}
test("immutable original-bit builtin bytes and owning caller envelopes",()=>{
  assert.equal(fixture.numbers.length,10213);
  for(const row of fixture.numbers){const n=number(row.inputBits);assert.equal(String(n),row.stringText);assert.equal(JSON.stringify(n),row.jsonTokenText);}
  for(const c of fixture.callers){const a=c.args.map(argument);const run=()=>c.operation==="date"?Reflect.apply(makeDate,undefined,a):c.operation==="round"?Reflect.apply(round,undefined,a):c.operation==="currency"?Reflect.apply(makeMoney,undefined,a):Reflect.apply(decodeValue,undefined,a);assert.deepEqual(observation(run),c.observation,c.id);}
});
test("error punctuation, field absence and violation ordering controls",()=>{
  const error=fixture.callers.find(c=>c.operation==="decode")!;
  const changed=structuredClone(error.observation) as {fields:{key:string;present:boolean;value?:unknown}[]};
  const message=changed.fields.find(f=>f.key==="message")!;message.value=String(message.value)+".";assert.notDeepEqual(changed,error.observation);
  const code=changed.fields.find(f=>f.key==="code")!;code.present=true;code.value=null;assert.notDeepEqual(changed,error.observation);
});
