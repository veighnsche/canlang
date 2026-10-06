#!/usr/bin/env python3
"""Join planning evidence and exact paths. Does not execute product code."""
import collections
import json
from pathlib import Path
import re
from capture import ROOT, OUT, capability, dump

PORTS = ROOT/'docs/research/package-subsystem-ports-20261006/implementation-plans'

CAPS = [
 ('F01','Authored application and language tools','Source identity/composition, grammar, flow/effects, owner catalogs and lowering','language','work'),
 ('F02','Exact values and input meaning','Exact arithmetic/representations, omission/defaults, profile-specific ordered owned validation','language','work'),
 ('F03','Canonical data and authority','Current admission/query/projection, invariants/hooks/containment, one fenced commit and replay','work','language'),
 ('F04','Identity and team lifecycle','Session/grant audiences, proof/consumption, membership/roles/revocation and typed atomic outcomes','product','delivery'),
 ('F05','Effects and external work','Atomic intent/schedule/event staging, provider evidence/guard/budget, bounded retry/reconciliation','work','language'),
 ('F06','Receipts, progress and cohorts','Selected disclosure, relation correlation, complete finite fanout, durable recovery and fair termination','work','language'),
 ('F07','Files and content lifecycle','Real bytes/provenance/finalization, durable host recovery, attachments, expiry/erasure and corpus grounding','work','language'),
 ('F08','Operation interfaces','HTTP/MCP/sealed delegation, current authority, schemas/errors/projection and authorized export/Print','product','delivery'),
 ('F09','Browser and personal configuration','All 68 components, page admission, installed client/assets, focus/polling, preferences/CSV','product','delivery'),
 ('F10','Descriptions and internal reference','One checked static description, located deterministic internal Markdown, source-language IDE/MCP','language','work'),
 ('F11','Artifact and product delivery','Install/build/release closure, typed actual Wasm, synchronous init, native job, upgrade/rollback/measurement','delivery','product'),
 ('F12','Examples, qualification and evidence','Independent fixture/expectation/causal journeys, full intent dispositions and truthful supported release','product','delivery'),
]

TDEPS={'T01':[],'T02':['T01'],'T03':[],'T04':[],'T05':['T03'],'T06':['T05'],
 'T07':['T05'],'T08':[],'T09':[],'T10':[],'T11':[],'T12':[],'T13':['T12'],
 'T14':['T10','T13'],'T15':['T04','T09','T10'],'T16':['T15'],'T17':['T16'],
 'T18':['T09','T16','T17'],'T19':['T15','T16','T18'],'T20':['T19'],'T21':['T16','T17'],
 'T22':['T15','T16','T17'],'T23':['T22'],'T24':['T16','T17'],'T25':['T14','T24'],
 'T26':['T25'],'T27':['T26'],'T28':[],'T29':['T28','T15','T16','T17'],
 'T30':[],'T31':['T16','T17','T30'],'T32':['T16','T17'],'T33':[],'T34':['T24','T33'],
 'T35':[],'T36':['T01','T02'],'T37':['T02','T05','T06','T08','T18','T19','T20','T21','T22','T23'],
 'T38':['T37'],'T39':['T37'],'T40':['T37'],'T41':['T02','T37','T38','T39','T40']}
TCAPS={1:['F12'],2:['F01','F12'],3:['F01'],4:['F01','F03','F08','F12'],5:['F01'],6:['F01','F04'],7:['F01'],8:['F01','F09'],9:['F01','F02'],10:['F01','F02'],11:['F01','F02'],12:['F01','F05'],13:['F01','F02','F05'],14:['F01','F05','F12'],15:['F01','F03','F08','F12'],16:['F03','F08'],17:['F03'],18:['F02','F03'],19:['F08','F09'],20:['F08','F09'],21:['F11','F12'],22:['F12'],23:['F12'],24:['F03','F05'],25:['F06'],26:['F06'],27:['F07'],28:['F01','F03'],29:['F01','F03'],30:['F01','F03'],31:['F03'],32:['F03','F05','F08'],33:['F06'],34:['F01','F03','F06','F12'],35:['F01'],36:['F01','F12'],37:['F12'],38:['F12'],39:['F12'],40:['F12'],41:['F11','F12']}

def link(path):
    review=OUT/'documentation-review.json'
    if review.exists():
        locations=json.loads(review.read_text()).get('root_locations',[])
        path=next((r['target'] for r in locations if r['source']==path and r.get('execution_status')=='applied locally'),path)
    return f'../../../../{path}'

def load_reviews():
    return {n:json.loads((OUT/'reviews'/f'{n}.json').read_text()) for n in ('language','work','delivery','product')}

def app_reviews():
    return {p.stem:json.loads(p.read_text()) for p in sorted((OUT/'reviews').glob('apps-*.json'))}

def app_duties(reviews):
    rows=[]
    for name,review in reviews.items():
        for d in review.get('additional_required_duties',[])+review.get('target_duties',[])+review.get('requirement_tasks',[]):
            paths=d.get('target',d.get('target_paths',d.get('new_proposed_leaves',[])))
            paths=paths+d.get('retained',d.get('retained_defining_paths',[]))
            paths += [p['path'] for p in d.get('target_files',[])]
            rows.append({'id':d['id'],'review':name,'requirement':d.get('requirement',d.get('duty',d.get('title',''))),
              'disposition':'REQUIRED','source_paths':d.get('evidence',[]),'target_paths':list(dict.fromkeys(paths)),
              'task_ids':d.get('task_ids',[]),'gate':d.get('gate',d.get('cutover_gate',d.get('cutover','per-app full intended outcome and actual installed consumer proof'))),
              'evidence':d.get('precise_evidence',[]),'availability':'required target; source/companion inspection, not executed proof'})
        for app in review.get('apps',[]):
            paths=[p['path'] if isinstance(p,dict) else p for p in app.get('additional_exact_target_paths',[])]
            if paths:
                rows.append({'id':'APP-'+app['app'],'review':name,'requirement':app.get('purpose',app['app']),
                  'disposition':'REQUIRED','source_paths':[],'target_paths':paths,'task_ids':[],
                  'gate':'source-owned business policy; reusable owner catalog/consumer/recovery qualification; see full app intent record',
                  'evidence':[],'availability':'proposed reusable boundaries; current declared APIs and integration require proof'})
    return rows

def duties(reviews):
    rows=[]
    for n in ('language','product'):
        for d in reviews[n]['duties']:
            rows.append({'id':d['id'],'review':n,'requirement':d['requirement'],'disposition':d['disposition'],
              'source_paths':d.get('source_paths',[]),'target_paths':d.get('target_paths',[]),
              'task_ids':d.get('task_ids',[]),'gate':d.get('cutover_gate','see primary review'),
              'evidence':d.get('evidence',[]),'availability':d.get('availability','source-inspected; not executed')})
    for s in reviews['work']['slices']:
        rows.append({'id':s['id'],'review':'work','requirement':s['title'],'disposition':s['disposition'],
          'source_paths':s.get('current_defining_files',s.get('source_paths',[])),'target_paths':[p['path'] for p in s.get('target_defining_files',[])],
          'task_ids':s.get('task_ids',[]),'gate':s.get('completion_gate','see work lifecycle/cutovers and linked tasks'),
          'evidence':s.get('requirement_authority',[]),'availability':'source inspection at pinned scope; no workflow run'})
    for s in reviews['delivery']['target_requirements']:
        owner_ids={'D-SOURCE':['reference-delivery'],'D-GRAPH':['release-host','runtime-imports'],
           'D-FACTS':['release-host','deployment-inventory'],'D-ASSETS':['deployment-assets','deployment-inventory','local-loader'],
           'D-BOOT':['local-loader','runtime-imports','conformance-delivery'],'D-STAGES':['preparation-native','retained-producers'],
           'D-NATIVE':['preparation-native'],'D-LIFE':['preparation-native','native-output'],
           'D-INSTALL':['release-host','native-output','runtime-imports'],'D-MIXED':['deployment-inventory','local-loader','preparation-native'],
           'D-EVIDENCE':['conformance-delivery'],'D-ROLL':['preparation-native','runtime-imports','conformance-delivery'],
           'D-UPGRADE':['installed-upgrade'],'D-DEFAULT':['preparation-native'],'D-JSONLY':['preparation-native'],'D-PACK':['native-output'],
           'D-DEFER':[],'D-DECLINE':[]}.get(s['id'],[])
        paths=[p for o in reviews['delivery']['target_owners'] if o['id'] in owner_ids for p in o['target_paths']]
        rows.append({'id':s['id'],'review':'delivery','requirement':s['title'],'disposition':s['disposition'],
          'source_paths':[],'target_paths':list(dict.fromkeys(paths)),'task_ids':[],
          'gate':s['contract'],'evidence':s['evidence'],'availability':'new target/retained source; source evidence indexed in delivery.json'})
    return rows

def source_maps(inventory, reviews):
    old=json.loads((ROOT/'docs/ideal-filetree-plan/target-tree.json').read_text())
    prior={r['source']:r for r in old['source_inputs']}
    selected={d['source']:d for d in reviews['language']['selected_decomposition']}
    work_runtime=sorted({p['path'] for s in reviews['work']['slices'] for p in s['target_defining_files'] if p['path'].startswith('packages/cloudflare/src/runtime/work/')})
    allocations=[]
    for row in inventory['rows']+inventory['added_inputs']:
        p=row['path']
        if p=='draft':continue
        prev=prior.get(p)
        targets=prev['targets'][:] if prev else [p]
        decision=prev.get('disposition','retain') if prev else 'retain'
        gate=prev.get('gate','current authority/actual consumer proof before any retirement') if prev else 'retained owning duty; source availability is not acceptance'
        if p in selected:
            targets=selected[p]['selected_targets'];decision='gated responsibility split';gate=selected[p]['cutover_gate']
        if p=='packages/cloudflare/src/deploy/bundle.ts':
            targets=[p];decision='retain public TS/host facade; scoped native successor bodies';gate='P/C actual consumer and broad-input compatibility gates; native module owner is preparation/src/modules.rs; old generic private bundle splits superseded'
        if p=='packages/cloudflare/src/runtime/invoke.ts':
            targets=[x for x in targets if '/runtime/dispatch/' not in x]+work_runtime
            decision='retain facade/canonical adapters; one work orchestration partition'
            gate='matching live state/work producers; current public ABI and ordered admission; one actual call-site cutover; old private dispatch partition superseded'
        if p.endswith('/src/messages.ts') and p.startswith('packages/ui/'):
            gate += '; canonical locale/error/exactness profiles agree before consolidating UI message mechanics'
        allocations.append({'source':p,'capability':row['capability'],'targets':targets,'decision':decision,'gate':gate,
             'catalog_scope':row['source_review'],'semantic_review':'see new workflow duty ledger plus byte-scoped historical review; not every function executed'})
    for r in inventory['draft']['rows']:
        allocations.append({'source':r['path'],'capability':'F01','targets':[r['path']],'decision':'retain authoritative intent/witness',
             'gate':'T02/T36 site-level draft-owner verdict before any correction; .mjs desired output only',
             'catalog_scope':'independent nested source and intent pin','semantic_review':'per-app intent review plus shared capability challenge'})
    return allocations

