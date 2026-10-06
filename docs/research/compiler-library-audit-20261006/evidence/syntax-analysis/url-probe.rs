use canlang_compiler::{analysis::check_program, source::SourceDb};
fn main() {
    for value in ["💥💥💥", "https://[garbage]", "https://host:999999", "https://valid.example", "https://user:pass@example.com"] {
        let source = format!("app T\nGiven\n M {{ link:url=\"{value}\" }}\n policy M read=members\nWhen\nThen\n");
        let mut db = SourceDb::new();
        let id = db.add("audit.can".into(), source);
        let result = std::panic::catch_unwind(|| check_program(&db, &[id], None));
        match result {
            Ok((_, ds)) => println!("{value:?}: {:?}", ds.iter().map(|d| (d.code, &d.message)).collect::<Vec<_>>()),
            Err(_) => println!("{value:?}: PANIC"),
        }
    }
}
