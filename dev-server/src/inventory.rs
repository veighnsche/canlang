//! Native producer membership and freshness. Node supplies only its module resolver
//! and the browser SDK's executable-path fact; it never enumerates this inventory.
use crate::capture::{self, Inventory, NamedInputPath, Result};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub type Call<'a> = dyn Fn(&str, Option<&str>, Value, &AtomicBool) -> Result<Value> + 'a;
const OWNED: &[&str] = &[
    "@canlang/cloudflare/worker/main",
    "@canlang/contracts/distribution",
    "@canlang/interfaces/distribution",
    "@canlang/identity/distribution",
    "@canlang/files/distribution",
    "@canlang/state/distribution",
    "@canlang/ui/distribution",
    "@canlang/stdlib/distribution",
    "@canlang/values/distribution",
    "@canlang/work/distribution",
    "@canlang/work-kernel/distribution",
    "@canlang/services/distribution",
    "@canlang/testkit",
];
const EXTERNAL: &[(&str, &str)] = &[
    (
        "@modelcontextprotocol/sdk",
        "@canlang/interfaces/distribution",
    ),
    ("cookie", "@canlang/identity/distribution"),
    ("@scure/base", "@canlang/identity/distribution"),
    ("csv-parse", "@canlang/ui/distribution"),
    ("@noble/hashes/sha2.js", "@canlang/services/distribution"),
    (
        "@jridgewell/sourcemap-codec",
        "@canlang/cloudflare/worker/main",
    ),
];
const MAX_FILES: usize = 8_000;

