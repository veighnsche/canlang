import pathlib,json,subprocess,time,statistics,hashlib,sys
root=pathlib.Path(__file__).parent
bins={'baseline':pathlib.Path('/private/tmp/canlang-pass7-profile/artifacts/current-native-can'),'current':pathlib.Path('/private/tmp/canlang-pass8-profile/artifacts/current-native-can')}
alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
def decode(mapping):
    rows=[];source=line=column=name=0
    for generated_line,text in enumerate(mapping.split(';')):
        generated_column=0
        for segment in text.split(','):
            if not segment:continue
            values=[];bits=shift=0
            for char in segment:
                n=alphabet.index(char);bits|=(n&31)<<shift
                if n&32:shift+=5
                else:
                    values.append(-(bits>>1) if bits&1 else bits>>1);bits=shift=0
            assert len(values) in (1,4,5) and shift==0
            generated_column+=values[0]
            if len(values)>1:
                source+=values[1];line+=values[2];column+=values[3]
                if len(values)>4:name+=values[4]
                rows.append([generated_line,generated_column,source,line,column,name if len(values)>4 else None])
    return rows
def outcome(artifact):
    value=json.loads(json.dumps(artifact))
    for module in value['modules']:
        mapping=module['map'];mapping['mappings']=decode(mapping['mappings'])
    return value
def run(which):
    command=[str(bins[which]),'compile','--format=json','--catalog',str(root/'catalog.json'),str(root/'ExpenseFlow.can')]
    start=time.perf_counter_ns();p=subprocess.run(command,capture_output=True,timeout=10);elapsed=(time.perf_counter_ns()-start)/1e6
    assert p.returncode==0,(which,p.stderr.decode());a=json.loads(p.stdout)
    return elapsed,a
witness={};samples={'baseline':[],'current':[]};order=[]
for _ in range(3):
    for side in bins:_,witness[side]=run(side)
assert outcome(witness['baseline'])==outcome(witness['current'])
for round in range(20):
    for side in (['baseline','current'] if round%2==0 else ['current','baseline']):
        elapsed,a=run(side);assert outcome(a)==outcome(witness['baseline']);samples[side].append(elapsed);order.append(side)
for side,a in witness.items():(root/(side+'.json')).write_text(json.dumps(a,indent=2)+'\n')
result={'warmups_per_side':3,'measured_rounds_per_side':20,'alternating_order':order,'milliseconds':samples,'median_ms':{k:statistics.median(v) for k,v in samples.items()},'independent_decoded_map_and_full_artifact_parity':True,'modules':len(witness['baseline']['modules']),'decoded_points':sum(len(decode(x['map']['mappings'])) for x in witness['baseline']['modules']),'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'ExpenseFlow.can',root/'catalog.json',*bins.values()]},'scope':'Bounded actual CLI compile for this fixed fixture/catalog on native host; includes process startup/full compile. No general speed claim.'}
(root/'results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['milliseconds','alternating_order','inputs']},indent=2))
