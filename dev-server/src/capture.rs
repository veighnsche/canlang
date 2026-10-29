//! Immutable source/input evidence. Inventory providers enumerate paths only;
//! this owner canonicalizes, reads and hashes every admitted input.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub type Result<T> = std::result::Result<T, String>;
pub type InventoryProvider<'a> = dyn Fn() -> Result<Inventory> + 'a;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NamedInputPath {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub package_input_paths: Vec<NamedInputPath>,
    #[serde(default)]
    pub extra_input_paths: Vec<NamedInputPath>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub checkout_root: String,
    pub app_path: String,
    pub profile: String,
    pub compiler_path: String,
    pub catalog_path: Option<String>,
    pub help_index_path: String,
    pub package_input_paths: Vec<NamedInputPath>,
    #[serde(default)]
    pub extra_input_paths: Vec<NamedInputPath>,
    #[serde(default)]
    pub semantic_options: BTreeMap<String, String>,
    #[serde(default)]
    pub input_inventory: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedInput {
    pub name: String,
    pub requested_path: Option<String>,
    pub canonical_path: Option<String>,
    pub sha256: Option<String>,
    pub bytes: Option<u64>,
    pub state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedClosure {
    pub root: String,
    pub files: Vec<GeneratedFile>,
    pub compiler_sources: Vec<String>,
    /// Compiler sources contributed by provider appdirs: `key` is the
    /// compiler-reported path (e.g. a trait `can.generated/<id>/...`
    /// carrier, which carries no app prefix), `physical` is the staged
    /// repo-relative path the bytes were snapshotted from. Provider `.can`
    /// files are intentionally absent: the provider snapshot covers them.
    #[serde(default)]
    pub provider_sources: Vec<ProviderCompilerSource>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCompilerSource {
    pub key: String,
    pub physical: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GeneratedFile {
    pub path: String,
    pub sha256: String,
}

/// One `use`-package provider captured into the closure, keyed by the
/// imported package name. Discovery proposes from owning `use`/`package`
/// declarations; the compiler's own verdict on the staged closure disposes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSource {
    pub package: String,
    pub snapshot: SourceSnapshot,
}

/// Node's Buffer JSON representation preserves the existing private bridge DTO.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BufferBytes {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceSnapshot {
    pub path: String,
    pub sha256: String,
    pub bytes: BufferBytes,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub requested_root: String,
    pub root: String,
    pub requested_app_path: String,
    pub app_path: String,
    pub compiler_operand: String,
    pub source_text: String,
    pub source_sha256: String,
    pub source_bytes: u64,
    pub source_revision: String,
    pub epoch_material: String,
    pub profile: String,
    pub semantic_options: BTreeMap<String, String>,
    pub inputs: Vec<CapturedInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_inventory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_closure: Option<GeneratedClosure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_snapshot: Option<Vec<SourceSnapshot>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_snapshot: Option<Vec<ProviderSource>>,
}

/// Owning profile declarations: the `app` count plus each `use` package
/// import with its source line, plus whether the line carries a `from=`
/// deployment binding. Same line discipline as admission: `#` comment
/// lines skipped, `export` prefixes transparent, keyword boundaries
/// exact (so `uses=` never reads as `use`).
pub(crate) fn profile_declarations(source_text: &str) -> (usize, Vec<(usize, String, bool)>) {
    let mut apps = 0;
    let mut uses = Vec::new();
    for (index, line) in source_text.lines().enumerate() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let after_export = line
            .strip_prefix("export")
            .filter(|tail| tail.starts_with(char::is_whitespace))
            .map(str::trim_start)
            .unwrap_or(line);
        if is_keyword(after_export, "use") {
            // A `from=` binding still stages its provider file when the
            // checkout has one (concrete member binding with verified
            // sends); when no file exists the compiler binds the
            // import opaque-external instead of erroring, so absence
            // is tolerated. The flag records which regime applies.
            let code = after_export.split('#').next().unwrap_or("");
            let bound = has_from_attribute(code);
            let name: String = after_export["use".len()..]
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                uses.push((index + 1, name, bound));
            }
        }
        if is_keyword(line, "app") {
            apps += 1;
        }
    }
    (apps, uses)
}

fn is_keyword(line: &str, word: &str) -> bool {
    line.strip_prefix(word).is_some_and(|tail| {
        tail.chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
    })
}

/// True when the (comment-stripped) use line carries a `from =` attribute.
/// A bound import split across lines conservatively keeps its
/// file-provider requirement and fails closed.
pub(crate) fn has_from_attribute(code: &str) -> bool {
    let bytes = code.as_bytes();
    let mut index = 0;
    while index + 4 <= bytes.len() {
        if code[index..].starts_with("from")
            && (index == 0 || !is_name_char(bytes[index - 1]))
            && bytes
                .get(index + 4)
                .is_some_and(|end| *end != b'_' && !end.is_ascii_alphanumeric())
        {
            let mut rest = &code[index + 4..];
            rest = rest.trim_start_matches(|c: char| c.is_whitespace());
            if rest.starts_with('=') {
                return true;
            }
        }
        index += 1;
    }
    false
}

fn is_name_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `app ... uses=[...]` composition members on one line: package or app
/// names the closure must also stage, or the compiler reports them as
/// unknown members. Same line discipline as [`profile_declarations`].
pub(crate) fn composition_members(source_text: &str) -> Vec<String> {
    let mut members = Vec::new();
    for line in source_text.lines() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !is_keyword(line, "app") {
            continue;
        }
        let Some(list) = line.split_once("uses=[") else {
            continue;
        };
        let Some(list) = list.1.split(']').next() else {
            continue;
        };
        for member in list.split(',') {
            let name: String = member
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                members.push(name);
            }
        }
    }
    members
}