fn text(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "producer path is not UTF-8".into())
}
fn canonical(path: impl AsRef<Path>) -> Result<PathBuf> {
    fs::canonicalize(path).map_err(|e| e.to_string())
}
fn json_file(path: &Path) -> Result<Value> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("producer metadata exceeds limit".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Resolution {
    specifier: String,
    from: Option<PathBuf>,
}
impl Resolution {
    fn new(specifier: &str, from: Option<&Path>) -> Self {
        Self {
            specifier: specifier.into(),
            from: from.map(Path::to_owned),
        }
    }
}
#[derive(Clone)]
struct Package {
    root: PathBuf,
    manifest: Value,
    name: String,
    version: String,
}
// Facts are shared only inside this enumeration. Every capture/final currency
// check creates a new Resolver and re-observes Node resolution and package data.
struct Resolver<'a> {
    call: &'a Call<'a>,
    cancel: &'a AtomicBool,
    facts: BTreeMap<Resolution, Result<Option<PathBuf>>>,
    packages: BTreeMap<PathBuf, Package>,
}
impl<'a> Resolver<'a> {
    fn new(call: &'a Call<'a>, cancel: &'a AtomicBool) -> Self {
        Self {
            call,
            cancel,
            facts: BTreeMap::new(),
            packages: BTreeMap::new(),
        }
    }
    fn prefetch(&mut self, requests: impl IntoIterator<Item = Resolution>) -> Result<()> {
        let pending: Vec<_> = requests
            .into_iter()
            .filter(|request| !self.facts.contains_key(request))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        for batch in pending.chunks(512) {
            capture::check_cancel(self.cancel)?;
            let requests:Vec<_>=batch.iter().map(|r|Ok(json!({"specifier":r.specifier,"from":r.from.as_deref().map(text).transpose()?}))).collect::<Result<_>>()?;
            let reply = (self.call)(
                "node.resolve",
                None,
                json!({"requests":requests}),
                self.cancel,
            )
            .map_err(|e| format!("resolving producer batch: {e}"))?;
            let results = reply["results"]
                .as_array()
                .filter(|rows| rows.len() == batch.len())
                .ok_or("invalid Node resolution batch facts")?;
            for (request, value) in batch.iter().zip(results) {
                let fact = if let Some(error) = value.get("error") {
                    Err(format!(
                        "resolving producer {}: {}",
                        request.specifier,
                        error["message"].as_str().unwrap_or("Node resolver failed")
                    ))
                } else if value["absent"] == true {
                    Ok(None)
                } else {
                    value["path"]
                        .as_str()
                        .ok_or_else(|| "invalid Node resolution fact".to_string())
                        .and_then(canonical)
                        .map(Some)
                };
                self.facts.insert(request.clone(), fact);
            }
        }
        Ok(())
    }
    fn resolve(&mut self, specifier: &str, from: Option<&Path>) -> Result<Option<PathBuf>> {
        capture::check_cancel(self.cancel)?;
        let request = Resolution::new(specifier, from);
        self.prefetch([request.clone()])?;
        self.facts
            .get(&request)
            .expect("prefetched Node fact")
            .clone()
    }
    fn required(&mut self, specifier: &str, from: Option<&Path>) -> Result<PathBuf> {
        self.resolve(specifier, from)?
            .ok_or_else(|| format!("required producer is absent: {specifier}"))
    }
    fn prefetch_external(&mut self, requests: &[(String, PathBuf)]) -> Result<()> {
        self.prefetch(requests.iter().flat_map(|(name, from)| {
            [
                Resolution::new(&format!("{name}/package.json"), Some(from)),
                Resolution::new(name, Some(from)),
            ]
        }))
    }
    fn external(&mut self, specifier: &str, from: &Path) -> Result<PathBuf> {
        self.required(&format!("{specifier}/package.json"), Some(from))
            .or_else(|_| self.required(specifier, Some(from)))
    }
    fn package(&mut self, entry: &Path) -> Result<Package> {
        let entry = canonical(entry)?;
        if let Some(package) = self.packages.get(&entry) {
            return Ok(package.clone());
        }
        let mut path = entry.clone();
        if !path.is_dir() {
            path.pop();
        }
        let selected = loop {
            if let Some(package) = self.packages.get(&path) {
                break package.clone();
            }
            let file = path.join("package.json");
            if file.is_file() {
                let manifest = json_file(&file)?;
                if let (Some(name), Some(version)) =
                    (manifest["name"].as_str(), manifest["version"].as_str())
                {
                    break Package {
                        root: path.clone(),
                        name: name.into(),
                        version: version.into(),
                        manifest,
                    };
                }
            }
            if !path.pop() {
                return Err("producer has no owning package manifest".into());
            }
        };
        self.packages
            .insert(selected.root.clone(), selected.clone());
        self.packages.insert(entry, selected.clone());
        Ok(selected)
    }
}
fn reference_root(platform: &Package) -> Result<(PathBuf, Option<PathBuf>, bool)> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = executable
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "libexec"))
        .and_then(Path::parent)
        .filter(|p| p.join("manifest.json").is_file());
    if let Some(root) = std::env::var_os("CAN_INSTALL_ROOT")
        .map(PathBuf::from)
        .or_else(|| sibling.map(Path::to_owned))
    {
        let root = canonical(root)?;
        if json_file(&root.join("manifest.json"))?["kind"] != "can-install" {
            return Err("invalid native installation manifest".into());
        }
        return Ok((root.clone(), Some(root), true));
    }
    if let Some(root) = std::env::var_os("CAN_TOOL_ROOT") {
        let root = canonical(root)?;
        if json_file(&root.join("tools.json"))?["schema"] != "canlang.tools.v1" {
            return Err("invalid tool release manifest".into());
        }
        return Ok((root.clone(), Some(root), false));
    }
    let root = platform
        .root
        .parent()
        .and_then(Path::parent)
        .ok_or("source runtime has no reference root")?;
    Ok((canonical(root)?, None, false))
}
fn extension(path: &Path, source: bool) -> bool {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if source {
        matches!(
            ext,
            "ts" | "tsx" | "js" | "mjs" | "json" | "css" | "rs" | "wasm"
        )
    } else {
        matches!(ext, "js" | "mjs" | "cjs" | "json" | "wasm" | "css")
            && !path.to_string_lossy().ends_with(".test.js")
    }
}
fn walk(
    base: &Path,
    current: &Path,
    source: bool,
    ancestors: &mut BTreeSet<PathBuf>,
    out: &mut Vec<PathBuf>,
    cancel: &AtomicBool,
) -> Result<()> {
    capture::check_cancel(cancel)?;
    if ancestors.len() >= 64 {
        return Err("producer directory nesting exceeds limit".into());
    }
    let actual = canonical(current)?;
    if !actual.starts_with(base) {
        return Err("producer file escapes its owning package".into());
    }
    if !ancestors.insert(actual.clone()) {
        return Err("producer directory cycle".into());
    }
    let mut entries = fs::read_dir(&actual)
        .map_err(|e| e.to_string())?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if matches!(entry.file_name().to_str(), Some("node_modules" | ".git")) {
            continue;
        }
        walk_entry(base, entry.path(), source, ancestors, out, cancel)?;
    }
    ancestors.remove(&actual);
    Ok(())
}
fn walk_entry(
    base: &Path,
    path: PathBuf,
    source: bool,
    ancestors: &mut BTreeSet<PathBuf>,
    out: &mut Vec<PathBuf>,
    cancel: &AtomicBool,
) -> Result<()> {
    let info = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if info.file_type().is_symlink() {
        let target = canonical(&path)?;
        if !source && (target == base || ancestors.contains(&target)) {
            return Ok(());
        }
        return Err("untracked source or producer alias".into());
    }
    if info.is_dir() {
        walk(base, &path, source, ancestors, out, cancel)?;
    } else if info.is_file() && extension(&path, source) {
        out.push(path);
    }
    if out.len() > MAX_FILES {
        return Err("producer membership exceeds finite limit".into());
    }
    Ok(())
}

