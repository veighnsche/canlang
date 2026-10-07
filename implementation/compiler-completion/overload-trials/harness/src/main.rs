use canlang_compiler::analysis::{check_program, ResolvedType, Scalar};
use canlang_compiler::analysis::catalog::{load_catalog, CatalogRequest};
use canlang_compiler::source::{SourceDb, Span, SourceId};
use std::path::Path;
fn main() {
 let root=Path::new("/Users/vince/Projects/canlang");
 let path=root.join("packages/values/dist/catalog.json");
 let (catalog, ds)=load_catalog(&CatalogRequest {flag:Some(&path),env:None,cwd:root,primary:Span::new(SourceId(0),0,0)});
 assert!(ds.is_empty(),"{ds:?}"); let catalog=catalog.unwrap();
 let cases=[
 ("money_int", "derive g():money = money(1,\"EUR\")",true),
 ("money_decimal", "derive g():money = money(1.5,\"EUR\")",true),
 ("money_named", "derive g():money = money(currency=\"EUR\",value=1.5)",true),
 ("format_plain", "derive g():text = format(values={v=\"EUR\"},template=\"{v}\")",true),
 ("format_null", "message m=\"Hi\"@{}\n derive g():text = format(m(),locale=null)",true),
 ("format_locale", "message m=\"Hi\"@{}\n derive g():text = format(locale=\"en\",descriptor=m())",true),
 ("local_good", "derive g(d:date):datetime = local_instant(d,\"12:30\",\"UTC\",fold=earlier)",true),
 ("local_bad_fold", "derive g(d:date):datetime = local_instant(d,\"12:30\",\"UTC\",fold=middle)",false),
 ("local_bad_fold_named", "derive g(d:date):datetime = local_instant(fold=middle,zone=\"UTC\",time=\"12:30\",date=d)",false),
 ("local_bad_zone", "derive g(d:date):datetime = local_instant(d,\"12:30\",\"not a zone\",fold=earlier)",false),
 ("min_nonempty", "derive g():int = min([1,2])",true),
 ("sum_money", "derive g():money = sum([money(1,\"EUR\")],currency=\"EUR\")",true),
 ("declaration_defaults", "derive f(a:text?=\"default\",b:text?=a):text? = b\n derive g():text? = f(b=null)",true),
 ];
 for (name,body,clean) in cases {
  let src=format!("app T\nGiven\n {body}\nWhen\nThen\n");
  std::fs::write(root.join(format!("implementation/compiler-completion/overload-trials/{name}.can")),&src).unwrap();
  let mut db=SourceDb::new(); let id=db.add(format!("{name}.can"),src.clone());
  let (checked,diags)=check_program(&db,&[id],Some(&catalog));
  assert_eq!(diags.is_empty(),clean,"{name}: {diags:?}");
  println!("CASE {name} diagnostics={diags:?}");
  let mut facts=checked.types.node_types.iter().collect::<Vec<_>>(); facts.sort_by_key(|(k,_)|(k.start,k.end,k.kind));
  for (k,t) in facts { if matches!(t,ResolvedType::Scalar(Scalar::Currency|Scalar::Locale|Scalar::Timezone)) {println!("FACT {:?} {:?} {t:?}",k,&src[k.start as usize..k.end as usize]);} }
  let mut selected=checked.types.selected_calls.iter().collect::<Vec<_>>(); selected.sort_by_key(|(k,_)|k.start); println!("SELECTED {selected:?}");
  if name.starts_with("local_bad_fold") {
   assert!(checked.types.selected_calls.is_empty());
   assert!(checked.types.node_types.iter().any(|(k,t)|&src[k.start as usize..k.end as usize]=="\"UTC\"" && *t==ResolvedType::Scalar(Scalar::Timezone)));
  }
 }
}