pub(crate) fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(parts: &[String]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("sha256:{:x}", hash.finalize())
}
fn text(path: impl AsRef<Path>) -> Result<String> {
    path.as_ref()
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "input path is not UTF-8".into())
}
pub(crate) fn absolute(root: impl AsRef<Path>, path: impl AsRef<Path>) -> PathBuf {
    let joined = root.as_ref().join(path);
    let mut clean = PathBuf::new();
    for item in joined.components() {
        match item {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            _ => clean.push(item),
        }
    }
    clean
}
fn canonical(path: impl AsRef<Path>) -> Result<String> {
    text(fs::canonicalize(path).map_err(|e| e.to_string())?)
}
fn same_metadata(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    (
        a.dev(),
        a.ino(),
        a.len(),
        a.mtime(),
        a.mtime_nsec(),
        a.ctime(),
        a.ctime_nsec(),
    ) == (
        b.dev(),
        b.ino(),
        b.len(),
        b.mtime(),
        b.mtime_nsec(),
        b.ctime(),
        b.ctime_nsec(),
    )
}
struct StableRead {
    path: String,
    bytes: Vec<u8>,
    size: u64,
    sha256: String,
}
fn stable_read(path: &str, keep: bool, limit: u64, cancel: &AtomicBool) -> Result<StableRead> {
    check_cancel(cancel)?;
    let real = canonical(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&real)
        .map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > limit {
        return Err("input is not a bounded regular file".into());
    }
    let (bytes, size, sha256) = read_chunks(&mut file, keep, before.len(), cancel)?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    let current = fs::metadata(&real).map_err(|e| e.to_string())?;
    if !same_metadata(&before, &after)
        || !same_metadata(&after, &current)
        || size != current.len()
        || canonical(path)? != real
    {
        return Err(format!("input changed during capture: {path}"));
    }
    Ok(StableRead {
        path: real,
        bytes,
        size,
        sha256,
    })
}
fn read_chunks(
    file: &mut File,
    keep: bool,
    size: u64,
    cancel: &AtomicBool,
) -> Result<(Vec<u8>, u64, String)> {
    let mut bytes = Vec::new();
    let mut total = 0;
    let mut hash = Sha256::new();
    let mut chunk = vec![0; 256 * 1024];
    loop {
        check_cancel(cancel)?;
        let len = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if len == 0 {
            break;
        }
        total += len as u64;
        if total > size {
            return Err("input changed during capture".into());
        }
        hash.update(&chunk[..len]);
        if keep {
            bytes.extend_from_slice(&chunk[..len]);
        }
    }
    Ok((bytes, total, format!("{:x}", hash.finalize())))
}
fn named_paths(request: &CaptureRequest) -> Result<Vec<(String, Option<String>)>> {
    if request.compiler_path.is_empty()
        || request.help_index_path.is_empty()
        || request.package_input_paths.is_empty()
    {
        return Err(
            "compiler, help index and at least one package output are required capture inputs"
                .into(),
        );
    }
    let mut paths = vec![
        ("compiler".into(), Some(request.compiler_path.clone())),
        ("catalog".into(), request.catalog_path.clone()),
        ("help-index".into(), Some(request.help_index_path.clone())),
    ];
    paths.extend(
        request
            .package_input_paths
            .iter()
            .map(|p| (format!("package:{}", p.name), Some(p.path.clone()))),
    );
    paths.extend(
        request
            .extra_input_paths
            .iter()
            .map(|p| (format!("extra:{}", p.name), Some(p.path.clone()))),
    );
    let mut names = BTreeSet::new();
    for (name, path) in &paths {
        if name.ends_with(':') || path.as_deref() == Some("") || !names.insert(name.clone()) {
            return Err(format!("duplicate or empty capture input: {name}"));
        }
    }
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(paths)
}
pub(crate) fn read_input(
    root: &str,
    name: String,
    path: Option<String>,
    cancel: &AtomicBool,
) -> Result<CapturedInput> {
    let Some(path) = path else {
        return Ok(CapturedInput {
            name,
            requested_path: None,
            canonical_path: None,
            sha256: None,
            bytes: None,
            state: "missing".into(),
        });
    };
    let requested = text(absolute(root, path))?;
    let read = stable_read(&requested, false, 1024 * 1024 * 1024, cancel)?;
    Ok(CapturedInput {
        name,
        requested_path: Some(requested),
        canonical_path: Some(read.path),
        sha256: Some(read.sha256),
        bytes: Some(read.size),
        state: "present".into(),
    })
}
fn runtime_input(name: &str) -> bool {
    name.starts_with("package:")
        || name.starts_with("extra:source:")
        || name.starts_with("generated:")
}
fn inventory_paths(inventory: Inventory, runtime: bool) -> Vec<(String, Option<String>)> {
    let mut paths: Vec<_> = inventory
        .package_input_paths
        .into_iter()
        .map(|p| (format!("package:{}", p.name), Some(p.path)))
        .collect();
    paths.extend(
        inventory
            .extra_input_paths
            .into_iter()
            .filter(|p| !runtime || p.name.starts_with("source:"))
            .map(|p| (format!("extra:{}", p.name), Some(p.path))),
    );
    paths
}
fn inventory_matches(
    kind: &Option<String>,
    root: &str,
    selected: &[(String, Option<String>)],
    provider: &InventoryProvider<'_>,
    after: bool,
    runtime: bool,
) -> Result<()> {
    let Some(kind) = kind else {
        return Ok(());
    };
    if kind != "installed-local-preview" {
        return Err("unsupported input inventory".into());
    }
    let expected = inventory_paths(provider()?, runtime);
    let actual: BTreeMap<_, _> = selected
        .iter()
        .filter(|(n, _)| {
            if runtime {
                runtime_input(n) && !n.starts_with("generated:")
            } else {
                n.starts_with("package:") || n.starts_with("extra:")
            }
        })
        .cloned()
        .collect();
    if actual.len() != expected.len() {
        return Err("installed preview input membership changed".into());
    }
    let mut names = BTreeSet::new();
    for (name, path) in expected {
        if !names.insert(name.clone()) {
            return Err("duplicate installed preview input".into());
        }
        let selected = actual
            .get(&name)
            .and_then(Option::as_ref)
            .ok_or("installed preview input membership changed")?;
        let expected = text(absolute(root, path.ok_or("missing inventory path")?))?;
        let selected = text(absolute(root, selected))?;
        if !after && selected == expected {
            continue;
        }
        if canonical(&selected)? != canonical(&expected)? {
            return Err("installed preview input alias changed".into());
        }
    }
    Ok(())
}
fn operand(root: &str, path: &str) -> Result<String> {
    let rel = Path::new(path)
        .strip_prefix(root)
        .map_err(|_| "selected app escapes checkout root")?;
    let value = text(rel)?;
    if value.is_empty() || !value.ends_with(".can") {
        return Err("selected app must be a .can file inside checkout root".into());
    }
    Ok(value)
}