def task_catalog():
    manifest=json.loads((PORTS/'execution-manifest.json').read_text());ports=[]
    for file in sorted(PORTS.glob('*.tasks.json')):
        d=json.loads(file.read_text());name=d['plan']
        for t in d['tasks']:
            row={'namespace':'ports','plan':name,'manifest':str(file.relative_to(ROOT)),**t}
            row['disposition']='REQUIRED' if t['required'] else ('DEFERRED' if t['id'].startswith('W09') else 'ACCEPTED-CONDITIONAL')
            row['capabilities']={'exact-values':['F02'],'input-validation':['F02','F03','F08'],'work-transitions':['F05','F06'],'artifact-preparation':['F11'],'shared':['F02','F03','F05','F06','F08','F11','F12']}[name]
            row['execution_status']='not assigned or executed by audit; active coordinator evidence separate'
            row['target_correction']='Compiler-unchanged applies only to port. Required original workflow cannot be closed by a declined acceleration profile or native-only fixture.'
            if t['id']=='P05.6':row['required_when_product']='Native preparation is selected for real mixed values/work Wasm assets; JS-only native profile remains intermediate.'
            if t['id'].startswith('V08') or t['id'].startswith('V10'):row['required_product_transport']='HTTP/MCP/forms remain required through a valid TS or qualified Rust path; Rust provenance/adoption itself conditional.'
            ports.append(row)
    challenge=[]
    text=(ROOT/'implementation/CHALLENGE-AUDIT-PLAN.md').read_text()
    for id,body in re.findall(r'^- \[ \] \*\*(T\d\d) (.*?)\n',text,re.M):
        title=body.split('**',1)[0].rstrip('.')
        challenge.append({'namespace':'challenge','id':id,'title':title,'contract':body,'depends_on':TDEPS[id],
          'capabilities':TCAPS[int(id[1:])],'disposition':'REQUIRED','status':'canonical parent; current accepted slices must be reused at exact scope, no new execution status',
          'gate_policy':'Dependencies refer to matching released capability slices, not unrelated full parent barriers; exact scoped prerequisites retained in contract.'})
    descriptions=[]
    text=(ROOT/'implementation/DESCRIPTION-REFERENCE-PLAN.md').read_text()
    matches=list(re.finditer(r'^- \[ \] \*\*(D\d\d) — (.+?)\*\*',text,re.M))
    for i,m in enumerate(matches):
        id=m.group(1);block=text[m.start():matches[i+1].start() if i+1<len(matches) else text.find('\n## ',m.end())]
        deps={'D01':[],'D02':['D01'],'D03':['D02'],'D04':['D02'],'D05':['D04'],'D06':['D02'],'D07':['D03','D04','D05','D06'],'D08':['D07']}[id]
        descriptions.append({'namespace':'description','id':id,'title':m.group(2),'contract':block.strip(),'depends_on':deps,'capabilities':['F10'],'disposition':'REQUIRED',
          'gate_policy':'Existing source mechanisms observed; current partial reservations/slices and D04 requiredness/installed reference proof revalidate; no repeated description JEV'})
    supplemental=[]
    text=(ROOT/'implementation/REMAINING-IMPLEMENTATION-LANES.md').read_text()
    for line in text.splitlines():
        m=re.match(r'^\| (A[1-5]|B[1-5]|C[1-4]|D[1-3]|E[12]|F1|LG0[0-6]) \|',line)
        if m:supplemental.append({'id':m.group(1),'namespace':'remaining','contract_row':line,'authority':'existing coordinator packet; read only','audit_assignment':False})
    return manifest,ports,challenge,descriptions,supplemental

