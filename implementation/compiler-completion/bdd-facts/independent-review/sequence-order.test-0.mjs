// Test-only example artifact: erased from production bundles.
import { starts_with } from "@canlang/stdlib";
export function exampleFixtures({self,other,imported}){
return {fixtures:{},examples:[{operation:"SequenceOrder.echo",dependencies:[],sequence:[{let:"box",value:async(c,s,b)=>({left:"A",right:"AB"})},{operation:"SequenceOrder.echo",by:async(c,s,b)=>(self),inputs:async(c,s,b)=>({value:b.box})},{observations:async(c,s,b)=>([(($can$a$30)=>starts_with($can$a$30[1],$can$a$30[0]))([b.box.left,b.box.right]),false && (($can$a$31)=>starts_with($can$a$31[1],$can$a$31[0]))([b.box.left,b.box.right])]),expected:async(c,s,b)=>([true,false]),types:["bool","bool"]}]}]};
}
