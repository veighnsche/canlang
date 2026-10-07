use canlang_compiler::{analysis::check_program, source::SourceDb};
fn check(name: &str, source: &str, expected: &[(&str,&str,usize)], interleaved: bool) {
    let mut db = SourceDb::new();
    let f = db.add(format!("{name}.can"), source.to_string());
    let (program, diagnostics) = check_program(&db, &[f], None);
    let actual: Vec<_> = diagnostics.iter().map(|d| {
        assert!(d.related.is_empty(), "{d:?}");
        (d.code, d.message.as_str(), d.primary.file, d.primary.start, d.primary.end)
    }).collect();
    let expected: Vec<_> = expected.iter().map(|(message,target,occurrence)| {
        let start = source.match_indices(&format!("call {target} {{")).nth(occurrence-1).unwrap().0 + 5;
        ("E3005",*message,f,start as u32,(start+target.len()) as u32)
    }).collect();
    assert_eq!(actual,expected,"{name}");
    if interleaved {
        let z = program.symbols.iter().find(|s|s.name=="z").unwrap().id.0;
        let a = program.symbols.iter().find(|s|s.name=="a").unwrap().id.0;
        assert!(a > z + 2, "generated/parameter symbols must intervene");
        println!("{name}: z={z}, a={a}");
    }
    println!("{name}: {actual:?}");
}
fn main() {
    let forward = "app T\nGiven\nWhen\n scenario a() by=members\n  do\n   call b {}\n   call c {}\n scenario b() by=members\n  do\n   call d {}\n scenario c() by=members\n  do\n   call d {}\n scenario d() by=members\n  do\n   call a {}\nThen\n";
    check("diamond-forward", forward, &[("call cycle: b -> d -> a -> b","b",1),("call cycle: a -> c -> d -> a","a",1)],false);
    let reverse = forward.replacen("call b {}\n   call c {}","call c {}\n   call b {}",1);
    check("diamond-reverse", &reverse, &[("call cycle: c -> d -> a -> c","c",1),("call cycle: a -> b -> d -> a","a",1)],false);
    let allocated = "app T\nGiven\n M {x:int}\n policy M read=members\nWhen\n scenario z(x:int) by=members\n  do\n   call a {x=x}\n crud M by=members fields=x\n scenario a(x:int) by=members\n  do\n   call z {x=x}\nThen\n";
    check("interleaved-symbols",allocated,&[("call cycle: z -> a -> z","z",1)],true);
}
