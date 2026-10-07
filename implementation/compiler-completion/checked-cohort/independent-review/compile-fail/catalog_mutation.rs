use canlang_compiler::analysis::catalog::Catalog; fn mutate(catalog: &mut Catalog) { catalog.lookup("lower").unwrap().js.clear(); } fn main() {}
