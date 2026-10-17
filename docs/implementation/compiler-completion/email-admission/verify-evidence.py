#!/usr/bin/env python3
"""Qualify the saved finite email evidence without changing production."""
import hashlib
import json
from pathlib import Path

packet = Path(__file__).resolve().parent
vectors = json.loads((packet / 'vectors.json').read_text())
observations = json.loads((packet / 'baseline-observations.json').read_text())
assert len(vectors) == len(observations) == 113
assert len({x['id'] for x in vectors}) == 113
assert [x['id'] for x in vectors] == [x['id'] for x in observations]
for vector, record in zip(vectors, observations):
    assert record['expected'] == vector['expected']
    assert record['value'] == vector['value']
    assert vector['scalars'] == [f'U+{ord(c):04X}' for c in vector['value']]
    for direction in ['decode', 'encode']:
        result = record[direction]
        assert result['accepted'] == vector['expected'], (vector['id'], direction)
        if result['accepted']:
            assert result['value'] == vector['value']
        else:
            if direction == 'decode':
                assert result['error']['name'] == 'SchemaError'
                assert [{'path':x['path'],'code':x['code']} for x in result['error']['violations']] == [{'path':[],'code':'format'}]
            else:
                assert result['error']['name'] == 'ValueError'
                assert result['error']['code'] == 'invalid-construction'
    fixture = packet / 'fixtures' / record['id']
    source = (fixture / 'value.can').read_bytes()
    assert record['sourceHash'] == hashlib.sha256(source).hexdigest()
    check = json.loads((fixture / 'check.stdout').read_text())
    assert check['complete'] and check['omitted'] == 0
    assert all(x['code'] == 'E3001' and x['severity'] == 'error' for x in check['diagnostics'])
    assert bool(check['diagnostics']) == (not record['check']['accepted'])
    assert record['check']['accepted'] == record['compile']['accepted']
    if check['diagnostics']:
        assert len(check['diagnostics']) == 1
        primary = check['diagnostics'][0]['primary']
        assert primary == {'file':0,'start':source.index(b'=')+1,'end':source.rindex(b' }')}, vector['id']
    if record.get('generated'):
        assert record['generated']['imported']
        assert record['generated']['value'] == vector['value']
        for direction in ['decode', 'encode']:
            assert record['generated'][direction]['accepted'] == vector['expected']
qualification = {'syntaxQualifiedChecks':len(observations),'complete':True,'emailOnlyRejections':True,'literalDiagnosticAnchors':sum(not x['check']['accepted'] for x in observations),'emittedMetadataImports':sum(bool(x.get('generated')) for x in observations),'otherCompilerFindings':[]}
(packet / 'baseline-qualification.json').write_text(json.dumps(qualification,indent=2)+'\n')
print(json.dumps(qualification))