fn add(map: &mut BTreeMap<String, String>, name: String, path: &Path) -> Result<()> {
    let path = text(path)?;
    if map.get(&name).is_some_and(|existing| existing != &path) {
        return Err(format!("duplicate producer membership: {name}"));
    }
    map.insert(name, path);
    if map.len() > MAX_FILES {
        return Err("producer membership exceeds finite limit".into());
    }
    Ok(())
}
fn modified(path: &Path) -> Result<std::time::SystemTime> {
    fs::metadata(path)
        .and_then(|s| s.modified())
        .map_err(|e| e.to_string())
}
fn entries(map: BTreeMap<String, String>) -> Vec<NamedInputPath> {
    map.into_iter()
        .map(|(name, path)| NamedInputPath { name, path })
        .collect()
}

pub fn collect(
    application_root: &Path,
    compiler: &Path,
    catalog: &Path,
    call: &Call<'_>,
    cancel: &AtomicBool,
) -> Result<Inventory> {
    let mut resolver = Resolver::new(call, cancel);
    prefetch_producers(&mut resolver, application_root)?;
    let platform_path = resolver.required("@canlang/cloudflare/worker/main", None)?;
    let platform = resolver.package(&platform_path)?;
    let (references, installation, installed) = reference_root(&platform)?;
    let owned = owned_packages(&mut resolver, application_root)?;
    let selected = producer_outputs(&mut resolver, &owned, &platform, installation.as_deref())?;
    let mut sources = producer_sources(&owned, installed, &references, &selected, cancel)?;
    validate_catalog(&owned, &platform, catalog)?;
    reference_inputs(&references, &mut sources)?;
    runtime_inputs(call, cancel, &mut sources)?;
    let esbuild = bundler(&mut resolver)?;
    add(&mut sources, "esbuild".into(), &esbuild)?;
    compiler_source_inputs(
        &references,
        installation.as_deref(),
        installed,
        compiler,
        cancel,
        &mut sources,
    )?;
    installation_inputs(installation.as_deref(), installed, &platform, &mut sources)?;
    browser_inputs(&owned, installation.is_some(), &mut resolver, &mut sources)?;
    Ok(Inventory {
        package_input_paths: entries(selected),
        extra_input_paths: entries(sources),
    })
}
fn prefetch_producers(resolver: &mut Resolver<'_>, application_root: &Path) -> Result<()> {
    let mut initial: Vec<_> = OWNED
        .iter()
        .filter(|name| **name != "@canlang/testkit")
        .map(|name| Resolution::new(name, None))
        .collect();
    initial.push(Resolution::new("@canlang/testkit", Some(application_root)));
    if std::env::var_os("ESBUILD_BINARY_PATH").is_none() {
        initial.push(Resolution::new("esbuild", None));
    }
    resolver.prefetch(initial)
}
fn owned_packages(resolver: &mut Resolver<'_>, application_root: &Path) -> Result<Vec<Package>> {
    let mut owned = Vec::new();
    for specifier in OWNED {
        let resolved = if *specifier == "@canlang/testkit" {
            match resolver.resolve(specifier, Some(application_root))? {
                Some(path) => Some(path),
                None => resolver.resolve(specifier, None)?,
            }
        } else {
            Some(resolver.required(specifier, None)?)
        };
        if let Some(path) = resolved {
            owned.push(resolver.package(&path)?);
        }
    }
    Ok(owned)
}
fn producer_outputs(
    resolver: &mut Resolver<'_>,
    owned: &[Package],
    platform: &Package,
    installation: Option<&Path>,
) -> Result<BTreeMap<String, String>> {
    let mut selected = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::new();
    for pkg in owned {
        queue.push_back((pkg.clone(), true));
    }
    let mut external_requests = Vec::new();
    for (specifier, owner) in EXTERNAL {
        let path = resolver.required(owner, None)?;
        let owner = resolver.package(&path)?;
        external_requests.push((specifier.to_string(), owner.root));
    }
    resolver.prefetch_external(&external_requests)?;
    enqueue_external(resolver, external_requests, &mut queue)?;
    while !queue.is_empty() {
        let frontier: Vec<_> = queue.drain(..).collect();
        let mut dependencies = Vec::new();
        for (pkg, is_owned) in frontier {
            if !seen.insert(pkg.root.clone()) {
                continue;
            }
            package_outputs(
                &pkg,
                is_owned,
                installation.unwrap_or(&platform.root),
                &mut selected,
                resolver.cancel,
            )?;
            external_dependencies(&pkg, &mut dependencies);
        }
        resolver.prefetch_external(&dependencies)?;
        enqueue_external(resolver, dependencies, &mut queue)?;
    }
    Ok(selected)
}
fn enqueue_external(
    resolver: &mut Resolver<'_>,
    requests: Vec<(String, PathBuf)>,
    queue: &mut VecDeque<(Package, bool)>,
) -> Result<()> {
    for (specifier, owner) in requests {
        let path = resolver.external(&specifier, &owner)?;
        queue.push_back((resolver.package(&path)?, false));
    }
    Ok(())
}
fn external_dependencies(pkg: &Package, dependencies: &mut Vec<(String, PathBuf)>) {
    if let Some(deps) = pkg.manifest["dependencies"].as_object() {
        for name in deps.keys().filter(|name| !name.starts_with("@canlang/")) {
            dependencies.push((name.to_string(), pkg.root.clone()));
        }
    }
}
fn package_outputs(
    pkg: &Package,
    is_owned: bool,
    anchor: &Path,
    selected: &mut BTreeMap<String, String>,
    cancel: &AtomicBool,
) -> Result<()> {
    let output = if is_owned {
        pkg.root.join("dist")
    } else {
        pkg.root.clone()
    };
    if !output.is_dir() {
        return Err(format!("{} has no producer outputs", pkg.name));
    }
    let context = if is_owned {
        String::new()
    } else {
        format!("instance:{}/", relative(anchor, &pkg.root))
    };
    let mut paths = vec![pkg.root.join("package.json")];
    walk(
        &pkg.root,
        &output,
        false,
        &mut BTreeSet::new(),
        &mut paths,
        cancel,
    )?;
    for path in paths {
        add(
            selected,
            format!(
                "{}@{}/{}{}",
                pkg.name,
                pkg.version,
                context,
                relative(&pkg.root, &path)
            ),
            &path,
        )?;
    }
    Ok(())
}
fn producer_sources(
    owned: &[Package],
    installed: bool,
    references: &Path,
    selected: &BTreeMap<String, String>,
    cancel: &AtomicBool,
) -> Result<BTreeMap<String, String>> {
    let mut sources = BTreeMap::new();
    for pkg in owned {
        let prefix = format!("source:{}@{}/", pkg.name, pkg.version);
        if installed {
            installed_catalog_source(pkg, references, &prefix, &mut sources)?;
            continue;
        }
        if !pkg.root.join("src").is_dir() {
            continue;
        }
        let paths = authored_paths(pkg, cancel)?;
        if pkg.name == "@canlang/values" {
            validate_values_bindings(pkg, &paths)?;
        }
        validate_emitted_freshness(pkg, &paths, selected)?;
        for path in paths {
            add(
                &mut sources,
                format!("{prefix}{}", relative(&pkg.root, &path)),
                &path,
            )?;
        }
    }
    Ok(sources)
}
fn installed_catalog_source(
    pkg: &Package,
    references: &Path,
    prefix: &str,
    sources: &mut BTreeMap<String, String>,
) -> Result<()> {
    if matches!(pkg.name.as_str(), "@canlang/values" | "@canlang/ui") {
        let leaf = pkg.name.strip_prefix("@canlang/").unwrap();
        let path = references
            .join("packages")
            .join(leaf)
            .join("src/catalog.ts");
        if !path.is_file() {
            return Err("owning authored catalog metadata is absent".into());
        }
        add(sources, format!("{prefix}src/catalog.ts"), &path)?;
    }
    Ok(())
}
fn authored_paths(pkg: &Package, cancel: &AtomicBool) -> Result<Vec<PathBuf>> {
    let directories: &[&str] = if pkg.name == "@canlang/values" {
        &[
            "src",
            "scripts",
            "semantics/src",
            "bindings/src",
            "bindings/generated",
            "conformance/v1",
        ]
    } else {
        &["src", "scripts"]
    };
    let mut paths = vec![];
    for name in directories {
        let path = pkg.root.join(name);
        if path.is_dir() {
            walk(
                &pkg.root,
                &path,
                true,
                &mut BTreeSet::new(),
                &mut paths,
                cancel,
            )?;
        }
    }
    for name in if pkg.name == "@canlang/values" {
        &["Cargo.toml", "Cargo.lock"][..]
    } else if pkg.name == "@canlang/ui" {
        &["themes.css"][..]
    } else {
        &[][..]
    } {
        paths.push(pkg.root.join(name));
    }
    Ok(paths)
}
fn validate_values_bindings(pkg: &Package, paths: &[PathBuf]) -> Result<()> {
    let binding = modified(&pkg.root.join("bindings/generated/BUILD.json"))?;
    let rust: Vec<_> = paths
        .iter()
        .filter(|p| p.starts_with(pkg.root.join("semantics/src")))
        .collect();
    if rust.is_empty()
        || rust
            .iter()
            .map(|p| modified(p))
            .collect::<Result<Vec<_>>>()?
            .iter()
            .any(|t| *t > binding)
    {
        return Err("Values bindings are older than their native semantics".into());
    }
    Ok(())
}
fn validate_emitted_freshness(
    pkg: &Package,
    paths: &[PathBuf],
    selected: &BTreeMap<String, String>,
) -> Result<()> {
    let oldest = selected
        .iter()
        .filter(|(n, p)| {
            n.starts_with(&format!("{}@{}/dist/", pkg.name, pkg.version)) && p.ends_with(".js")
        })
        .map(|(_, p)| modified(Path::new(p)))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .min()
        .ok_or("producer has no emitted JavaScript")?;
    if paths
        .iter()
        .map(|p| modified(p))
        .collect::<Result<Vec<_>>>()?
        .iter()
        .any(|t| *t > oldest)
    {
        return Err(format!(
            "{} outputs are older than source; rebuild this producer",
            pkg.name
        ));
    }
    Ok(())
}
fn validate_catalog(owned: &[Package], platform: &Package, catalog: &Path) -> Result<()> {
    let values = owned
        .iter()
        .find(|p| p.name == "@canlang/values")
        .ok_or("Values producer unavailable")?;
    let selected_catalog = canonical(catalog)?;
    if selected_catalog != canonical(values.root.join("dist/catalog.json"))?
        && selected_catalog != canonical(platform.root.join("dist/native-catalog.json"))?
    {
        return Err("catalog must belong to the selected installed producer".into());
    }
    if values.root.join("src/catalog.ts").is_file() {
        let time = modified(&selected_catalog)?;
        if [
            values.root.join("src/catalog.ts"),
            values.root.join("dist/src/catalog.js"),
        ]
        .iter()
        .map(|p| modified(p))
        .collect::<Result<Vec<_>>>()?
        .iter()
        .any(|t| *t > time)
        {
            return Err("catalog is older than its owning producer".into());
        }
    }
    Ok(())
}
fn reference_inputs(references: &Path, sources: &mut BTreeMap<String, String>) -> Result<()> {
    let grammar = references.join("docs/specification/GRAMMAR.md");
    if !grammar.is_file() {
        return Err("installed grammar reference is unavailable".into());
    }
    add(sources, "grammar".into(), &grammar)
}
fn runtime_inputs(
    call: &Call<'_>,
    cancel: &AtomicBool,
    sources: &mut BTreeMap<String, String>,
) -> Result<()> {
    let facts = call("runtime.constants", None, json!({}), cancel)?;
    add(
        sources,
        "node".into(),
        &canonical(
            facts["nodePath"]
                .as_str()
                .ok_or("Node executable unavailable")?,
        )?,
    )?;
    add(
        sources,
        "runtime-host".into(),
        &canonical(facts["hostPath"].as_str().ok_or("SDK host unavailable")?)?,
    )?;
    let host = canonical(facts["hostPath"].as_str().ok_or("SDK host unavailable")?)?;
    for entry in
        fs::read_dir(host.parent().ok_or("host has no parent")?).map_err(|e| e.to_string())?
    {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|s| s == "mjs") {
            add(
                sources,
                format!(
                    "runtime-host:{}",
                    path.file_name().unwrap().to_string_lossy()
                ),
                &path,
            )?;
        }
    }
    add(
        sources,
        "dev-server".into(),
        &canonical(std::env::current_exe().map_err(|e| e.to_string())?)?,
    )
}
fn bundler(resolver: &mut Resolver<'_>) -> Result<PathBuf> {
    let esbuild = if let Some(path) = std::env::var_os("ESBUILD_BINARY_PATH") {
        canonical(path)?
    } else {
        let path = resolver.required("esbuild", None)?;
        let esbuild = resolver.package(&path)?;
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let os = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        match resolver.resolve(
            &format!("@esbuild/{os}-{arch}/bin/esbuild"),
            Some(&esbuild.root),
        )? {
            Some(path) => path,
            None => canonical(
                esbuild
                    .root
                    .join("lib")
                    .join(format!("downloaded-@esbuild-{os}-{arch}-esbuild")),
            )?,
        }
    };
    if esbuild == Path::new("/usr/bin/esbuild") {
        return Err("reserved esbuild override".into());
    }
    use std::os::unix::fs::PermissionsExt;
    if fs::metadata(&esbuild)
        .map_err(|e| e.to_string())?
        .permissions()
        .mode()
        & 0o111
        == 0
    {
        return Err("bundler is not executable".into());
    }
    Ok(esbuild)
}
fn compiler_source_inputs(
    references: &Path,
    installation: Option<&Path>,
    installed: bool,
    compiler: &Path,
    cancel: &AtomicBool,
    sources: &mut BTreeMap<String, String>,
) -> Result<()> {
    let compiler = canonical(compiler)?;
    let installed_compiler = installation
        .filter(|_| installed)
        .map(|p| p.join("libexec/can"))
        .filter(|p| p.exists())
        .map(canonical)
        .transpose()?;
    if installed_compiler.as_ref() != Some(&compiler) {
        for p in compiler_inputs(references, &compiler, cancel)? {
            add(
                sources,
                format!(
                    "compiler-source:{}",
                    relative(&references.join("compiler"), &p)
                ),
                &p,
            )?;
        }
    }
    Ok(())
}
fn installation_inputs(
    installation: Option<&Path>,
    installed: bool,
    platform: &Package,
    sources: &mut BTreeMap<String, String>,
) -> Result<()> {
    if let Some(root) = installation {
        add(
            sources,
            if installed {
                "installation-manifest"
            } else {
                "tool-release-manifest"
            }
            .into(),
            &root.join(if installed {
                "manifest.json"
            } else {
                "tools.json"
            }),
        )?;
    }
    add(
        sources,
        "construct-catalog".into(),
        &platform.root.join("dist/native-dev-catalog.json"),
    )
}

