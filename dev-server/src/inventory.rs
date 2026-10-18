//! Native producer membership and freshness. Node supplies only its module resolver
//! and the browser SDK's executable-path fact; it never enumerates this inventory.
use crate::capture::{self, Inventory, NamedInputPath, Result};
use serde_json::{Value, json};
use std::{collections::{BTreeMap, BTreeSet, VecDeque}, fs, path::{Path, PathBuf}, sync::atomic::AtomicBool};

pub type Call<'a> = dyn Fn(&str, Option<&str>, Value, &AtomicBool) -> Result<Value> + 'a;
const OWNED: &[&str] = &["@canlang/cloudflare/worker/main", "@canlang/contracts/distribution", "@canlang/interfaces/distribution", "@canlang/identity/distribution", "@canlang/files/distribution", "@canlang/state/distribution", "@canlang/ui/distribution", "@canlang/stdlib/distribution", "@canlang/values/distribution", "@canlang/work/distribution", "@canlang/work-kernel/distribution", "@canlang/services/distribution", "@canlang/testkit"];
const EXTERNAL: &[(&str, &str)] = &[("@modelcontextprotocol/sdk", "@canlang/interfaces/distribution"), ("cookie", "@canlang/identity/distribution"), ("@scure/base", "@canlang/identity/distribution"), ("csv-parse", "@canlang/ui/distribution"), ("@noble/hashes/sha2.js", "@canlang/services/distribution"), ("@jridgewell/sourcemap-codec", "@canlang/cloudflare/worker/main")];
const MAX_FILES: usize = 8_000;