pub fn capture(
    request: &CaptureRequest,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
) -> Result<Capture> {
    capture_with_phases(request, inventory, cancel, &|_| {})
}
pub fn capture_with_phases(
    request: &CaptureRequest,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
    phase: &dyn Fn(&str),
) -> Result<Capture> {
    check_cancel(cancel)?;
    phase("capturing_source");
    if request.profile.is_empty() || request.semantic_options.keys().any(String::is_empty) {
        return Err("profile and semantic option names must be nonempty".into());
    }
    let root = canonical(&request.checkout_root)?;
    if !Path::new(&root).is_dir() {
        return Err("checkout root is not a directory".into());
    }
    let requested_app_path = text(absolute(&root, &request.app_path))?;
    let source = stable_read(&requested_app_path, true, u32::MAX as u64, cancel)?;
    let compiler_operand = operand(&root, &source.path)?;
    let source_text =
        String::from_utf8(source.bytes).map_err(|_| "selected source is not valid UTF-8")?;
    let paths = named_paths(request)?;
    phase("discovering_capture_membership");
    inventory_matches(
        &request.input_inventory,
        &root,
        &paths,
        inventory,
        false,
        false,
    )?;
    let mut captured = Capture {
        requested_root: request.checkout_root.clone(),
        root,
        requested_app_path,
        app_path: source.path,
        source_revision: digest(&[
            "can.dev.source-set.v1".into(),
            compiler_operand.clone(),
            source.sha256.clone(),
        ]),
        compiler_operand,
        source_text,
        source_sha256: source.sha256,
        source_bytes: source.size,
        epoch_material: String::new(),
        profile: request.profile.clone(),
        semantic_options: request.semantic_options.clone(),
        inputs: Vec::new(),
        input_inventory: request.input_inventory.clone(),
        generated_closure: None,
        source_snapshot: None,
        provider_snapshot: None,
    };
    phase("capturing_producer_bytes");
    captured.inputs = map_inputs(paths.len(), &|index| {
        let (name, path) = &paths[index];
        read_input(&captured.root, name.clone(), path.clone(), cancel)
    })?;
    phase("capturing_provider_closure");
    capture_provider_closure(&mut captured, cancel)?;
    phase("capturing_generated_inputs");
    capture_generated(&mut captured, cancel)?;
    captured.source_revision = digest(&{
        let mut parts = vec![
            "can.dev.source-set.v1".into(),
            captured.compiler_operand.clone(),
            captured.source_sha256.clone(),
        ];
        if let Some(providers) = &captured.provider_snapshot {
            for provider in providers {
                parts.extend([
                    provider.package.clone(),
                    provider.snapshot.path.clone(),
                    provider.snapshot.sha256.clone(),
                ]);
            }
        }
        parts
    });
    finish_capture(&mut captured, &paths, inventory, cancel, phase)?;
    Ok(captured)
}
fn finish_capture(
    captured: &mut Capture,
    paths: &[(String, Option<String>)],
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
    phase: &dyn Fn(&str),
) -> Result<()> {
    phase("verifying_capture_membership");
    if canonical(&captured.requested_root)? != captured.root
        || canonical(&captured.requested_app_path)? != captured.app_path
    {
        return Err("selected checkout or app path changed during capture".into());
    }
    inventory_matches(
        &captured.input_inventory,
        &captured.root,
        &paths,
        inventory,
        true,
        false,
    )?;
    phase("verifying_capture_bytes");
    verify_identity_reads(&captured, cancel, false)?;
    let final_source = stable_read(&captured.requested_app_path, false, u32::MAX as u64, cancel)?;
    if final_source.path != captured.app_path
        || final_source.sha256 != captured.source_sha256
        || final_source.size != captured.source_bytes
    {
        return Err("source changed during capture".into());
    }
    captured.epoch_material = epoch(&captured);
    Ok(())
}
fn epoch(capture: &Capture) -> String {
    let mut parts = vec![
        "can.dev.capture-epoch.v1".into(),
        capture.root.clone(),
        capture.compiler_operand.clone(),
        capture.source_revision.clone(),
        capture.profile.clone(),
        capture.semantic_options.len().to_string(),
    ];
    for (key, value) in &capture.semantic_options {
        parts.extend([key.clone(), value.clone()]);
    }
    parts.push(capture.inputs.len().to_string());
    for i in &capture.inputs {
        parts.extend([
            i.name.clone(),
            i.state.clone(),
            i.canonical_path.clone().unwrap_or_default(),
            i.sha256.clone().unwrap_or_default(),
            i.bytes.map(|b| b.to_string()).unwrap_or_default(),
        ]);
    }
    digest(&parts)
}
fn generated_marker(source: &str) -> bool {
    source
        .as_bytes()
        .windows(2)
        .any(|p| p[0] == b'$' && (p[1] == b'"' || p[1] == b'_' || p[1].is_ascii_alphabetic()))
}
fn capture_generated(capture: &mut Capture, cancel: &AtomicBool) -> Result<()> {
    if capture.input_inventory.is_none() || !generated_marker_needed(capture) {
        return Ok(());
    }
    let closure = discover_generated(capture, cancel)?;
    let snapshot = snapshot_generated(capture, &closure, cancel)?;
    if snapshot
        .iter()
        .find(|s| s.path == capture.compiler_operand)
        .map(|s| &s.sha256)
        != Some(&capture.source_sha256)
    {
        return Err("source changed during generated capture".into());
    }
    for input in &closure.files {
        let identity = read_input(
            &capture.root,
            format!("generated:{}", input.path),
            Some(input.path.clone()),
            cancel,
        )?;
        if identity.sha256.as_ref() != Some(&input.sha256) {
            return Err("saved generation input changed during capture".into());
        }
        capture.inputs.push(identity);
    }
    capture.generated_closure = Some(closure);
    capture.source_snapshot = Some(snapshot);
    Ok(())
}