fn relative(base: &Path, path: &Path) -> String {
    let b: Vec<_> = base.components().collect();
    let p: Vec<_> = path.components().collect();
    let common = b.iter().zip(&p).take_while(|(a, b)| a == b).count();
    std::iter::repeat_n("..".to_owned(), b.len() - common)
        .chain(
            p[common..]
                .iter()
                .map(|c| c.as_os_str().to_string_lossy().into_owned()),
        )
        .collect::<Vec<_>>()
        .join("/")
}

fn browser_inputs(
    owned: &[Package],
    installed: bool,
    resolver: &mut Resolver<'_>,
    out: &mut BTreeMap<String, String>,
) -> Result<()> {
    let Some(kit) = owned.iter().find(|p| p.name == "@canlang/testkit") else {
        return Ok(());
    };
    let producer = kit.root.join("dist/browser/chromium.js");
    if !producer.is_file() {
        return Ok(());
    }
    add(out, "browser:producer".into(), &producer)?;
    let tools = browser_tools()?;
    if installed && tools.is_none() {
        return Ok(());
    }
    if let Some(root) = &tools {
        validate_browser_tools(root)?;
    }
    let Some(entry) = resolver.resolve(
        "@playwright/test",
        Some(tools.as_ref().unwrap_or(&kit.root)),
    )?
    else {
        return Ok(());
    };
    add(out, "browser:driver-entry".into(), &entry)?;
    let driver = resolver.package(&entry)?;
    if driver.version != "1.63.0" {
        return Err("browser driver version mismatch".into());
    }
    let core_entry = resolver.required("playwright-core", Some(&driver.root))?;
    let core = resolver.package(&core_entry)?;
    browser_driver_inputs(driver, resolver, out)?;
    let Some(executable) = browser_executable(tools.as_deref(), &entry, resolver)? else {
        return Ok(());
    };
    add(out, "browser:executable".into(), &executable)?;
    browser_installation_inputs(&executable, &core, out, resolver.cancel)
}
fn browser_tools() -> Result<Option<PathBuf>> {
    let explicit = std::env::var_os("CAN_BROWSER_TOOLS_ROOT").map(PathBuf::from);
    let default = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".local/share/can/development/browser/1.63.0");
    let selection = explicit.clone().unwrap_or(default);
    if selection.exists() {
        Ok(Some(canonical(&selection)?))
    } else if explicit.is_some() {
        Err("explicit browser tooling is unavailable".into())
    } else {
        Ok(None)
    }
}
fn validate_browser_tools(root: &Path) -> Result<()> {
    let manifest = json_file(&root.join("package.json"))?;
    if manifest["name"] != "can-browser-development-tools"
        || manifest["version"] != "1.63.0"
        || manifest["devDependencies"]["@playwright/test"] != "1.63.0"
    {
        return Err("browser tools do not match pinned producer".into());
    }
    Ok(())
}
fn browser_driver_inputs(
    driver: Package,
    resolver: &mut Resolver<'_>,
    out: &mut BTreeMap<String, String>,
) -> Result<()> {
    let mut queue = VecDeque::from([driver.clone()]);
    let mut seen = BTreeSet::new();
    while !queue.is_empty() {
        let frontier: Vec<_> = queue.drain(..).collect();
        let mut dependencies = Vec::new();
        for pkg in frontier {
            if !seen.insert(pkg.root.clone()) {
                continue;
            }
            browser_package_inputs(&pkg, out, resolver.cancel)?;
            if let Some(deps) = pkg.manifest["dependencies"].as_object() {
                for name in deps.keys() {
                    dependencies.push(Resolution::new(name, Some(&pkg.root)));
                }
            }
        }
        resolver.prefetch(dependencies.clone())?;
        for dependency in dependencies {
            let path = resolver.required(&dependency.specifier, dependency.from.as_deref())?;
            queue.push_back(resolver.package(&path)?);
        }
    }
    Ok(())
}
fn browser_package_inputs(
    pkg: &Package,
    out: &mut BTreeMap<String, String>,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut paths = vec![pkg.root.join("package.json")];
    walk_browser(
        &pkg.root,
        &pkg.root,
        &mut BTreeSet::new(),
        &mut paths,
        cancel,
    )?;
    for path in paths {
        add(
            out,
            format!(
                "browser:driver:{}@{}/{}",
                pkg.name,
                pkg.version,
                relative(&pkg.root, &path)
            ),
            &path,
        )?;
    }
    Ok(())
}
fn browser_executable(
    tools: Option<&Path>,
    entry: &Path,
    resolver: &Resolver<'_>,
) -> Result<Option<PathBuf>> {
    if let Some(root) = tools {
        return installed_browser_executable(root).map(Some);
    }
    let fact = (resolver.call)(
        "browser.executable",
        None,
        json!({"driverEntryPath":entry}),
        resolver.cancel,
    )?;
    let path = PathBuf::from(
        fact["executablePath"]
            .as_str()
            .ok_or("browser executable fact unavailable")?,
    );
    if !path.exists() {
        return Ok(None);
    }
    canonical(path).map(Some)
}
fn installed_browser_executable(root: &Path) -> Result<PathBuf> {
    let manifest = json_file(&root.join("package.json"))?;
    let rel = manifest["canDevelopment"]["browserExecutable"]
        .as_str()
        .ok_or("browser tooling lacks its recorded executable")?;
    if Path::new(rel).is_absolute() || rel.split(['/', '\\']).any(|p| matches!(p, "" | "..")) {
        return Err("browser executable escapes installation".into());
    }
    let path = canonical(root.join(rel))?;
    if !path.starts_with(root) {
        return Err("browser executable escapes installation".into());
    }
    Ok(path)
}
fn browser_owner(executable: &Path) -> Result<&Path> {
    let mut base = executable
        .parent()
        .ok_or("browser executable owner unavailable")?;
    loop {
        let name = base.file_name().and_then(|p| p.to_str()).unwrap_or("");
        if name
            .strip_prefix("chromium-")
            .or_else(|| name.strip_prefix("chromium_headless_shell-"))
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        {
            return Ok(base);
        }
        base = base
            .parent()
            .ok_or("browser installation has no locked owner")?;
    }
}
fn validate_browser_revision<'a>(base: &'a Path, core: &Package) -> Result<&'a str> {
    let folder = base
        .file_name()
        .and_then(|p| p.to_str())
        .ok_or("browser owner name unavailable")?;
    let browsers = json_file(&core.root.join("browsers.json"))?;
    let name = if folder.starts_with("chromium_headless_shell-") {
        "chromium-headless-shell"
    } else {
        "chromium"
    };
    let revision = browsers["browsers"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["name"] == name))
        .and_then(|v| v["revision"].as_str())
        .ok_or("locked browser revision missing")?;
    if folder.rsplit('-').next() != Some(revision) || !base.join("INSTALLATION_COMPLETE").is_file()
    {
        return Err("browser installation revision is not complete/current".into());
    }
    Ok(folder)
}
fn browser_installation_inputs(
    executable: &Path,
    core: &Package,
    out: &mut BTreeMap<String, String>,
    cancel: &AtomicBool,
) -> Result<()> {
    let base = browser_owner(executable)?;
    let folder = validate_browser_revision(base, core)?;
    let mut paths = vec![];
    walk_browser(base, base, &mut BTreeSet::new(), &mut paths, cancel)?;
    for path in paths {
        add(
            out,
            format!("browser:installation:{folder}/{}", relative(base, &path)),
            &path,
        )?;
    }
    Ok(())
}

