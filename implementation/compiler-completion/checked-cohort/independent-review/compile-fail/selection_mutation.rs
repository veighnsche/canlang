use canlang_compiler::{analysis::check_program,source::SourceDb}; fn main() { let db=SourceDb::new(); let (program,_)=check_program(&db,&[],None); program.checked_files().clear(); }