/// Resolve every `use` package of the app source (transitively) to the
/// selectable `.can` file declaring it, and freeze the providers into the
/// capture. Exactly one declaring file must exist; zero or several refuse.
/// A `use` of the app's own package needs no extra operand. Discovery is
/// bounded and proposes only: the compiler's verdict on the staged closure
/// (plus `verify_compiler_sources`) is the membership authority. Both
/// `use` package imports and `app ... uses=[...]` composition members
/// (which may name apps or packages) seed the closure transitively.
pub(crate) fn capture_provider_closure(captured: &mut Capture, cancel: &AtomicBool) -> Result<()> {
    let (_, uses) = profile_declarations(&captured.source_text);
    let composed = composition_members(&captured.source_text);
    if uses.is_empty() && composed.is_empty() {
        return Ok(());
    }
    let mut own = BTreeSet::new();
    for line in captured.source_text.lines() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if is_keyword(line, "package") {
            let name: String = line["package".len()..]
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                own.insert(name);
            }
        }
    }
    let mut resolved: Vec<ProviderSource> = Vec::new();
    let mut seen = BTreeSet::new();
    // A name is required when ANY occurrence is a bare `use` or a
    // composition member; `from=`-only names tolerate absence (the
    // compiler binds them opaque-external).
    let mut required = BTreeSet::new();
    let mut pending: Vec<String> = Vec::new();
    for (_, name, bound) in uses {
        if !bound {
            required.insert(name.clone());
        }
        pending.push(name);
    }
    for name in composed {
        required.insert(name.clone());
        pending.push(name);
    }
    let mut rounds = 0usize;
    while let Some(package) = pending.pop() {
        if !seen.insert(package.clone()) {
            continue;
        }
        rounds += 1;
        if rounds > 64 {
            return Err("provider closure did not converge".into());
        }
        if own.contains(&package) {
            continue;
        }
        // T14b/B1: `std` is a compiler-known provider fed by consumed
        // schemas, never by a checkout file; the compiler binds its
        // members as externals itself.
        if package == "std" {
            continue;
        }
        check_cancel(cancel)?;
        let canonical = match locate_member_source(&captured.root, &package) {
            Ok(canonical) => canonical,
            Err(_) if !required.contains(&package) => continue,
            Err(error) => return Err(error),
        };
        let read = stable_read(&canonical, true, u32::MAX as u64, cancel)?;
        let relative = operand(&captured.root, &read.path)?;
        if relative == captured.compiler_operand {
            continue;
        }
        let provider_text = String::from_utf8(read.bytes.clone())
            .map_err(|_| format!("provider source {relative} is not valid UTF-8"))?;
        let (_, nested) = profile_declarations(&provider_text);
        for (_, name, bound) in nested {
            if !bound {
                required.insert(name.clone());
            }
            pending.push(name);
        }
        for name in composition_members(&provider_text) {
            required.insert(name.clone());
            pending.push(name);
        }
        resolved.push(ProviderSource {
            package,
            snapshot: SourceSnapshot {
                path: relative,
                sha256: read.sha256,
                bytes: BufferBytes {
                    kind: "Buffer".into(),
                    data: read.bytes,
                },
            },
        });
    }
    resolved.sort_by(|a, b| a.snapshot.path.cmp(&b.snapshot.path));
    captured.provider_snapshot = Some(resolved);
    Ok(())
}

/// Provider discovery inside the established selectable-source universe:
/// `<root>/draft/apps/*/*.can` plus `<root>/draft/shared/*.can`, mirroring
/// the accepted `discoverDraftSources`/`selectedInventory` inventory. Scratch,
/// build output, fixtures and frozen evidence elsewhere in the checkout are
/// never selectable preview inputs. Proposes a candidate path; the compiler's
/// own verdict on the staged closure is the membership authority, and any
/// remaining ambiguity refuses explicitly.
fn locate_package_provider(root: &str, package: &str) -> Result<String> {
    let mut candidates = Vec::new();
    let apps = Path::new(root).join("draft").join("apps");
    if let Ok(entries) = fs::read_dir(&apps) {
        let mut dirs: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
        dirs.sort_by_key(|entry| entry.file_name());
        for dir in dirs {
            if dir.metadata().is_ok_and(|meta| meta.is_dir()) {
                candidates.extend(app_dir_sources(&dir.path()));
            }
        }
    }
    candidates.extend(app_dir_sources(
        &Path::new(root).join("draft").join("shared"),
    ));
    let mut hits = Vec::new();
    for path in candidates {
        let source = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        for line in source.lines() {
            let line = line.trim_start();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if is_keyword(line, "package") {
                let declared: String = line["package".len()..]
                    .trim_start()
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                if declared == package {
                    hits.push(text(canonical(
                        path.to_str().ok_or("provider path is not UTF-8")?,
                    )?)?);
                    break;
                }
            }
        }
    }
    match hits.len() {
        0 => Err(format!(
            "imported package {package} has no provider source in the checkout"
        )),
        1 => Ok(hits.into_iter().next().unwrap()),
        _ => Err(format!(
            "imported package {package} is ambiguous across provider sources"
        )),
    }
}