def extra_tasks():
    def task(id,title,deps,writes,gate,caps):return {'namespace':'finished-product','id':id,'title':title,'depends_on':deps,'writes':writes,'acceptance':[gate],'capabilities':caps,'disposition':'REQUIRED','execution_status':'NEW-PROPOSED packet, not authorization to current implementation lanes'}
    rows=[
      task('FP.IDENTITY-CONTRACT','Release typed identity conditional outcome/context/fence contract',['T04'],['packages/contracts/src/identity.ts','packages/identity/src/ports.ts','packages/state/src/ports/identity.ts'],'Exact table/owner transaction participants, verified anonymous/session/grant context, one-use winner, last-owner/role/recovery atomicity, replay/rollback and origin binding. System registration alone insufficient. Consult triple JEV for consequential unsettled mechanism with verified full context before selection.',['F04','F03']),
      task('FP.IDENTITY','Join identity lifecycle to real authoritative storage',['FP.IDENTITY-CONTRACT','T16'],['packages/identity/src/storage/commands.ts','packages/identity/src/storage/d1.ts','packages/state/src/storage/d1.ts','packages/cloudflare/src/runtime/env-assembly.ts'],'Typed conditional winner and constrained batch, no raw SQL feature bypass; source-present APIs revalidated under actual D1/DO/revocation/retry proof.',['F04','F03']),
      task('FP.BROWSER','Ship and qualify browser/assets and polling lifecycle',['T15','T19','T20'],['packages/ui/src/browser/bootstrap.ts','packages/ui/src/browser/polling.ts','packages/ui/scripts/build-browser.mjs','packages/ui/src/browser/style.css','packages/interfaces/src/http/assets.ts'],'All 68 catalog bindings, real installed CSS/HTMX/client/static path, focus/keyboard/unsaved forms and URL/history; authorized one-inflight poll, visibility/context/logout termination and obsolete responses/actions.',['F09','F11']),
      task('FP.PREFERENCES','Join checked preference metadata/current storage/consumer',['T15','T20'],['packages/state/src/preferences/schema.ts','packages/state/src/preferences/commands.ts','packages/state/src/preferences/reads.ts','packages/interfaces/src/http/preferences.ts'],'Self/owner/app/team key, current reference fallback/default/reset/conflict/cancel and bound-tab save; base shared account settings separate; never changes business authority.',['F09']),
      task('FP.CSV','Close source-derived CSV intake server review and per-row commit',['T19','T20','T32'],['packages/interfaces/src/http/csv.ts','packages/ui/src/csv/parse.ts','packages/ui/src/csv/preview.ts','packages/ui/src/csv/confirm.ts'],'Preserve invalid/duplicate rows, renewed consent on changed candidates, authorized pure review before each frozen-identity confirmation, canonical independent replay-safe outcomes/partial failure.',['F08','F09']),
      task('FP.EXPORT','Close authorized bounded CSV export/Print and large-output lifecycle',['T20','T24','T32'],['packages/interfaces/src/http/export.ts','packages/interfaces/src/http/print.ts','packages/ui/src/browser/export.ts','packages/ui/src/browser/print.ts','packages/work/src/exports/jobs.ts','packages/work/src/exports/download.ts'],'Current row/field/file grants, explicit completeness/limits/currency/ID/version columns/formula handling; durable status/expiry guarded downloads for large exports; Print declared authorized view.',['F08','F09','F05']),
      task('FP.POLICY-REVIEW','Connect staff business review to checked owner facts',['T04','T15','T20'],['compiler/src/review.rs','packages/contracts/src/review.ts','packages/interfaces/src/projection/review.ts'],'Same-source permissions/actions/exceptions/defaults/assumptions/examples, unresolved intent and truthful approval/availability. No copied prose policy.',['F01','F09']),
      task('FP.LIFETIME','Implement owner expiry and sensitive-copy disposal',['T15','T17','T25'],['packages/state/src/retention/expiry.ts','packages/state/src/retention/disposal.ts','packages/state/src/retention/recovery.ts'],'Archived/locked records, child/reference lifetime, safe replay identity, sensitive history/receipt/outbox disposal and physical erasure delay/restart; file GC alone insufficient.',['F03','F07']),
      task('FP.FILES-DURABLE','Join file metadata/blob durable lifecycle',['T04','T16','T24'],['packages/files/src/storage/metadata.ts','packages/files/src/storage/blob.ts','packages/files/src/storage/recovery.ts'],'Real receiving-app bytes/digest/provenance/finalization/attachment/read, upload/principal limits, restart/duplicate/conflicting-output proof; async interface release, no R2+state atomicity promise.',['F07']),
      task('FP.CORPUS','Connect accepted model-bound corpus and opaque grounding',['T13','T14','T15','T24','T25','T26','T32','FP.FILES-DURABLE'],['packages/contracts/src/corpus.ts','packages/state/src/corpus/sources.ts','packages/state/src/corpus/grounded.ts','packages/state/src/corpus/available.ts','packages/state/src/corpus/status.ts','packages/services/src/corpus/index.ts','packages/services/src/corpus/controller.ts','packages/services/src/corpus/extract.ts','packages/services/src/corpus/normalize.ts','packages/cloudflare/src/runtime/work/corpus.ts','packages/testkit/src/fixtures/corpus.ts'],'Accepted grammar preserved. Real origin/principal/scope and all actually used immutable context verified at retrieval and every disclosure; opaque nonconstructible Answer, truthful coverage/as-of, current revocation/withdrawal, index repair and genuine fixtures. T12 B8 exclusion is availability, not deferral.',['F01','F05','F07']),
      task('FP.INSTALLED-RELEASE','Close outside-checkout release facts/producer closure',['C04.graph','C04.values-assets','C04.work-assets','C04.native-release'],['packages/cloudflare/src/release/inputs.ts','packages/cloudflare/src/deploy/producer-inventory.ts','.github/workflows/release.yml','docs/install.md'],'Install complete actual runtime/docs/browser producer closure and assets without workspace siblings/compiler Cargo.toml; cold/full installed CLI and Worker proofs on every claimed host; actual numeric/work binaries not smoke.',['F11']),
      task('FP.UPGRADE-JOIN','Connect source-derived staged upgrade and recovery',['T15','T17','T24'],['packages/cloudflare/src/upgrade/host.ts','packages/cloudflare/test/upgrade-installed.test.ts'],'Exact installed predecessor/desired schema, bounded complete-state/work inventory, staged validation, fenced activation/recovery, negative unknown/unsupported transitions; retain truthful online limitations.',['F03','F11']),
      task('FP.DOC-REQUIREDNESS','Reconcile reference stored-array creation facts',['T09','D04'],['compiler/src/docs.rs','compiler/tests/docs.rs'],'Ordinary arrays omit to empty; required arrays differ; reference/form/MCP/state agree. Signature params remain distinct; no blanket count updates.',['F10','F02']),
      task('FP.COMPILED-DECIMAL','Close exact decimal expression lowering',['T11','T13','T15'],['compiler/src/codegen/js.rs','compiler/src/codegen/ir.rs','packages/values/src/catalog.ts','packages/stdlib/src/index.ts'],'Real owner-derived exact constructor/lowering preserving authored integral magnitude/scale, constraints and no Number/i64 intermediary; meaningful invalid/ambiguous/range controls; package-only port unchanged.',['F01','F02']),
      task('FP.QUALIFY','Qualify all accepted original workflow families',['T37','T38','T39','T40','FP.IDENTITY','FP.BROWSER','FP.PREFERENCES','FP.CSV','FP.EXPORT','FP.POLICY-REVIEW','FP.LIFETIME','FP.CORPUS','FP.UPGRADE-JOIN','FP.COMPILED-DECIMAL'],'tests/e2e/journeys/original-corpus.spec.ts'.split(),'All 49 app intent dispositions with full declared required workflows/negatives, real canonical compiled examples, meaningful multi-actor/browser/MCP/persistence/retry/recovery; per-app gates and honest provider/storage evidence.',['F12']),
      task('FP.FULL','Review full intended-product supported release',['T41','D08','A11','V12','W08','P11','C04.complete','C05.complete','FP.QUALIFY','FP.INSTALLED-RELEASE','FP.DOC-REQUIREDNESS'],['docs/ideal-filetree-plan.md'],'Complete source/duty review, independently challenged owners, actual source/artifact/runtime/examples/installed workflow proofs, package/current/prepared/Rust economics, precise required/conditional/deferred/declined ledger and upgrade/rollback. Optional W09 stays outside. Reconcile every accumulated merge delta before checkpoint advance.',['F01','F02','F03','F04','F05','F06','F07','F08','F09','F10','F11','F12'])
    ]
    joins=[
      task('FP.CONTEXT','Close verified source context and allowed-hook carriers',['T04','T15'],['compiler/src/codegen/ir.rs','compiler/src/codegen/js.rs','packages/cloudflare/src/runtime/context.ts','packages/cloudflare/src/runtime/invoke.ts'],'Lower actor/team/now/operation from the same verified current invocation, without ambient free variables. Preserve operation readonly id/source and all accepted per-scope bounds; hook context must be released by its owner, not inferred from nonhook c. Required sites compile and execute with meaningful actor-null/current-scope negatives. B4 report is proposal/source evidence.',['F01','F03','F08']),
      task('FP.DISPATCH-AVAILABILITY','Join deployment availability to durable send outcome',['T12','T24','FP.SOURCE-MAPPINGS'],['packages/cloudflare/src/runtime/work/providers.ts','packages/cloudflare/src/runtime/invoke.ts'],'Use current owning source/actual target binding and optional host availability contract; preserve lifecycle -> availability -> guard -> revalidation -> claim trace where injected. Current Cloudflare mirror omits availability and rejects unavailable; physical drive mints/persists held claim and awaits snapshot/authority before replaying kernel callbacks. Release the actual producer/mirror/order and durable terminal transport/receipt/persist/recovery mapping explicitly; an unavailable kernel return alone neither persists terminal state nor qualifies runtime. Prove missing versus broken/temporarily unavailable deployment policy, withheld guard/revalidation/claim, actual compiled sends and source namespace. Original required corpus/provider outcomes remain required, not declined. Refresh W01/W04/W06/W07 callback/outcome/ABI profiles; retain unknown broad JS on TS.',['F05','F06','F11']),
      task('FP.MAINTENANCE','Join configured trusted maintenance to owner admission',['T16','T17','T28','T29'],['packages/cloudflare/src/maintenance/records.ts','packages/state/src/maintenance/admission.ts','packages/contracts/src/state.ts'],'Cloudflare transport resolves configured request; state owns constrained canonical maintenance admission. Configured source/team/version and canonical constraints, candidate hooks, owner fence/history/replay/outbox; Check and Catch maintenance require same commit authority. No product configuration tools or direct SQL bypass.',['F03','F11']),
      task('FP.PING','Join provisioned heartbeat ingress',['FP.MAINTENANCE','T24','T32'],['packages/interfaces/src/health/ping.ts'],'Configured namespace+secret GET/POST, noncached bounded responses and durable canonical ping before ACK; current token/revision, unknown/revoked key negatives and restart/due/pause/recovery races; notice acceptance does not reset health.',['F05','F08']),
      task('FP.INSTRUMENTATION','Close minimized versioned error capture and intake',['FP.MAINTENANCE','T24','FP.LIFETIME'],['packages/services/src/instrumentation/reports.ts','packages/services/src/instrumentation/redaction.ts','packages/services/src/instrumentation/grouping.ts','packages/interfaces/src/instrumentation/intake.ts','packages/ui/src/browser/instrumentation.ts','packages/cloudflare/src/runtime/instrumentation.ts'],'Explicit ErrorsV1 source/project binding, bounded UTF-8 before parse, pinned redaction before queue/group/files, nonblocking nonrecursive SDK, quota/replay/work single fence and retry-horizon safe tombstones. Deleted project suppression, sourced fresh/stale/unavailable intake health and independent raw/diagnostic lifetime.',['F05','F07','F09']),
      task('FP.ALERTS','Qualify safe installed heartbeat alert adapter',['FP.SOURCE-MAPPINGS','T24'],['packages/services/src/alerts/adapter.ts','packages/services/src/alerts/egress.ts'],'Owning AlertsV1 acceptance/source/destination/message schema and explicit provider mapping; bounded public HTTPS egress, redirect/current destination/credential restrictions, safe diagnostic and current dispatch guard. Durable Notice association/acceptance stays distinct from heartbeat health or external job success.',['F05','F06','F11']),
      task('FP.SOURCE-MAPPINGS','Release configured provider namespaces and causation',['T12','T14','T24'],['packages/services/src/source-mappings.ts','packages/services/src/adapters/commission.ts','packages/services/src/adapters/discovery.ts','packages/services/src/adapters/registry.ts','packages/cloudflare/src/runtime/work/providers.ts'],'Owning versioned declarations/capability schemas and explicit provisioned namespaces; source request digest/committed cause/action/delivery/domain revision. Commission allocation versus bank outcome, contradictions/reversals and source qualifications stay distinct; no guessed name routing or cross-owner provider transaction.',['F01','F05','F06']),
      task('FP.SERVICE-CATALOG','Complete required standard provider consumers',['T12','T14','T24','FP.FILES-DURABLE'],['packages/services/src/standard/text-generation.ts','packages/services/src/standard/images.ts','packages/services/src/catalog.ts'],'Owner-generated signatures, exact selected provider adapters and current approved hosted configuration; real text/media/file output/progress/reconcile and meaningful unavailable/cancel/unknown cases. Existing harness or adapter export cannot certify declared Chat/Creative journeys.',['F05','F07']),
      task('FP.MAILBOX','Release MailboxV1 catalog and receiving-file consumer contract',['FP.SOURCE-MAPPINGS','FP.FILES-DURABLE','T24'],['packages/services/src/standard/mailbox.ts'],'Release the owning MailboxV1 catalog/receiving-file contract and thin standard coordinator; FP.AW-MAILBOX supplies the private actual producer and conformance. Authenticated installed mailbox source; normalized MIME and receiving-app immutable files finalized before inbox commit; content-bound source identity, conflicting redelivery refusal, completeness, reply and reconcile separate from Email.send. Preserve bounded attempts and exhausted unknown evidence.',['F05','F07']),
      task('FP.REPORTS','Join finite source-derived reporting and historical coverage',['FP.SOURCE-MAPPINGS','T17','T15'],['packages/services/src/reports/sources.ts','packages/services/src/reports/checkpoints.ts','packages/services/src/analytics/dimensions.ts','packages/services/src/analytics/mapping.ts'],'Finite typed dimensions/weighted intervals and current delegated read audience; complete checkpoint/range/site/reversal coverage, immutable financial producer/digest, exact currency/unit separation and N/A/unavailable. Historical day/calendar/price evidence requires owning source verdict; no invented backfill or arbitrary SQL.',['F01','F03','F05']),
      task('FP.TRACKER','Close consent/session tracker and intake',['FP.REPORTS','FP.LIFETIME','T24'],['packages/services/src/analytics/tracker.ts','packages/ui/src/tracker/client.ts','packages/ui/src/tracker/consent.ts','packages/ui/src/tracker/session.ts'],'Configured event schema/source, current consent/reset/session/local queues and canonical normalization; public key never read/truth authority; quota/receipt/work fence and 30-day identifier disposal with safe replay tombstone. Real SDK and Analytics consumer proof.',['F03','F05','F07','F09']),
      task('FP.INVOCATION','Complete finite approved invocation value and protected actions',['T04','T15','T16','T32'],['packages/services/src/models/invocations.ts','packages/interfaces/src/projection/invocations.ts'],'Complete normalized args/version/ref provenance and request allowlist; currently readable protected preview, approval + effects in same owner transaction and post-call invariant rollback; actual Workbench Task.update/complete and negative roles/version cases. No string dispatcher or alternate execute API.',['F01','F03','F05','F08']),
      task('FP.APP-ADJUDICATION','Resolve source/companion correspondence at exact sites',['T02','T36'],['draft/CanMail.can','draft/CanReception.can','draft/CanRent.can','draft/CanDiscover.can','draft/CanCatch.can','draft/CanAffiliate.can','draft/CanEvent.can','draft/CanStock.can'],'Separate explicit desired policy from source defect, missing implementation and deliberate negative. Resolve Mail frozen latest address dispatch, Reception fresh repeat result/contextual guest destination, Rent historical day facts/denominator, Discover committed hook, Catch cumulative/daily meaning and Affiliate cancellation qualification, Event public availability authority and Stock single-leg reversal versus paired transfer conservation; preserve opposing evidence/uncertainty. This packet requests owner verdicts before any draft correction, not invented source policy.',['F01','F03','F05','F09','F12']),
      task('FP.SOURCE-CLOSURE','Close outstanding deep source and mixed-duty review',['T02'],['docs/ideal-filetree-plan/finished-product/requirements.json','docs/ideal-filetree-plan/finished-product/findings.md'],'Review remaining body/control-flow/test expectation scope in accumulated delta and oversized catalogs; independent challenger records real caller/authority/failure/termination and each mixed-duty owner. Structural symbols/counts alone never close source review or advance checkpoint.',['F01','F02','F03','F04','F05','F06','F07','F08','F09','F10','F11','F12'])
    ]
    rows+=joins
    qualify=next(t for t in rows if t['id']=='FP.QUALIFY')
    qualify['depends_on'] += [t['id'] for t in joins if t['id']!='FP.SOURCE-CLOSURE']
    qualify['writes'] += ['tests/e2e/journeys/apps-delivery-installed.spec.ts','tests/e2e/journeys/apps-analytics-installed.spec.ts']
    next(t for t in rows if t['id']=='FP.FULL')['depends_on'].append('FP.SOURCE-CLOSURE')
    return rows

