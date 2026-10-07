// Node >=24 native TypeScript stripping. Resolve source-local .js imports to
// owning .ts files, and the pinned cached codec without editing node_modules.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'requires Node 24 native TS stripping');
const [root, payloadPath, artifactPath, sourcePath, codecPath] = process.argv.slice(2);
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@jridgewell/sourcemap-codec') return {url:pathToFileURL(codecPath).href, shortCircuit:true};
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const candidate = new URL(specifier.slice(0,-3)+'.ts', context.parentURL);
    if (existsSync(candidate)) return {url:candidate.href, shortCircuit:true};
  }
  return next(specifier, context);
}});
const runtime = join(root, 'packages/cloudflare/src/runtime');
const {lookup} = await import(pathToFileURL(join(runtime,'sourcemap.ts')));
const {invokeCallable} = await import(pathToFileURL(join(runtime,'invoke.ts')));
const {parseArtifactText,loadArtifactFile} = await import(pathToFileURL(join(runtime,'artifact.ts')));
const {formatFailureLocation} = await import(pathToFileURL(join(root,'packages/testkit/src/reporting/report.ts')));
const codecPackage = JSON.parse(readFileSync(join(dirname(dirname(codecPath)), 'package.json'),'utf8'));
assert.equal(codecPackage.version,'1.6.0');
// Arithmetic decoder has no dependency on Rust or the consumer codec. Expected
// tuples below are authored from immutable text bytes, never codec round trips.
function independent(mappings) {
  if (!mappings) return [];
  const abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let source=0,line=0,column=0,name=0;
  return mappings.split(';').map(row=> {
    let generated=0;
    return row ? row.split(',').map(segment=> {
      const fields=[]; let value=0,shift=0;
      for (const character of segment) {
        const digit=abc.indexOf(character); assert.ok(digit>=0);
        value+=(digit%32)*2**shift;
        if (digit<32) { fields.push(value%2 ? -Math.floor(value/2) : Math.floor(value/2)); value=0;shift=0; }
        else shift+=5;
      }
      assert.equal(shift,0); assert.ok([1,4,5].includes(fields.length));
      generated+=fields[0];
      if(fields.length===1) return [generated];
      source+=fields[1];line+=fields[2];column+=fields[3];
      const decoded=[generated,source,line,column];
      if(fields.length===5) {name+=fields[4];decoded.push(name);}
      return decoded;
    }) : [];
  });
}
const maps=JSON.parse(readFileSync(payloadPath,'utf8'));
const expectedCoordinates=[[0,0,0,0],[0,0,0,2],[0,0,0,6],[0,0,0,7],[0,0,0,7],[0,0,1,0],[0,0,1,6],[0,0,1,7],[0,0,1,7],[0,0,2,0]];
assert.deepEqual(independent(maps.coordinate.mappings),expectedCoordinates.map(segment=>[segment]));
assert.deepEqual(maps.coordinate.sources,['coordinate.can','coordinate.can','empty.can']);
assert.deepEqual(maps.coordinate.sourcesContent,['é😀x\r\né😀y\r\n','second\r\né😀z','']);
assert.deepEqual(maps.coordinate.names,[]);
assert.deepEqual(Object.keys(maps.coordinate),['version','file','sources','sourcesContent','names','mappings']);
const snapshots=[[0,1,1,6,0],[0,0,0,6,1],[0,1,0,0,0],[0,2,0,0,1],[0],[0,0,1,0]];
assert.deepEqual(independent(maps.snapshots.mappings),snapshots.map(segment=>[segment]));
assert.deepEqual(maps.snapshots.names,['repeat','','missing']);
for (const [index,segment] of expectedCoordinates.entries()) {
  for(const generatedColumn of [0,17]) assert.deepEqual(lookup(maps.coordinate,index+1,generatedColumn),{source:'coordinate.can',line:segment[2]+1,column:segment[3]+1});
}
for(const [index,segment] of snapshots.entries()) {
  const actual=lookup(maps.snapshots,index+1,0);
  if(segment.length===1) assert.equal(actual,null); // semantic unmapped, never the former bogus 4-field point
  else assert.deepEqual(actual,{source:maps.snapshots.sources[segment[1]],line:segment[2]+1,column:segment[3]+1,...(segment.length===5?{name:maps.snapshots.names[segment[4]]}:{})});
}
assert.deepEqual(independent(maps.empty.mappings),[]);
assert.equal(lookup(maps.empty,1,0),null);
assert.equal(lookup(maps.coordinate,11,0),null);
assert.equal(lookup({...maps.coordinate,mappings:';A;'},1,0),null);
assert.equal(lookup({...maps.coordinate,mappings:';A;'},2,0),null);
// Narrow public-JsWriter raw-span witness. The JS is intentionally synthetic;
// it exercises the real generated-frame invoke branch and report formatting,
// not the complete Can frontend or browser UTF16 source navigation.
const dir=dirname(payloadPath), modulePath=join(dir,'witness.mjs');
const js='export function canApp(){return {boom};}\nfunction boom(){\nthrow new Error("coordinate failure");\n}\n';
writeFileSync(modulePath,js);
const artifact={artifact_version:1,language_version:'1',tool_version:'synthetic-byte-witness',sources:[],modules:[{path:'witness.mjs',js,map:maps.coordinate}],callables:[{id:'boom',kind:'operation',module:'witness.mjs',export:'boom',member:['boom']}],pages:[],requires:[],tests:[]};
const assembly={dir,entryUrl:pathToFileURL(modulePath).href,moduleUrls:{'witness.mjs':pathToFileURL(modulePath).href},sourceMaps:{'witness.mjs':maps.coordinate}};
const invoked=await invokeCallable(assembly,artifact,'boom',{});
assert.equal(invoked.ok,false);
assert.equal(invoked.error,'coordinate failure');
assert.deepEqual(invoked.mapped,{source:'coordinate.can',line:1,column:7});
assert.equal(formatFailureLocation(invoked.mapped),'coordinate.can:1:7');
// Separate actual frontend witness: fresh CLI bytes enter the actual current
// loader then mapper unchanged. Coordinates are computed directly from source
// bytes with the declared CRLF alias, not from the Rust encoder or LineIndex.
const fresh=parseArtifactText(readFileSync(artifactPath,'utf8'),artifactPath).artifact;
assert.deepEqual(loadArtifactFile(artifactPath).artifact,fresh);
const sourceBytes=readFileSync(sourcePath);
assert.equal(fresh.sources[0].path,sourcePath);
assert.equal(fresh.sources[0].sha256,createHash('sha256').update(sourceBytes).digest('hex'));
const sourceText=sourceBytes.toString('utf8');
const lineStarts=[0]; for(let i=0;i<sourceBytes.length;i++) if(sourceBytes[i]===10) lineStarts.push(i+1);
const validPoints=new Set();
for(let offset=0;offset<=sourceBytes.length;offset++) {
  let line=0;while(line+1<lineStarts.length&&lineStarts[line+1]<=offset) line++;
  let column=offset-lineStarts[line];
  if(offset>0&&sourceBytes[offset-1]===13&&sourceBytes[offset]===10) column--;
  validPoints.add(`${line}:${column}`);
}
assert.equal(fresh.modules.length,1);
assert.equal(fresh.modules[0].path,'shop.mjs');
// Fixed frontend ownership anchors for this authored CRLF fixture. The CRUD
// declaration's generated export remains attributed to the existing When span
// (line5, column5); app scaffolding remains attributed to app byte zero.
assert.deepEqual(lookup(fresh.modules[0].map,1,0),{source:sourcePath,line:1,column:1});
assert.deepEqual(lookup(fresh.modules[0].map,3,0),{source:sourcePath,line:5,column:5,name:'Shop.Gadget.create'});
assert.deepEqual(lookup(fresh.modules[0].map,6,0),{source:sourcePath,line:1,column:1,name:'appDefinition'});
let points=0;
for(const module of fresh.modules) {
  assert.deepEqual(Object.keys(module.map),['version','file','sources','sourcesContent','names','mappings']);
  assert.equal(module.map.file,module.path);
  assert.deepEqual(module.map.sources,[sourcePath]);
  assert.deepEqual(module.map.sourcesContent,[sourceText]);
  const decoded=independent(module.map.mappings);
  assert.equal(decoded.length,module.js.split('\n').length-1,'each emitted JS line has a mapping row');
  for(const [line,segments] of decoded.entries()) {
    assert.equal(segments.length,1); const segment=segments[0];assert.equal(segment[0],0);
    assert.equal(segment[1],0);assert.ok(validPoints.has(`${segment[2]}:${segment[3]}`));
    const actual=lookup(module.map,line+1,0);
    assert.equal(actual.source,sourcePath);assert.equal(actual.line,segment[2]+1);assert.equal(actual.column,segment[3]+1);
    points++;
  }
}
const sourcePins=Object.fromEntries(['sourcemap.ts','invoke.ts','artifact.ts','context.ts'].map(name=>[name,createHash('sha256').update(readFileSync(join(runtime,name))).digest('hex')]));
sourcePins['report.ts']=createHash('sha256').update(readFileSync(join(root,'packages/testkit/src/reporting/report.ts'))).digest('hex');
console.log(JSON.stringify({sourcePins,profile:'original Can byte columns; generated point column zero',node:process.versions.node,codec:codecPackage.version,codecSha256:createHash('sha256').update(readFileSync(codecPath)).digest('hex'),consumer:'current source artifact parse/load, lookup, invokeCallable, formatFailureLocation',syntheticInvocation:'coordinate.can:1:7',freshCliModules:fresh.modules.length,freshCliPoints:points,browserUTF16:'unqualified'}));