/// Composition members may name apps (`draft/apps/<Name>/<Name>.can`)
/// or packages. Prefer the app file when it exists; otherwise fall
/// back to the package provider search.
fn locate_member_source(root: &str, member: &str) -> Result<String> {
    let app_path = Path::new(root)
        .join("draft")
        .join("apps")
        .join(member)
        .join(format!("{member}.can"));
    if app_path.is_file() {
        return text(canonical(
            app_path.to_str().ok_or("provider path is not UTF-8")?,
        )?);
    }
    locate_package_provider(root, member)
}

/// Top-level `.can` files of one source directory, sorted for determinism.
fn app_dir_sources(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file() && path.extension().is_some_and(|extension| extension == "can")
        })
        .collect();
    files.sort();
    files
}

pub fn is_current(
    capture: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
) -> bool {
    is_current_with_phases(capture, inventory, cancel, &|_| {})
}
pub fn is_current_with_phases(
    capture: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
    phase: &dyn Fn(&str),
) -> bool {
    if inputs_current_with_phases(capture, inventory, cancel, false, phase).is_err() {
        return false;
    }
    phase("verifying_source_bytes");
    if !stable_read(&capture.requested_app_path, false, u32::MAX as u64, cancel).is_ok_and(|r| {
        r.path == capture.app_path
            && r.size == capture.source_bytes
            && r.sha256 == capture.source_sha256
    }) {
        return false;
    }
    phase("verifying_provider_bytes");
    let Some(providers) = &capture.provider_snapshot else {
        return true;
    };
    providers.iter().all(|provider| {
        text(absolute(&capture.root, &provider.snapshot.path))
            .ok()
            .and_then(|path| stable_read(&path, false, u32::MAX as u64, cancel).ok())
            .is_some_and(|read| read.sha256 == provider.snapshot.sha256)
    })
}
pub fn producer_inputs_current(
    capture: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
) -> bool {
    inputs_current(capture, inventory, cancel, false).is_ok()
}
pub fn runtime_inputs_current(
    capture: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
) -> bool {
    inputs_current(capture, inventory, cancel, true).is_ok()
}
fn inputs_current(
    capture: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
    runtime: bool,
) -> Result<()> {
    inputs_current_with_phases(capture, inventory, cancel, runtime, &|_| {})
}
fn inputs_current_with_phases(
    capture: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
    runtime: bool,
    phase: &dyn Fn(&str),
) -> Result<()> {
    check_cancel(cancel)?;
    phase("verifying_inventory");
    if canonical(&capture.requested_root)? != capture.root {
        return Err("checkout alias changed".into());
    }
    let paths: Vec<_> = capture
        .inputs
        .iter()
        .map(|i| (i.name.clone(), i.requested_path.clone()))
        .collect();
    inventory_matches(
        &capture.input_inventory,
        &capture.root,
        &paths,
        inventory,
        false,
        runtime,
    )?;
    if let Some(closure) = &capture.generated_closure {
        phase("verifying_generated_membership");
        let discovered = if runtime {
            discover_current_generated(capture, cancel)?
        } else {
            discover_generated(capture, cancel)?
        };
        if &discovered != closure {
            return Err("saved generation closure changed".into());
        }
    }
    phase("verifying_producer_bytes");
    verify_identity_reads(capture, cancel, runtime)
}
fn verify_identity_reads(capture: &Capture, cancel: &AtomicBool, runtime: bool) -> Result<()> {
    let selected: Vec<_> = capture
        .inputs
        .iter()
        .filter(|i| !runtime || runtime_input(&i.name))
        .collect();
    map_inputs(selected.len(), &|index| {
        let input = selected[index];
        let current = read_input(
            &capture.root,
            input.name.clone(),
            input.requested_path.clone(),
            cancel,
        )?;
        if &current != input {
            return Err(format!("input {} changed after capture", input.name));
        }
        Ok(())
    })?;
    Ok(())
}
/// Match the existing capture reader bound: independent files may hash in
/// parallel, but every started reader joins before any failure escapes.
fn map_inputs<T: Send>(
    length: usize,
    read: &(impl Fn(usize) -> Result<T> + Sync),
) -> Result<Vec<T>> {
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..length.min(8) {
            workers.push(scope.spawn(|| {
                let mut completed = Vec::new();
                while !failed.load(Ordering::Acquire) {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= length {
                        break;
                    }
                    let result = read(index);
                    if result.is_err() {
                        failed.store(true, Ordering::Release);
                    }
                    completed.push((index, result));
                }
                completed
            }));
        }
        let mut results: Vec<Option<Result<T>>> = (0..length).map(|_| None).collect();
        let mut panicked = false;
        for worker in workers {
            match worker.join() {
                Ok(completed) => {
                    for (index, result) in completed {
                        results[index] = Some(result);
                    }
                }
                Err(_) => {
                    panicked = true;
                }
            }
        }
        if panicked {
            return Err("input reader panicked".into());
        }
        results
            .into_iter()
            .map(|item| item.ok_or_else(|| "capture input reader stopped".to_string())?)
            .collect()
    })
}