def app_owner_tasks(apps):
    dependencies={'AW-MAILBOX':['FP.MAILBOX'],'AW-PAYMENTS':['FP.SOURCE-MAPPINGS','T24','FP.COMPILED-DECIMAL'],
      'AW-DOCUMENTS':['FP.SOURCE-MAPPINGS','FP.FILES-DURABLE'],'AW-SOURCE-CONNECTOR':['FP.SOURCE-MAPPINGS'],
      'AW-ONBOARD-HANDOFF':['FP.SOURCE-MAPPINGS','FP.IDENTITY','T16'],'AW-JUDGMENT':['T12','T13','T24'],
      'AW-REPLAY-IMPORT':['FP.CSV','FP.FILES-DURABLE']}
    rows=[]
    for name,review in apps.items():
        for d in review.get('requirement_tasks',[]):
            rows.append({'namespace':'finished-product','id':'FP.'+d['id'],'title':d['duty'],
              'depends_on':dependencies.get(d['id'],['T15','T24']),
              'writes':[p['path'] for p in d['target_files']], 'acceptance':[d['cutover']+' Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.'],
              'capabilities':['F03','F05','F06','F07','F12'],'disposition':'REQUIRED','apps':d['apps'],
              'scope_relationship':'Uses the named common released contract; owns only missing private producer or applicable app conformance, not a second implementation of the common facade/authority. Shared exact writes require one owner handoff.', 'execution_status':'NEW-PROPOSED packet, no active assignment','primary_evidence':f'reviews/{name}.json'})
    return rows

def owner(path):
    if path.startswith('compiler/'):return 'compiler'
    if path.startswith('draft/'):return 'draft-reserved'
    if path.startswith('packages/'):
        return path.split('/')[1]+'-owner'
    if path.startswith('.github/') or path in ('package.json','bun.lock'):return 'delivery-integrator'
    if path.startswith('tests/'):return 'qualification'
    if path.startswith('docs/ideal-filetree-plan'):return 'Codex-living-plan'
    if '/evidence/' in path or path.startswith('implementation/'):return 'existing-evidence/coordinator owner; exact reservation before edits'
    if path.startswith('editor/'):return 'compiler-editor'
    return 'repository-subject-owner'

