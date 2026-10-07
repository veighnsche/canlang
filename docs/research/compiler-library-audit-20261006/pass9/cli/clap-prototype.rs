use clap::{Arg,ArgAction,Command,ValueHint};
fn value(name:&str)->Arg { Arg::new(name.to_string()).long(name.to_string()).action(ArgAction::Set).allow_hyphen_values(true) }
fn cli()->Command {
 let mut c=Command::new("can").disable_help_subcommand(true).args_override_self(true)
  .arg(value("format").global(true).value_parser(["json","text"]))
  .arg(value("catalog").global(true));
 for cmd in ["compile","check","lint","fmt","explain","lsp","policy","docs","completions","help","run","test","build","deploy","activate"] {
  let thin=["run","test","build","deploy","activate"].contains(&cmd);
  let mut sub=Command::new(cmd).args_override_self(true);
  if thin { sub=sub.disable_help_flag(true); }
  if cmd=="fmt" {sub=sub.arg(Arg::new("check").long("check").action(ArgAction::SetTrue));}
  if cmd=="lint" {sub=sub.arg(Arg::new("fix").long("fix").action(ArgAction::SetTrue));}
  if cmd=="docs" {sub=sub.arg(value("locale")).arg(value("out"));}
  if cmd!="lsp" {
   let mut operands=Arg::new("operands").num_args(0..).allow_hyphen_values(thin).trailing_var_arg(thin).value_hint(ValueHint::AnyPath);
   if cmd=="completions" {operands=operands.num_args(1).required(true).value_parser(["bash","zsh","fish"]).value_hint(ValueHint::Other);}
   sub=sub.arg(operands);
  }
  c=c.subcommand(sub);
 }
 c
}
fn main(){
 if std::env::args().nth(1).as_deref()==Some("--generate") {
  let shell=match std::env::args().nth(2).as_deref(){Some("bash")=>clap_complete::Shell::Bash,Some("zsh")=>clap_complete::Shell::Zsh,Some("fish")=>clap_complete::Shell::Fish,_=>panic!("shell")};
  clap_complete::generate(shell,&mut cli(),"can",&mut std::io::stdout());return;
 }
 match cli().try_get_matches(){Ok(m)=>{
 let f=m.get_one::<String>("format").cloned();let cat=m.get_one::<String>("catalog").cloned();
 if let Some((cmd,s))=m.subcommand(){let args:Vec<_>=s.get_many::<String>("operands").into_iter().flatten().collect();println!("cmd={cmd:?} format={f:?} catalog={cat:?} operands={args:?}")}else{println!("no-command format={f:?} catalog={cat:?}")}
},Err(e)=>{eprintln!("kind={:?}",e.kind());let code=e.exit_code();if e.use_stderr(){eprint!("{e}")}else{print!("{e}")}std::process::exit(code)}}}
