//! Supplied arrays preserve typed, ordered evaluation without gaining stored-read authority.
use canlang_compiler::analysis::{
    catalog::{CatalogRequest, load_catalog},
    check_program,
};
use canlang_compiler::codegen::ir;
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};

#[test]
fn supplied_array_order_preserves_types_identity_stability_and_failures() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut db = SourceDb::new();
    let id=db.add("value-order.can".into(),r#"app ValueOrder
Given
 contract Entry {key:int?, label:text, keep:bool}
 contract Group {items:Entry[]}
 contract Window {from:datetime, label:text}
 Site {name:text}
 policy Site read=members
 derive asc(items:Entry[]):Entry[] = items as item order=item.key
 derive desc(items:Entry[]):Entry[] = items as item order=-item.key
 derive key(item:Entry):int? = item.key
 derive keep(item:Entry):bool = item.keep
 derive label(item:Entry):text = item.label
 derive phases(items:Entry[]):text[] = items as item where keep(item) order=key(item) select label(item)
 derive windows(items:Window[]):Window[] = items as interval order=interval.from
 derive sites(items:Site[]):Site[] = items as site order=site.id
 derive text_desc(items:text[]):text[] = items as item order=-item
 derive integers(items:int[]):int[] = items as item order=-item
 derive durations(items:duration[]):duration[] = items as item order=item
 derive decimals(items:decimal[]):decimal[] = items as item order=item
 derive amounts(items:money[]):money[] = items as item order=item
 derive ordered_dates(items:date[]):date[] = items as item order=item
 derive captured(row:int,items:int[]):int[] = items where row>0 order=row select row
 derive explicit(row:int,items:int[]):int[] = items as row order=-row
 derive nested(items:Group[]):bool[] = items as group select any(group.items as item order=item.key,item.keep)
When
Then
"#.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let output = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let mut altered = ir.clone();
    let item = altered
        .items
        .iter_mut()
        .find(|item| item.canonical == "ValueOrder.asc")
        .unwrap();
    let ir::IrItemKind::DeriveFn {
        expr: Some(body), ..
    } = &mut item.kind
    else {
        unreachable!()
    };
    let ir::IrExpr::Query(query) = &mut body.expr else {
        unreachable!()
    };
    query.domain = ir::IrQueryDomain::Model("ValueOrder.Site".into());
    let rejected = js::emit_program_with_native_source_receipts(&altered, false, &db);
    assert!(
        rejected
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic
                    .message
                    .contains("ordering does not belong to its domain")),
        "{:?}",
        rejected.diagnostics
    );
    let script=r#"
import assert from 'node:assert/strict';
import {datetime,date,parseDecimal,money,ValueError} from '@canlang/values';
const text=__ENTRY__.replaceAll('"@canlang/stdlib"',JSON.stringify(import.meta.resolve('@canlang/cloudflare/runtime/stdlib')));
const {canApp}=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const registry=canApp(), call=(name,items)=>registry['ValueOrder.'+name]({},items);
const rows=[{key:2n,label:'two',keep:true},{key:null,label:'null-1',keep:true},
 {key:1n,label:'one-1',keep:true},{key:1n,label:'one-2',keep:true},{key:null,label:'null-2',keep:true}];
const copy=[...rows];
assert.deepEqual(await call('asc',rows),[rows[1],rows[4],rows[2],rows[3],rows[0]]);
assert.deepEqual(await call('desc',rows),[rows[0],rows[2],rows[3],rows[1],rows[4]]);
assert.deepEqual(rows,copy);
assert.equal((await call('asc',rows))[0],rows[1]);
assert.deepEqual(await call('asc',[]),[]);
const absent={label:'absent',keep:true};
assert.deepEqual(await call('asc',[...rows,absent]),[rows[1],rows[4],absent,rows[2],rows[3],rows[0]]);
assert.deepEqual(await call('desc',[...rows,absent]),[rows[0],rows[2],rows[3],rows[1],rows[4],absent]);
const reads=[], counted=n=>({get key(){reads.push(n);return 1n;}}), tied=[counted(0),counted(1),counted(2)];
assert.deepEqual(await call('asc',tied),tied);assert.deepEqual(reads,[0,1,2]);
const trace=[], watched=(name,key,keep=true)=>({
 get keep(){trace.push('filter:'+name);return keep;},
 get key(){trace.push('key:'+name);return key;},
 get label(){trace.push('select:'+name);return name;}
});
assert.deepEqual(await call('phases',[watched('b',2n),watched('skip',0n,false),watched('a',1n)]),['a','b']);
assert.deepEqual(trace,['filter:b','filter:skip','filter:a','key:b','key:a','select:a','select:b']);
trace.length=0;
const sentinel=new Error('key-failed'), broken={keep:true,get key(){throw sentinel;},get label(){throw new Error('projection must not run');}};
await assert.rejects(call('phases',[broken]),error=>error===sentinel);
await assert.rejects(call('phases',[watched('first',2n),broken,watched('later',1n)]),error=>error===sentinel);
assert.deepEqual(trace,['filter:first','filter:later','key:first']);
const windows=[{from:datetime('2026-10-15T10:00:00Z')},{from:datetime('2026-10-14T10:00:00Z')}];
assert.deepEqual(await call('windows',windows),[windows[1],windows[0]]);
const sites=[{id:'b'},{id:'a'}];assert.deepEqual(await call('sites',sites),[sites[1],sites[0]]);
assert.deepEqual(await call('text_desc',['a','\u{10000}','\uE000']),['\u{10000}','\uE000','a']);
assert.deepEqual(await call('integers',[-9223372036854775808n,9223372036854775807n,0n]),[9223372036854775807n,0n,-9223372036854775808n]);
assert.deepEqual(await call('durations',[2n,-1n,0n]),[-1n,0n,2n]);
const decimals=['9007199254740993.01','9007199254740993.00'].map(parseDecimal);
assert.deepEqual(await call('decimals',decimals),[decimals[1],decimals[0]]);
const amounts=[money(2n,'EUR'),money(1n,'EUR')];assert.deepEqual(await call('amounts',amounts),[amounts[1],amounts[0]]);
let expected;try{await call('amounts',[money(1n,'USD'),money(1n,'EUR')]);}catch(error){expected=error;}
assert(expected instanceof ValueError);
const dates=['2026-10-15','2026-10-14'].map(date);assert.deepEqual(await call('ordered_dates',dates),[dates[1],dates[0]]);
assert.deepEqual(await call('nested',[{items:[rows[0],rows[2]]},{items:[]}]),[true,false]);
assert.deepEqual(await registry['ValueOrder.captured']({},9n,[2n,1n]),[9n,9n]);
assert.deepEqual(await registry['ValueOrder.captured']({},0n,[2n,1n]),[]);
assert.deepEqual(await registry['ValueOrder.explicit']({},9n,[1n,2n]),[2n,1n]);
"#.replace("__ENTRY__",&serde_json::to_string(&output.entry.js).unwrap());
    let result = std::process::Command::new("node")
        .args(["--input-type=module", "--eval", &script])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
