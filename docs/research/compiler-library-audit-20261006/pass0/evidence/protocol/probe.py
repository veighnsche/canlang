from pathlib import Path
import hashlib,json,platform,subprocess,os
ROOT=Path('/Users/vince/Projects/canlang')
OUT=ROOT/'docs/research/compiler-library-audit-20261006/pass0'
EV=OUT/'evidence/protocol'
BIN=Path('/private/tmp/canlang-compiler-pass0-38c0370/debug/can')
files=['compiler/src/json.rs','compiler/src/lsp/transport.rs','compiler/src/lsp/server.rs','compiler/src/diagnostic.rs','compiler/src/cli.rs','compiler/src/lib.rs','compiler/src/analysis/catalog.rs','compiler/src/docs.rs','compiler/tests/authoring.rs','compiler/tests/ide.rs','compiler/tests/common/lsp_driver.rs','compiler/tests/b3_authoring_join.rs','compiler/tests/b3_s4.rs','editors/vscode/test/lsp-capabilities.cjs','compiler/Cargo.toml','compiler/Cargo.lock','docs/research/compiler-library-audit-20261006/evidence/protocol-cli/probe-results.json']
hashes={f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files}
profile={'os':platform.platform(),'python':platform.python_version(),'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'source_sha256':hashes,'binary_sha256':hashlib.sha256(BIN.read_bytes()).hexdigest(),'binary_source_provenance':'Fresh locked lib+can build supplied by root: cargo build --locked --manifest-path compiler/Cargo.toml --lib --bin can --target-dir /private/tmp/canlang-compiler-pass0-38c0370; root captures build evidence separately.','commands':['python3 docs/research/compiler-library-audit-20261006/pass0/evidence/protocol/probe.py','rustc --edition=2024 -A warnings docs/research/compiler-library-audit-20261006/pass0/evidence/protocol/parser-probe.rs -o docs/research/compiler-library-audit-20261006/pass0/evidence/protocol/parser-probe','docs/research/compiler-library-audit-20261006/pass0/evidence/protocol/parser-probe'],'scope':'This worker performed no Cargo invocation, repository tests, dependencies or product-source changes. 5-second timeout per real process; EOF after supplied bytes; inherited env except catalog variable removed.'}
(EV/'profile.json').write_text(json.dumps(profile,indent=2)+'\n')
P='{"processId":null,"rootUri":null,"capabilities":{}}'
def req(id='1',method='initialize',params=P,version='"2.0"'):
 return '{"jsonrpc":'+version+(',"id":'+id if id is not None else '')+',"method":'+json.dumps(method)+(',"params":'+params if params is not None else '')+'}'
def frame(body):
 b=body if isinstance(body,bytes) else body.encode()
 return b'Content-Length: '+str(len(b)).encode()+b'\r\n\r\n'+b
cases=[]
def add(name,body,expected,status='established',gate=None):
 cases.append({'name':name,'wire_hex':frame(body).hex(),'expected':expected,'expectation_basis':status,'unresolved_gate':gate})
for name,id in [('id_min','-2147483648'),('id_max','2147483647'),('id_negative_zero','-0'),('id_string','"é😀"')]:
 add(name,req(id),{'responses':1,'response_id_raw':id,'result_has':'capabilities'},'LSP legal value + current raw-number fidelity')
add('id_absent',req(None,'$/cancelRequest','{"id":1}'),{'responses':0},'LSP notification rule')
for name,id in [('id_null','null'),('id_bool','true'),('id_array','[]'),('id_object','{}'),('id_fraction','1.5'),('id_above_lsp_range','2147483648')]:
 add(name,req(id),{'must_not_dispatch':True,'error_code':-32600,'response_id':None},'LSP type-invalid; proposed InvalidRequest/null mapping','Confirm invalid-ID response correlation policy before release')
for name,v in [('wrong_version','"1.0"'),('number_version','2')]:
 add(name,req(version=v),{'must_not_dispatch':True,'error_code':-32600},'JSON-RPC required version; response correlation gate','Confirm echo recognizable legal id vs null for invalid envelope')
add('params_scalar',req(params='4'),{'must_not_dispatch':True},'JSON-RPC invalid structured params','Choose envelope InvalidRequest vs method InvalidParams, with ordering')
add('params_null',req(params='null'),{'must_not_dispatch':True},'JSON-RPC invalid structured params','Same params admission/error mapping gate')
add('params_missing_initialize',req(params=None),{'must_not_initialize':True},'LSP InitializeParams required','Resolve compatibility with existing {} initialize helpers separately from envelope validation')
add('invalid_utf8',req('"PLACEHOLDER"').encode().replace(b'PLACEHOLDER',b'\xff'),{'must_not_dispatch':True,'error_code':-32700,'response_id':None},'UTF-8 requirement + proposed ParseError mapping','Confirm byte-decode error mapping')
add('malformed_json','{bad',{'responses':1,'error_code':-32700,'response_id':None},'JSON-RPC parse error')
add('valid_notification_unknown',req(None,'unknown/method','{}'),{'responses':0},'JSON-RPC no response to notifications')
add('invalid_request_no_id','{"jsonrpc":"2.0","method":4}',{'responses':1,'error_code':-32600,'response_id':None},'JSON-RPC invalid request example')
add('duplicate_id','{"jsonrpc":"2.0","id":1,"id":2,"method":"initialize","params":'+P+'}',{'decision_required':True},'RFC duplicate semantics not fixed','Retain first-match vs reject at LSP boundary; no silent last-wins migration')
add('integer_exponent_id',req('1e0'),{'decision_required':True},'Value is integral; numeric lexical policy not established','Separate lexical accessor compatibility from legal numeric ID value')
add('preinit_request',req('1','textDocument/hover','{}'),{'responses':1,'error_code':-32002,'response_id':1},'LSP initialization gate')
add('exit_before_shutdown',req(None,'exit',None),{'responses':0,'exit_code':1},'LSP exit rule')
openbody=req(None,'textDocument/didOpen','{"textDocument":{"uri":"file:///probe.can","languageId":"can","version":1,"text":"app A\\n"}}')
add('preinit_didopen',openbody,{'responses':0,'diagnostics':0},'LSP pre-initialize notification drop')
wire=frame(req())+frame(req('2','shutdown',None))+frame(req('3','textDocument/hover','{}'))+frame(req(None,'exit',None))
cases.append({'name':'shutdown_handshake','wire_hex':wire.hex(),'expected':{'response_ids':[1,2,3],'shutdown_result':None,'post_shutdown_error':-32600,'exit_code':0},'expectation_basis':'LSP lifecycle','unresolved_gate':None})
for c in cases:
 proc=subprocess.run([str(BIN),'lsp'],input=bytes.fromhex(c['wire_hex']),capture_output=True,timeout=5,cwd=ROOT,env={k:v for k,v in os.environ.items() if k!='CAN_PRODUCER_CATALOG'})
 c['observed']={'exit_code':proc.returncode,'stdout_hex':proc.stdout.hex(),'stdout_utf8':proc.stdout.decode(errors='replace'),'stderr_utf8':proc.stderr.decode(errors='replace')}
 c['execution']='bounded_fresh_locked_real_binary'
 c['comparison']='manual; independent expected specification/contract, not old-output golden'
(EV/'process-observations.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2)+'\n')
print('Saved',len(cases),'bounded process observations; curated witness contract is maintained separately')
