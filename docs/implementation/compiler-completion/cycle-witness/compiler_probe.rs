use canlang_compiler::{analysis::{check_program,resolve::resolve_program},source::SourceDb,syntax};
fn main(){
let cases=[
("composition_upstream", "app U uses=[A]\napp A uses=[B]\napp B uses=[A]\n"),
("composition_duplicate", "app A uses=[B,B]\napp B uses=[A,A]\n"),
("ownership_upstream", "app T\nGiven\n U in A {x:int}\n A in B {x:int}\n B in A {x:int}\n policy U read=members\n policy A read=members\n policy B read=members\nWhen\nThen\n"),
("fixture_upstream", "app T\nGiven\n M {m:M?}\n policy M read=members\n fixture u=M {m=a}\n fixture a=M {m=b}\n fixture b=M {m=a}\nWhen\nThen\n"),
("derive_upstream", "app T\nGiven\n derive u(): int = a()\n derive a(): int = b()\n derive b(): int = a()\nWhen\nThen\n"),
("calls_upstream", "app T\nGiven\nWhen\n scenario u() by=members\n  do\n   call a {}\n scenario a() by=members\n  do\n   call b {}\n scenario b() by=members\n  do\n   call a {}\nThen\n"),
("calls_overlap", "app T\nGiven\nWhen\n scenario a() by=members\n  do\n   call b {}\n   call c {}\n scenario b() by=members\n  do\n   call a {}\n scenario c() by=members\n  do\n   call a {}\nThen\n")];
for (name,text) in cases {let mut db=SourceDb::new();let f=db.add(format!("{name}.can"),text.into());let (tree,_)=syntax::parse(&db,f);let mut raw=vec![];let _=resolve_program(&db,&[(f,tree)],None,&mut raw);println!("CASE {name}");for d in raw.iter().filter(|d|matches!(d.code,"E2007"|"E2008"|"E2017"|"E2018")){println!("RAW {} {}..{} {}",d.code,d.primary.start,d.primary.end,d.message)}let (_,diags)=check_program(&db,&[f],None);for d in diags {println!("PUBLIC {} {}..{} {}",d.code,d.primary.start,d.primary.end,d.message)}}
}
