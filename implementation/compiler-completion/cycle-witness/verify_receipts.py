#!/usr/bin/env python3
"""Qualify static-call ordering and retain other graph policies separately."""
from pathlib import Path
from collections import Counter
import hashlib
import json
import subprocess

root=Path(__file__).resolve().parents[3]
ev=Path(__file__).resolve().parent
before=json.loads((ev/'before-reproduction.json').read_text())
after=json.loads((ev/'after-reproduction.json').read_text())
assert all(r['exit']==0 for r in before['runs']+after['runs'])
noncalls=[n for n in after['distinct_diagnostics'] if not n.startswith('calls_')]
for name in noncalls:
    original=before['runs'][0]['cases'][name]
    expected_public=[s for s in original if s.startswith('PUBLIC ')]
    expected_raw=Counter(s for s in original if s.startswith('RAW '))
    for run in before['runs']+after['runs']:
        actual=run['cases'][name]
        assert [s for s in actual if s.startswith('PUBLIC ')]==expected_public, name
        assert Counter(s for s in actual if s.startswith('RAW '))==expected_raw, name
# Fixed literal tuples agree with the independently handwritten messages and
# source occurrence anchors in cycle_witness.rs; not another graph traversal.
expected={
 'calls_upstream':['PUBLIC E3005 141..142 call cycle: a -> b -> a'],
 'calls_overlap':['PUBLIC E3005 111..112 call cycle: a -> b -> a',
                  'PUBLIC E3005 154..155 call cycle: a -> c -> a']}
for name,lines in expected.items():
    assert after['distinct_diagnostics'][name]==[lines], name
paths=['compiler/src/analysis/types.rs','compiler/tests/cycle_witness.rs','AGENTS.md',
 'docs/research/compiler-library-audit-20261006/responsibility-map/semantics.md',
 'docs/research/compiler-library-audit-20261006/responsibility-map/semantic-evidence/review-authority.md',
 'docs/research/compiler-library-audit-20261006/pass9/graphs/ASSESSMENT.md',
 'docs/research/compiler-library-audit-20261006/pass9/graphs/compiler_probe.rs']
pins={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
result={
 'packet':'SEM-R07 / G09-1', 'writer_freeze':pins,
 'production_delta':'Sort only static-call caller origins ascending by SymbolId; authored edge vectors, DFS, visited policy, closing spans, global sorted path-vertex-set dedup and callable filtering unchanged.',
 'contract':'Same exact sources and supplied check-file order have deterministic witnesses. SymbolId order follows indexing, including nested/generated symbols. File/declaration permutations may change preferred witness; duplicate paths remain distinct immutable IDs. No global canonical-path or lexical-name policy.',
 'jev':'Three independently worded equivalent choice consultations unanimously prefer index_order; advice only. Initial sandbox connection failures retained; escalated minimal current requests succeeded.',
 'frozen_before_after':'Source manifests show only changed preexisting source path src/analysis/types.rs; after adds tests/cycle_witness.rs. Frozen-after focused suite: 11 pass, 0 fail, including 24 fresh child-process checks.',
 'before_processes':24,
 'before_distinct_call_sets':{n:len(before['distinct_diagnostics'][n]) for n in expected},
 'after_processes':24,
 'after_distinct_call_sets':{n:len(after['distinct_diagnostics'][n]) for n in expected},
 'expected_public_call_diagnostics':expected,
 'unchanged_observer_cases':noncalls,
 'other_graph_comparison':'Ordered public tuples and raw multisets preserved; fixture/derive raw origin order remains randomized as before and is intentionally outside this repair.',
 'live_focused_suite':'11 pass, 0 fail, including 24 fresh child-process checks',
 'live_related_suites':{'analysis':'37 pass','b4_resolve':'11 pass','check':'37 pass','effects':'46 pass','b4_examples':'24 pass, 1 fail: minimal_table_rows_emit_expected_and_error receives E6011 from concurrent checked-cohort seam. Root notified and owns repair; no worker writes there.'},
 'retained_failed_attempts':['Before frozen build omitted three include_str completion files; copied and rehashed them, then build succeeded.','First test assumed tight E2018 spans; existing spans include leading whitespace. Corrected exact control expectation, no production span change.','Three sandbox JEV connection failures, subsequent escalated preauthorized current questions succeeded.','Related b4_examples foreign-owner E6011 failure.','Initial receipt comparison incorrectly required unrelated fixture/derive RAW order to be deterministic; corrected to ordered public tuples plus raw multisets.'],
 'limitations':['Finite graph corpus and 24 processes qualify named outcomes; no exhaustive graph proof.','No graph-library migration, benchmark, runtime deployment or whole compiler suite qualification.','Snapshots/binaries remain under /private/tmp; pins, patch, observer and receipts are retained here, not a hermetic source release.','Shared DECISIONS/ledger/plan updates belong to root; worker made no Git operation.']}
(ev/'acceptance.json').write_text(json.dumps(result,indent=2)+'\n')
(ev/'toolchain.txt').write_text(subprocess.check_output(['rustc','--version'],text=True)+subprocess.check_output(['cargo','--version'],text=True)+subprocess.check_output(['python3','--version'],text=True))
print('Verified frozen before/after exact static-call tuples and separate graph policies.')
