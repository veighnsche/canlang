import * as v from '/private/tmp/canlang-roadmap-f1-db57c379/packages/values/dist/src/index.js';
const base=v.makeUserRef('actor-one');
const extended=Object.freeze({...base,email:'actor@example.test',email_verified:true});
const member=v.makeMemberRef('member-one',extended,'team-one');
const attemptedDecode = wire => {try{return {ok:true,value:v.decodeValue('user',wire)}}catch(e){return {ok:false,name:e.name,code:e.code,message:e.message}}};
console.log(JSON.stringify({scope:'public frozen Values APIs and standard JS only; hypothetical ordinary enumerable extended user object, no adopted actor carrier',factory:base,factoryKeys:Object.keys(base),extendedRecognized:v.isUserRef(extended),identityEqual:v.same(base,extended),typedUserWire:v.encodeValue('user',extended),decodeIdOnly:attemptedDecode({id:base.id}),decodeExtraFacts:attemptedDecode({id:base.id,email:extended.email,email_verified:true}),memberCopiedUserKeys:Object.keys(member.user),memberRawJSON:JSON.stringify(member),typedMemberWire:v.encodeValue('member',member),extendedRawJSON:JSON.stringify(extended),extendedStructuredClone:structuredClone(extended)},null,2));
