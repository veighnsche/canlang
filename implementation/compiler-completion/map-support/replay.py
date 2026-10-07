#!/usr/bin/env python3
"""Finite pinned-API controls; no compiler rebuild or production writes."""
import hashlib, json, pathlib, subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CRATE = pathlib.Path.home() / '.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/sourcemap-9.3.2'
DEPS = ROOT / 'compiler/target/debug/deps'
RLIB = DEPS / 'libsourcemap-c9bb006fd2e49a06.rlib'
SOURCE = ROOT / 'compiler/src/codegen/sourcemap.rs'
pins = [SOURCE, ROOT/'compiler/Cargo.lock', ROOT/'compiler/Cargo.toml', ROOT/'compiler/tests/sourcemap_contract.rs', ROOT/'compiler/tests/fixtures/sourcemap-consumer.mjs', ROOT/'compiler/tests/codegen.rs', ROOT/'compiler/src/codegen/artifact.rs', ROOT/'compiler/src/codegen/mod.rs', ROOT/'compiler/src/lib.rs', RLIB]
pins += [CRATE/'src'/name for name in ('lib.rs', 'encoder.rs', 'vlq.rs', 'types.rs', 'builder.rs')]
(HERE/'pins.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in pins}, indent=2)+'\n')
lines = SOURCE.read_text().splitlines()
decoder = '\n'.join(lines[132:233])
controls = r'''
fn main() {
    assert_eq!(decode_mappings("").unwrap(), Vec::<Vec<DecodedSegment>>::new());
    let rows = decode_mappings(";G,D;;AAAA;AAAAA;").unwrap();
    assert_eq!(rows.len(), 6);
    assert!(rows[0].is_empty() && rows[2].is_empty() && rows[5].is_empty());
    assert_eq!(rows[1].iter().map(|s| s.gen_col).collect::<Vec<_>>(), [3, 2]);
    assert_eq!(rows[3][0].name, None);
    assert_eq!(rows[4][0].name, Some(0));
    for bad in [",", "A,", ",A", "AA", "AAA", "AAAAAA", "!A", "éA", "g", "/////////////A", "////////////P"] {
        assert!(decode_mappings(bad).is_err(), "accepted {bad:?}");
    }
    let large = sourcemap::vlq::generate_vlq_segment(&[(1i64 << 62) - 1]).unwrap();
    assert!(decode_mappings(&format!("{large},{large},{large}")).is_err());
    for index in 1..5 {
        let mut fields = [0; 5];
        fields[index] = (1i64 << 62) - 1;
        let segment = sourcemap::vlq::generate_vlq_segment(&fields).unwrap();
        assert!(decode_mappings(&format!("{segment};{segment};{segment}")).is_err());
    }
    assert_eq!(sourcemap::vlq::generate_vlq_segment(&[0,0,0,0]).unwrap(), "AAAA");
    assert_eq!(sourcemap::vlq::generate_vlq_segment(&[0,0,0,2]).unwrap(), "AAAE");
    let mut builder = sourcemap::SourceMapBuilder::new(Some("probe.mjs"));
    let src = builder.add_source("probe.can");
    builder.add_raw(0,0,0,0,Some(src),None,false);
    builder.add_raw(1,0,0,2,Some(src),None,false);
    let map = builder.into_sourcemap();
    let mut output = Vec::new();
    map.to_writer(&mut output).unwrap();
    let wire = String::from_utf8(output).unwrap();
    assert!(wire.contains("\"mappings\":\"AAAA;AAAE\""));
    assert!(map.to_data_url().unwrap().starts_with("data:application/json;charset=utf-8;base64,"));
    println!("current decoder extracted verbatim: authored rows/order, 11 malformed cases, all 5 accumulation-overflow dimensions PASS");
    println!("public numeric encoding + full-map to_writer/to_data_url PASS: {wire}");
}
'''
(HERE/'controls.rs').write_text(decoder+'\n'+controls)
probes = {
    'private_encoder': 'use sourcemap::encoder::Encodable; fn main() {}',
    'get_mappings': 'fn main() { let map = sourcemap::SourceMapBuilder::new(None).into_sourcemap(); let _ = map.get_mappings(); }',
    'serialize_trait': 'fn requires<T: serde::Serialize>() {} fn main() { requires::<sourcemap::SourceMap>(); }',
}
receipts = {}
for name, text in {'controls': decoder+'\n'+controls, **probes}.items():
    path = HERE/(name+'.rs')
    path.write_text(text+'\n')
    cmd = ['rustc','--edition=2021',str(path),'-L','dependency='+str(DEPS),'--extern','sourcemap='+str(RLIB),'-o',str(HERE/name)]
    if name == 'serialize_trait':
        # Select serde used by the existing sourcemap build from E0277 diagnostic;
        # the pinned public source independently establishes no Serialize impl.
        cmd += ['--extern', 'serde='+str(DEPS/'libserde-5f77724b6c1d8dcc.rlib')]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    (HERE/(name+'.stdout')).write_text(result.stdout)
    (HERE/(name+'.stderr')).write_text(result.stderr)
    assert (result.returncode == 0) == (name == 'controls'), (name, result.stderr)
    receipts[name] = {'command':cmd,'exit':result.returncode}
    if name == 'controls':
        run = subprocess.run([str(HERE/name)], capture_output=True, text=True, timeout=10)
        (HERE/'controls.run.stdout').write_text(run.stdout)
        (HERE/'controls.run.stderr').write_text(run.stderr)
        assert run.returncode == 0, run.stderr
        receipts[name]['run_exit'] = run.returncode
    (HERE/name).unlink(missing_ok=True)
(HERE/'receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
print('Pinned source/API controls and expected rejection probes PASS')
