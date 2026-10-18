//! Captured construct help and local ranking eligibility.
//! Support comes from the authored reference and owning package catalogs.
//! External advice remains disabled; no source projection leaves this process.
use crate::capture::{self, Capture, CapturedInput};
use crate::files::{self, FileRef};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::atomic::AtomicBool;

type Result<T> = std::result::Result<T, String>;
const DOCUMENT: &str = "docs/specification/CONSTRUCT-HELP.md";
const VALUES_SOURCE: &str = "packages/values/src/catalog.ts";
const UI_SOURCE: &str = "packages/ui/src/catalog.ts";
const FLAGS: &[&str] = &[
    "exactSourceSpan",
    "structuralRecovery",
    "recoveryComplete",
    "nameFilterComplete",
    "materialIntentChoice",
    "evidenceSufficient",
    "unsupportedBehaviorProven",
];

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn flag(value: &Value, key: &str) -> bool {
    value[key] == true
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn sha(bytes: &[u8]) -> String {
    capture::hash(bytes)
}
fn digest(parts: &[String]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}
fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn card_id(value: &str) -> bool {
    value.strip_prefix("can.v1.").is_some_and(|tail| {
        !tail.is_empty()
            && tail
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
    })
}
fn word(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}
fn name(value: &str, limit: usize, punctuation: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || (i > 0 && (b.is_ascii_digit() || punctuation.contains(&b)))
        })
}
fn control(value: &str) -> bool {
    value
        .chars()
        .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
}
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
fn runtime_string(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && utf16_len(v) <= 4096)
        .ok_or_else(|| "invalid runtime string".into())
}
// Compiler DTOs use numbers; retain Number(...) coercion at the original
// internal boundary for saved diagnostic payloads as well.
fn number(value: Option<&Value>) -> f64 {
    fn text(value: &Value) -> String {
        match value {
            Value::Null => String::new(),
            Value::String(v) => v.clone(),
            Value::Array(v) => v.iter().map(text).collect::<Vec<_>>().join(","),
            Value::Object(_) => "[object Object]".into(),
            _ => value.to_string(),
        }
    }
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.,
        Some(Value::Bool(v)) => {
            if *v {
                1.
            } else {
                0.
            }
        }
        Some(Value::Number(v)) => v.as_f64().unwrap_or(f64::NAN),
        Some(v @ (Value::String(_) | Value::Array(_))) => {
            let string = text(v);
            let s = string.trim_matches(js_space);
            if s.is_empty() {
                0.
            } else if let Some((tail, radix)) = s
                .strip_prefix("0x")
                .or_else(|| s.strip_prefix("0X"))
                .map(|v| (v, 16))
                .or_else(|| {
                    s.strip_prefix("0o")
                        .or_else(|| s.strip_prefix("0O"))
                        .map(|v| (v, 8))
                })
                .or_else(|| {
                    s.strip_prefix("0b")
                        .or_else(|| s.strip_prefix("0B"))
                        .map(|v| (v, 2))
                })
            {
                if tail.is_empty() {
                    f64::NAN
                } else {
                    tail.chars()
                        .try_fold(0., |n, c| {
                            c.to_digit(radix).map(|v| n * radix as f64 + v as f64)
                        })
                        .unwrap_or(f64::NAN)
                }
            } else if s == "Infinity" || s == "+Infinity" {
                f64::INFINITY
            } else if s == "-Infinity" {
                f64::NEG_INFINITY
            } else if s
                .bytes()
                .all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b))
            {
                s.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        _ => f64::NAN,
    }
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{9}'..='\u{d}'|'\u{20}'|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}

fn decode(value: &str) -> String {
    value
        .replace("&#124;", "|")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}
