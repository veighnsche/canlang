// Audit tooling only: parses frozen source; never imports package implementation.
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const repo=path.resolve(process.argv[2]||'.');
const ts = require(require.resolve('typescript',{paths:[repo]}));
const pin=JSON.parse(fs.readFileSync(path.join(__dirname,'scope.json'),'utf8')).source_checkpoint;
const coverage=fs.readFileSync(repo+'/docs/research/package-library-audit-20261006/responsibility-callers/file-coverage.tsv','utf8').trim().split('\n').slice(1).map(s=>s.split('\t'));
const sources=[],groups=new Map(),forwarders=[];
for(const row of coverage){
  const path=row[0];
  if(!/\.(?:ts|mts|cts)$/.test(path)) continue;
  const source=cp.execFileSync('git',['show',pin+':'+path],{cwd:repo,encoding:'utf8',maxBuffer:5e6});
  sources.push({path,sha256:crypto.createHash('sha256').update(source).digest('hex')});
  const sf=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  function visit(n){
    if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n))&&n.body){
      const start=n.body.getStart(sf),end=n.body.end;
      const name=n.name?.getText(sf)||n.parent.name?.getText(sf)||'<anonymous>';
      const site={path,name,start:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,end:sf.getLineAndCharacterOfPosition(end).line+1};
      const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,source.slice(start,end));
      const tokens=[];let token;
      while((token=scanner.scan())!==ts.SyntaxKind.EndOfFileToken)tokens.push([token,scanner.getTokenText()]);
      if(tokens.length>=50){
        const hash=crypto.createHash('sha256').update(JSON.stringify(tokens)).digest('hex');
        if(!groups.has(hash))groups.set(hash,{hash,token_count:tokens.length,sites:[]});
        groups.get(hash).sites.push(site);
      }
      let returned=ts.isBlock(n.body)&&n.body.statements.length===1&&ts.isReturnStatement(n.body.statements[0])?n.body.statements[0].expression:!ts.isBlock(n.body)?n.body:null;
      if(returned&&ts.isCallExpression(returned))forwarders.push({...site,callee:returned.expression.getText(sf),expression:returned.getText(sf)});
    }
    ts.forEachChild(n,visit);
  }
  visit(sf);
}
const duplicates=[...groups.values()].filter(g=>new Set(g.sites.map(s=>s.path)).size>1);
const result={pin,method:'Exact token bodies excluding trivia; identifiers and literals preserved. Similarity seed only, not semantic equivalence. No alpha renaming or product execution.',typescript_version:ts.version,sources,duplicates,forwarders};
const output=JSON.stringify(result,null,2)+'\n';
if(process.argv[3])fs.writeFileSync(process.argv[3],output);else process.stdout.write(output);