def converge():
    inventory=json.loads((OUT/'inventory.json').read_text());reviews=load_reviews();apps=app_reviews();ds=duties(reviews)+app_duties(apps)
    allocations=source_maps(inventory,reviews);by_source={a['source']:a for a in allocations}
    manifest,ports,challenge,descriptions,supplemental=task_catalog();extra=extra_tasks()+app_owner_tasks(apps)
    next(t for t in extra if t['id']=='FP.QUALIFY')['depends_on'] += [t['id'] for t in extra if t['id'].startswith('FP.AW-')]
    scoped_tasks={
      'W-MUT':['T16','T17','T18','T24','V09','W06'], 'W-HOOK':['T28','T29','T31','T32'],
      'W-DISPATCH':['T24','W06','W08'], 'W-RECEIPT':['T25','T26','T27','T34','W06','W07'],
      'W-PROGRESS':['T26','W06','W07'], 'W-RECOVERY':['T24','W06','W07'],
      'W-KERNEL':['W02','W03','W04','W05','W06','W08'],
      'D-SOURCE':['D04','D05','D07','D08'], 'D-BOOT':['A07','W05','P04','P05','C04.complete'],
      'D-STAGES':['P03','P04','P06','P07'], 'D-NATIVE':['P01','P02','P03','P07','P08','P09','P10','P11'],
      'D-LIFE':['P04','P05','P06','P07'], 'D-EVIDENCE':['P08','P10','P11','C05.complete'],
      'D-ROLL':['P08','P10','P11'], 'D-DEFAULT':['P10','P11'], 'D-JSONLY':['P05','P08','P11'],
      'D-PACK':['P09','C04.native-release'], 'D-DEFER':['W09'], 'D-DECLINE':[],
      'APP-D06':['T24','T26','T33','T34','W06','W07'], 'APP-CanDecide':['T12','T13','T14','T24','FP.AW-JUDGMENT']}
    app_packets=[]
    normalize=lambda name:name[3:] if name.startswith('Can') else name
    for name,review in apps.items():
        for app in review.get('apps',[]):
            app_name=normalize(app['app'])
            specialised=[t['id'] for t in extra if app_name in [normalize(a) for a in t.get('apps',[])]]
            app_paths={p['path'] if isinstance(p,dict) else p for p in app.get('additional_exact_target_paths',[])}
            specialised += [t['id'] for t in extra if app_paths&set(t.get('writes',[]))]
            for duty in app.get('required_owner_duties',[]):
                specialised += {'W-FILE':['FP.FILES-DURABLE'],'W-LIFETIME':['FP.LIFETIME'],'W-CORPUS':['FP.CORPUS'],'W-FANOUT':['T33','T34']}.get(duty,[])
            for duty in review.get('target_duties',[]):
                if app_name in duty.get('apps',[]):
                    specialised += [t['id'] for t in extra if set(duty.get('new_proposed_leaves',[]))&set(t.get('writes',[]))]
            app_packets.append({'app':app_name,'primary_record':f'reviews/{name}.json','disposition':'REQUIRED',
              'workflow_record':app,'specialised_owner_tasks':sorted(set(specialised)),
              'source_and_scope_gate':'Matching T02/T36 source verdicts and T04/T15/T16 compiler/canonical released capability; only exact used constructs, no unrelated full-parent barrier',
              'qualification_gate':'Original compiled app with independent source expectations; current multi-actor/browser/MCP/canonical persistence and full authored failure/retry/termination. Actual provider/file/installed evidence labeled separately; FP.QUALIFY closes only all required app scopes.',
              'writer':'qualification owner requests exact applicable producer/draft file reservation; business rules remain owning .can'})
    dump('apps.json',{'draft_pin':inventory['draft']['pin'],'apps':sorted(app_packets,key=lambda r:r['app']),
      'shared_canonical_sources':'reviews/apps-delivery.json shared rows; import identity/authority remains single owner',
      'dispatch':'per-app packets may qualify as matching prerequisites release; this crosswalk launches/assigns nothing and does not impose a global app gate'})
    app_text=['# Original apps and scoped qualification packets','',
      'All 49 complete source/companion pairs and three shared declarations were read at the independent draft pin. [apps.json](apps.json) retains full app records and exact primary ledger; each ledger distinguishes desired source/API from current runtime evidence. Required workflow and negative behavior stays authored in .can, with one current authority per imported declaration.','',
      '| App | Owning primary ledger | Distinct reusable joins / scoped acceptance |','| --- | --- | --- |']
    for app in sorted(app_packets,key=lambda r:r['app']):
        record=app['workflow_record'];summary=record.get('purpose')
        if not summary:summary='; '.join(str(v) for v in record.get('required_primitives_and_missing_joins',[])[:3])
        if not summary:summary='Complete required workflow/failure/retry/termination record in ledger'
        app_text.append(f"| {app['app']} | [{app['primary_record'].split('/')[-1]}]({app['primary_record']}) | {str(summary).replace('|',' / ')}; exact specialised tasks: {', '.join(app['specialised_owner_tasks']) or 'matching shared owners/constructs'} |")
    app_text+=['','The shared Employees/Locations/Suppliers declarations are reviewed in [apps-delivery](reviews/apps-delivery.md). Required canonical imports preserve grants and one authority, including the Employee/Location declaration-resolution cycle. Provider account/public tracking key/intake token cannot grant business roles.','',
      'A per-app qualification may start when its exact source verdict and used compiler/state/interface/provider/file capabilities release. No Chat image gate, no unrelated parent completion barrier, no corpus/runtime exclusion turning Knowledge into a deferred workflow. FP.QUALIFY is a full-corpus completion gate, not a prerequisite for each app packet. Existing active coordinator assignments stay separate.','',
      'Independent app challenges reread selected raw Mail/Invoice/Mailbox/corpus/expiry, maintenance/instrumentation/source mapping, Reception/Rent/Stock/Workbench sites. The [shared queue](findings.md) preserves source-policy disagreements and strongest countercases. This establishes intent tracing and reviewed target boundaries, not whole-app compiled/browser/provider execution or exhaustive branch review.']
    (OUT/'apps.md').write_text('\n'.join(app_text)+'\n')
    for d in ds:
        d['task_ids']=sorted(set(d['task_ids'])|set(scoped_tasks.get(d['id'],[]))|{t['id'] for t in ports+extra if set(d['target_paths'])&set(t.get('writes',[]))})
        d['task_scope']='Matching released duty/profile and current producer, not every unrelated parent gate; exact review contract/target site constrains these IDs'
        known={t['id'] for t in ports+challenge+descriptions+extra}
        aggregate=[i for i in d['task_ids'] if i not in known and re.fullmatch(r'C0[1-4]',i)]
        remaining=[i for i in d['task_ids'] if i not in known and i not in aggregate]
        d['external_task_refs']=[{'id':i,'namespace':'existing remaining coordinator packet','source':'implementation/REMAINING-IMPLEMENTATION-LANES.md','scope':'original duty site; no new assignment/status'} for i in remaining]
        d['aggregate_port_refs']=aggregate
        d['task_ids']=sorted(({i for i in d['task_ids'] if i in known})|{t['id'] for t in ports if any(t['id'].startswith(i+'.') for i in aggregate)})
    dump('requirements.json',{'source_pin':inventory['source_pin'],'stage':'accepted intended requirements; mechanisms and newly proposed leaves separate','capabilities':[{'id':i,'title':t,'duty':d,'primary':p,'challenger':c} for i,t,d,p,c in CAPS],'duties':ds,
      'classifications':{'REQUIRED':'finished supported outcome mandatory; unavailable stays blocking','ACCEPTED-CONDITIONAL':'accepted bounded/profile/default direction with exact qualification/adoption condition','DEFERRED':'explicit excluded future scope, never hides required original workflow','DECLINED':'explicit rejected alternative at this scope; reasons in review'},
      'prohibited_inferences':['all checker restrictions justified','draft diagnostic is source error','test count proves workflow','Wasm core proves installed adoption','Rust allocation proves performance','source reference proves authorization or human approval'],
      'semantic_buckets':'a proven source defect; b required correct intent/missing implementation; c overly strict rule; d unadopted proposal; e deliberate negative, separately tracked from availability',
      'app_intent_ledgers':{name:{'record':f'reviews/{name}.json','apps':[r['app'] for r in review.get('apps',[])], 'shared_sources':review.get('shared',review.get('shared_sources',[]))} for name,review in apps.items()},
      'open_semantic_review':'Structural inventory is exhaustive at pin; exhaustive source/control-path/independent test-body review remains an explicit FP.SOURCE-CLOSURE gate, not inferred from path or symbol counts.'})
    leaves={};reservations=[]
    def add(p,reason,disposition='REQUIRED',sources=(),task=None):
        if p.endswith('/'):reservations.append({'directory':p,'reason':reason,'disposition':disposition,'gate':'fixture/generated ABI names must freeze before cutover; directory is not counted as exact leaf'});return
        targets=by_source[p]['targets'] if p in by_source else [p]
        for target in targets:
            if target=='draft':continue
            v=leaves.setdefault(target,{'path':target,'owner':owner(target),'capability':capability(target),'sources':[],'duties':[],'tasks':[],'dispositions':[],'status':'existing' if (ROOT/target).is_file() else 'proposed defining/generated leaf; not implemented'})
            for k,vals in [('sources',sources),('duties',[reason]),('tasks',[task] if task else []),('dispositions',[disposition])]:
                for value in vals:
                    if value not in v[k]:v[k].append(value)
    for a in allocations:
        for p in a['targets']:add(p,'input-accountability:'+a['capability'],sources=[a['source']])
    for d in ds:
        for p in d['target_paths']:add(p,d['id'],d['disposition'],d['source_paths'])
    for t in ports+extra:
        if t['disposition']=='DEFERRED':continue
        for p in t.get('writes',[]):add(p,t['id'],t['disposition'],task=t['id'])
    # Named ABI output proposal makes generated-directory duty reviewable. Producer gate may revise the stem.
    generated=['packages/values/bindings/generated/values.js','packages/values/bindings/generated/values.d.ts','packages/values/bindings/generated/values.wasm',
       'packages/values/dist/semantics/values.js','packages/values/dist/semantics/values.wasm','packages/work-kernel/dist/bindings/work-kernel.js','packages/work-kernel/dist/bindings/work-kernel.wasm',
       'packages/ui/dist/browser/can-browser.js','packages/ui/dist/browser/can.css','packages/ui/dist/browser/manifest.json']
    for p in generated:add(p,'generated-output-proposal; exact ABI/installed import inventory gate; stem may revise','ACCEPTED-CONDITIONAL')
    for p in sorted(OUT.rglob('*')):
        if p.is_file() and '__pycache__' not in str(p):add(str(p.relative_to(ROOT)),'planning-bookkeeping; one current living target')
    # Exact final compiler roots: current predecessor paths are transition inputs, not second module roots.
    for selected in reviews['language']['selected_decomposition']:
        if selected['source'] not in selected['selected_targets']:leaves.pop(selected['source'],None)
    current_paths={r['path'] for r in inventory['rows']+inventory['added_inputs']}
    for p in ['packages/cloudflare/src/deploy/bundle/modules.ts','packages/cloudflare/src/deploy/bundle/vendors.ts','packages/cloudflare/src/deploy/bundle/scan.ts']:
        if p not in current_paths:leaves.pop(p,None)
    for p in list(leaves):
        if '/cloudflare/src/runtime/dispatch/' in p and p not in current_paths:leaves.pop(p,None)
    retirement=[]
    for a in allocations:
        if a['source'] not in a['targets']:
            retirement.append({'predecessor':a['source'],'successors':a['targets'],'gate':a['gate'],'retirement':'only after actual callers/build/tests/installed imports cut over; source not deleted here'})
    optional=[{'id':t['id'],'disposition':t['disposition'],'required_in_port':False,'condition':t.get('required_when_product',t['acceptance']),'writes':t['writes']} for t in ports if not t['required']]
    dump('target-tree.json',{'source_pin':inventory['source_pin'],'checkpoint_advanced':False,'input_allocations':allocations,'target_leaves':sorted(leaves.values(),key=lambda x:x['path']),
       'retirements':retirement,'directory_reservations':reservations,'deferred_target_leaves':[{'path':p,'task':t['id']} for t in ports if t['disposition']=='DEFERRED' for p in t['writes']],
       'optional_task_dispositions':optional,'generated_inventory_gate':'Named values/work/browser output stems are NEW-PROPOSED ABI/asset inventory, not demonstrated tool output; C03/A07/W05/C04 actual producer naming must be reconciled before implementation/cutover.',
       'semantic_retirements':'matching work/state duplicate mechanism bodies and native scoped calculations only after full domain/trace/caller proof; retain observable public wrappers/TS rollback. Parser prototype/catalog mirrors only after actual replacement caller parity.',
       'supersessions':['new target incorporates existing selected structural tree, extends intended required capabilities','selected native job supersedes old unimplemented generic bundle split','runtime/work partition supersedes old unimplemented dispatch partition','the historical 12-package/TS-only statement is not a finished-language freeze; work-owned leaf and package Rust cores/native crate included']})
    all_tasks=ports+challenge+descriptions+extra
    ids={t['id'] for t in all_tasks};assert len(ids)==len(all_tasks)
    for t in all_tasks:
        t['target_writes']=sorted({q for p in t.get('writes',[]) if not p.endswith('/') for q in (by_source[p]['targets'] if p in by_source else [p])})
        t['writer_resources']=sorted({owner(p) for p in t.get('writes',[])})
    # Union conditional edges to verify an order allowing every accepted optional branch.
    deps={t['id']:set(t.get('depends_on',[]))|{d for c in t.get('conditional_dependencies',[]) for d in c['depends_on']} for t in all_tasks}
    unknown={d for ds0 in deps.values() for d in ds0 if d not in ids};assert not unknown,unknown
    done=set();order=[]
    while len(done)<len(ids):
        ready=sorted(i for i in ids-done if deps[i]<=done)
        assert ready,{'cycle_or_missing':sorted(ids-done)}
        order+=ready;done.update(ready)
    conflicts=collections.defaultdict(list)
    for t in all_tasks:
        for p in t['target_writes']:conflicts[p].append(t['id'])
    dump('tasks.json',{'scope':'finished-product planning, not active coordinator assignments','port_counts':{'all':len(ports),'required':sum(t['required'] for t in ports),'conditional_or_deferred':sum(not t['required'] for t in ports)},
       'exclusive_writer_conflicts':{p:ids for p,ids in sorted(conflicts.items()) if len(ids)>1},
       'tasks':all_tasks,'remaining_packet_crosswalk':supplemental,'topological_order_all_conditional_edges':order,'original_manifest':str((PORTS/'execution-manifest.json').relative_to(ROOT)),
       'original_manifest_preserved':True,'dispatch_capacity':'not fixed; choose actual ready capacity with one writer per exact resource and measured heavy-check limits; no workers launched',
       'parent_completion_policy':'Readiness/foundation gates release actual consumers; parent closes only full promised scope, positive/negative/installed/recovery evidence; decline acceleration never declines mandatory interface workflow.',
       'legacy_findings_policy':'Old C01-C15/R01-R08 are historical corrective/decomposition evidence. Revalidate against current source and current owner acceptance before allocating duplicate work; original R01 independent review and coordinator C01 remain their own scopes.'})
    write_docs(inventory,ds,allocations,leaves,ports,challenge,descriptions,extra,supplemental,order)
    apply_documentation_review()
    print(json.dumps({'duties':len(ds),'port_tasks':len(ports),'challenge_tasks':len(challenge),'description_tasks':len(descriptions),'new_packets':len(extra),'input_allocations':len(allocations),'target_leaves':len(leaves),'directory_reservations':len(reservations),'ordered_tasks':len(order)}))

