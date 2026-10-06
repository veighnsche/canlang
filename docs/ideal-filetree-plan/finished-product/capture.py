#!/usr/bin/env python3
"""Read-only repository catalog; writes only this audit's evidence directory."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
CHECKPOINT = '8249342707d3280e88e39e8c911b7e457828f31f'
HISTORICAL = '350163ad661e61b667809a5f78b608c23812a5f0'

def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd)

def dump(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')

def capability(path):
    if path.startswith('draft/') or path == 'draft': return 'F01'
    if path.startswith('compiler/'):
        if '/docs' in path or 'description' in path: return 'F10'
        if '/examples' in path: return 'F12'
        return 'F01'
    owners = {'values':'F02','state':'F03','identity':'F04','work':'F05',
              'work-kernel':'F06','services':'F05','files':'F07','interfaces':'F08',
              'ui':'F09','cloudflare':'F11','testkit':'F12','stdlib':'F03'}
    if path.startswith('packages/'):
        bits = path.split('/')
        if bits[1] == 'contracts':
            return {'values.ts':'F02','identity.ts':'F04','work.ts':'F06','services.ts':'F05',
                    'files.ts':'F07','wire.ts':'F08','presentation.ts':'F09','reference.ts':'F10',
                    'deployment.ts':'F11','deployment-assets.ts':'F11','examples.ts':'F12'}.get(bits[-1],'F01')
        if '/fanout/' in path or '/receipt/' in path or '/observation/' in path: return 'F06'
        return owners.get(bits[1], 'F11')
    if path.startswith('tests/'): return 'F12'
    if path.startswith(('.github/', 'scripts/')) or path in ('package.json','bun.lock','.gitignore','.gitmodules'): return 'F11'
    if path.startswith('editor/'): return 'F01'
    return 'F12' if '/evidence/' in path or '/jev/' in path else 'F01'

def structural(path, data):
    result={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'binary':b'\0' in data}
    try: text=data.decode('utf-8')
    except UnicodeDecodeError:
        result['format']='binary'; return result
    result['lines']=len(text.splitlines())
    ext=Path(path).suffix
    if ext in ('.rs','.ts','.js','.mjs','.py'):
        result['symbols']=re.findall(r'(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:async\s+)?(?:fn|function|class|interface|type|struct|enum|def)\s+([\w$]+)',text)
        result['members']=[{'line':i,'name':m.group(1),'declared_type':m.group(2).strip()}
            for i,line in enumerate(text.splitlines(),1)
            if (m:=re.match(r'^\s*(?:pub(?:\([^)]*\))?\s+)?(?:readonly\s+)?([A-Za-z_][\w$]*)(?:\?)?\s*:\s*([^=]+?)[,;]?\s*$',line))]
        result['imports']=re.findall(r'(?m)(?:from\s+[\"\']([^\"\']+)[\"\']|^\s*(?:pub\s+)?(?:use|mod)\s+([^;\n]+))',text)
        result['structural_kind']='source-symbol/import catalog; not control-flow proof'
    elif ext=='.json':
        try:
            d=json.loads(text);result['json_shape']={'kind':type(d).__name__,'length':len(d) if isinstance(d,(dict,list)) else None,'keys':list(d) if isinstance(d,dict) else []}
        except ValueError: result['json_shape']={'parse':'not-json'}
    elif ext=='.md': result['headings']=re.findall(r'(?m)^#{1,6}\s+(.+)',text)
    elif ext in ('.toml','.yml','.yaml','.lock'):result['structural_kind']='build/configuration inventory'
    else:result['structural_kind']='text/data inventory'
    return result

def capture():
    prior_capture=OUT/'inventory.json'
    prior=json.loads(prior_capture.read_text()) if prior_capture.exists() else {}
    pin=git('rev-parse','HEAD').decode().strip() if '--refresh-source' in sys.argv or not prior else prior['source_pin']
    initial_review_pin=prior.get('initial_semantic_review_pin',prior.get('source_pin',pin))
    entries=[]
    for record in git('ls-tree','-r','-z',pin).split(b'\0'):
        if not record:continue
        meta,path=record.split(b'\t',1);mode,kind,oid=meta.decode().split()
        entries.append((path.decode(),mode,kind,oid))
    old=json.loads((ROOT/'docs/ideal-filetree-plan/inventory.json').read_text())
    previous={r['path']:r for r in old['rows']}
    blobs=[e for e in entries if e[2]=='blob']
    proc=subprocess.Popen(['git','cat-file','--batch'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    raw,_=proc.communicate(('\n'.join(e[3] for e in blobs)+'\n').encode())
    pos=0;data_by_oid={}
    for _,_,_,oid in blobs:
        end=raw.index(b'\n',pos);header=raw[pos:end].split();size=int(header[-1]);pos=end+1
        data_by_oid[oid]=raw[pos:pos+size];pos+=size+1
    rows=[]
    for path,mode,kind,oid in entries:
        r={'path':path,'mode':mode,'kind':kind,'blob':oid,'capability':capability(path),
           'source_review':'structural catalog; see responsibility reviews for semantic scope'}
        if kind=='blob':
            r.update(structural(path,data_by_oid[oid]))
            prev=previous.get(path)
            if prev and prev.get('pinned_blob')==oid:
                r['historical_review']='identical primary-pin bytes; reuse only its recorded scope'
            else:r['historical_review']='changed/new relative to primary catalog; no old semantic claim advanced'
            p=ROOT/path
            if p.is_file():
                working=p.read_bytes();sha=hashlib.sha256(working).hexdigest()
                if sha!=r['sha256']:r['working_overlay']={'sha256':sha,'bytes':len(working)}
        else:r['source_review']='independent gitlink; nested draft catalog below'
        rows.append(r)
    added=[]
    for p in git('ls-files','--others','--exclude-standard','-z').decode().split('\0'):
        if not p or p.startswith('docs/ideal-filetree-plan/finished-product/'):continue
        file=ROOT/p
        if file.is_file():added.append({'path':p,'capability':capability(p),'source_review':'other-owner untracked evidence; retained, not accepted',**structural(p,file.read_bytes())})
    draft_pin=git('rev-parse','HEAD',cwd=ROOT/'draft').decode().strip()
    draft=[]
    for p in git('ls-files','-z',cwd=ROOT/'draft').decode().split('\0'):
        if not p:continue
        f=ROOT/'draft'/p
        if f.is_file():draft.append({'path':'draft/'+p,'capability':'F01','authority':'business intent/desired output, not executed proof',**structural(p,f.read_bytes())})
    delta=[]
    for record in git('diff','--name-status',CHECKPOINT,pin).decode().splitlines():
        bits=record.split('\t');delta.append({'change':bits[0],'paths':bits[1:]})
    contracts=['AGENTS.md','docs/specification/REQUIREMENTS.md','docs/specification/DESIGN.md','docs/specification/GRAMMAR.md','docs/specification/DECISIONS.md',
               'implementation/CONTRACTS.md','implementation/CHALLENGE-AUDIT-PLAN.md',
               'implementation/DESCRIPTION-REFERENCE-PLAN.md','implementation/REMAINING-IMPLEMENTATION-LANES.md',
               'implementation/challenge-audit-run/t33-resolution.md','implementation/challenge-audit-run/evidence/t34-plan.md']
    contracts += [str(p.relative_to(ROOT)) for p in sorted((ROOT/'docs/research/package-subsystem-ports-20261006/implementation-plans').glob('*')) if p.is_file()]
    dirty=git('status','--porcelain=v1','--untracked-files=all').decode().splitlines()
    audit={'schema_version':1,'checkout':str(ROOT),'source_pin':pin,'branch':git('branch','--show-current').decode().strip(),
           'complete_checkpoint':CHECKPOINT,'historical_primary':HISTORICAL,'checkpoint_advanced':False,
           'observed_head_at_capture':git('rev-parse','HEAD').decode().strip(),
           'initial_semantic_review_pin':initial_review_pin,
           'source_baseline':'current structural/catalog pin; initial semantic review and explicit post-pin review remain distinct',
           'review_baseline':'finished workflows reviewed anew against contracts; historical bytes reuse scoped, no wholesale current-proof relabel',
           'dirty_at_capture':[d for d in dirty if 'docs/ideal-filetree-plan/finished-product/' not in d],
           'contracts':[{'path':p,'working_sha256':hashlib.sha256((ROOT/p).read_bytes()).hexdigest()} for p in contracts],
           'rows':rows,'added_inputs':added,'delta_since_complete_checkpoint':delta,
           'draft':{'pin':draft_pin,'gitlink_at_source_pin':next(r['blob'] for r in rows if r['path']=='draft'),'dirty':git('status','--short',cwd=ROOT/'draft').decode().splitlines(),'rows':draft},
           'writer_boundary':{'audit_owner':'Codex root; three disjoint review writers','owned_prefix':'docs/ideal-filetree-plan/finished-product/',
              'shared_entry':'docs/ideal-filetree-plan.md only after convergence; current merge-maintenance records preserved',
              'not_owned':['implementation/challenge-audit-run/remaining-tasks.md','docs/research/package-subsystem-ports-20261006/evidence/implementation/','current Muse source reservations'],
              'ownership_evidence':'docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/ownership.json; REMAINING-IMPLEMENTATION-LANES.md states coordinator does not own unrelated living-filetree edits'},
           'missing_skill_support':['references/procedure.md','references/records.md','references/scheduling.md','scripts/check_artifacts.py']}
    dump('inventory.json',audit)
    oversized=sorted(({'path':r['path'],'lines':r.get('lines',0),'bytes':r.get('bytes',0),'symbols':r.get('symbols',[]),'members':r.get('members',[])} for r in rows if r.get('lines',0)>600),key=lambda r:-r['lines'])
    dump('oversized.json',{'scope':'internal symbols extracted for every text source; semantic duty review separately recorded','files':oversized})
    print(json.dumps({'pin':pin,'tracked':len(rows),'added':len(added),'draft':len(draft),'delta':len(delta),'oversized':len(oversized)}))

if __name__=='__main__':capture()