fn text(path: &Path) -> Result<String> { path.to_str().map(str::to_owned).ok_or_else(|| "producer path is not UTF-8".into()) }
fn canonical(path: impl AsRef<Path>) -> Result<PathBuf> { fs::canonicalize(path).map_err(|e| e.to_string()) }
fn json_file(path: &Path) -> Result<Value> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 { return Err("producer metadata exceeds limit".into()); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn resolve(specifier: &str, from: Option<&Path>, call: &Call<'_>, cancel: &AtomicBool) -> Result<Option<PathBuf>> {
    capture::check_cancel(cancel)?;
    let value = call("node.resolve", None, json!({"specifier":specifier,"from":from.map(text).transpose()?}), cancel)?;
    if value["absent"] == true { return Ok(None); }
    canonical(value["path"].as_str().ok_or("invalid Node resolution fact")?).map(Some)
}
fn required(specifier: &str, from: Option<&Path>, call: &Call<'_>, cancel: &AtomicBool) -> Result<PathBuf> {
    resolve(specifier, from, call, cancel)?.ok_or_else(|| format!("required producer is absent: {specifier}"))
}
#[derive(Clone)]
struct Package { root: PathBuf, manifest: Value, name: String, version: String }
fn package(entry: &Path) -> Result<Package> {
    let mut path = canonical(entry)?;
    if !path.is_dir() { path.pop(); }
    loop {
        let file = path.join("package.json");
        if file.is_file() {
            let manifest = json_file(&file)?;
            if let (Some(name), Some(version)) = (manifest["name"].as_str(), manifest["version"].as_str()) {
                return Ok(Package { root: path, name: name.into(), version: version.into(), manifest });
            }
        }
        if !path.pop() { return Err("producer has no owning package manifest".into()); }
    }
}
fn reference_root(platform: &Package) -> Result<(PathBuf, Option<PathBuf>, bool)> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = executable.parent().filter(|p| p.file_name().is_some_and(|n| n == "libexec")).and_then(Path::parent).filter(|p| p.join("manifest.json").is_file());
    if let Some(root) = std::env::var_os("CAN_INSTALL_ROOT").map(PathBuf::from).or_else(|| sibling.map(Path::to_owned)) {
        let root = canonical(root)?;
        if json_file(&root.join("manifest.json"))?["kind"] != "can-install" { return Err("invalid native installation manifest".into()); }
        return Ok((root.clone(), Some(root), true));
    }
    if let Some(root) = std::env::var_os("CAN_TOOL_ROOT") {
        let root = canonical(root)?;
        if json_file(&root.join("tools.json"))?["schema"] != "canlang.tools.v1" { return Err("invalid tool release manifest".into()); }
        return Ok((root.clone(), Some(root), false));
    }
    let root = platform.root.parent().and_then(Path::parent).ok_or("source runtime has no reference root")?;
    Ok((canonical(root)?, None, false))
}
fn extension(path: &Path, source: bool) -> bool {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if source { matches!(ext, "ts" | "tsx" | "js" | "mjs" | "json" | "css" | "rs" | "wasm") }
    else { matches!(ext, "js" | "mjs" | "cjs" | "json" | "wasm" | "css") && !path.to_string_lossy().ends_with(".test.js") }
}
fn walk(base: &Path, current: &Path, source: bool, ancestors: &mut BTreeSet<PathBuf>, out: &mut Vec<PathBuf>, cancel: &AtomicBool) -> Result<()> {
    capture::check_cancel(cancel)?;
    if ancestors.len() >= 64 { return Err("producer directory nesting exceeds limit".into()); }
    let actual = canonical(current)?;
    if !actual.starts_with(base) { return Err("producer file escapes its owning package".into()); }
    if !ancestors.insert(actual.clone()) { return Err("producer directory cycle".into()); }
    let mut entries = fs::read_dir(&actual).map_err(|e| e.to_string())?.collect::<std::io::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if matches!(entry.file_name().to_str(), Some("node_modules" | ".git")) { continue; }
        let path = entry.path();
        let info = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if info.file_type().is_symlink() {
            let target = canonical(&path)?;
            if !source && (target == base || ancestors.contains(&target)) { continue; }
            return Err("untracked source or producer alias".into());
        }
        if info.is_dir() { walk(base, &path, source, ancestors, out, cancel)?; }
        else if info.is_file() && extension(&path, source) { out.push(path); }
        if out.len() > MAX_FILES { return Err("producer membership exceeds finite limit".into()); }
    }
    ancestors.remove(&actual);
    Ok(())
}
fn add(map: &mut BTreeMap<String, String>, name: String, path: &Path) -> Result<()> {
    let path = text(path)?;
    if map.insert(name, path).is_some() { return Err("duplicate producer membership".into()); }
    if map.len() > MAX_FILES { return Err("producer membership exceeds finite limit".into()); }
    Ok(())
}
fn modified(path: &Path) -> Result<std::time::SystemTime> { fs::metadata(path).and_then(|s| s.modified()).map_err(|e| e.to_string()) }
fn entries(map: BTreeMap<String, String>) -> Vec<NamedInputPath> { map.into_iter().map(|(name,path)| NamedInputPath { name,path }).collect() }