def write_docs(inv,ds,alloc,leaves,ports,challenge,descriptions,extra,supplemental,order):
    capcounts=collections.Counter(a['capability'] for a in alloc)
    text=['# Intended finished Canlang: requirements and workflows','',
      'This is the current target derived from authored company-SaaS intent and accepted contracts. It supersedes the older audit’s current-checkout allocation as a complete product target, while preserving reusable responsibility evidence. Files are chosen after requirements; package folders are not the slice definition. No product execution or implementation launch is claimed.','',
      '| Capability | Required outcome | Primary / independent challenger | Accountable inputs |','| --- | --- | --- | --- |']
    for id,title,duty,p,c in CAPS:text.append(f'| {id} {title} | {duty} | {p} / {c} | {capcounts[id]} |')
    text+=['','Every input has a primary path allocation in [target-tree.json](target-tree.json); mixed-file duties also appear in [requirements.json](requirements.json), symbol/import internals in [oversized.json](oversized.json), and the four [reviews](reviews/product.md). Source counts, workflow tracing, independent challenge and exact targets are separate dimensions. Symbol extraction is structural evidence, not a semantic proof.','',
      'The end-to-end contracts are reconstructed in [language](reviews/language.md), [state/work](reviews/work.md), [identity/interfaces/browser](reviews/product.md), and [delivery](reviews/delivery.md). Read those lifecycle/authority/failure/termination records before implementing a target leaf. The full 49 app/companion pairs and three shared declarations are recorded in [app language](reviews/apps-language.md), [app work](reviews/apps-work.md), and [app delivery](reviews/apps-delivery.md), with exact operations, source hashes, authority/lifecycle/negatives and focused independent challenges. Required unavailable behavior remains required; a new filename never establishes an API. [Shared findings](findings.md) and [late source reconciliation](late-source.md) constrain all dependent instructions.','',
      'Workflow families: authored composition → generated operations; create/default/update/read with current grants and replay; imported business relationships and bounded hook rollback; account/team/grant lifecycle; browser/MCP equal-authority calls; independent notifications/reminders and uncertain external outcomes; selected receipts/progress/recovery; receiving-app file finalization; complete finite Shift/Volunteer cohorts; private grounded Knowledge with all-used-context disclosure; self-only settings/CSV/current polling/export/Print; source retention/schema maintenance; deterministic descriptions/reference; installed release and rollback; compiled causal examples and original qualification.','',
      'Fanout, corpus, containment, hooks and reads have accepted scoped contracts. Their runtime/consumer proof gates are not invitations to reopen the language rules. A genuinely new consequential mechanism still requires verified balanced triple JEV advice and a released owner contract. Specialized foundations stay excluded by REQUIREMENTS; app diagnostics alone never justify scoping out coherent company workflows.','',
      '| Disposition | Meaning in this plan |','| --- | --- |','| REQUIRED | Finished supported outcome is mandatory. Missing producer or runtime blocks that outcome. |','| ACCEPTED-CONDITIONAL | Accepted optimization/profile/default direction; exact consumer/provenance/resource/installed/adoption gate remains. |','| DEFERRED | Explicit additional scope, such as W09 continuation scheduler or localized MCP; no mandatory workflow hidden here. |','| DECLINED | Duplicated authority, automatic semantic fallback, silent caps/narrowing, false cross-store atomicity, alternate per-app setup. See reasons in reviews. |','',
      'The draft conflict buckets a–e remain orthogonal: proven source error, correct missing implementation, too-strict rule, unadopted proposal, deliberate negative. Preserve intent, opposing case, uncertainty, exact site and evidence that changes a verdict. D-series reference first delivery remains localized internal Markdown with source-language IDE/MCP; no new translation quota, public hosting or description consultation.']
    (OUT/'workflows.md').write_text('\n'.join(text)+'\n')
    baseline=f'''# Inputs, baselines and writer boundary

Literal checkout `{inv['checkout']}`, branch `{inv['branch']}`, current structural/catalog pin `{inv['source_pin']}`; initial new semantic review `{inv['initial_semantic_review_pin']}`. The independent draft pin is `{inv['draft']['pin']}` with {len(inv['draft']['rows'])} nested paths. Parent tracked catalog: {len(inv['rows'])}; other-owner added inputs: {len(inv['added_inputs'])}. All {len(inv['delta_since_complete_checkpoint'])} accumulated path deltas since complete checkpoint `{inv['complete_checkpoint']}` are recorded, including deletion/move history; no checkpoint advances. Historical primary `{inv['historical_primary']}` is a separate review baseline. [Late source](late-source.md) accounts for the post-review paths at their distinct recorded review scopes and supersedes only stated source-availability claims.

Contract/proposal/intent byte pins, dirty state, JSON/data/build/source internals and exact input roles are in [inventory.json](inventory.json). Changed source does not inherit old semantic acceptance; identical bytes reuse only the older recorded review scope. Current defining bodies were reread for the new requirements/review records; tests and historical owner acceptance retain their original scope. The complete review checkpoint remains old because joined source/deep review is unfinished. Open product defects and unperformed qualification are separate acceptance dimensions; neither a passing structural check nor review agreement substitutes for complete source review. This audit reviews and accounts for the delta, rather than claiming every new test body or branch fully proved.

Current live writers are the existing Muse coordinator and package owners, recorded in `REMAINING-IMPLEMENTATION-LANES.md`, read-only `remaining-tasks.md` and port `evidence/implementation/shared/ownership.json`. Old stopped-state text is historical; the latest authorized implementation run is active. Codex owns the living audit, and that schedule explicitly excludes unrelated living-filetree edits from coordinator ownership. This audit owns `docs/ideal-filetree-plan/finished-product/` and a final entry-point integration. It preserves other integrators' `integration-20261006-*.json` and untracked evidence. Agents owned disjoint review pairs and app ledgers; they edited no source or active checklist. No new messages to external chats, assignments, branches, worktrees, sessions, grants or timers were issued.

The installed ideal-filetree skill has only SKILL.md; searches of local skills/plugins found no referenced procedure/records/scheduling files or checker. The supplied eight-step method was followed. [capture.py](capture.py), [converge.py](converge.py) and [check.py](check.py) are local standard-library audit checks, separately scoped; they are not the missing prescribed checker or product tests. The model-selection skill supported focused Sol High primary/challenger reviews of cross-file uncertainty.

Performed evidence: repository/blob/status/submodule/diff reads; source/contract/draft/witness interpretation; per-path SHA-256; source symbol/import and data/config structural catalog; manifest/dependency/ownership/collision/link checks; three new preauthorized JEV native-host/publication consultations. No product tests/builds/install/deploy/provider calls or source/Git mutations occurred. The consultations are design advice, not runtime proofs.

After each merge, its handler reconciles all accumulated changes against the complete checkpoint, updates coverage/decisions/owners/targets/retirements/tasks/lanes together, and advances only after complete review. Bookkeeping does not recursively update itself or grant implementation. Current source/contract drift after this pin must be reclassified before acceptance.
'''
    (OUT/'baseline.md').write_text(baseline)
    owners='''# Defining owners and language/package fit

Choose technology at each authority boundary; this plan does not preserve a fixed language/package count. `.can` owns application identity/composition and business intent. Rust owns the supported compiler and selected package-owned pure exact/owned-validation/work mechanisms plus standalone native preparation. TypeScript owns observable JS traversal/carriers, browser/SDK integrations, storage and provider callbacks, authority, orchestration and publication. Shared description locale/ICU/timezone remains the existing host owner. Build/config Python or shell does not become a semantic runtime.

The values local workspace contains one shared Rust semantics crate for exact mechanisms and ordered validation with distinct profiles, plus the versioned binding crate. Work uses the work-owned contracts-only `work-kernel` leaf; state never imports full-work/public stdlib back into itself. Native preparation is Cloudflare-owned and independent of those crates and compiler for packaging convenience. No root Cargo workspace couples the compiler to ports. Generated catalog facts flow from owning implementations to checking/discovery/forms/reference, never four manually maintained schemas. Compiler static literal contexts/spans retain their owner and use conformance/catalog handshakes; direct Rust core reuse is deferred until a separate sound contract/cost gate.

Prepared TS/current TS and actual Rust must meet the same inputs/errors/identity/bytes/order/authority/delivery outcomes. Native reuse or measured whole-call benefit can justify the compatible core; Rust default remains conditional. Unknown objects, getters/proxies/callbacks, custom iterators/prototypes, repeated reads, mutable schemas, locale/ICU, payload identities and ordinary public APIs stay on TS until full-domain equivalence is proved. Ownership tokens must precede graph exposure; freezing/snapshotting arbitrary inputs manufactures no provenance. Backend selection precedes evaluation; selected Rust trap/integrity/error never replays through TS.

Keep broad public TS preparation helpers and rollback until their caller domains are covered. The native retained job owns admitted semantic tree/index/buffers/calculations; TS retains ordered parse/producer/catalog/activation/Bun/confirmation/publish/apply. Text-only v1 behavior—including existing character-count conventions—stays exact; mixed text/Wasm format has explicit kind/raw-byte/hash/version rules. Worker maps never carry native binaries. One actual values/work initialized module preserves synchronous calls after startup. Tiny smoke proves a loader, never those final binaries or installed consumers.

The existing selected compiler/private structural partitions are reused and reconciled, with the final module coordinator under `mod.rs` and predecessor retained only until import/span/diagnostic/artifact/consumer cutover. Functional repairs do not wait for a refactor. The selected native job supersedes unimplemented generic TS bundle decomposition for its semantic duties; the private `runtime/work` partition supersedes old unimplemented dispatch leaves. Every retained/moved input, successor and retirement gate is exact in [target-tree.json](target-tree.json); no two module roots/semantic authorities are intended.

New required corpus/lifetime/durable-file/identity/browser/CSV/preferences/export/installed-release/upgrade seams are proposals grounded in accepted product requirements. Interface agreement and consequential unsettled mechanism gates precede implementation; the audit does not assert installed APIs. State remains one authoritative commit engine. Identity's separate tables require an explicit verified-context typed conditional-outcome/fence transaction participant; registering a system command is insufficient. R2/blob + owner state and external providers remain recoverable coordination, never imaginary atomic transactions.

Native support is explicit qualified opt-in. Existing compiler release candidates are Linux x86_64 and macOS aarch64, with no native preparation hosts qualified by this audit. Preserve current explicit TS support. Bundle native binaries in owning dist as a provisional target; JEV publication advice split with low confidence. Compare actual compressed/raw size/install/error/release complexity with optional host packages before adopting that topology. No universal Node/Windows native promise or new signing claim follows. The [consultation record](consultations.md) saves raw distributions and uncertainty.

Retirement applies to matching duplicate mechanism bodies only after complete caller-domain and actual consumer conformance. Keep work/state error/staging profiles, replay/raw hash order and callback demand with their wrappers. Keep Python syntax tooling/manual catalog transcriptions until replacement syntax/locations/callers or owner-generated catalog proof. Missing capability remains visible and blocks its advertised workflow.
'''
    (OUT/'ownership.md').write_text(owners)
    native=[]
    for i in (1,2,3):
        result=json.loads((OUT/'consultations'/f'result-{i}.json').read_text())['response'];native.append(result)
    consult=['# Consultation, uncertainty and policy','','Native supported-host/publication is materially new to the finished-product integration. Three preauthorized `choice` requests use identical verified outcomes/criteria with independently worded questions. Source facts are pinned in requests and delivery review; repeated description/corpus/fanout decisions were not consulted anew.','','| Call | Support choice / confidence | Publication choice / confidence |','| --- | --- | --- |']
    for i,r in enumerate(native,1):
        a=r['answers'];consult.append(f"| [{i}](consultations/result-{i}.json) | {a['native_support']['choice']} / {a['native_support']['confidence']} | {a['native_publication']['choice']} / {a['native_publication']['confidence']} |")
    consult+=['','Support advice agrees on qualified opt-in. Packaging advice is divided and weak: two bundled, one optional host packages. Existing files:[dist]/stamp/notices favors a simple bundled starting target; optional packages may save irrelevant-host download bytes but add release/install failure topology. No future binary sizes or full installed evidence exist. The choice remains provisional behind P09/C04/FP.INSTALLED-RELEASE measurement/install proof, with exact target revision required before an alternate package topology. Confidence is advisory and cannot establish optimality or readiness.','',
      'Existing triple package-port advice (work leaf, explicit bootstrap, bounded validator join, staged native job) is reused only for those choices. Existing description-reference mixed advice and corrected finite-cohort/corpus advice retain their uncertainty and accepted scopes. The review distinguishes owner policy from unrestricted technical superiority. Newly unsettled identity transaction-participant/storage contracts require balanced triple consultation with the exact resolved authority context before implementation; no mechanism was silently selected here.','',
      f"Reported new consultation usage: {sum(r['usage']['input_tokens'] for r in native)} input and {sum(r['usage']['output_tokens'] for r in native)} output tokens. All raw request/result files are retained; no credentials are printed or stored."]
    (OUT/'consultations.md').write_text('\n'.join(consult)+'\n')
    tree=['# Complete selected target leaves','','This exact manifest joins current retained/successor responsibilities, intended required capabilities and the four subsystem port task outputs. It is one evolving target. [Machine tree](target-tree.json) records each defining owner, source mapping, task and disposition; conditional/deferred/transition artifacts are explicit. Generated output stems/platform binaries are proposals behind producer ABI/install gates, not files created by this audit. Historical evidence remains retained but is not a second normative product contract.','','```text']
    tree += sorted(leaves)
    tree += ['```','','Predecessors appear only in the input/retirement ledger when their final successors replace them. Do not delete until actual importing callers/build/tests/install/export paths use those successors. Directory fixture reservations are not counted as exact generated leaves; freeze actual fixture names and generated binding outputs at the named owner gate before cutover. W09 deferred scheduler files are outside the selected product tree.']
    (OUT/'target-tree.md').write_text('\n'.join(tree)+'\n')
    tasks=['# Dependency-ordered packets and future lanes','','[tasks.json](tasks.json) preserves all 230 port items: 220 required in their declared scope and ten conditional/deferred. It also maps all 41 canonical challenge parents, eight description parents, the existing remaining packet rows, and new required product joins. Status is never copied from an old checkbox into this audit. Original manifests/checklists and coordinator ownership stay unchanged.','','## Work readiness and ownership','','The DAG, exact released interface and current reservation determine readiness. Foundation/readiness gates may release one consumer before a full parent closes. Gated original pilot needs only its real constructs; Chat does not wait for images; cohorts need imported containment only when used; fixtures wait only applicable source adjudication. A declared rejected Rust route does not remove mandatory HTTP/MCP/forms. Native JS-only cannot certify a selected mixed-Wasm consumer.','','Use actual ready capacity with exclusive file/resource writers; no fixed global worker count, fabricated duration or optimal makespan. Functional/current compiler paths remain execution boundaries until later gated structural cutover. One values binding/module integrator serializes A/V common lib/manifest/glue writes; one C-delivery owner serializes root lock/manifests/vendor/assets; work/runtime V09 handoffs preserve matching source and callback/replay order. Package owners receive exact consumer requests, not concurrent edits from other lanes. Heavy verification capacity is a measured resource separate from editing lanes. This plan launches nothing.','','| Logical lane | Exact responsibilities / producer handoff |','| --- | --- |','| Source/analysis | Compiler source contexts/catalog/descriptors/examples/reference; shared types/effects/IR/JS serialized by exact reservation. Draft corrections separately reserved. |','| Values/owned validation | Pure Rust exact/plan/profile modules in package-local core; distinct host facades and before-exposure provenance; one common binding integrator. |','| State authority | Canonical current reads/admission/defaults/hooks/containment/storage; identity/corpus/lifetime participants use released constrained contracts. |','| Durable work | Work-owned pure leaf modules vs TS scheduling/provider/receipt/progress/fanout/recovery shells; real state claim/commit/restart joins. |','| Identity/interfaces | Verified context/atomic credential outcomes, SDK/framing/schema/error/projection/upload/CSV/export/settings routes; no competing CRUD. |','| Presentation | Catalog/rendering/browser assets/focus/polling/settings/forms/CSV; current operation and page admission joins. |','| Native preparation | Separate Rust algorithm modules with one retained-job protocol/host integrator; Bun/catalog/stages/publication stay existing owners. |','| Delivery integration | One actual dependency graph/lock/export/release/asset/vendor/installed metadata/upgrade owner; common C04 requests serial. |','| Qualification | Isolated actual compiled fixtures/expectations and original per-app browser/MCP/storage/recovery evidence; no business bypass. |','| Planning/review | Independent challenge, scope/uncertainty/adoption ledger and complete post-merge reconciliation; no source assignment. |','','## New required product joins','','These fill accepted requirement duties absent from the old execution task tables. They are proposals for separately authorized implementation, not additions to active Muse assignments.','','| Packet | Depends on matching scope | Acceptance |','| --- | --- | --- |']
    for t in extra:tasks.append(f"| {t['id']} — {t['title']} | {', '.join(t['depends_on'])} | {t['acceptance'][0]} |")
    tasks+=['','## All port items','','Dependencies include explicit accepted-branch conditional edges in JSON; wave numbers never become barriers. Each source manifest preserves exact acceptance/actions/writes; target_writes resolves eventual structural successors.','','| ID | Plan / duty | Required in original port? | Finished disposition | Declared prerequisites |','| --- | --- | --- | --- | --- |']
    for t in ports:tasks.append(f"| {t['id']} | {t['plan']}: {t['title']} | {'yes' if t['required'] else 'no'} | {t['disposition']} | {', '.join(t['depends_on']) or 'none'} |")
    tasks+=['','## Original requirement mapping','','| Parent | Required target capabilities | Declared outcome |','| --- | --- | --- |']
    for t in challenge+descriptions:tasks.append(f"| {t['id']} | {', '.join(t['capabilities'])} | {t['title']} |")
    tasks+=['','## Verification ladder','','1. Adjudicate source/intent roots and freeze owner contract/profiles/ABI, retaining deliberate negatives and independent expected values.','2. Verify current/prepared/real Rust or native mechanism behavior with complete admitted domains, bytes/identity/errors/demand/host predicate traces and disposal.','3. Produce source-derived descriptors/catalogs/callables/examples and prove real canonical admission/commit/read joins, permitted hook/retention/corpus behavior.','4. Qualify actual package/module/browser/native outputs outside checkout and in real workerd/D1/DO: startup, missing/corrupt/ABI errors, built consumers, restart/fences/rollback.','5. Run original browser/MCP/compiled examples and causal workflow matrices with provider/file evidence honestly labeled. All cohort M1–M10 and original finite sizes retained.','6. Compare complete caller/job economics/current and prepared TS, conversion/startup/resources and actual reuse; choose backend/default/rollout with same persisted data rollback. No performance claimed before measurement.','7. Reconcile corpus advertised scope and all accumulated merge deltas; only complete independent review can advance living checkpoint.','','All these are future acceptance duties; this audit ran only its documented read-only planning checks.']
    (OUT/'tasks.md').write_text('\n'.join(tasks)+'\n')

