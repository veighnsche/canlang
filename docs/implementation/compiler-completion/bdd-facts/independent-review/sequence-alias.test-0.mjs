// Test-only example artifact: erased from production bundles.
export function exampleFixtures({self,other,imported}){
return {fixtures:{},examples:[{operation:"SequenceAlias.echo",dependencies:[],sequence:[{let:"word",value:async(c,s,b)=>("A")},{operation:"SequenceAlias.echo",by:async(c,s,b)=>(self),inputs:async(c,s,b)=>({value:b.word})},{observations:async(c,s,b)=>([await (($can$a$30)=>$can$s$50726f76696465722e74616b65(c,$can$a$30[1],$can$a$30[0]))(["B",b.word])]),expected:async(c,s,b)=>(["A|B"]),types:["text"]}]}]};
}