pub fn collect(application_root: &Path, compiler: &Path, catalog: &Path, call: &Call<'_>, cancel: &AtomicBool) -> Result<Inventory> {
    let platform = package(&required("@canlang/cloudflare/worker/main", None, call, cancel)?)?;
    let (references, installation, installed) = reference_root(&platform)?;
    let mut selected = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::new();
    let mut owned = Vec::new();
    for specifier in OWNED {
        let resolved = if *specifier == "@canlang/testkit" {
            resolve(specifier, Some(application_root), call, cancel)?.or(resolve(specifier, None, call, cancel)?)
        } else { Some(required(specifier, None, call, cancel)?) };
        if let Some(path) = resolved { owned.push(package(&path)?); }
    }
    for pkg in &owned { queue.push_back((pkg.clone(), true)); }
    for (specifier, owner) in EXTERNAL {
        let owner = package(&required(owner, None, call, cancel)?)?;
        queue.push_back((package(&required(specifier, Some(&owner.root), call, cancel)?)?, false));
    }
    while let Some((pkg, is_owned)) = queue.pop_front() {
        if !seen.insert(pkg.root.clone()) { continue; }
        let output = if is_owned { pkg.root.join("dist") } else { pkg.root.clone() };
        if !output.is_dir() { return Err(format!("{} has no producer outputs",pkg.name)); }
        let context = if is_owned { String::new() } else {
            let anchor = installation.as_ref().unwrap_or(&platform.root);
            format!("instance:{}/", relative(anchor, &pkg.root))
        };
        let mut paths = vec![pkg.root.join("package.json")];
        walk(&pkg.root, &output, false, &mut BTreeSet::new(), &mut paths, cancel)?;
        for path in paths { add(&mut selected, format!("{}@{}/{}{}",pkg.name,pkg.version,context,relative(&pkg.root,&path)), &path)?; }
        if let Some(deps) = pkg.manifest["dependencies"].as_object() {
            for name in deps.keys().filter(|name| !name.starts_with("@canlang/")) {
                queue.push_back((package(&required(name, Some(&pkg.root), call, cancel)?)?, false));
            }
        }
    }
    for pkg in &owned {
        let prefix = format!("source:{}@{}/",pkg.name,pkg.version);
        if installed {
            if matches!(pkg.name.as_str(), "@canlang/values" | "@canlang/ui") {
                let leaf = pkg.name.strip_prefix("@canlang/").unwrap();
                let path = references.join("packages").join(leaf).join("src/catalog.ts");
                if !path.is_file() { return Err("owning authored catalog metadata is absent".into()); }
                add(&mut sources, format!("{prefix}src/catalog.ts"), &path)?;
            }
            continue;
        }
        if !pkg.root.join("src").is_dir() { continue; }
        let directories: &[&str] = if pkg.name == "@canlang/values" { &["src","scripts","semantics/src","bindings/src","bindings/generated","conformance/v1"] } else { &["src","scripts"] };
        let mut paths = vec![];
        for name in directories { let path = pkg.root.join(name); if path.is_dir() { walk(&pkg.root,&path,true,&mut BTreeSet::new(),&mut paths,cancel)?; } }
        for name in if pkg.name == "@canlang/values" { &["Cargo.toml","Cargo.lock"][..] } else if pkg.name == "@canlang/ui" { &["themes.css"][..] } else { &[][..] } { paths.push(pkg.root.join(name)); }
        if pkg.name == "@canlang/values" {
            let binding = modified(&pkg.root.join("bindings/generated/BUILD.json"))?;
            let rust:Vec<_> = paths.iter().filter(|p| p.starts_with(pkg.root.join("semantics/src"))).collect();
            if rust.is_empty() || rust.iter().any(|p| modified(p).is_ok_and(|t| t > binding)) { return Err("Values bindings are older than their native semantics".into()); }
        }
        let oldest = selected.iter().filter(|(n,p)| n.starts_with(&format!("{}@{}/dist/",pkg.name,pkg.version)) && p.ends_with(".js")).map(|(_,p)| modified(Path::new(p))).collect::<Result<Vec<_>>>()?.into_iter().min().ok_or("producer has no emitted JavaScript")?;
        if paths.iter().any(|p| modified(p).is_ok_and(|t| t > oldest)) { return Err(format!("{} outputs are older than source; rebuild this producer",pkg.name)); }
        for path in paths { add(&mut sources,format!("{prefix}{}",relative(&pkg.root,&path)),&path)?; }
    }
    let values = owned.iter().find(|p|p.name == "@canlang/values").ok_or("Values producer unavailable")?;
    let selected_catalog = canonical(catalog)?;
    if selected_catalog != canonical(values.root.join("dist/catalog.json"))? && selected_catalog != canonical(platform.root.join("dist/native-catalog.json"))? { return Err("catalog must belong to the selected installed producer".into()); }
    if values.root.join("src/catalog.ts").is_file() {
        let time = modified(&selected_catalog)?;
        if [values.root.join("src/catalog.ts"), values.root.join("dist/src/catalog.js")].iter().any(|p| modified(p).is_ok_and(|t| t > time)) { return Err("catalog is older than its owning producer".into()); }
    }
    let grammar = references.join("docs/specification/GRAMMAR.md");
    if !grammar.is_file() { return Err("installed grammar reference is unavailable".into()); }
    add(&mut sources,"grammar".into(),&grammar)?;
    let facts = call("runtime.constants",None,json!({}),cancel)?;
    add(&mut sources,"node".into(),&canonical(facts["nodePath"].as_str().ok_or("Node executable unavailable")?)?)?;
    add(&mut sources,"runtime-host".into(),&canonical(facts["hostPath"].as_str().ok_or("SDK host unavailable")?)?)?;
    let host=canonical(facts["hostPath"].as_str().ok_or("SDK host unavailable")?)?;
    for entry in fs::read_dir(host.parent().ok_or("host has no parent")?).map_err(|e|e.to_string())? {let path=entry.map_err(|e|e.to_string())?.path();if path.extension().is_some_and(|s|s=="mjs"){add(&mut sources,format!("runtime-host:{}",path.file_name().unwrap().to_string_lossy()),&path)?;}}
    add(&mut sources,"dev-server".into(),&canonical(std::env::current_exe().map_err(|e|e.to_string())?)?)?;
    let esbuild = if let Some(path) = std::env::var_os("ESBUILD_BINARY_PATH") { canonical(path)? } else {
        let esbuild = package(&required("esbuild",None,call,cancel)?)?;
        let arch = if cfg!(target_arch="aarch64") {"arm64"} else {"x64"};
        let os = if cfg!(target_os="macos") {"darwin"} else {"linux"};
        match resolve(&format!("@esbuild/{os}-{arch}/bin/esbuild"),Some(&esbuild.root),call,cancel)? {
            Some(path)=>path,
            None=>canonical(esbuild.root.join("lib").join(format!("downloaded-@esbuild-{os}-{arch}-esbuild")))?,
        }
    };
    if esbuild == Path::new("/usr/bin/esbuild") { return Err("reserved esbuild override".into()); }
    use std::os::unix::fs::PermissionsExt;
    if fs::metadata(&esbuild).map_err(|e|e.to_string())?.permissions().mode() & 0o111 == 0 { return Err("bundler is not executable".into()); }
    add(&mut sources,"esbuild".into(),&esbuild)?;
    let compiler = canonical(compiler)?;
    let installed_compiler = installation.as_ref().filter(|_|installed).map(|p|p.join("libexec/can")).filter(|p|p.exists()).map(canonical).transpose()?;
    if installed_compiler.as_ref() != Some(&compiler) {
        for p in compiler_inputs(&references,&compiler,cancel)? {add(&mut sources,format!("compiler-source:{}",relative(&references.join("compiler"),&p)),&p)?;}

    }
    for (name,leaf) in [("compiler-test","compiler/tests/construct_help.rs"),("fixture","compiler/tests/fixtures/construct-help-first-profile.can")] {
        let path=references.join(leaf); if path.is_file() { add(&mut sources,format!("construct-profile:{name}"),&path)?; }
    }
    if let Some(root)=&installation { add(&mut sources,if installed {"installation-manifest"} else {"tool-release-manifest"}.into(),&root.join(if installed {"manifest.json"} else {"tools.json"}))?; }
    add(&mut sources,"construct-catalog".into(),&platform.root.join("dist/native-dev-catalog.json"))?;
    browser_inputs(&owned,installation.is_some(),call,cancel,&mut sources)?;
    Ok(Inventory { package_input_paths:entries(selected), extra_input_paths:entries(sources) })
}
fn relative(base:&Path,path:&Path)->String {
    let b:Vec<_>=base.components().collect();let p:Vec<_>=path.components().collect();let common=b.iter().zip(&p).take_while(|(a,b)|a==b).count();
    std::iter::repeat_n("..".to_owned(),b.len()-common).chain(p[common..].iter().map(|c|c.as_os_str().to_string_lossy().into_owned())).collect::<Vec<_>>().join("/")
}