fn split_row(line: &str) -> Result<Vec<String>> {
    if !line.starts_with("| ") || !line.ends_with(" |") {
        return Err("invalid construct help row".into());
    }
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut previous = '\0';
    for ch in line[1..line.len() - 1].chars() {
        if ch == '|' && previous != '\\' {
            cells.push(cell.trim().into());
            cell.clear();
        } else {
            cell.push(ch);
        }
        previous = ch;
    }
    cells.push(cell.trim().into());
    Ok(cells)
}
fn inline(value: &str, field: &str) -> Result<String> {
    let content = value
        .strip_prefix('`')
        .and_then(|v| v.strip_suffix('`'))
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("construct help {field} is missing"))?;
    Ok(decode(&content.replace("\\|", "|")))
}
fn plain(value: &str) -> Result<String> {
    let content = value
        .strip_prefix("<code>")
        .and_then(|v| v.strip_suffix("</code>"))
        .or_else(|| value.strip_prefix('`').and_then(|v| v.strip_suffix('`')))
        .ok_or("construct help example is not a code fragment")?;
    let mut out = String::new();
    let mut tail = content;
    while let Some(at) = tail.find('<') {
        out.push_str(&tail[..at]);
        tail = &tail[at..];
        if let Some(end) = tail.find('>') {
            let tag = tail[1..end].to_ascii_lowercase();
            let rest = tag.strip_prefix("br");
            if rest.is_some_and(|v| v.trim().trim_matches('/').trim().is_empty()) {
                out.push('\n');
                tail = &tail[end + 1..];
                continue;
            }
        }
        out.push('<');
        tail = &tail[1..];
    }
    out.push_str(tail);
    Ok(decode(&out))
}
fn link(value: &str, field: &str) -> Result<String> {
    let bad = || format!("construct help {field} is missing");
    let (label, target) = value
        .strip_prefix('[')
        .and_then(|v| v.split_once("]("))
        .ok_or_else(bad)?;
    let target = target
        .strip_suffix(')')
        .filter(|v| !v.is_empty() && !v.contains(')'))
        .ok_or_else(bad)?;
    if label.is_empty() || label.contains(']') {
        return Err(bad());
    }
    Ok(target.into())
}
fn section(heading: &str) -> Result<&str> {
    if heading == "Callable builtins" {
        Ok("Expression")
    } else if heading.starts_with("App,") {
        Ok("App/Given")
    } else if heading.starts_with("When,") {
        Ok("When")
    } else if heading.starts_with("Then,") {
        Ok("Then")
    } else {
        Err(format!("unknown construct help section: {heading}"))
    }
}
fn card_section<'a>(id: &str, table: &'a str) -> &'a str {
    if id.starts_with("can.v1.app.")
        || id == "can.v1.package"
        || id.starts_with("can.v1.import")
        || id.starts_with("can.v1.context")
        || id == "can.v1.export"
    {
        "App"
    } else if id == "can.v1.section.when"
        || ["can.v1.when.", "can.v1.execution.", "can.v1.examples."]
            .iter()
            .any(|p| id.starts_with(p))
    {
        "When"
    } else if id == "can.v1.section.then"
        || ["can.v1.then.", "can.v1.ui."]
            .iter()
            .any(|p| id.starts_with(p))
    {
        "Then"
    } else if ["can.v1.expression.", "can.v1.builtin."]
        .iter()
        .any(|p| id.starts_with(p))
    {
        "Expression"
    } else if id.starts_with("can.v1.maintenance.") {
        "Migration"
    } else if table == "App/Given" {
        "Given"
    } else {
        table
    }
}
fn card_anchor<'a>(cell: &'a str, ids: &mut BTreeSet<String>) -> Result<(&'a str, &'a str)> {
    let (anchor, id) = cell
        .strip_prefix("<a id=\"")
        .and_then(|v| v.split_once("\"></a>`"))
        .and_then(|(a, v)| v.strip_suffix('`').map(|id| (a, id)))
        .ok_or("construct card has an invalid ID or anchor")?;
    if !anchor.starts_with("can-v1-")
        || !anchor
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        || !card_id(id)
    {
        return Err("construct card has an invalid ID or anchor".into());
    }
    let normal = id.replace('.', "-");
    if anchor != normal && anchor != normal.replace('_', "-") {
        return Err(format!("construct card ID/anchor mismatch: {id}"));
    }
    if !ids.insert(id.to_owned()) {
        return Err(format!("duplicate construct card: {id}"));
    }
    Ok((anchor, id))
}
fn parse_card(line: &str, table: &str, width: usize, ids: &mut BTreeSet<String>) -> Result<Value> {
    if table.is_empty() || width == 0 {
        return Err("construct card is outside a known table".into());
    }
    let cells = split_row(line)?;
    if cells.len() != width {
        return Err(format!(
            "construct help row has {} cells; expected {width}",
            cells.len()
        ));
    }
    let (anchor, id) = card_anchor(&cells[0], ids)?;
    let signature = inline(&cells[1], "signature")?;
    let meaning = cells[2].trim();
    let example = plain(&cells[3])?;
    let availability = cells[4].trim();
    let stable = link(&cells[width - 1], "stable link")?;
    if meaning.is_empty()
        || availability.is_empty()
        || example.is_empty()
        || stable != format!("#{anchor}")
    {
        return Err(format!("incomplete construct card: {id}"));
    }
    let source = if width == 7 {
        link(&cells[5], "source link")?
    } else {
        VALUES_SOURCE.into()
    };
    Ok(
        json!({"id":id,"section":card_section(id,table),"signature":signature,"meaning":meaning,
        "example":example,"availability":availability,
        "status":if availability.to_lowercase().contains("proposed") {"planned"} else {"working"},
        "link":format!("{DOCUMENT}{stable}"),"sourceLink":source}),
    )
}
fn parse_cards(markdown: &str) -> Result<Vec<Value>> {
    let mut cards = Vec::new();
    let mut ids = BTreeSet::new();
    let mut table = "";
    let mut width = 0;
    for line in markdown
        .split('\n')
        .map(|v| v.strip_suffix('\r').unwrap_or(v))
    {
        if let Some(heading) = line.strip_prefix("### ") {
            table = section(heading)?;
        }
        if line == "| ID | Signature | Meaning | Example | Availability | Source | Stable link |" {
            width = 7;
            continue;
        }
        if line == "| ID | Signature | Meaning | Example | Availability | Stable link |" {
            width = 6;
            continue;
        }
        if !line.starts_with("| <a id=") {
            continue;
        }
        cards.push(parse_card(line, table, width, &mut ids)?);
    }
    if cards.is_empty() {
        return Err("construct help inventory is empty".into());
    }
    Ok(cards)
}

