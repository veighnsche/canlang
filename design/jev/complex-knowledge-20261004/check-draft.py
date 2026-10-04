"""Bounded source/desired-target checks; this does not execute Can semantics."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

can = Path('draft/CanKnowledge.can')
js = Path('draft/CanKnowledge.mjs')
s, j = can.read_text(), js.read_text()
lines = s.splitlines()
out, excluded = [], []
i = 0
while i < len(lines):
    line = lines[i]
    if line.startswith('  # Index only current publications') or line.startswith('  corpus '):
        excluded.append(f'{i+1}: corpus declaration/attached description')
        i += 1
        continue
    if line.startswith('   examples') and i+1 < len(lines) and lines[i+1] == '    do':
        start = i+1
        i += 1
        while i < len(lines) and (not lines[i].strip() or len(lines[i])-len(lines[i].lstrip()) >= 4):
            i += 1
        excluded.append(f'{start}–{i}: shared-state sequence')
        continue
    replacement = re.sub(r'delivery\([^)]*\)', 'text', line)
    if replacement != line:
        excluded.append(f'{i+1}: delivery associations replaced with text for syntax only')
    if ' poll=5s' in replacement:
        excluded.append(f'{i+1}: page poll attribute omitted')
        replacement = replacement.replace(' poll=5s', '')
    out.append(replacement)
    i += 1
projection = Path('/tmp/canknowledge-business-projection.can')
projection.write_text('\n'.join(out)+'\n')
commands = [
    ['node', '--check', str(js)],
    ['python3', 'tools/can_parser.py', str(can)],
    ['python3', 'tools/can_parser.py', str(projection)],
    ['node', 'design/jev/complex-knowledge-20261004/final-descriptor-review.cjs'],
]
results = []
for command in commands:
    run = subprocess.run(command, text=True, capture_output=True)
    results.append({'command':' '.join(command), 'exit':run.returncode,
                    'output':(run.stdout+run.stderr).strip()})
assert [r['exit'] for r in results] == [0, 1, 0, 0], results
scenarios = re.findall(r'^  scenario (\w+)', s, re.M)
models = re.findall(r'^  ([A-Z]\w+)(?: in \w+)? \{', s, re.M)
fixtures = re.findall(r'^  fixture (\w+)=', s, re.M)
assert len(scenarios) == 15 and all(f'async {x}(c,' in j for x in scenarios)
assert all(f'"knowledge.{x}":{{handler:"{x}"' in j for x in scenarios)
assert len(models) == 8 and all(f'"knowledge.{m}":{{' in j for m in models)
assert len(fixtures) == 18 and all(f'const {f}=' in j for f in fixtures)
source_examples = len(re.findall(r'^   examples', s, re.M))
target_examples = len(re.findall(r'^  \{operation:"knowledge\.', j, re.M))
assert source_examples == target_examples == 14
assert len(re.findall(r'\bsequence:\[', j)) == 4
assert len(re.findall(r'^   \{dependencies:', j, re.M)) == 30
assert len(re.findall(r'^export async function \w+Page\(', j, re.M)) == 4
assert 'async progressed(c,{event})' in j
assert 'return {fixtures:{' in j
assert not re.search(r'\bresult:\s*"', j)
assert not re.search(r'by:\s*"[^"\n]+ or ', j)
assert not re.search(r'(?:table|list|gallery)\(\{[^\n]*\brows:', j)
assert 'count(row.Escalation)>0' in s
assert not re.search(r'\bseed:', j)
assert not re.search(r'\.trim\(', j)
assert len('Request leave early.') == 20
hashes = {str(p):hashlib.sha256(p.read_bytes()).hexdigest()
          for p in [can, js, Path('draft/CanKnowledge.md')]}
report = {'checks':results,
          'static':{'models':8,'scenarios':15,'fixtures':18,'example_blocks':14,
                    'table_rows':30,'sequence_blocks':4,'pages':4},
          'descriptor_review':json.loads(results[3]['output']),
          'projection_exclusions':excluded,'sha256':hashes}
Path('design/jev/complex-knowledge-20261004/static-verification.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