pub(crate) fn verified_bytes(
    capture: &Capture,
    name: &str,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    let input = capture
        .inputs
        .iter()
        .find(|i| i.name == name)
        .ok_or_else(|| format!("captured compiler input {name} is unavailable"))?;
    let requested = input
        .requested_path
        .as_ref()
        .ok_or("missing captured compiler input")?;
    let read = stable_read(requested, true, 1024 * 1024 * 1024, cancel)?;
    if input.state != "present"
        || input.sha256.as_ref() != Some(&read.sha256)
        || input.canonical_path.as_ref() != Some(&read.path)
        || input.bytes != Some(read.size)
    {
        return Err(format!("input {name} changed after capture"));
    }
    Ok(read.bytes)
}
#[derive(Deserialize)]
struct GenerationReport {
    ok: bool,
    units: Vec<GenerationUnit>,
}
#[derive(Deserialize)]
struct GenerationUnit {
    id: Option<String>,
    association: Option<String>,
    current_files: Option<Vec<GeneratedFile>>,
    compiler_sources: Option<Vec<String>>,
}
pub(crate) fn discover_generated(
    capture: &Capture,
    cancel: &AtomicBool,
) -> Result<GeneratedClosure> {
    let compiler = verified_bytes(capture, "compiler", cancel)?;
    discover_with_compiler(capture, cancel, &compiler)
}
fn discover_current_generated(capture: &Capture, cancel: &AtomicBool) -> Result<GeneratedClosure> {
    // Old artifact reruns depend on current generated membership and runtime
    // producers, independently of analysis-only compiler byte changes.
    let path = capture
        .inputs
        .iter()
        .find(|i| i.name == "compiler")
        .and_then(|i| i.requested_path.as_deref())
        .ok_or("captured compiler path is unavailable")?;
    let compiler = stable_read(path, true, 1024 * 1024 * 1024, cancel)?;
    discover_with_compiler(capture, cancel, &compiler.bytes)
}
/// Providers grouped by parent directory (absolute), each file paired with
/// whether its bytes carry a generation marker. Sorted by directory for
/// deterministic rediscovery.
fn provider_source_dirs(capture: &Capture) -> Result<BTreeMap<PathBuf, Vec<(String, bool)>>> {
    let mut by_dir: BTreeMap<PathBuf, Vec<(String, bool)>> = BTreeMap::new();
    let Some(providers) = &capture.provider_snapshot else {
        return Ok(by_dir);
    };
    for provider in providers {
        let abs = absolute(Path::new(&capture.root), &provider.snapshot.path);
        let dir = abs
            .parent()
            .ok_or("provider source has no parent")?
            .to_path_buf();
        let marker = generated_marker(&String::from_utf8_lossy(&provider.snapshot.bytes.data));
        by_dir.entry(dir).or_default().push((text(&abs)?, marker));
    }
    for files in by_dir.values_mut() {
        files.sort();
    }
    Ok(by_dir)
}

fn generated_marker_needed(capture: &Capture) -> bool {
    if generated_marker(&capture.source_text) {
        return true;
    }
    let Ok(dirs) = provider_source_dirs(capture) else {
        return true;
    };
    dirs.values()
        .flat_map(|files| files.iter().map(|(_, marker)| *marker))
        .any(|marker| marker)
}

fn discover_with_compiler(
    capture: &Capture,
    cancel: &AtomicBool,
    compiler: &[u8],
) -> Result<GeneratedClosure> {
    let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
    let executable = staging.path().join("can");
    crate::compiler::write_executable(&executable, compiler)?;
    let app_project = Path::new(&capture.app_path)
        .parent()
        .ok_or("app has no parent")?
        .to_path_buf();
    let mut by_dir = provider_source_dirs(capture)?;
    // Same-directory providers ride the app discovery call: their units
    // associate against the same project root.
    let mut app_files = vec![capture.app_path.clone()];
    if let Some(same) = by_dir.remove(&app_project) {
        app_files.extend(same.into_iter().map(|(path, _)| path));
    }
    app_files.sort();
    let mut closure = discover_dir(capture, cancel, &executable, &app_project, &app_files)?;
    // Provider `.can` entries are covered by the provider snapshot in
    // membership; only carrier entries need provider-source records.
    let provider_paths: BTreeSet<String> = capture
        .provider_snapshot
        .iter()
        .flatten()
        .map(|p| p.snapshot.path.clone())
        .collect();
    closure.compiler_sources.retain(|entry| {
        entry == &capture.compiler_operand
            || !provider_paths.contains(
                &relative_path(Path::new(&capture.root), &absolute(&app_project, entry))
                    .unwrap_or_default(),
            )
    });
    for (dir, files) in &by_dir {
        if !files.iter().any(|(_, marker)| *marker) {
            continue;
        }
        let paths: Vec<String> = files.iter().map(|(path, _)| path.clone()).collect();
        let extra = discover_dir(capture, cancel, &executable, dir, &paths)?;
        merge_provider_closure(capture, &mut closure, dir, extra, &provider_paths)?;
    }
    closure.files.sort_by(|a, b| a.path.cmp(&b.path));
    closure.compiler_sources.sort();
    closure.provider_sources.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(closure)
}

fn discover_dir(
    capture: &Capture,
    cancel: &AtomicBool,
    executable: &Path,
    project: &Path,
    files: &[String],
) -> Result<GeneratedClosure> {
    let request = serde_json::json!({"version":1,"request_id":format!("dev-capture-{}",std::process::id()),"operation":"status","root":project,"files":files});
    let run = crate::compiler::run_owned(
        executable,
        &["gen".into()],
        Path::new(&capture.root),
        &[("CAN_GENERATION_COMPILER_ONLY", "1")],
        Some(request.to_string().into_bytes()),
        cancel,
        60,
        8 * 1024 * 1024,
    )?;
    if run.code != Some(0) {
        return Err("saved generation discovery failed".into());
    }
    let report: GenerationReport = serde_json::from_slice(&run.stdout)
        .map_err(|e| format!("invalid saved generation discovery: {e}"))?;
    if !report.ok {
        return Err("saved generation discovery refused".into());
    }
    closure_from_report(capture, project, report)
}

