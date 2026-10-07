// Test-only example artifact: erased from production bundles.
export function exampleFixtures({self,other,imported}){
return {fixtures:{},examples:[{operation:"ResultOnly.echo",dependencies:[],inputs:async(c,s)=>({value:"HI"}),selectors:["value"],observations:[async(c,s)=>result],rows:[{dependencies:[],values:async(c,s)=>(["HI"]),expected:async(c,s)=>(["HI"])}]},{operation:"ResultOnly.echo",dependencies:[],sequence:[{operation:"ResultOnly.echo",by:async(c,s,b)=>(self),inputs:async(c,s,b)=>({value:"HI"})},{observations:async(c,s,b)=>([result]),expected:async(c,s,b)=>(["HI"]),types:["text"]}]}]};
}
