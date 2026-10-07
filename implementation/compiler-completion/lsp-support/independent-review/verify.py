#!/usr/bin/env python3
"""Read-only independent evidence checks; write this review's receipt only."""
import hashlib, json, pathlib, re, subprocess
root = pathlib.Path(__file__).resolve().parents[4]
packet = root / 'implementation/compiler-completion/lsp-support'
out = pathlib.Path(__file__).resolve().parent
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
inventory = json.loads((packet / 'inventory.json').read_text())
manifest_path = root / 'implementation/compiler-completion/integration-after-bindings/after-message-coverage/before-compiler-inputs.json'
manifest = json.loads(manifest_path.read_text())
checks = {}
checks['manifest_count_118'] = len(manifest) == 118
checks['selected_source_pins'] = all(sha(root / p) == pin['sha256'] == pin['frozen_sha256'] == manifest[p] for p, pin in inventory['selected_pins'].items())
checks['receipt_pins'] = all(sha(root / p) == digest for p, digest in inventory['receipt_pins'].items())
drift = [p for p, digest in manifest.items() if not (root / p).is_file() or sha(root / p) != digest]
checks['current_drift_is_js_and_codegen_tests_only'] = drift == ['compiler/src/codegen/js.rs', 'compiler/tests/codegen.rs']
counts = []
for target in inventory['target_counts']:
    lines = (root / target['file']).read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(target['symbol']))
    end = next(i for i in range(start + 1, len(lines)) if lines[i] == '}')
    counts.append(end - start + 1)
    assert (start + 1, end + 1, end - start + 1) == (target['start'], target['end'], target['physical_declaration_lines'])
checks['declaration_counts_29_and_18'] = sum(counts[:3]) == 29 and sum(counts[3:]) == 18
raw = subprocess.run(['rg', '-n', r'\b(response_ok|response_err|notification|TextPos|LspRange|LanguageAnalysis)\b', 'compiler', 'editors', 'packages', 'examples', '--glob', '!target/**', '--glob', '!**/target/**', '--glob', '!**/node_modules/**', '--glob', '!**/dist/**'], cwd=root, text=True, capture_output=True)
checks['raw_callers_reproduce_as_line_multiset'] = raw.returncode == 0 and sorted(raw.stdout.splitlines()) == sorted((packet / 'raw-callers.txt').read_text().splitlines())
log = (manifest_path.parent / 'full-suite.log').read_text()
selected = [line for line in log.splitlines() if line.startswith('test lsp::') or line.startswith('test source::tests::line_index') or any(n in line for n in ['accepted_integral_ids_preserve', 'valid_unicode_string_id', 'real_all_output_families', 'real_opaque_uri', 'real_version_increment', 'real_supported_reference', 'real_clean_rename', 'public_queued_work'])]
checks['selected_40_historical_pass_records_reproduce'] = len(selected) == 40 and all(line.endswith(' ... ok') for line in selected) and '\n'.join(selected) + '\n' == (packet / 'selected-bodies.log').read_text()
receipt = json.loads((packet / 'direct-controls-receipt.json').read_text())
checks['direct_dependency_rlib_pins'] = all(sha(pathlib.Path(p)) == digest for p, digest in receipt['dependency_rlib_sha256'].items())
direct = (packet / 'direct-controls.rs').read_text()
linked_sources = [str((packet / path).resolve().relative_to(root)) for path in re.findall(r'#\[path = "([^"]+)"\]', direct)]
checks['direct_compiles_exact_source_modules'] = linked_sources == ['compiler/src/json.rs', 'compiler/src/source.rs', 'compiler/src/diagnostic.rs', 'compiler/src/lsp/transport.rs'] and str(packet / 'direct-controls.rs') in receipt['command'] and not any('libcanlang' in item for item in receipt['command'])
checks['direct_success_receipt_and_log'] = receipt['build_exit'] == receipt['run_exit'] == 0 and (packet / 'direct-controls.log').read_text().startswith('PASS: exact helper bytes,')
result = {'checks': checks, 'all_checks_pass': all(checks.values()), 'current_drift': drift, 'linked_source_modules': linked_sources, 'target_counts': counts, 'historical_selected_pass_records': len(selected), 'scope': 'No compilation or suite rerun; independently reproduced hashes, counts, caller search and historical pass-record selection. Existing direct receipt inspected for exact source-module/local-rlib linkage. Not a new execution receipt.', 'limits': ['The 118-input manifest excludes editor include_str fixtures used by typed-output tests.', 'Raw name search contains declarations, comments and unrelated names; it is not a semantic call graph.', 'Public textual declaration inventory includes restricted visibility and omits enum variants; source inspection supplements it.', 'The historical suite contains an unrelated mode-4750 body skip; selected LSP bodies have no optional skip branch.']}
(out / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
