use icu_locale_core::Locale;
fn main(){for s in std::env::args().skip(1){match Locale::try_from_str(&s){Ok(l)=>println!("{s}\tOK\t{l}"),Err(e)=>println!("{s}\tERR\t{e:?}")}}}
