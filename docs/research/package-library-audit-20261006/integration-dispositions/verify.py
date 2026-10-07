#!/usr/bin/env python3
"""Verify audit records and exact source provenance; never execute product code."""
import collections
import hashlib
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = next(p for p in HERE.parents if (p / 'packages').is_dir())
BASE = HERE.parent
FREEZE = '780ab04ca60bad2e30f47ae4e7ae63e5ee838bb9'

def readj(path):
    return json.loads(path.read_text())

def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

checks = []
def check(name, ok, detail=None):
    checks.append({'check': name, 'passed': bool(ok), 'detail': detail})

records = rows(HERE / 'dispositions.jsonl')
libraries = rows(BASE / 'library-fit/assessments.jsonl')
duplicates = rows(BASE / 'duplication-layers/candidates.jsonl')
maintenance = rows(BASE / 'maintenance-benefit/assessments.jsonl')
expected = {r['id'] for r in libraries + duplicates}
choices = {'retain-thin-integration', 'simplify-wrapper', 'consolidate-ownership',
           'select-better-fitting-mechanism', 'retain-existing-implementation'}
check('27 families and 49 subsidiary IDs covered once, DR08 remains alias',
      len(records) == 76 and len({r['id'] for r in records}) == 76
      and {r['id'] for r in records} == expected and 'DR08' not in expected)
check('exact five-choice vocabulary, finite rationale and retirement',
      all(r['choice'] in choices and r['rationale'] and r['retirement_conditions']
          and r['uncertainty'] and r['contract_decision'] and r['decisive_sources']
          for r in records))
check('no selected behavior change, policy or implementation acceptance',
      all(r['execution_authorized'] is False and r['accepted_policy_change'] is False
          and r['contract_change_required'] is False for r in records))
check('future reductions unknown and unaccepted',
      all(r['future_net_reduction_demonstrated'] is False
          and r['actual_future_implementation_lines'] is None
          and r['actual_future_declaration_lines'] is None for r in records))
check('requested Sol high for all substantive dispositions',
      all(r['analysis_model'] == 'gpt-6.1-sol' and r['reasoning_effort'] == 'high'
          for r in records))
scope = readj(HERE / 'scope.json')
counts = {kind: dict(collections.Counter(r['choice'] for r in records if r['kind'] == kind))
          for kind in ['library-family', 'duplication-review']}
check('count/choice/source checkpoint and planning scope reconcile',
      counts == scope['choice_counts'] and scope['freeze'] == FREEZE
      and scope['families'] == 27 and scope['subsidiary_records'] == 49
      and not any(scope[x] for x in ['execution_authorized','package_source_changes',
                                     'product_tests','merge','checkpoint_advance','canonical_task_acceptance']), counts)
inputs = readj(HERE / 'inputs.json')['records']
input_errors = [r['path'] for r in inputs if not (ROOT / r['path']).is_file()
                or sha(ROOT / r['path']) != r['sha256']]
check('all saved audit input hashes match', not input_errors, input_errors)
sources = readj(HERE / 'sources.json')
source_errors = []
seen = set()
for r in sources['records'] + sources['added_decisive_source_hashes']:
    if not r.get('path'):
        continue  # Versioned URL citation, not a local source hash claim.
    path = Path(r['path'])
    path = path if path.is_absolute() else ROOT / path
    seen.add(str(path))
    if not path.is_file() or sha(path) != r['sha256']:
        source_errors.append(str(path))
check('129 baseline source pins and all extra decisive file pins match',
      len(sources['records']) == 129 and not source_errors,
      {'distinct_files': len(seen), 'errors': source_errors})
range_errors = []
range_count = 0
prior_counter = readj(BASE / 'maintenance-benefit/counter-review.json')
range_groups = [{'id':r['id'], 'source_ranges':r['source_ranges']} for r in maintenance]
range_groups += [{'id':r['recordID'], 'source_ranges':r['anchors']} for r in prior_counter['largestEnvelopeChecks']]
for r in range_groups:
    for a in r['source_ranges']:
        path = ROOT / a['path']
        lo, hi = a['start'], a['end']
        lines = path.read_bytes().splitlines(keepends=True)
        range_count += 1
        if not 1 <= lo <= hi <= len(lines):
            range_errors.append({'id':r['id'], 'path':a['path'], 'range':[lo,hi]})
        elif hashlib.sha256(b''.join(lines[lo-1:hi])).hexdigest() != a['slice_sha256']:
            range_errors.append({'id':r['id'], 'path':a['path'], 'issue':'slice hash'})