struct Index {
    revision: String,
    compiler: String,
    document: String,
    cards: Vec<Value>,
}
fn ui_name(id: &str) -> &str {
    let suffix = id.strip_prefix("can.v1.ui.").unwrap_or(id);
    if suffix.starts_with("calendar-") {
        "calendar"
    } else if suffix.starts_with("tabs-") {
        "tabs"
    } else {
        suffix
    }
}
fn apply_catalog(cards: &mut [Value], values: &[Value], ui: &[Value]) -> Result<()> {
    let builtins: Vec<_> = values.iter().filter(|v| v["kind"] == "builtin").collect();
    let builtin_ids: BTreeSet<_> = builtins.iter().map(|v| string(&v["id"])).collect();
    if builtin_ids.len() != builtins.len()
        || builtins.len()
            != cards
                .iter()
                .filter(|v| string(&v["id"]).starts_with("can.v1.builtin."))
                .count()
    {
        return Err("Values builtin card inventory differs from captured catalog".into());
    }
    for card in cards.iter_mut() {
        let id = string(&card["id"]);
        let fact = if let Some(name) = id.strip_prefix("can.v1.builtin.") {
            let fact = builtins.iter().find(|v| v["id"] == name).copied();
            if fact.is_none_or(|v| v["signature"] != card["signature"]) {
                return Err(format!("Values builtin signature drift: {id}"));
            }
            values.iter().rev().find(|v| v["id"] == name)
        } else if id.starts_with("can.v1.ui.") {
            let name = ui_name(id);
            if !ui
                .iter()
                .any(|v| v["kind"] == "component" && v["id"] == name)
            {
                return Err(format!("UI construct missing from captured catalog: {id}"));
            }
            ui.iter().rev().find(|v| v["id"] == name)
        } else {
            None
        };
        if card["status"] != "planned"
            && fact.is_some_and(|v| {
                v["availability"] != "implemented" && v["availability"] != "external"
            })
        {
            card["status"] = json!("planned");
        }
    }
    Ok(())
}
fn create_index(input: &Value) -> Result<Index> {
    for name in ["compiler", "grammar", "values", "ui"] {
        if !hash_valid(string(&input[name]["sha256"])) {
            return Err(format!("missing captured {name} source hash"));
        }
    }
    if input["languageVersion"] != "1.0" {
        return Err(format!(
            "unsupported help language version: {}",
            string(&input["languageVersion"])
        ));
    }
    let markdown = input["markdown"]
        .as_str()
        .ok_or("captured help markdown is missing")?;
    let mut cards = parse_cards(markdown)?;
    let values = input["values"]["entries"]
        .as_array()
        .ok_or("captured Values catalog facts are required")?;
    let ui = input["ui"]["entries"]
        .as_array()
        .ok_or("captured UI catalog facts are required")?;
    apply_catalog(&mut cards, values, ui)?;
    let document = sha(markdown.as_bytes());
    let compiler = string(&input["compiler"]["sha256"]).to_owned();
    let revision = digest(&[
        "can.dev.construct-help.v1".into(),
        "1.0".into(),
        document.clone(),
        compiler.clone(),
        string(&input["grammar"]["sha256"]).into(),
        string(&input["values"]["sha256"]).into(),
        string(&input["ui"]["sha256"]).into(),
    ]);
    Ok(Index {
        revision,
        compiler,
        document,
        cards,
    })
}
impl Index {
    fn card(&self, id: &str) -> Option<Value> {
        self.cards.iter().find(|v| v["id"] == id).cloned()
    }
}

fn context(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    if obj.keys().any(|k| {
        !["version", "messageKind", "section", "guess"].contains(&k.as_str())
            && !FLAGS.contains(&k.as_str())
    }) || value["version"] != 1
        || !name(string(&value["messageKind"]), 64, b"_")
        || !["Given", "When", "Then", "root"].contains(&string(&value["section"]))
        || !word(string(&value["guess"]))
        || FLAGS.iter().any(|k| !value[k].is_boolean())
    {
        return None;
    }
    Some(value.clone())
}
fn routing(value: &Value) -> Value {
    fn valid_ids(ids: &[Value]) -> bool {
        let mut seen = BTreeSet::new();
        !(ids.len() > 8
            || ids.iter().any(|v| {
                v.as_str()
                    .is_none_or(|s| s.len() > 96 || !card_id(s) || !seen.insert(s))
            }))
    }
    fn parse(value: &Value) -> Option<Value> {
        value.as_object()?;
        let disposition = string(&value["disposition"]);
        if value["version"] != 1
            || !["exact", "structural", "none", "unknown"].contains(&disposition)
            || !value["complete"].is_boolean()
        {
            return None;
        }
        let ids = value["ids"].as_array()?;
        let slot = value.get("slot").unwrap_or(&Value::Null);
        if !slot.is_null() && !name(slot.as_str()?, 96, b"_.-") {
            return None;
        }
        if !valid_ids(ids) {
            return None;
        }
        if (disposition == "exact" && (slot.is_null() || ids.is_empty()))
            || (disposition != "exact" && !ids.is_empty())
            || (["structural", "unknown"].contains(&disposition) && value["complete"] != false)
        {
            return None;
        }
        let mut out = json!({"version":1,"disposition":disposition,"slot":slot,"ids":ids,"complete":value["complete"]});
        if disposition == "exact" && value["complete"] == true {
            if let Some(ctx) = context(&value["context"]) {
                out["context"] = ctx;
            }
        }
        Some(out)
    }
    parse(value).unwrap_or_else(
        || json!({"version":1,"disposition":"unknown","slot":null,"ids":[],"complete":false}),
    )
}
fn unknown(reason: &str) -> Value {
    json!({"grammarCoverage":"unknown","candidateCoverage":"unknown","reason":reason,"cards":[]})
}
fn join(index: &Index, value: &Value) -> Value {
    let route = routing(value);
    let disposition = string(&route["disposition"]);
    let mut out = if disposition == "none" && route["complete"] == true {
        json!({"grammarCoverage":"complete","candidateCoverage":"complete","cards":[]})
    } else if disposition != "exact" {
        unknown(if disposition == "structural" {
            "structural recovery needs a source edit"
        } else {
            "compiler candidate routing is incomplete"
        })
    } else if route["complete"] != true {
        unknown("compiler slot inventory is incomplete or from another revision")
    } else {
        let mut cards = Vec::new();
        let mut missing = None;
        for id in array(&route["ids"]).iter().map(string) {
            if let Some(card) = index.card(id) {
                cards.push(card);
            } else {
                missing = Some(format!("unknown construct ID: {id}"));
                break;
            }
        }
        if let Some(reason) = missing {
            unknown(&reason)
        } else {
            let complete = cards.iter().all(|v| v["status"] == "working");
            let mut value = json!({"grammarCoverage":"complete","candidateCoverage":if complete {"complete"} else {"unknown"},"cards":cards});
            if !complete {
                value["reason"] = json!("one or more candidates are not implemented");
            }
            value
        }
    };
    out["disposition"] = route["disposition"].clone();
    out["slot"] = route["slot"].clone();
    out
}

