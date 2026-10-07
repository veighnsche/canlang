use canlang_compiler::{analysis, source::{SourceDb,sha256_hex},lint::driver::{LintConfig,RuleSet,collect_fixes,apply_fixes,lint_program}};
const PREFIX:&str="app T\nGiven\n Todo { title:text }\nWhen\n scenario s(task:Todo) by=members\n  do\n";
const SUFFIX:&str=" # Sibling metadata.\n scenario sibling(task:Todo) by=members\n  do\n   set task {title=\"live\"}\nThen\n";
fn inspect(text:&str)->(SourceDb,analysis::CheckedProgram,Vec<canlang_compiler::diagnostic::Diagnostic>){let mut db=SourceDb::new();let id=db.add("probe.can".into(),text.into());let(p,d)=analysis::check_program(&db,&[id],None);(db,p,d)}
fn main(){
 let config=LintConfig{enabled:RuleSet::all(),fix:true,deprecated:None};
 for (label,body,expected) in [
 ("nested-else", "   require false\n   ## parent\n   if true\n    ## then café  \n    set task {title=\"## not prose\"}\n   else\n    ## else ✓\n    set task {title=\"# not metadata\"}\n   ## trailing\n", "   require false\n   ## parent\n    ## then café  \n    ## else ✓\n   ## trailing\n"),
 ("joined-delimiter-comment", "   require false\n   set task {\n    ## inside record\n    title=\"dead\"\n   }\n", "   require false\n    ## inside record\n"),
 ("empty-and-gaps", "   require false\n\n   ##\n \n   ## trailing spaces   \n   let dead=2\n\n", "   require false\n   ##\n   ## trailing spaces   \n\n")
 ] {for nl in ["\n","\r\n"] {let text=format!("{PREFIX}{body}{SUFFIX}").replace('\n',nl);let expected=format!("{PREFIX}{expected}{SUFFIX}").replace('\n',nl);let(db,p,d)=inspect(&text);assert!(d.is_empty(),"{label}: {d:?}");let fixes=collect_fixes(&p,&db,&config);assert_eq!(fixes.len(),1,"{label}: {fixes:?}");let fixed=apply_fixes(&text,&sha256_hex(text.as_bytes()),&fixes).unwrap();assert_eq!(fixed,expected,"{label}");let(db,p,d)=inspect(&fixed);assert!(d.is_empty(),"{label} fixed: {d:?}");assert!(collect_fixes(&p,&db,&config).is_empty());assert!(lint_program(&p,&db,&config).is_empty());println!("PASS {label} {} exact source + valid fixed point",if nl=="\n"{"LF"}else{"CRLF"});}}
 // Record the initial invalid-fixture expectation independently: effect descriptions are invalid.
 let text=format!("{PREFIX}   require false\n   # Describes dead binding.\n   let dead=2\n{SUFFIX}");let(db,p,d)=inspect(&text);assert!(d.iter().any(|d|d.code=="E1126"));assert!(collect_fixes(&p,&db,&config).is_empty());println!("PASS effect-description invalid E1126; no fix (never a valid-input success)");
 let text=format!("{PREFIX}   require false\n\t   ## tab indentation\n   let dead=2\n{SUFFIX}");let(db,p,d)=inspect(&text);let fixes=collect_fixes(&p,&db,&config);println!("QUALIFICATION lexical indentation errors {:?}, public library fix count {}",d.iter().map(|d|d.code).collect::<Vec<_>>(),fixes.len());
}
