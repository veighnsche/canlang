use canlang_compiler::{analysis::check_program, source::SourceDb};

fn main() {
    for value in ["en-u-ca-gregory", "en-x-private", "en-US-US", "en-US"] {
        let source = format!("app T\nGiven\n M {{ tag:locale=\"{value}\" }}\n policy M read=members\nWhen\nThen\n");
        let mut db = SourceDb::new();
        let id = db.add("audit.can".into(), source);
        let (_, ds) = check_program(&db, &[id], None);
        println!("{value:?}: {:?}", ds.iter().map(|d| (d.code, &d.message)).collect::<Vec<_>>());
    }
}