fn captured<'a>(
    capture: &'a Capture,
    path: &str,
    accepts: impl Fn(&str) -> bool,
) -> Result<&'a CapturedInput> {
    let expected = capture::absolute(&capture.root, path);
    let matches: Vec<_> = capture
        .inputs
        .iter()
        .filter(|v| {
            v.state == "present"
                && v.sha256.is_some()
                && (v
                    .canonical_path
                    .as_deref()
                    .is_some_and(|p| Path::new(p) == expected)
                    || accepts(&v.name))
        })
        .collect();
    if matches.len() != 1 || matches[0].canonical_path.is_none() {
        return Err(format!("construct help input is absent: {path}"));
    }
    Ok(matches[0])
}
fn captured_bytes(input: &CapturedInput, cancel: &AtomicBool) -> Result<Vec<u8>> {
    capture::check_cancel(cancel)?;
    let path = input
        .canonical_path
        .as_ref()
        .ok_or("captured input path is absent")?;
    if fs::canonicalize(path).map_err(|e| e.to_string())? != Path::new(path) {
        return Err("captured input is not canonical".into());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > files::MAX_FILE {
        return Err("construct help input is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(files::MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = fs::metadata(path).map_err(|e| e.to_string())?;
    if (
        before.dev(),
        before.ino(),
        before.len(),
        before.mtime(),
        before.mtime_nsec(),
        before.ctime(),
        before.ctime_nsec(),
    ) != (
        after.dev(),
        after.ino(),
        after.len(),
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    ) {
        return Err("construct help input changed during read".into());
    }
    if bytes.len() > files::MAX_FILE as usize || Some(sha(&bytes)) != input.sha256 {
        return Err(format!(
            "construct help input changed after capture: {path}"
        ));
    }
    capture::check_cancel(cancel)?;
    Ok(bytes)
}
fn source_producer(name: &str, package: &str) -> bool {
    name.strip_prefix(&format!("extra:source:@canlang/{package}@"))
        .and_then(|v| v.split_once('/'))
        .is_some_and(|(version, path)| !version.is_empty() && path == "src/catalog.ts")
}
fn anchors(markdown: &str) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    for line in markdown.lines() {
        if let Some(tail) = line.split_once("<a id=\"").map(|(_, v)| v) {
            if let Some((id, _)) = tail.split_once("\"></a>") {
                if !id.is_empty()
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
                {
                    result.insert(id.into());
                }
            }
        }
        let hashes = line.bytes().take_while(|b| *b == b'#').count();
        if !(1..=6).contains(&hashes) || !line[hashes..].starts_with(' ') {
            continue;
        }
        let mut heading = String::new();
        let mut html = false;
        for c in line[hashes + 1..].to_lowercase().chars() {
            if c == '<' {
                html = true;
            } else if c == '>' && html {
                html = false;
            } else if !html && (c.is_alphanumeric() || "_ -".contains(c)) {
                heading.push(c);
            }
        }
        let slug = heading
            .trim()
            .split(' ')
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        if !slug.is_empty() {
            result.insert(slug);
        }
    }
    result
}
fn validate_links(index: &Index, document: &Path, cancel: &AtomicBool) -> Result<()> {
    // Source links are authored relative to the help document. Captured input
    // identities bind the owning grammar and catalogs before resolving links.
    let directory = document
        .parent()
        .ok_or("construct help document has no directory")?;
    let root = directory
        .parent()
        .and_then(Path::parent)
        .ok_or("construct help document has no reference root")?;
    let links: BTreeSet<_> = index
        .cards
        .iter()
        .map(|v| string(&v["sourceLink"]))
        .filter(|v| *v != VALUES_SOURCE)
        .collect();
    for link in links {
        capture::check_cancel(cancel)?;
        let (path, anchor) = link
            .split_once('#')
            .filter(|(p, a)| !p.is_empty() && !a.is_empty())
            .ok_or_else(|| format!("construct help source link has no target: {link}"))?;
        let actual = fs::canonicalize(directory.join(path)).map_err(|e| e.to_string())?;
        if !actual.starts_with(root) {
            return Err(format!(
                "construct help source link escapes checkout: {link}"
            ));
        }
        let markdown = fs::read_to_string(actual).map_err(|e| e.to_string())?;
        if !anchors(&markdown).contains(anchor) {
            return Err(format!("construct help source anchor is missing: {link}"));
        }
    }
    Ok(())
}
fn load_inputs(capture: &Capture, cancel: &AtomicBool) -> Result<Value> {
    let compiler = captured(capture, "", |v| v == "compiler")?;
    let help = captured(capture, DOCUMENT, |v| v == "help-index")?;
    let grammar = captured(capture, "docs/specification/GRAMMAR.md", |v| {
        v == "extra:grammar"
    })?;
    let values = captured(capture, VALUES_SOURCE, |v| source_producer(v, "values"))?;
    let ui = captured(capture, UI_SOURCE, |v| source_producer(v, "ui"))?;
    let catalog = captured(capture, "", |v| v == "extra:construct-catalog")?;
    let catalog: Value =
        serde_json::from_slice(&captured_bytes(catalog, cancel)?).map_err(|e| e.to_string())?;
    let markdown = String::from_utf8(captured_bytes(help, cancel)?).map_err(|e| e.to_string())?;
    // Bind provenance to current captured bytes before an index is retained.
    captured_bytes(grammar, cancel)?;
    captured_bytes(values, cancel)?;
    captured_bytes(ui, cancel)?;
    let inputs = json!({"languageVersion":"1.0","markdown":markdown,"compiler":{"sha256":compiler.sha256},
        "grammar":{"sha256":grammar.sha256},"values":{"sha256":values.sha256,"entries":catalog["values"]},
        "ui":{"sha256":ui.sha256,"entries":catalog["ui"]}});
    let index = create_index(&inputs)?;
    validate_links(
        &index,
        Path::new(help.canonical_path.as_deref().unwrap()),
        cancel,
    )?;
    if sha(&captured_bytes(help, cancel)?) != index.document {
        return Err("captured help changed during snapshot".into());
    }
    Ok(inputs)
}
fn read_json(reference: &Value) -> Result<Value> {
    let reference: FileRef =
        serde_json::from_value(reference.clone()).map_err(|e| e.to_string())?;
    serde_json::from_slice(&files::read(&reference)?).map_err(|e| e.to_string())
}

/// Execute against a captured index or load one from captured catalog JSON.
/// Saved indexes use the same private, bounded FileRef contract.
pub fn run(capture: &Capture, payload: &Value, cancel: &AtomicBool) -> Result<Value> {
    capture::check_cancel(cancel)?;
    let inputs = if let Some(reference) = payload.get("index") {
        read_json(reference)?["inputs"].clone()
    } else {
        load_inputs(capture, cancel)?
    };
    let index = create_index(&inputs)?;
    if !capture
        .inputs
        .iter()
        .any(|v| v.name == "compiler" && v.sha256.as_deref() == Some(index.compiler.as_str()))
        || !capture
            .inputs
            .iter()
            .any(|v| v.name == "help-index" && v.sha256.as_deref() == Some(index.document.as_str()))
    {
        return Err("captured help identity mismatch".into());
    }
    let mut out = json!({"index_revision":index.revision,"compiler_sha256":index.compiler});
    match string(&payload["action"]) {
        "index" => {
            out["inputs"] = inputs;
            out["cards"] = json!(index.cards);
        }
        "help" => {
            let id = runtime_string(&payload["id"])?;
            out["card"] = index.card(id).ok_or("construct ID unavailable")?;
        }
        "detail" => {
            out["construct_help"] = join(&index, &payload["candidates"]);
        }
        "rank" => {
            out["result"] = rank(capture, payload, &index)?;
        }
        _ => return Err("unknown construct action".into()),
    }
    capture::check_cancel(cancel)?;
    Ok(out)
}

fn outcome(state: &str, reason: &str) -> Value {
    json!({"state":state,"reason":reason})
}
fn source_keyword(bytes: &[u8], start: usize) -> bool {
    let mut quote = 0;
    let mut comment = false;
    let mut at = 0;
    while at < start {
        let b = bytes[at];
        if comment {
            if b == 10 || b == 13 {
                comment = false;
            }
        } else if quote != 0 {
            if b == 92 {
                at += 1;
            } else if b == quote {
                quote = 0;
            }
        } else if b == 35 {
            comment = true;
        } else if b == 34 || b == 39 || b == 96 {
            quote = b;
        }
        at += 1;
    }
    quote == 0 && !comment
}
fn identifier(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}
fn exact_span(ctx: &Value, bytes: &[u8], start: usize, end: usize) -> bool {
    flag(ctx, "exactSourceSpan")
        && end >= start
        && end <= bytes.len()
        && source_keyword(bytes, start)
        && &bytes[start..end] == string(&ctx["guess"]).as_bytes()
        && (start == 0 || !identifier(bytes[start - 1]))
        && (end == bytes.len() || !identifier(bytes[end]))
}
fn valid_intent(value: &str) -> bool {
    !value.trim_matches(js_space).is_empty() && utf16_len(value) <= 240 && !control(value)
}
fn evidence(
    capture: &Capture,
    start: usize,
    end: usize,
    guess: &str,
    intent: Option<&str>,
) -> Option<Value> {
    let bytes = capture.source_text.as_bytes();
    if sha(bytes) != capture.source_sha256
        || end <= start
        || end > bytes.len()
        || !word(guess)
        || &bytes[start..end] != guess.as_bytes()
        || intent.is_some_and(|v| !valid_intent(v))
    {
        return None;
    }
    let lines: Vec<_> = capture.source_text.split('\n').collect();
    let line = bytes[..start].iter().filter(|b| **b == b'\n').count();
    let selected = &lines[line.saturating_sub(1)..(line + 4).min(lines.len())];
    let raw = selected.join("\n");
    if raw.len() > 1024 || selected.len() > 5 {
        return None;
    }
    let text = redact(&raw, guess);
    let indent = |v: &str| utf16_len(v) - utf16_len(v.trim_start_matches(js_space));
    let next = lines.iter().skip(line + 4).find(|v| {
        !v.trim_matches(js_space).is_empty() && !v.trim_start_matches(js_space).starts_with("##")
    });
    let truncated = next.is_some_and(|v| indent(v) > indent(lines[line]));
    let mut value = json!({"sourceSha256":capture.source_sha256,"span":{"start":start,"end":end},
        "sourceWindow":{"text":text,"logicalLines":selected.len(),"bytesBeforeRedaction":raw.len(),"redacted":true,"truncated":truncated}});
    if let Some(intent) = intent {
        value["authorIntent"] = json!({"label":"author_intent_data","text":intent});
    }
    Some(value)
}
fn redact(raw: &str, guess: &str) -> String {
    let mut out = String::new();
    let mut at = 0;
    let allowed = [
        "page",
        "title",
        "empty",
        "text",
        "row",
        "name",
        "quantity",
        "available",
        guess,
    ];
    while at < raw.len() {
        let tail = &raw[at..];
        let c = tail.chars().next().unwrap();
        let size = c.len_utf8();
        if matches!(c, '\"' | '\'' | '`') {
            at += size;
            while at < raw.len() {
                let ch = raw[at..].chars().next().unwrap();
                at += ch.len_utf8();
                if ch == '\\' {
                    if at < raw.len() {
                        at += raw[at..].chars().next().unwrap().len_utf8();
                    }
                } else if ch == c {
                    break;
                }
            }
            out.push_str("<STRING>");
        } else if c == '#' {
            at += tail.find('\n').unwrap_or(tail.len());
            out.push_str("<COMMENT>");
        } else if c.is_ascii_alphabetic() || c == '_' {
            let count = tail.bytes().take_while(|b| identifier(*b)).count();
            let token = &tail[..count];
            out.push_str(if allowed.contains(&token) {
                token
            } else {
                "<REDACTED>"
            });
            at += count;
        } else if js_space(c) || "()[]{}.,:=/?<>!-".contains(c) {
            out.push(c);
            at += size;
        } else {
            let count = tail
                .char_indices()
                .find(|(_, c)| {
                    js_space(*c)
                        || c.is_ascii_alphabetic()
                        || *c == '_'
                        || "()[]{}.,:=/?<>!-".contains(*c)
                })
                .map(|(i, _)| i)
                .unwrap_or(tail.len());
            at += count;
            out.push_str("<REDACTED>");
        }
    }
    out
}
fn office_evidence(ctx: &Value, route: &Value, cards: &[Value], evidence: Option<&Value>) -> bool {
    let mut ids: Vec<_> = cards.iter().map(|v| string(&v["id"])).collect();
    ids.sort_unstable();
    if ctx["messageKind"] != "unknown_collection_presentation"
        || ctx["section"] != "Then"
        || route["slot"] != "then.collection-presentation"
        || ids != ["can.v1.ui.list", "can.v1.ui.table"]
    {
        return false;
    }
    let Some(e) = evidence else {
        return false;
    };
    if e["authorIntent"]["text"]
        != "Show the supplies in separate name, quantity and available columns."
        || e["sourceWindow"]["truncated"] != false
    {
        return false;
    }
    // Equivalent to the bounded `text row.name, row.quantity, row.available`
    // evidence expression: punctuation has no optional intervening whitespace.
    let text = string(&e["sourceWindow"]["text"]);
    for (start, _) in text.match_indices("text") {
        if start > 0 && identifier(text.as_bytes()[start - 1]) {
            continue;
        }
        let tail = &text[start + 4..];
        if tail.chars().next().is_none_or(|c| !js_space(c)) {
            continue;
        }
        let tail = tail.trim_start_matches(js_space);
        let Some(tail) = tail.strip_prefix("row.name") else {
            continue;
        };
        let Some(tail) = tail.trim_start_matches(js_space).strip_prefix(',') else {
            continue;
        };
        let Some(tail) = tail
            .trim_start_matches(js_space)
            .strip_prefix("row.quantity")
        else {
            continue;
        };
        let Some(tail) = tail.trim_start_matches(js_space).strip_prefix(',') else {
            continue;
        };
        let Some(tail) = tail
            .trim_start_matches(js_space)
            .strip_prefix("row.available")
        else {
            continue;
        };
        if tail.as_bytes().first().is_none_or(|b| !identifier(*b)) {
            return true;
        }
    }
    false
}
fn ranked_card(card: &Value) -> Value {
    json!({"id":card["id"],"section":card["section"],"signature":card["signature"],"meaning":card["meaning"],"availability":card["status"]})
}
fn valid_ranked_card(card: &Value) -> bool {
    let section = string(&card["section"]);
    card_id(string(&card["id"]))
        && !section.is_empty()
        && section.len() <= 40
        && section.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_alphabetic() || (i > 0 && (b.is_ascii_digit() || b"_ /.-".contains(&b)))
        })
        && !string(&card["signature"]).is_empty()
        && utf16_len(string(&card["signature"])) <= 192
        && !string(&card["meaning"]).is_empty()
        && utf16_len(string(&card["meaning"])) <= 240
        && !control(string(&card["signature"]))
        && !control(string(&card["meaning"]))
}
fn rank(capture: &Capture, payload: &Value, index: &Index) -> Result<Value> {
    let diagnostic = &payload["diagnostic"];
    if !diagnostic.is_object() {
        return Err("invalid runtime object".into());
    }
    let route = routing(&diagnostic["construct_candidates"]);
    if route["disposition"] == "structural" {
        return Ok(outcome("structural", "authoring slot is not reliable"));
    }
    if route["disposition"] == "none"
        && route["complete"] == true
        && payload["complete"] == true
        && payload["omitted"] == 0
    {
        return Ok(json!({"state":"none"}));
    }
    let Some(ctx) = route.get("context") else {
        return Ok(outcome(
            "candidate_coverage_unknown",
            "captured compiler ranking context is incomplete",
        ));
    };
    let span = &diagnostic["primary"];
    if !span.is_object() {
        return Err("invalid runtime object".into());
    }
    let start = number(span.get("start"));
    let end = number(span.get("end"));
    let valid =
        |v: f64| v.is_finite() && (0. ..=9_007_199_254_740_991.).contains(&v) && v.fract() == 0.;
    if !valid(start) || !valid(end) {
        return Ok(outcome(
            "ineligible",
            "diagnostic or source capture is incomplete",
        ));
    }
    let (start, end) = (start as usize, end as usize);
    if !flag(ctx, "recoveryComplete")
        || !flag(ctx, "nameFilterComplete")
        || !exact_span(ctx, capture.source_text.as_bytes(), start, end)
    {
        return Ok(outcome(
            "ineligible",
            "diagnostic or source capture is incomplete",
        ));
    }
    rank_candidates(capture, payload, index, ctx, &route, (start, end))
}