/// Union one provider directory's closure into the app closure. File paths
/// are repo-relative so appdirs cannot collide; a same-path hash conflict
/// refuses. Compiler sources naming provider `.can` files are dropped
/// (the provider snapshot covers them in membership); carrier entries
/// become explicit provider sources keyed by compiler-reported path.
fn merge_provider_closure(
    capture: &Capture,
    closure: &mut GeneratedClosure,
    project: &Path,
    extra: GeneratedClosure,
    provider_paths: &BTreeSet<String>,
) -> Result<()> {
    for file in extra.files {
        if let Some(old) = closure.files.iter().find(|f| f.path == file.path) {
            if old.sha256 != file.sha256 {
                return Err("conflicting saved generation inputs".into());
            }
            continue;
        }
        closure.files.push(file);
    }
    for entry in extra.compiler_sources {
        let physical = relative_path(Path::new(&capture.root), &absolute(project, &entry))?;
        if provider_paths.contains(&physical) {
            continue;
        }
        let physical_abs = absolute(Path::new(&capture.root), &physical);
        if !physical_abs.starts_with(project) {
            return Err("provider compiler source escapes its project".into());
        }
        if let Some(old) = closure.provider_sources.iter().find(|s| s.key == entry) {
            if old.physical != physical {
                return Err("conflicting provider compiler source".into());
            }
            continue;
        }
        closure.provider_sources.push(ProviderCompilerSource {
            key: entry,
            physical,
        });
    }
    Ok(())
}
fn relative_path(root: &Path, path: &Path) -> Result<String> {
    let base: Vec<_> = root.components().collect();
    let child: Vec<_> = path.components().collect();
    let shared = base.iter().zip(&child).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in shared..base.len() {
        out.push("..");
    }
    for part in &child[shared..] {
        out.push(part);
    }
    text(out)
}
fn closure_from_report(
    capture: &Capture,
    project: &Path,
    report: GenerationReport,
) -> Result<GeneratedClosure> {
    let mut files = BTreeMap::new();
    let mut sources = BTreeSet::new();
    for unit in report
        .units
        .into_iter()
        .filter(|u| u.id.is_some() && u.association.as_deref() != Some("orphaned"))
    {
        for input in unit
            .current_files
            .ok_or("compiler lacks saved generation capture handoff")?
        {
            let path = text(
                absolute(project, &input.path)
                    .strip_prefix(&capture.root)
                    .map_err(|_| "saved generation input escapes root")?,
            )?;
            validate_relative(&path)?;
            if !valid_hash(&input.sha256) {
                return Err("invalid saved generation input hash".into());
            }
            if absolute(&capture.root, &path) == Path::new(&capture.app_path) {
                continue;
            }
            if files
                .insert(path, input.sha256.clone())
                .is_some_and(|old| old != input.sha256)
            {
                return Err("conflicting saved generation inputs".into());
            }
        }
        for source in unit
            .compiler_sources
            .ok_or("compiler lacks saved generation source handoff")?
        {
            let path = absolute(project, source);
            sources.insert(if path == Path::new(&capture.app_path) {
                capture.compiler_operand.clone()
            } else {
                relative_path(project, &path)?
            });
        }
    }
    Ok(GeneratedClosure {
        root: text(project)?,
        files: files
            .into_iter()
            .map(|(path, sha256)| GeneratedFile { path, sha256 })
            .collect(),
        compiler_sources: sources.into_iter().collect(),
        provider_sources: Vec::new(),
    })
}
pub(crate) fn validate_relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains('\\')
        || Path::new(path).is_absolute()
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("invalid root-relative source path".into());
    }
    Ok(())
}
pub(crate) fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn snapshot_generated(
    capture: &Capture,
    closure: &GeneratedClosure,
    cancel: &AtomicBool,
) -> Result<Vec<SourceSnapshot>> {
    let mut paths: BTreeSet<_> = closure.files.iter().map(|f| f.path.clone()).collect();
    paths.insert(capture.compiler_operand.clone());
    // Lease every project dir containing staged files: the app project
    // plus any provider dir with union files. Nested projects lease each
    // containing level so no writer journal or lock scope is missed; a
    // file under no project refuses instead of locking sideways.
    let root = Path::new(&capture.root);
    let mut candidates: BTreeSet<PathBuf> = BTreeSet::from([PathBuf::from(&closure.root)]);
    for dir in provider_source_dirs(capture)?.keys() {
        candidates.insert(dir.clone());
    }
    let mut grouped: BTreeMap<PathBuf, Vec<&String>> = BTreeMap::new();
    for path in &paths {
        let abs = absolute(root, path);
        let owners: Vec<PathBuf> = candidates
            .iter()
            .filter(|dir| abs.starts_with(dir))
            .cloned()
            .collect();
        if owners.is_empty() {
            return Err("saved generation input escapes projects".into());
        }
        for owner in owners {
            grouped.entry(owner).or_default().push(path);
        }
    }
    let mut held = Vec::new();
    for (project, group) in &grouped {
        let relative: Vec<_> = group
            .iter()
            .map(|p| relative_path(project, &absolute(root, p)))
            .collect::<Result<_>>()?;
        held.push(ReadLeases::acquire(project, &relative)?);
        refuse_unresolved_journals(project)?;
    }
    let mut snapshot = Vec::new();
    for path in paths {
        let read = stable_read(&text(absolute(root, &path))?, true, u32::MAX as u64, cancel)?;
        if closure
            .files
            .iter()
            .find(|f| f.path == path)
            .is_some_and(|f| f.sha256 != read.sha256)
        {
            return Err("saved generation inputs changed during capture".into());
        }
        snapshot.push(SourceSnapshot {
            path,
            sha256: read.sha256,
            bytes: BufferBytes {
                kind: "Buffer".into(),
                data: read.bytes,
            },
        });
    }
    for leases in held {
        leases.release()?;
    }
    Ok(snapshot)
}
fn refuse_unresolved_journals(project: &Path) -> Result<()> {
    let runs = match fs::read_dir(project.join(".can/gen/runs")) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for run in runs {
        let journal = run.map_err(|e| e.to_string())?.path().join("journal.json");
        match fs::metadata(journal) {
            Ok(m) if m.is_file() => {
                return Err("refusing to read unresolved generation journal".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn lock_present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
struct ReadLeases {
    held: Vec<PathBuf>,
    token: String,
}
impl ReadLeases {
    fn acquire(project: &Path, paths: &[String]) -> Result<Self> {
        let directory = project.join(".can/gen/locks");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let mut random = [0u8; 8];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(|e| e.to_string())?;
        let token = format!(
            "v1-{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let mut set = Self {
            held: Vec::new(),
            token,
        };
        let ordered: BTreeSet<_> = paths.iter().collect();
        for path in ordered {
            set.take(&directory, path)?;
        }
        Ok(set)
    }
    fn take(&mut self, directory: &Path, path: &str) -> Result<()> {
        validate_relative(path)?;
        let escaped: String = path
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"._-".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let writer = directory.join(format!("{escaped}.write.lock"));
        if lock_present(&writer)? {
            return Err("generation read lease conflicts with held writer".into());
        }
        let lock = directory.join(format!("{escaped}.read.{}.lock", self.token));
        let body = serde_json::json!({"version":1,"holder":format!("dev-capture:{}",std::process::id()),"token":self.token,"mode":"read","path":path});
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|e| e.to_string())?;
        if let Err(error) = file.write_all(body.to_string().as_bytes()) {
            let _ = fs::remove_file(&lock);
            return Err(error.to_string());
        }
        self.held.push(lock);
        if lock_present(&writer)? {
            return Err("generation read lease lost racing acquisition".into());
        }
        Ok(())
    }
    fn release(mut self) -> Result<()> {
        self.release_held()
    }
    fn release_held(&mut self) -> Result<()> {
        while let Some(path) = self.held.pop() {
            let body = match fs::read(&path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.to_string()),
            };
            let value: serde_json::Value =
                serde_json::from_slice(&body).map_err(|e| e.to_string())?;
            if value["token"].as_str() != Some(&self.token) {
                return Err("generation lease token changed; refusing foreign release".into());
            }
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
impl Drop for ReadLeases {
    fn drop(&mut self) {
        let _ = self.release_held();
    }
}

pub fn verify_compiler_sources(
    capture: &Capture,
    report: &serde_json::Value,
    complete: bool,
) -> Result<()> {
    if !complete {
        return Err("analysis_incomplete".into());
    }
    let mut expected = BTreeMap::from([(
        capture.compiler_operand.clone(),
        capture.source_sha256.clone(),
    )]);
    if let Some(closure) = &capture.generated_closure {
        for path in &closure.compiler_sources {
            if path == &capture.compiler_operand {
                continue;
            }
            let physical = relative_path(Path::new(&capture.root), &absolute(&closure.root, path))?;
            let hash = capture
                .inputs
                .iter()
                .find(|i| i.name == format!("generated:{physical}"))
                .and_then(|i| i.sha256.clone())
                .ok_or("source_membership_mismatch")?;
            expected.insert(path.clone(), hash);
        }
        for source in &closure.provider_sources {
            let hash = capture
                .inputs
                .iter()
                .find(|i| i.name == format!("generated:{}", source.physical))
                .and_then(|i| i.sha256.clone())
                .ok_or("source_membership_mismatch")?;
            if expected
                .insert(source.key.clone(), hash)
                .is_some_and(|old| old != expected[&source.key])
            {
                return Err("source_membership_mismatch".into());
            }
        }
    }
    if let Some(providers) = &capture.provider_snapshot {
        for provider in providers {
            expected.insert(
                provider.snapshot.path.clone(),
                provider.snapshot.sha256.clone(),
            );
        }
    }
    let sources = report["sources"]
        .as_array()
        .ok_or("source_membership_mismatch")?;
    if sources.len() != expected.len() {
        return Err("source_membership_mismatch".into());
    }
    // Multi-root compiles qualify synthetic carriers as
    // `can.generated/r<root>-<id>/...` where the discovery report carries
    // the bare `<id>` form. Root numbering is positional compiler-internal
    // detail (operand order, nested drops, symlinks) that capture must not
    // re-derive: normalize both sides and anchor identity on the unit id
    // plus exact bytes. Count, duplicate, and hash checks below still
    // refuse phantom, repeated, or skewed sources.
    let mut normalized: BTreeMap<String, &String> = BTreeMap::new();
    for (path, hash) in &expected {
        let key = strip_root_qualifiers(path);
        if let Some(old) = normalized.insert(key, hash) {
            if old != hash {
                return Err("source_membership_mismatch".into());
            }
        }
    }
    if normalized.len() != expected.len() {
        return Err("source_membership_mismatch".into());
    }
    let mut seen = BTreeSet::new();
    for source in sources {
        let path = source["path"].as_str().ok_or("source_path_mismatch")?;
        let key = strip_root_qualifiers(path);
        if !seen.insert(key.clone()) || !normalized.contains_key(&key) {
            return Err("source_path_mismatch".into());
        }
        let hash = source["sha256"].as_str().ok_or("source_hash_mismatch")?;
        if !valid_hash(hash) || normalized.get(&key).map(|h| h.as_str()) != Some(hash) {
            return Err("source_hash_mismatch".into());
        }
    }
    Ok(())
}

/// Strip compiler multi-root qualifiers (`r<root>-`) from synthetic
/// `can.generated/<id>/...` carrier paths, repeatedly. Ordinary source
/// paths pass through untouched. All cut points are ASCII boundaries.
fn strip_root_qualifiers(path: &str) -> String {
    let mut out = path.to_string();
    loop {
        let Some(rest) = out.strip_prefix("can.generated/r") else {
            return out;
        };
        let Some(slash) = rest.find('/') else {
            return out;
        };
        let (segment, _) = rest.split_at(slash);
        let Some(dash) = segment.find('-') else {
            return out;
        };
        let (root, _) = segment.split_at(dash);
        if root.is_empty() || !root.bytes().all(|b| b.is_ascii_digit()) {
            return out;
        }
        let cut = "can.generated/r".len() + root.len() + 1;
        out = format!("can.generated/{}", &out[cut..]);
    }
}