fn browser_inputs(owned:&[Package],installed:bool,call:&Call<'_>,cancel:&AtomicBool,out:&mut BTreeMap<String,String>)->Result<()> {
    let Some(kit)=owned.iter().find(|p|p.name=="@canlang/testkit") else{return Ok(())};
    let producer=kit.root.join("dist/browser/chromium.js");
    if !producer.is_file(){return Ok(())}
    add(out,"browser:producer".into(),&producer)?;
    let explicit=std::env::var_os("CAN_BROWSER_TOOLS_ROOT").map(PathBuf::from);
    let default=std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".local/share/can/development/browser/1.63.0");
    let selection=explicit.clone().unwrap_or(default);
    let tools=if selection.exists(){Some(canonical(&selection)?)}else if explicit.is_some(){return Err("explicit browser tooling is unavailable".into())}else{None};
    if installed && tools.is_none(){return Ok(())}
    if let Some(root)=&tools {
        let manifest=json_file(&root.join("package.json"))?;
        if manifest["name"]!="can-browser-development-tools" || manifest["version"]!="1.63.0" || manifest["devDependencies"]["@playwright/test"]!="1.63.0" {return Err("browser tools do not match pinned producer".into())}
    }
    let Some(entry)=resolve("@playwright/test",Some(tools.as_ref().unwrap_or(&kit.root)),call,cancel)? else{return Ok(())};
    add(out,"browser:driver-entry".into(),&entry)?;
    let driver=package(&entry)?;if driver.version!="1.63.0"{return Err("browser driver version mismatch".into())}
    let core=package(&required("playwright-core",Some(&driver.root),call,cancel)?)?;
    let mut queue=VecDeque::from([driver.clone()]);let mut seen=BTreeSet::new();
    while let Some(pkg)=queue.pop_front(){
        if !seen.insert(pkg.root.clone()){continue}
        let mut paths=vec![pkg.root.join("package.json")];walk_browser(&pkg.root,&pkg.root,&mut BTreeSet::new(),&mut paths,cancel)?;
        for path in paths {add(out,format!("browser:driver:{}@{}/{}",pkg.name,pkg.version,relative(&pkg.root,&path)),&path)?;}
        if let Some(deps)=pkg.manifest["dependencies"].as_object(){for name in deps.keys(){queue.push_back(package(&required(name,Some(&pkg.root),call,cancel)?)?);}}
    }
    let executable=if let Some(root)=tools {
        let manifest=json_file(&root.join("package.json"))?;let rel=manifest["canDevelopment"]["browserExecutable"].as_str().ok_or("browser tooling lacks its recorded executable")?;
        if Path::new(rel).is_absolute() || rel.split(['/', '\\']).any(|p|matches!(p,""|"..")){return Err("browser executable escapes installation".into())}
        let path=canonical(root.join(rel))?;if !path.starts_with(&root){return Err("browser executable escapes installation".into())}path
    }else{
        let fact=call("browser.executable",None,json!({"driverEntryPath":entry}),cancel)?;
        let path=PathBuf::from(fact["executablePath"].as_str().ok_or("browser executable fact unavailable")?);
        if !path.exists(){return Ok(())}canonical(path)?
    };
    add(out,"browser:executable".into(),&executable)?;
    let mut base=executable.parent().ok_or("browser executable owner unavailable")?;
    loop{
        let name=base.file_name().and_then(|p|p.to_str()).unwrap_or("");
        if name.strip_prefix("chromium-").or_else(||name.strip_prefix("chromium_headless_shell-")).is_some_and(|p|!p.is_empty()&&p.bytes().all(|b|b.is_ascii_digit())){break}
        base=base.parent().ok_or("browser installation has no locked owner")?;
    }
    let folder=base.file_name().and_then(|p|p.to_str()).ok_or("browser owner name unavailable")?;
    let browsers=json_file(&core.root.join("browsers.json"))?;
    let name=if folder.starts_with("chromium_headless_shell-"){ "chromium-headless-shell" }else{"chromium"};
    let revision=browsers["browsers"].as_array().and_then(|a|a.iter().find(|v|v["name"]==name)).and_then(|v|v["revision"].as_str()).ok_or("locked browser revision missing")?;
    if folder.rsplit('-').next()!=Some(revision)||!base.join("INSTALLATION_COMPLETE").is_file(){return Err("browser installation revision is not complete/current".into())}
    let mut paths=vec![];walk_browser(base,base,&mut BTreeSet::new(),&mut paths,cancel)?;
    for path in paths{add(out,format!("browser:installation:{folder}/{}",relative(base,&path)),&path)?;}
    Ok(())
}
fn walk_browser(base:&Path,current:&Path,ancestors:&mut BTreeSet<PathBuf>,out:&mut Vec<PathBuf>,cancel:&AtomicBool)->Result<()> {
    capture::check_cancel(cancel)?;
    let actual=canonical(current)?;
    if !actual.starts_with(base)||ancestors.len()>64||!ancestors.insert(actual.clone()){return Err("browser membership escapes or cycles".into())}
    for e in fs::read_dir(current).map_err(|e|e.to_string())?{
        let e=e.map_err(|e|e.to_string())?;if matches!(e.file_name().to_str(),Some("node_modules"|".git")){continue}
        let path=e.path();let actual=canonical(&path)?;
        if !actual.starts_with(base){return Err("browser input alias escapes installation".into())}
        if actual.is_dir(){walk_browser(base,&path,ancestors,out,cancel)?}else if actual.is_file(){out.push(path)}else{return Err("unsupported browser file kind".into())}
        if out.len()>16_000{return Err("browser membership exceeds finite limit".into())}
    }
    ancestors.remove(&actual);Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    #[test] fn membership_refuses_nonself_alias_and_sees_new_files(){
        let d=tempfile::tempdir().unwrap();fs::write(d.path().join("one.js"),"1").unwrap();let mut files=vec![];
        walk(d.path(),d.path(),false,&mut BTreeSet::new(),&mut files,&AtomicBool::new(false)).unwrap();assert_eq!(files.len(),1);
        fs::write(d.path().join("two.json"),"{}").unwrap();files.clear();walk(d.path(),d.path(),false,&mut BTreeSet::new(),&mut files,&AtomicBool::new(false)).unwrap();assert_eq!(files.len(),2);
        symlink(d.path().join("one.js"),d.path().join("alias.js")).unwrap();assert!(walk(d.path(),d.path(),false,&mut BTreeSet::new(),&mut files,&AtomicBool::new(false)).is_err());
    }
    #[test] fn instance_identity_retains_physical_package_position(){assert_eq!(relative(Path::new("/root/packages/cf"),Path::new("/root/node_modules/.bun/x")),"../../node_modules/.bun/x");}
}

pub fn compiler_inputs(root:&Path,compiler:&Path,cancel:&AtomicBool)->Result<Vec<PathBuf>> {
    let compiler=canonical(compiler)?;let target=canonical(root.join("compiler/target"))?;
    if !compiler.starts_with(&target)||compiler==target{return Err("compiler must belong to the selected checkout target".into());}
    let base=root.join("compiler");let mut paths=vec![];walk(&base,&base.join("src"),true,&mut BTreeSet::new(),&mut paths,cancel)?;
    paths.retain(|p|p.extension().is_some_and(|x|x=="rs"));paths.extend([base.join("Cargo.toml"),base.join("Cargo.lock")]);
    let built=modified(&compiler)?;if paths.is_empty(){return Err("compiler source inventory is empty".into());}
    for path in &paths {if modified(path)?>built{return Err("checkout compiler is older than source".into());}}
    Ok(paths)
}
