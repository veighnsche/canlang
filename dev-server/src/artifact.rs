//! One-shot public CLI handoff for exact saved artifacts. Uses the same native
//! producer capture, admission and isolated row runner as the session owner.
use crate::{capture,examples,gateway::Gateway,inventory,preview,runtime::Bridge,sdk};
use serde_json::{Value,json};
use std::{collections::BTreeMap,path::Path,sync::{Arc,atomic::{AtomicBool,Ordering}},thread,time::{Duration,Instant}};
type Result<T>=std::result::Result<T,String>;
pub fn run(argv:&[String])->u8 {
    crate::signals::install();
    let cancel=Arc::new(AtomicBool::new(false));let finished=Arc::new(AtomicBool::new(false));
    let signal=cancel.clone();let done=finished.clone();
    let watcher=thread::spawn(move||while !done.load(Ordering::Acquire){if crate::signals::take(){signal.store(true,Ordering::Release);}thread::sleep(Duration::from_millis(20));});
    let result=perform(argv,&cancel);finished.store(true,Ordering::Release);let _=watcher.join();
    match result {Ok(result)=>{println!("{result}");if result["ok"]==false{1}else{0}},Err(error)=>{println!("{}",json!({"ok":false,"code":if cancel.load(Ordering::Acquire){"command-cancelled"}else{"native-examples-failed"},"detail":crate::service::short(&error,512)}));1}}
}
fn perform(argv:&[String],cancel:&AtomicBool)->Result<Value>{
    let command=argv.first().ok_or("missing native helper command")?;
    let mut flags=BTreeMap::new();
    if argv.len()%2!=1{return Err("native helper flags require values".into());}
    for pair in argv[1..].chunks_exact(2){if !["--root","--artifact","--compiler","--catalog"].contains(&pair[0].as_str())||flags.insert(pair[0].as_str(),pair[1].as_str()).is_some(){return Err("invalid native helper argument".into());}}
    let root=std::fs::canonicalize(flags.get("--root").copied().unwrap_or(".")).map_err(|e|e.to_string())?;
    if command=="producer-current"{
        let compiler=flags.get("--compiler").ok_or("compiler path is required")?;
        inventory::compiler_inputs(&root,Path::new(compiler),cancel)?;
        return Ok(json!({"ok":true}));
    }
    let artifact_path=std::fs::canonicalize(flags.get("--artifact").ok_or("artifact path is required")?).map_err(|e|e.to_string())?;
    if std::fs::metadata(&artifact_path).map_err(|e|e.to_string())?.len()>16*1024*1024{return Err("saved artifact exceeds limit".into());}
    let bytes=std::fs::read(&artifact_path).map_err(|e|e.to_string())?;
    let artifact:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
    if artifact["artifact_version"]!=1{return Err("saved artifact version is unsupported".into());}
    if artifact["tests"].as_array().is_none_or(|a|a.is_empty()){return Err("compiled artifact has zero example rows; zero-row results cannot pass".into());}
    let sources:Vec<_>=artifact["sources"].as_array().ok_or("artifact sources are absent")?.iter().filter_map(|s|s["path"].as_str()).filter(|p|!p.split('/').any(|c|c=="can.generated")).collect();
    if sources.len()!=1{return Err("local examples require one owning source plus its saved generated contributions".into());}
    let mut config=crate::app::artifact_config(&root,sources[0]).map_err(|e|e.to_string())?;
    config.bridge.session_id=format!("artifact-{}",preview::random_id()?);
    let bridge=Bridge::spawn(config.bridge).map_err(|e|e.to_string())?;
    let resources=sdk::Resources::default();
    let parent=format!("artifact-{}",preview::random_id()?);
    let outcome=(||{
        let call=|command:&str,parent:Option<&str>,payload:Value,signal:&AtomicBool|sdk::call(&bridge,&resources,command,parent,payload,signal);
        let inventory=||inventory::collect(&root,Path::new(&config.capture.compiler_path),Path::new(config.capture.catalog_path.as_deref().ok_or("catalog unavailable")?),&call,cancel);
        let mut request=config.capture.clone();let inputs=inventory()?;request.package_input_paths=inputs.package_input_paths;request.extra_input_paths=inputs.extra_input_paths;
        let capture=capture::capture(&request,&inventory,cancel)?;
        capture::verify_compiler_sources(&capture,&artifact,true)?;
        let gateway=Gateway::bind().map_err(|e|e.to_string())?;
        let prepared=preview::prepare(&capture,&artifact,&bytes,&parent,gateway.origin(),None,config.preview_roles.as_ref().unwrap_or(&json!({})),&call,cancel)?;
        let result=examples::run(&prepared.recipe,&capture,&parent,"artifact",None,None,&inventory,&call,cancel)?;
        Ok(json!({"ok":result["ok"],"executed":result["executed"],"report":result["report"]}))
    })();
    let release=sdk::release(&bridge,&resources,&parent);
    // Physical process-group release is also the fallback for an unresponsive SDK.
    bridge.shutdown(Instant::now()+Duration::from_secs(5)).map_err(|e|e.to_string())?;
    resources.host_released()?;
    release?;outcome
}
