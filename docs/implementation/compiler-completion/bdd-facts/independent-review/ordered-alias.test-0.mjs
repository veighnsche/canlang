// Test-only example artifact: erased from production bundles.
import { starts_with } from "@canlang/stdlib";
export function exampleFixtures({self,other,imported}){
return {fixtures:{},examples:[{operation:"Ordered.echo",dependencies:[],inputs:async(c,s)=>({}),selectors:["value"],observations:[async(c,s)=>(($can$a$30)=>starts_with($can$a$30[1],$can$a$30[0]))([value.left,value.right]),async(c,s)=>await (($can$a$31)=>$can$s$50726f76696465722e74616b65(c,$can$a$31[1],$can$a$31[0]))([value.right,value.left])],rows:[{dependencies:[],values:async(c,s)=>([{left:"A",right:"AB"}]),expected:async(c,s)=>([true,"A|AB"])}]}]};
}