check('263 assessment slices plus 10 prior opposing-envelope anchors match current source',
      range_count == 273 and not range_errors, {'ranges':range_count, 'errors':range_errors})
extra_ranges = 0
extra_errors = []
corrections = []
for r in sources['added_decisive_source_hashes']:
    if not r.get('path') or not r.get('lines'):
        continue
    path = Path(r['path'])
    path = path if path.is_absolute() else ROOT / path
    lo, hi = r['lines']
    extra_ranges += 1
    if not 1 <= lo <= hi <= len(path.read_bytes().splitlines()):
        extra_errors.append({'path':str(path), 'range':[lo,hi]})
    if r.get('requested_range_correction'):
        corrections.append({'path':r['path'], **r['requested_range_correction']})
check('additional analyst ranges bounded, copied EOF corrections explicit',
      not extra_errors, {'ranges':extra_ranges, 'errors':extra_errors, 'corrections':corrections})
product_diff = subprocess.run(['git','diff','--name-only',FREEZE,'--',
                               'packages','package.json','bun.lock'],
                              cwd=ROOT,text=True,capture_output=True,check=True).stdout.splitlines()
check('tracked package/root source still equals exact checkpoint', not product_diff, product_diff)
byid = {r['id']:r for r in records}
check('oversized compensated seams not labeled thin',
      all(byid[x]['choice'] == 'retain-existing-implementation'
          for x in ['delivery-imports','DD-006','delivery-maps','DD-005',
                    'decimal-rounding','lossless-transport','DV10']))
review = readj(HERE / 'counter-review.json')
check('eight opposing findings reconciled without product repair claim',
      len(review['findings']) == 8 and all(f['resolution'] and
      f['status'] == 'addressed-in-planning-record' for f in review['findings'])
      and not review['product_repairs'] and not review['clean_room'])
questions = ['uri_strategy','locale_strategy']
requests = [readj(HERE / f'jev/request-{i}.json') for i in [1,2,3]]
responses = [readj(HERE / f'jev/response-{i}.json') for i in [1,2,3]]
check('three exact JEV request/response pairs preserved',
      all(r['request'] == q and set(r['response']['answers']) == set(questions)
          for q,r in zip(requests,responses)))
check('independently rewritten equivalent question/context/criteria prose',
      len({json.dumps(q['state'],sort_keys=True) for q in requests}) == 3
      and all(len({q['questions'][k]['instructions'] for q in requests}) == 3
              and len({json.dumps(q['questions'][k]['criteria'],sort_keys=True)
                       for q in requests}) == 3
              and len({tuple(q['questions'][k]['criteria']) for q in requests}) == 1
              for k in questions))
assessment = readj(HERE / 'jev/assessment.json')
check('JEV advice split/uncertainty retained without vote threshold',
      assessment['questions']['uri_strategy']['agreement'] is False
      and assessment['questions']['locale_strategy']['agreement'] is True
      and all(assessment['questions'][q]['acceptance_threshold'] is None
              and assessment['questions'][q]['uncertainty']
              and assessment['questions'][q]['investigation'] for q in questions))
links = []
for path in HERE.rglob('*.md'):
    for href in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if '://' in href or href.startswith('#'):
            continue
        target = (path.parent / href.split('#')[0]).resolve()
        if not target.exists():
            links.append({'file':str(path.relative_to(ROOT)), 'href':href})
check('local document links exist',not links,links)
result = {'freeze':FREEZE, 'passed':all(c['passed'] for c in checks),
          'checks':checks, 'limits':'Audit metadata/source/coverage/proposal and advisory provenance only; no product execution, future reduction, library adoption, installed/security or programme acceptance.'}
(HERE / 'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'passed':result['passed'], 'checks':len(checks),
                  'failed':[c for c in checks if not c['passed']]}))
raise SystemExit(0 if result['passed'] else 1)