fn walk_browser(
    base: &Path,
    current: &Path,
    ancestors: &mut BTreeSet<PathBuf>,
    out: &mut Vec<PathBuf>,
    cancel: &AtomicBool,
) -> Result<()> {
    capture::check_cancel(cancel)?;
    let actual = canonical(current)?;
    if !actual.starts_with(base) || ancestors.len() > 64 || !ancestors.insert(actual.clone()) {
        return Err("browser membership escapes or cycles".into());
    }
    for e in fs::read_dir(current).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        if matches!(e.file_name().to_str(), Some("node_modules" | ".git")) {
            continue;
        }
        let path = e.path();
        let actual = canonical(&path)?;
        if !actual.starts_with(base) {
            return Err("browser input alias escapes installation".into());
        }
        if actual.is_dir() {
            walk_browser(base, &path, ancestors, out, cancel)?
        } else if actual.is_file() {
            out.push(path)
        } else {
            return Err("unsupported browser file kind".into());
        }
        if out.len() > 16_000 {
            return Err("browser membership exceeds finite limit".into());
        }
    }
    ancestors.remove(&actual);
    Ok(())
}


pub fn compiler_inputs(root: &Path, compiler: &Path, cancel: &AtomicBool) -> Result<Vec<PathBuf>> {
    let compiler = canonical(compiler)?;
    let target = canonical(root.join("compiler/target"))?;
    if !compiler.starts_with(&target) || compiler == target {
        return Err("compiler must belong to the selected checkout target".into());
    }
    let base = root.join("compiler");
    let mut paths = vec![];
    walk(
        &base,
        &base.join("src"),
        true,
        &mut BTreeSet::new(),
        &mut paths,
        cancel,
    )?;
    paths.retain(|p| p.extension().is_some_and(|x| x == "rs"));
    paths.extend([base.join("Cargo.toml"), base.join("Cargo.lock")]);
    let built = modified(&compiler)?;
    if paths.is_empty() {
        return Err("compiler source inventory is empty".into());
    }
    for path in &paths {
        if modified(path)? > built {
            return Err("checkout compiler is older than source".into());
        }
    }
    Ok(paths)
}