def apply_documentation_review():
    """Join selected documentation dispositions without recapturing historical source pins."""
    review_path=OUT/'documentation-review.json'
    if not review_path.exists():return
    review=json.loads(review_path.read_text())
    tree=json.loads((OUT/'target-tree.json').read_text())
    catalog=json.loads((OUT/'tasks.json').read_text())
    requirements=json.loads((OUT/'requirements.json').read_text())
    findings=json.loads((OUT/'findings.json').read_text())
    selections={source:r for r in review['selected_allocations'] for source in r['sources']}
    remap={source:r['target'] for source,r in selections.items()}
    for a in tree['input_allocations']:
        if a['source'] in selections:
            r=selections[a['source']]
            a.update(targets=[r['target']],decision=r['decision'],gate=r['gate'],
                     documentation_review='documentation-review.json',
                     semantic_review='Document roles, reference dependencies and independent focused review; topic deletion requires complete content-preservation gate.')
    leaves={}
    def add_leaf(row):
        path=remap.get(row['path'],row['path'])
        v=leaves.setdefault(path,dict(row,path=path,owner=owner(path)))
        for key in ('sources','duties','tasks','dispositions'):
            v[key]=sorted(set(v.get(key,[]))|set(row.get(key,[])))
        if path!=row['path']:
            v['status']='existing relocated document' if path in {r['target'] for r in review['root_locations']} else 'proposed consolidated topic record; source notes still retained'
    for row in tree['target_leaves']:add_leaf(row)
    def ensure_leaf(path,task=None):
        if path.endswith('/'):return
        path=remap.get(path,path)
        if path not in leaves:
            leaves[path]={'path':path,'owner':owner(path),'capability':capability(path),'sources':[],
                          'duties':['documentation ownership or planning bookkeeping'],'tasks':[],
                          'dispositions':['REQUIRED'],'status':'existing' if (ROOT/path).is_file() else 'proposed defining leaf'}
        if task and task not in leaves[path]['tasks']:leaves[path]['tasks'].append(task)
    for name in ('documentation-inventory.json','documentation-review.json'):
        ensure_leaf(str((OUT/name).relative_to(ROOT)))
    for source,r in selections.items():
        ensure_leaf(r['target'],r['task'])
        leaves[r['target']]['sources']=sorted(set(leaves[r['target']]['sources'])|{source})
        if r.get('execution_status')=='applied locally':
            leaves[r['target']]['status']='existing relocated document' if r['task']=='DOC01' else 'existing consolidated consultation record; original source sections and evidence retained'
    selected_sources=set(selections)
    tree['retirements']=[r for r in tree['retirements'] if r['predecessor'] not in selected_sources]
    tree['retirements'] += [{'predecessor':source,'successors':[r['target']],'gate':r['gate'],
                            'retirement':'completed editor audit retired from working tree; exact bytes and logical paths recover from pinned Git revision' if r['task']=='DOC07' else 'root relocation applied locally; original historical evidence preserved' if r['task']=='DOC01' else 'lossless consultation consolidation applied locally; original sections retained, superseded file retired' if r.get('execution_status')=='applied locally' else 'proposed lossless consolidation; source not deleted here'} for source,r in sorted(selections.items()) if source!=r['target']]
    tree['documentation_review']='documentation-review.json'
    catalog['tasks']=[t for t in catalog['tasks'] if t['namespace']!='documentation']+review['tasks']
    for t in catalog['tasks']:
        t['target_writes']=sorted({remap.get(p,p) for p in t.get('target_writes',t.get('writes',[])) if not p.endswith('/')})
        if t['namespace']=='documentation':
            t['target_writes']=sorted({remap.get(p,p) for p in t['writes'] if not p.endswith('/')})
            if t['disposition']!='DEFERRED':
                for p in t['target_writes']:ensure_leaf(p,t['id'])
    ids={t['id'] for t in catalog['tasks']}
    deps={t['id']:set(t.get('depends_on',[]))|{d for c in t.get('conditional_dependencies',[]) for d in c['depends_on']} for t in catalog['tasks']}
    done=set();order=[]
    while len(done)<len(ids):
        ready=sorted(i for i in ids-done if deps[i]<=done)
        assert ready,{'cycle_or_missing':sorted(ids-done)}
        order+=ready;done.update(ready)
    catalog['topological_order_all_conditional_edges']=order
    conflicts=collections.defaultdict(list)
    for t in catalog['tasks']:
        for p in t['target_writes']:conflicts[p].append(t['id'])
    catalog['exclusive_writer_conflicts']={p:tasks for p,tasks in sorted(conflicts.items()) if len(tasks)>1}
    requirements['duties']=[d for d in requirements['duties'] if not d['id'].startswith('DOCUMENTATION-')]
    for t in review['tasks']:
        requirements['duties'].append({'id':'DOCUMENTATION-'+t['id'],'review':'documentation-review.json',
            'requirement':t['title'],'disposition':t['disposition'],'source_paths':t['writes'],
            'target_paths':t['target_writes'],'task_ids':[t['id']],'gate':t['gate'],
            'evidence':['documentation-inventory.json','documentation-review.json'],
            'availability':t['execution_status']})
    findings['items']=[r for r in findings['items'] if r['id']!='BOUND-DOCUMENTATION']
    findings['items'].append({'id':'BOUND-DOCUMENTATION','boundary':'documentation authority, navigation and evidence',
        'finding':'Only README and AGENTS remain at root; four specification owners and the completed evaluation plan relocated. Selected 52-to-25 topic consolidation preserves corrections and uncertainty; captured duplicate bytes are retained until reconstruction proof.',
        'owner_gate':'DOC01 and DOC02 applied locally; DOC03-DOC05 require exact owner/content gates; DOC06 deferred' if review.get('execution',{}).get('topic_consolidation') else 'DOC01 applied locally; DOC02-DOC05 require exact owner/content gates; DOC06 deferred',
        'classification':'accepted documentation placement; conditional content consolidation',
        'status':'Root relocation and selected27-file consolidation applied; further pruning remains conditional/deferred' if review.get('execution',{}).get('topic_consolidation') else 'Root relocation applied; broader pruning not executed','evidence':'documentation-review.json'})
    retired_audit=review.get('execution',{}).get('completed_editor_audit',{})
    if retired_audit:
        leaves['docs/ideal-filetree-plan/finished-product/documentation-review.json']['status']='existing documentation disposition and pinned Git recovery ledger'
        finding=findings['items'][-1]
        finding['finding']+=' Completed editor audit has no live build/test/install consumer; all 187 files recover exactly from its pinned Git revision.'
        finding['owner_gate']+='; DOC07 editor audit retirement applied locally; other captured evidence remains under DOC06'
        finding['status']+='; 187 editor archive files including 23 Markdown retired from working tree'
    for leaf in leaves.values():
        for key in ('sources','duties','tasks','dispositions'):leaf[key]=sorted(set(leaf[key]))
    tree['target_leaves']=sorted(leaves.values(),key=lambda r:r['path'])
    for name,value in [('target-tree.json',tree),('tasks.json',catalog),('requirements.json',requirements),('findings.json',findings)]:dump(name,value)
    target=OUT/'target-tree.md'
    text=target.read_text()
    text=re.sub(r'```text\n[\s\S]*?\n```','```text\n'+'\n'.join(sorted(leaves))+'\n```',text,count=1)
    target.write_text(text)
    # Reuse existing narrative owners; the audit introduces no additional Markdown pages.
    def section(file,body):
        text=file.read_text();start='<!-- documentation-review:start -->';end='<!-- documentation-review:end -->'
        text=re.sub(re.escape(start)+r'[\s\S]*?'+re.escape(end)+r'\n?', '',text).rstrip()
        file.write_text(text+'\n\n'+start+'\n'+body.rstrip()+'\n'+end+'\n')
    common='## Markdown placement and consolidation\n\nOnly `README.md` and `AGENTS.md` remain at the repository root. The current requirements, design, grammar, and decision log are in `docs/specification/`; the completed evaluation plan is `design/evaluation/PLAN.md`. These five moves and live reference repairs are applied locally, including the separate draft working tree; publication and complete checkpoint advancement remain separate.\n\n[Documentation inventory](documentation-inventory.json) records 490 tracked and three added Markdown paths at its observation. [Review and migration ledger](documentation-review.json) retains every disposition, original hash, exact successor, task and preservation gate. The selected target consolidates 52 small assessment/correction notes into 25 topic records, potentially reducing Markdown by 27 files. This consolidation remains future work. Moving the five root files alone does not reduce total file count. Frozen captures, final report bytes and raw consultation JSON retain their provenance.\n\nKeep project decisions in `docs/specification/DECISIONS.md`; proposals and accepted decisions have distinct status. Prior-plan prose, shared setup guidance and superseded launch instructions have further scoped review tasks; archival moves alone are not pruning. All 493 paths are structurally accounted for, but focused semantic review does not certify every paragraph for deletion.'
    if review.get('execution',{}).get('topic_consolidation'):
        common=common.replace('The selected target consolidates 52 small assessment/correction notes into 25 topic records, potentially reducing Markdown by 27 files. This consolidation remains future work.',
            'The selected consolidation is applied: 52 assessment/correction notes now form 25 topic records, reducing Markdown by 27 files. All original source blocks, corrections, uncertainty, witnesses and limitations were preserved under heading/navigation normalization and independently cross-reviewed; 169 raw JSON records remain byte-identical. Stable source anchors replace old note paths. The ledger records original hashes, section preservation hashes, live reference repairs and 51 retired predecessors; one existing README was retained and 24 new successors created.')
    if retired_audit:
        common+='\n\nThe completed `editors/vscode/audit-astra/` working copies are retired: 187 files, including 23 Markdown files and 42,687,533 bytes. No build/test/install consumer depends on them; the active highlighting checker retains the defect regressions. The existing ledger pins all original paths, sizes and SHA-256 hashes to Git revision `'+retired_audit['revision']+'`; a fresh archive extraction reproduced every byte. Existing audit navigation uses commit-pinned links and recovery instructions. This scoped retirement does not authorize pruning other captures, change historical review conclusions, or advance the checkpoint. DOC06 remains deferred for broader storage deduplication.'
    for name in ('ownership.md','findings.md','workflows.md','target-tree.md'):section(OUT/name,common)
    task_text=common+'\n\n| Task | Selected work | Execution / gate |\n| --- | --- | --- |\n'
    for t in review['tasks']:task_text+=f"| {t['id']} | {t['title']} | {t['execution_status']}; {t['gate']} |\n"
    task_text+='\nThese documentation tasks do not impose a global barrier on product lanes. Serialize actual overlapping document writers and preserve active coordinator records until the owning handoff.'
    section(OUT/'tasks.md',task_text)
    section(ROOT/'docs/ideal-filetree-plan.md',common.replace('(documentation-inventory.json)','(ideal-filetree-plan/finished-product/documentation-inventory.json)').replace('(documentation-review.json)','(ideal-filetree-plan/finished-product/documentation-review.json)'))

if __name__=='__main__':converge()