fn rank_candidates(
    capture: &Capture,
    payload: &Value,
    index: &Index,
    ctx: &Value,
    route: &Value,
    span: (usize, usize),
) -> Result<Value> {
    let (start, end) = span;
    let diagnostic = &payload["diagnostic"];
    let selected = join(index, &route);
    let cards = array(&selected["cards"]);
    let evidence = if ctx["messageKind"] == "unknown_collection_presentation" {
        evidence(
            capture,
            start,
            end,
            string(&ctx["guess"]),
            payload["authorIntent"].as_str(),
        )
    } else {
        None
    };
    let code = runtime_string(&diagnostic["code"])?;
    // Preserve local eligibility order before the default no-disclosure policy.
    if payload["complete"] != true
        || number(payload.get("omitted")) != 0.
        || !hash_valid(&capture.source_sha256)
    {
        return Ok(outcome(
            "ineligible",
            "diagnostic or source capture is incomplete",
        ));
    }
    if flag(ctx, "structuralRecovery") {
        return Ok(outcome("structural", "authoring slot is not reliable"));
    }
    let office = office_evidence(ctx, &route, cards, evidence.as_ref());
    if flag(ctx, "materialIntentChoice") && !office {
        return Ok(outcome(
            "intent_required",
            "author must choose the permission, identity or effect contract",
        ));
    }
    rank_choice(ctx, &selected, cards, office, code)
}
fn rank_choice(
    ctx: &Value,
    selected: &Value,
    cards: &[Value],
    office: bool,
    code: &str,
) -> Result<Value> {
    if selected["candidateCoverage"] != "complete" || cards.iter().any(|v| v["status"] != "working")
    {
        return Ok(outcome(
            "candidate_coverage_unknown",
            "one or more construct candidates are not implemented",
        ));
    }
    if cards.is_empty() {
        return Ok(if flag(ctx, "unsupportedBehaviorProven") {
            json!({"state":"none"})
        } else {
            outcome(
                "candidate_coverage_unknown",
                "no candidate does not prove unsupported behavior",
            )
        });
    }
    if cards.iter().any(|v| !valid_ranked_card(v)) {
        return Ok(outcome(
            "candidate_coverage_unknown",
            "candidate IDs are invalid or duplicated",
        ));
    }
    if cards.len() == 1 {
        return Ok(json!({"state":"deterministic","card":ranked_card(&cards[0])}));
    }
    if cards.len() > 8 {
        return Ok(outcome(
            "intent_required",
            "candidate set is too broad; narrow the authoring intent",
        ));
    }
    if !word(string(&ctx["guess"])) {
        return Ok(outcome(
            "intent_unclear",
            "safe offending keyword is unavailable",
        ));
    }
    if (!flag(ctx, "evidenceSufficient") && !office)
        || (ctx["messageKind"] == "unknown_collection_presentation" && !office)
    {
        return Ok(outcome(
            "intent_unclear",
            "bounded source evidence cannot distinguish the candidates",
        ));
    }
    if code.len() != 5
        || !code.starts_with('E')
        || !code.as_bytes()[1..].iter().all(u8::is_ascii_digit)
    {
        return Ok(outcome(
            "ineligible",
            "source diagnostic identity is missing",
        ));
    }
    Ok(outcome(
        "ranking_disallowed",
        "external decision support is disabled",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::Payloads;

    const HELP: &str = include_str!("../../docs/specification/CONSTRUCT-HELP.md");
    fn inputs() -> Value {
        let cards = parse_cards(HELP).unwrap();
        let values: Vec<_>=cards.iter().filter_map(|v|string(&v["id"]).strip_prefix("can.v1.builtin.")
            .map(|id|json!({"id":id,"kind":"builtin","signature":v["signature"],"availability":"implemented"}))).collect();
        let ui: BTreeSet<_> = cards
            .iter()
            .filter(|v| string(&v["id"]).starts_with("can.v1.ui."))
            .map(|v| ui_name(string(&v["id"])))
            .collect();
        json!({"languageVersion":"1.0","markdown":HELP,"compiler":{"sha256":sha(b"compiler")},
            "grammar":{"sha256":sha(b"grammar")},"values":{"sha256":sha(b"values"),"entries":values},
            "ui":{"sha256":sha(b"ui"),"entries":ui.into_iter().map(|id|json!({"id":id,"kind":"component","availability":"implemented"})).collect::<Vec<_>>()}})
    }
    fn capture(source: &str, index: &Index) -> Capture {
        serde_json::from_value(json!({"requestedRoot":"/tmp","root":"/tmp","requestedAppPath":"/tmp/app.can","appPath":"/tmp/app.can",
            "compilerOperand":"app.can","sourceText":source,"sourceSha256":sha(source.as_bytes()),"sourceBytes":source.len(),
            "sourceRevision":"source","epochMaterial":"epoch","profile":"local-d1-identity","semanticOptions":{},
            "inputs":[{"name":"compiler","requestedPath":"/compiler","canonicalPath":"/compiler","sha256":index.compiler,"bytes":1,"state":"present"},
                {"name":"help-index","requestedPath":"/help","canonicalPath":"/help","sha256":index.document,"bytes":HELP.len(),"state":"present"}]})).unwrap()
    }
    fn route(ids: &[&str]) -> Value {
        json!({"version":1,"disposition":"exact","slot":"given.rule","ids":ids,"complete":true})
    }
    fn ranking_context(guess: &str) -> Value {
        json!({"version":1,"messageKind":"unrecognized_keyword","section":"Given","guess":guess,"exactSourceSpan":true,
            "structuralRecovery":false,"recoveryComplete":true,"nameFilterComplete":true,"materialIntentChoice":false,
            "evidenceSufficient":true,"unsupportedBehaviorProven":false})
    }

    #[test]
    fn authored_cards_keep_prose_signatures_links_and_exact_grammar_provenance() {
        let source = inputs();
        let index = create_index(&source).unwrap();
        assert_eq!(index.cards.len(), 278);
        let policy = index.card("can.v1.policy").unwrap();
        assert_eq!(
            policy["signature"],
            "policy path read=expr [where=expr] [fields=selectors]"
        );
        assert_eq!(policy["section"], "Given");
        assert_eq!(
            policy["link"],
            "docs/specification/CONSTRUCT-HELP.md#can-v1-policy"
        );
        assert_eq!(index.card("can.v1.when.crud").unwrap()["section"], "When");
        assert_eq!(index.document, sha(HELP.as_bytes()));
        let mut changed = source.clone();
        changed["grammar"]["sha256"] = json!(sha(b"changed grammar"));
        assert_ne!(create_index(&changed).unwrap().revision, index.revision);
        changed = source.clone();
        changed["markdown"] = json!(format!("{HELP}\n"));
        assert_ne!(create_index(&changed).unwrap().revision, index.revision);
        changed = source.clone();
        changed["markdown"] = json!(HELP.replace("#can-v1-policy)", "#wrong-anchor)"));
        assert!(
            create_index(&changed)
                .err()
                .unwrap()
                .contains("incomplete construct card")
        );
        let grammar = include_str!("../../docs/specification/GRAMMAR.md");
        let known = anchors(grammar);
        for card in &index.cards {
            let source = string(&card["sourceLink"]);
            if let Some(anchor) = source.strip_prefix("GRAMMAR.md#") {
                assert!(known.contains(anchor), "{source}");
            }
        }
    }

    #[test]
    fn candidate_support_comes_from_the_authored_reference_and_package_catalogs() {
        let source = inputs();
        let index = create_index(&source).unwrap();
        let selected = join(&index, &route(&["can.v1.policy", "can.v1.import"]));
        assert_eq!(selected["grammarCoverage"], "complete");
        assert_eq!(selected["candidateCoverage"], "complete");
        assert_eq!(selected["cards"][0]["status"], "working");
        let mut planned = source;
        planned["ui"]["entries"][0]["availability"] = json!("proposed");
        let unavailable_id = format!(
            "can.v1.ui.{}",
            planned["ui"]["entries"][0]["id"].as_str().unwrap()
        );
        let index = create_index(&planned).unwrap();
        assert_eq!(
            join(&index, &route(&[&unavailable_id]))["candidateCoverage"],
            "unknown"
        );
        assert_eq!(
            join(&index, &route(&["can.v1.fake"]))["grammarCoverage"],
            "unknown"
        );
    }

    #[test]
    fn routing_preserves_structural_none_and_malformed_context_without_inventing_candidates() {
        let index = create_index(&inputs()).unwrap();
        let structural = json!({"version":1,"disposition":"structural","ids":[],"complete":false});
        assert_eq!(join(&index, &structural)["disposition"], "structural");
        assert_eq!(join(&index, &structural)["grammarCoverage"], "unknown");
        let none =
            json!({"version":1,"disposition":"none","slot":"given.rule","ids":[],"complete":true});
        assert_eq!(join(&index, &none)["candidateCoverage"], "complete");
        let exact = route(&["can.v1.policy"]);
        for malformed in [
            Value::Null,
            json!({}),
            json!({"version":2}),
            json!({"ids":[]}),
        ] {
            assert_eq!(routing(&malformed)["disposition"], "unknown");
        }
        let mut malformed = exact.clone();
        malformed["ids"] = json!(["can.v1.policy", "can.v1.policy"]);
        assert_eq!(routing(&malformed)["disposition"], "unknown");
        let mut with_context = exact.clone();
        with_context["context"] = ranking_context("rules");
        assert!(routing(&with_context).get("context").is_some());
        with_context["context"]["extra"] = json!(true);
        assert_eq!(routing(&with_context), exact);
        with_context["context"] = ranking_context("rules");
        with_context["complete"] = json!(false);
        assert!(routing(&with_context).get("context").is_none());
    }

    #[test]
    fn unicode_byte_spans_are_exact_and_literals_comments_and_identifier_suffixes_are_ineligible() {
        let index = create_index(&inputs()).unwrap();
        let source = "## café 😀\nGiven\n rules todo\n";
        let capture = capture(source, &index);
        let start = source.find("rules").unwrap();
        let ctx = ranking_context("rules");
        assert!(exact_span(&ctx, source.as_bytes(), start, start + 5));
        assert!(!exact_span(
            &ctx,
            source.as_bytes(),
            source[..start].chars().count(),
            start + 5
        ));
        for source in [
            "## rules\n",
            "title=\"rules\"\n",
            "arules",
            "rules2",
            "`rules`",
        ] {
            let start = source.find("rules").unwrap();
            assert!(
                !exact_span(&ctx, source.as_bytes(), start, start + 5),
                "{source}"
            );
        }
        let projected = evidence(&capture, start, start + 5, "rules", None).unwrap();
        assert_eq!(
            projected["sourceWindow"]["text"],
            "<REDACTED>\n rules <REDACTED>\n"
        );
        assert!(evidence(&capture, start, start + 5, "rules", Some("unsafe\nintent")).is_none());
    }

    #[test]
    fn saved_index_file_refs_preserve_help_identity_and_local_ranking_policy() {
        let inputs = inputs();
        let index = create_index(&inputs).unwrap();
        let capture = capture("rules", &index);
        let mut files = Payloads::new().unwrap();
        let saved = files.json(&json!({"inputs":inputs})).unwrap();
        let cancel = AtomicBool::new(false);
        let mut request = json!({"action":"help","index":saved,"id":"can.v1.policy"});
        let help = run(&capture, &request, &cancel).unwrap();
        assert_eq!(help["card"]["status"], "working");
        let mut candidates = route(&["can.v1.policy", "can.v1.invariant"]);
        candidates["context"] = ranking_context("rules");
        request["action"] = json!("rank");
        request["complete"] = json!(true);
        request["omitted"] = json!(0);
        request["diagnostic"] =
            json!({"code":"E2001","primary":{"start":0,"end":5},"construct_candidates":candidates});
        assert_eq!(
            run(&capture, &request, &cancel).unwrap()["result"],
            outcome(
                "ranking_disallowed",
                "external decision support is disabled"
            )
        );
        request["diagnostic"]["construct_candidates"]["ids"] = json!(["can.v1.policy"]);
        assert_eq!(
            run(&capture, &request, &cancel).unwrap()["result"]["state"],
            "deterministic"
        );
        let mut stale_capture = capture.clone();
        stale_capture.inputs[0].sha256 = Some(sha(b"stale compiler"));
        assert!(
            run(&stale_capture, &request, &cancel)
                .unwrap_err()
                .contains("captured help identity mismatch")
        );
        request["diagnostic"]["construct_candidates"] =
            json!({"version":1,"disposition":"none","ids":[],"complete":true});
        assert_eq!(
            run(&capture, &request, &cancel).unwrap()["result"],
            json!({"state":"none"})
        );
        request["diagnostic"]["construct_candidates"] =
            json!({"version":1,"disposition":"structural","ids":[],"complete":false});
        assert_eq!(
            run(&capture, &request, &cancel).unwrap()["result"]["state"],
            "structural"
        );
    }
}
