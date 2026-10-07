// Narrow carrier/public-factory controls, not an authorized collection query.
import assert from 'node:assert/strict';
import {tabs, text, message} from '../../../../packages/ui/dist/src/index.js';

const context={appDefaultLocale:'en',preferredLocales:['en']};
const trace=[];
const caption=value=>{trace.push(`caption:${value}`);return message(value);};
const child=value=>{trace.push(`child:${value}`);return text({context,values:[message(value)]});};
const html=await tabs({context,id:'review-eager',items:[
  false?({value:'0',caption:caption('hidden'),children:[child('hidden')]}):null,
  ({value:'1',caption:caption('one'),children:[child('one')]}),
  ({value:'2',caption:caption('two'),children:[child('two')]})
].filter(item=>item!=null)});
assert.deepEqual(trace,['caption:one','child:one','caption:two','child:two']);
assert.ok(/value="1"[^>]* checked/.test(html));
assert.ok(html.includes('one') && html.includes('two'));
await assert.rejects(tabs({context,id:'review-empty',items:[]}),/nonempty tab-child suite/);

// Exact emitter suffix expression: JSON preserves ancestor boundaries, then
// percent encoding prevents whitespace/path punctuation from entering the id.
const suffix=path=>'review-site-'+encodeURIComponent(JSON.stringify(path));
const paths=[['a/b','c'],['a','b/c'],['outer one','same'],['outer two','same'],['x"','é'],['x','"é']];
const ids=paths.map(suffix);
assert.equal(new Set(ids).size,ids.length);
for(let i=0;i<paths.length;i++) {
 assert.deepEqual(JSON.parse(decodeURIComponent(ids[i].slice('review-site-'.length))),paths[i]);
 assert.ok(/^\S+$/.test(ids[i]));
}
const markup=await Promise.all(ids.map(id=>tabs({context,id,items:[{value:'0',caption:message('Same'),children:['row body']}]})));
const panelIds=markup.flatMap(html=>[...html.matchAll(/ id="([^"]+)"/g)].map(match=>match[1]));
assert.equal(new Set(panelIds).size,panelIds.length);
const names=markup.flatMap(html=>[...html.matchAll(/ name="([^"]+)"/g)].map(match=>match[1]));
assert.equal(new Set(names).size,names.length);
console.log(JSON.stringify({status:'passed',scope:'narrow carrier and actual public factory protocol; no query runner',checks:['caption/child eager initiation order once','false gate skips payload','first surviving value','all gated/empty fails closed','JSON ancestor path boundary and percent encoding','real factory radio/panel namespaces'],trace,ids},null,2));
