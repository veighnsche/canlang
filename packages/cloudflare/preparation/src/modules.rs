//! Module inventory, rewriting and graph checks (P05.1).
//!
//! Pure port of the `deploy/bundle.ts` calculation core: posix path
//! algebra, import-specifier collection/validation/rewriting, artifact
//! staging, duplicate-last-wins merging, workerd loadability + link
//! checks (in that order), the legacy v1 serialization/digest, and
//! the staged-deployment + manifest builders.
//!
//! The host owns filesystem reads (worker/runtime/vendor walks), Bun
//! builds and catalog derivation (P05.2), and publication writes;
//! this module owns every byte decision over the texts it is given.
//! Staging consumes P04.1-validated views (paths/sources are text);
//! texts travel as UTF-16 units so every regex offset and every
//! `string.length` count matches JS exactly.
//!
//! Mixed-asset (v2) support is NOT ported: the typed C04.asset
//! contract was read (`contracts/deployment-assets.ts`: frozen v1
//! text digest, v2 mixed frames, `inventorizeAssets` guards) and the
//! v1 text-only path below is untouched by it. Binary assets travel
//! alongside (never through) these text stages.

#![allow(dead_code)]

use crate::input::{json_quote, render_text, Node};
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Published names (mirror the bundle.ts exports).
// ---------------------------------------------------------------------------

/// Main module key: the deployed worker entry within the module map.
pub const DEPLOY_MAIN_MODULE: &str = "worker/main.js";
/// MCP handler key: the sibling `./mcp-handler.js` bundle convention.
pub const MCP_HANDLER_MODULE: &str = "worker/mcp-handler.js";
/// HTTP operations key: the sibling `./http-operations.js` bundle convention.
pub const HTTP_OPERATIONS_MODULE: &str = "worker/http-operations.js";
/// Staged-deployment key: the sibling `./artifact.js` join contract.
pub const ARTIFACT_MODULE: &str = "worker/artifact.js";
/// Derived-inputs key: the sibling `./derived-inputs.js` E1 join contract.
pub const DERIVED_INPUTS_MODULE: &str = "worker/derived-inputs.js";
/// Assembly key: the base every portable module URL resolves against.
const ASSEMBLY_MODULE_KEY: &str = "worker/assembly.js";

/// MCP bundle marker set: the real handler chain plus the bundle's
/// own `IdentityError` copy (no mixing across the bundle boundary).
pub const MCP_BUNDLE_MARKERS: [&str; 4] = [
    "createMcpHandler",
    "createArtifactRegistry",
    "createArtifactCatalog",
    "IdentityError",
];
/// HTTP operations bundle marker set: the real op chain plus the
/// bundle's own `IdentityError` copy.
pub const HTTP_BUNDLE_MARKERS: [&str; 2] = ["handleOperationRequest", "IdentityError"];

/// Checkout-resolving producer specifiers (rewritten when staged).
pub const STDLIB_SPECIFIER: &str = "@canlang/stdlib";
pub const UI_SPECIFIER: &str = "@canlang/ui";
const IDENTITY_SOURCE_SPECIFIER: &str = "@canlang/identity";
const STATE_D1_SOURCE_SPECIFIER: &str = "../../../state/dist/state/src/storage/d1.js";
const STATE_RECEIPT_JOIN_SOURCE_SPECIFIER: &str = "../../../state/dist/state/src/receipt/join.js";
const STATE_RECEIPT_OBSERVER_SOURCE_SPECIFIER: &str =
    "../../../state/dist/state/src/receipt/observer.js";
const VALUES_SOURCE_SPECIFIER: &str = "@canlang/values";
const CONTRACTS_SOURCE_SPECIFIER: &str = "@canlang/contracts";

/// Vendor entry keys (mirroring each package's `main`).
const UI_VENDOR_ENTRY: &str = "vendor/ui/index.js";
const STDLIB_VENDOR_ENTRY: &str = "vendor/stdlib/index.js";
const IDENTITY_VENDOR_ENTRY: &str = "vendor/identity/index.js";
const CONTRACTS_VENDOR_ENTRY: &str = "vendor/contracts/index.js";
const STATE_D1_VENDOR_ENTRY: &str = "vendor/state/storage/d1.js";
const STATE_RECEIPT_JOIN_VENDOR_ENTRY: &str = "vendor/state/receipt/join.js";
const STATE_RECEIPT_OBSERVER_VENDOR_ENTRY: &str = "vendor/state/receipt/observer.js";
const VALUES_VENDOR_ENTRY: &str = "vendor/values/index.js";

/// One bundle refusal, message-identical to the TS throw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModulesError {
    pub message: String,
}

/// Ordered module inventory: `(key, text)` pairs (insertion order is
/// meaningful — it decides first-error reporting).
pub type ModuleMap = Vec<(Vec<u16>, Vec<u16>)>;

// ---------------------------------------------------------------------------
// JS character classes (ASCII `\w`, full `\s`).
// ---------------------------------------------------------------------------

fn is_word_unit(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x5A | 0x5F | 0x61..=0x7A)
}

/// JS `\s`: WhiteSpace + LineTerminator (the trim set).
fn is_space_unit(u: u16) -> bool {
    matches!(
        u,
        0x0009
            | 0x000A
            | 0x000B
            | 0x000C
            | 0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2000
            | 0x2001
            | 0x2002
            | 0x2003
            | 0x2004
            | 0x2005
            | 0x2006
            | 0x2007
            | 0x2008
            | 0x2009
            | 0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

/// `\b` before unit `at`: exactly one side is a word unit.
fn is_boundary_before(units: &[u16], at: usize) -> bool {
    let left = at > 0 && is_word_unit(units[at - 1]);
    let right = at < units.len() && is_word_unit(units[at]);
    left != right
}

/// `\b` after the unit before `at` (i.e. between `at-1` and `at`).
fn is_boundary_at(units: &[u16], at: usize) -> bool {
    let left = at > 0 && is_word_unit(units[at - 1]);
    let right = at < units.len() && is_word_unit(units[at]);
    left != right
}

fn literal_at(units: &[u16], at: usize, text: &str) -> bool {
    let bytes = text.as_bytes();
    at + bytes.len() <= units.len()
        && units[at..at + bytes.len()]
            .iter()
            .zip(bytes.iter())
            .all(|(u, b)| *u == *b as u16)
}

// ---------------------------------------------------------------------------
// Posix path algebra over units (non-`/` units are opaque segments).
// ---------------------------------------------------------------------------

fn split_segments(path: &[u16]) -> Vec<&[u16]> {
    let mut segments = Vec::new();
    let mut start = 0;
    for (i, u) in path.iter().enumerate() {
        if *u == 0x2F {
            segments.push(&path[start..i]);
            start = i + 1;
        }
    }
    segments.push(&path[start..]);
    segments
}

fn join_segments(absolute: bool, segments: &[Vec<u16>]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    if absolute {
        out.push(0x2F);
    }
    for (i, segment) in segments.iter().enumerate() {
        if i > 0 {
            out.push(0x2F);
        }
        out.extend_from_slice(segment);
    }
    out
}

/// Exact `posix.normalize`: `.`/empty collapse, `..` pops (clamped
/// at root for absolute paths, preserved leading for relative).
fn posix_normalize(path: &[u16]) -> Vec<u16> {
    let absolute = path.first() == Some(&0x2F);
    let mut stack: Vec<Vec<u16>> = Vec::new();
    for segment in split_segments(path) {
        if segment.is_empty() || segment == [0x2E] {
            continue;
        } else if segment == [0x2E, 0x2E] {
            if stack.pop().is_none() && !absolute {
                stack.push(vec![0x2E, 0x2E]);
            }
        } else {
            stack.push(segment.to_vec());
        }
    }
    if stack.is_empty() {
        return if absolute { vec![0x2F] } else { vec![0x2E] };
    }
    // Node keeps a trailing slash when the input had one (except the
    // root itself); reproduce: re-append when the last input segment
    // was empty and the result is not just `/`.
    let mut out = join_segments(absolute, &stack);
    let had_trailing = path.len() > 1 && path.last() == Some(&0x2F);
    if had_trailing && out != [0x2F] {
        out.push(0x2F);
    }
    out
}

/// Exact `posix.join`: segments concatenate with `/`, then normalize
/// (absolute segments do NOT reset, unlike `resolve`).
fn posix_join(parts: &[&[u16]]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for part in parts {
        if !out.is_empty() {
            out.push(0x2F);
        }
        out.extend_from_slice(part);
    }
    if out.is_empty() {
        return vec![0x2E];
    }
    posix_normalize(&out)
}

/// Exact `posix.dirname`.
fn posix_dirname(path: &[u16]) -> Vec<u16> {
    if path.is_empty() {
        return vec![0x2E];
    }
    let mut end = path.len();
    while end > 0 && path[end - 1] == 0x2F {
        end -= 1;
    }
    if end == 0 {
        return vec![0x2F];
    }
    let mut start = end;
    while start > 0 && path[start - 1] != 0x2F {
        start -= 1;
    }
    if start == 0 {
        return if path[0] == 0x2F {
            vec![0x2F]
        } else {
            vec![0x2E]
        };
    }
    let mut dir_end = start - 1;
    while dir_end > 0 && path[dir_end - 1] == 0x2F {
        dir_end -= 1;
    }
    if dir_end == 0 {
        return vec![0x2F];
    }
    path[..dir_end].to_vec()
}

/// Exact `posix.relative(from, to)`: both resolve against root, then
/// segment-diff (`..` per remaining `from` segment).
fn posix_relative(from: &[u16], to: &[u16]) -> Vec<u16> {
    fn resolved(path: &[u16]) -> Vec<Vec<u16>> {
        let abs: Vec<u16> = if path.first() == Some(&0x2F) {
            path.to_vec()
        } else {
            let mut v = vec![0x2F];
            v.extend_from_slice(path);
            v
        };
        let mut stack: Vec<Vec<u16>> = Vec::new();
        for segment in split_segments(&posix_normalize(&abs)) {
            if !segment.is_empty() {
                stack.push(segment.to_vec());
            }
        }
        stack
    }
    let from_segs = resolved(from);
    let to_segs = resolved(to);
    let mut common = 0;
    while common < from_segs.len() && common < to_segs.len() && from_segs[common] == to_segs[common]
    {
        common += 1;
    }
    let mut out: Vec<Vec<u16>> = Vec::new();
    for _ in common..from_segs.len() {
        out.push(vec![0x2E, 0x2E]);
    }
    for segment in to_segs.iter().skip(common) {
        out.push(segment.clone());
    }
    if out.is_empty() {
        return Vec::new();
    }
    join_segments(false, &out)
}

/// Module-relative specifier from one map key to another (`./…` form).
pub fn relative_specifier(from_module: &[u16], to_key: &[u16]) -> Vec<u16> {
    let rel = posix_relative(&posix_dirname(from_module), to_key);
    if rel.first() == Some(&0x2E) {
        rel
    } else {
        let mut out = vec![0x2E, 0x2F];
        out.extend_from_slice(&rel);
        out
    }
}

fn units_eq_ascii(units: &[u16], text: &str) -> bool {
    units.len() == text.len() && units.iter().zip(text.bytes()).all(|(u, b)| *u == b as u16)
}

/// Refuse escaping/absolute/empty module paths (mirrors
/// `assertSafeRelativePath`; `what` names the operation).
pub fn assert_safe_relative_path(path: &[u16], what: &str) -> Result<(), ModulesError> {
    let normalized = posix_normalize(path);
    let escapes = path.is_empty()
        || path.first() == Some(&0x2F)
        || normalized == [0x2E, 0x2E]
        || (normalized.len() > 2 && normalized[..3] == [0x2E, 0x2E, 0x2F]);
    if escapes {
        return Err(ModulesError {
            message: format!(
                "deploy bundle: refusing {what} outside the module map: {}",
                json_quote(path)
            ),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Import-specifier matchers (exact `/g`-pattern semantics over units).
// ---------------------------------------------------------------------------

/// Match result: byte offsets (unit indices) of the whole match plus
/// the pre/spec/post groups. Advance past `end` (patterns never match
/// empty, mirroring `/g` progression exactly).
struct SpecMatch {
    start: usize,
    spec_start: usize,
    spec_end: usize,
    end: usize,
}

fn scan_spaces(units: &[u16], mut at: usize) -> usize {
    while at < units.len() && is_space_unit(units[at]) {
        at += 1;
    }
    at
}

fn is_quote(u: u16) -> bool {
    u == 0x22 || u == 0x27
}

/// `(\bfrom\s*['"])([^'"]+)(['"])` at `at` (opening/closing quotes
/// are independent classes, like the regex — no backreference).
fn match_from(units: &[u16], at: usize) -> Option<SpecMatch> {
    if !is_boundary_before(units, at) || !literal_at(units, at, "from") {
        return None;
    }
    let pre_end = scan_spaces(units, at + 4);
    if pre_end >= units.len() || !is_quote(units[pre_end]) {
        return None;
    }
    let spec_start = pre_end + 1;
    let mut spec_end = spec_start;
    while spec_end < units.len() && !is_quote(units[spec_end]) {
        spec_end += 1;
    }
    if spec_end == spec_start || spec_end >= units.len() {
        return None;
    }
    Some(SpecMatch {
        start: at,
        spec_start,
        spec_end,
        end: spec_end + 1,
    })
}

/// `(\bimport\s*\(\s*['"])([^'"]+)(['"]\s*\))` at `at`.
fn match_dynamic_import(units: &[u16], at: usize) -> Option<SpecMatch> {
    if !is_boundary_before(units, at) || !literal_at(units, at, "import") {
        return None;
    }
    let mut p = scan_spaces(units, at + 6);
    if p >= units.len() || units[p] != 0x28 {
        return None;
    }
    p = scan_spaces(units, p + 1);
    if p >= units.len() || !is_quote(units[p]) {
        return None;
    }
    let spec_start = p + 1;
    let mut spec_end = spec_start;
    while spec_end < units.len() && !is_quote(units[spec_end]) {
        spec_end += 1;
    }
    if spec_end == spec_start || spec_end >= units.len() {
        return None;
    }
    let end = scan_spaces(units, spec_end + 1);
    if end >= units.len() || units[end] != 0x29 {
        return None;
    }
    Some(SpecMatch {
        start: at,
        spec_start,
        spec_end,
        end: end + 1,
    })
}

/// `(\bimport\s*['"])([^'"]+)(['"])` — note `\s+` (≥1 space).
fn match_side_effect_import(units: &[u16], at: usize) -> Option<SpecMatch> {
    if !is_boundary_before(units, at) || !literal_at(units, at, "import") {
        return None;
    }
    let pre_end = scan_spaces(units, at + 6);
    if pre_end == at + 6 || pre_end >= units.len() || !is_quote(units[pre_end]) {
        return None;
    }
    let spec_start = pre_end + 1;
    let mut spec_end = spec_start;
    while spec_end < units.len() && !is_quote(units[spec_end]) {
        spec_end += 1;
    }
    if spec_end == spec_start || spec_end >= units.len() {
        return None;
    }
    Some(SpecMatch {
        start: at,
        spec_start,
        spec_end,
        end: spec_end + 1,
    })
}

/// Plain collection in pattern-major order (mirrors
/// `collectSpecifiers`: FROM scan, then DYNAMIC, then SIDE-EFFECT —
/// source order is NOT preserved).
fn collect_specifiers(js: &[u16]) -> Vec<(usize, usize)> {
    let mut specs = Vec::new();
    for matcher in [match_from, match_dynamic_import, match_side_effect_import] {
        let mut at = 0;
        while at < js.len() {
            match matcher(js, at) {
                Some(m) => {
                    specs.push((m.spec_start, m.spec_end));
                    at = m.end;
                }
                None => at += 1,
            }
        }
    }
    specs
}

/// Whether a static-import match sits at a statement start: only
/// spaces/tabs/CRs may precede it back to the string start, a
/// newline, or `;`/`{`/`}`.
fn is_statement_start(js: &[u16], match_index: usize) -> bool {
    let mut i = match_index as isize - 1;
    while i >= 0 && matches!(js[i as usize], 0x20 | 0x09 | 0x0D) {
        i -= 1;
    }
    if i < 0 {
        return true;
    }
    matches!(js[i as usize], 0x0A | 0x3B | 0x7B | 0x7D)
}

/// `/\b(import|export)\b/` test over units.
fn has_import_or_export_word(segment: &[u16]) -> bool {
    for word in ["import", "export"] {
        let bytes = word.as_bytes();
        let mut at = 0;
        while at + bytes.len() <= segment.len() {
            if literal_at(segment, at, word)
                && is_boundary_before(segment, at)
                && is_boundary_at(segment, at + bytes.len())
            {
                return true;
            }
            at += 1;
        }
    }
    false
}

/// Guarded collection (mirrors `collectLinkSpecifiers`): static
/// side-effect forms must sit at statement starts; FROM forms must
/// follow `import`/`export` back to a statement boundary (brace
/// imports and every re-export form carry the keyword); dynamic
/// `import()` keeps the loose form.
fn collect_link_specifiers(js: &[u16]) -> Vec<(usize, usize)> {
    let mut specs = Vec::new();
    let matchers = [
        (match_from as fn(&[u16], usize) -> Option<SpecMatch>, 0),
        (
            match_dynamic_import as fn(&[u16], usize) -> Option<SpecMatch>,
            1,
        ),
        (
            match_side_effect_import as fn(&[u16], usize) -> Option<SpecMatch>,
            2,
        ),
    ];
    for (matcher, kind) in matchers {
        let mut at = 0;
        while at < js.len() {
            match matcher(js, at) {
                Some(m) => {
                    let keep = if kind == 2 {
                        is_statement_start(js, m.start)
                    } else if kind == 0 {
                        let mut i = m.start as isize - 1;
                        while i >= 0 && js[i as usize] != 0x0A && js[i as usize] != 0x3B {
                            i -= 1;
                        }
                        has_import_or_export_word(&js[(i + 1) as usize..m.start])
                    } else {
                        true
                    };
                    if keep {
                        specs.push((m.spec_start, m.spec_end));
                    }
                    at = m.end;
                }
                None => at += 1,
            }
        }
    }
    specs
}

fn is_relative_specifier(spec: &[u16]) -> bool {
    spec == [0x2E]
        || spec == [0x2E, 0x2E]
        || (spec.len() >= 2 && spec[0] == 0x2E && spec[1] == 0x2F)
        || (spec.len() >= 3 && spec[0] == 0x2E && spec[1] == 0x2E && spec[2] == 0x2F)
}

// ---------------------------------------------------------------------------
// Comment/string/wrapper blanking (length-preserving, newline-preserving).
// ---------------------------------------------------------------------------

fn blank_region(out: &mut [u16], from: usize, to: usize) {
    let end = to.min(out.len());
    for u in &mut out[from..end] {
        if *u != 0x0A {
            *u = 0x20;
        }
    }
}

/// Exact `blankStringsAndComments`: `//`/`/* */` blank always; plain
/// strings blank unless `keep_strings`; template text blanks while
/// `${…}` code stays live (naive brace counting, no string awareness
/// inside interpolations — transcribed literally).
fn blank_strings_and_comments(source: &[u16], keep_strings: bool) -> Vec<u16> {
    let mut out = source.to_vec();
    let length = out.len();
    let mut i = 0;
    while i < length {
        let c = source[i];
        let d = source.get(i + 1).copied();
        if c == 0x2F && d == Some(0x2F) {
            let mut j = i + 2;
            while j < length && source[j] != 0x0A {
                j += 1;
            }
            blank_region(&mut out, i, j);
            i = j;
        } else if c == 0x2F && d == Some(0x2A) {
            let mut end = length;
            let mut j = i + 2;
            while j + 1 < length {
                if source[j] == 0x2A && source[j + 1] == 0x2F {
                    end = j + 2;
                    break;
                }
                j += 1;
            }
            // `indexOf` finds overlapping-adjacent closers too (`/**/`
            // closes at 2); the scan above matches it.
            blank_region(&mut out, i, end);
            i = end;
        } else if c == 0x27 || c == 0x22 {
            let mut j = i + 1;
            while j < length {
                if source[j] == 0x5C {
                    j += 2;
                } else if source[j] == c {
                    j += 1;
                    break;
                } else {
                    j += 1;
                }
            }
            if !keep_strings {
                blank_region(&mut out, i, j.min(length));
            }
            i = j;
        } else if c == 0x60 {
            let mut j = i + 1;
            let mut segment = i;
            while j < length {
                if source[j] == 0x5C {
                    j += 2;
                    continue;
                }
                if source[j] == 0x60 {
                    blank_region(&mut out, segment, j + 1);
                    j += 1;
                    break;
                }
                if source[j] == 0x24 && source.get(j + 1) == Some(&0x7B) {
                    blank_region(&mut out, segment, j);
                    let mut depth = 1;
                    j += 2;
                    while j < length && depth > 0 {
                        if source[j] == 0x7B {
                            depth += 1;
                        } else if source[j] == 0x7D {
                            depth -= 1;
                        }
                        j += 1;
                    }
                    segment = j;
                    continue;
                }
                j += 1;
            }
            if j >= length {
                blank_region(&mut out, segment, length);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Exact `blankCommonJsWrappers`: `__commonJS(` regions blank via
/// paren-depth scan with plain (non-template-aware) string handling.
fn blank_commonjs_wrappers(source: &[u16]) -> Vec<u16> {
    let mut out = source.to_vec();
    let length = out.len();
    let tag: &[u16] = &[
        0x5F, 0x5F, 0x63, 0x6F, 0x6D, 0x6D, 0x6F, 0x6E, 0x4A, 0x53, 0x28,
    ];
    let mut i = 0;
    while i + tag.len() <= length {
        if source[i..i + tag.len()] != *tag {
            i += 1;
            continue;
        }
        let mut j = i + tag.len();
        let mut depth = 1;
        let mut in_string: Option<u16> = None;
        while j < length && depth > 0 {
            let c = source[j];
            if let Some(q) = in_string {
                if c == 0x5C {
                    j += 2;
                } else if c == q {
                    in_string = None;
                    j += 1;
                } else {
                    j += 1;
                }
            } else if c == 0x27 || c == 0x22 || c == 0x60 {
                in_string = Some(c);
                j += 1;
            } else if c == 0x28 {
                depth += 1;
                j += 1;
            } else if c == 0x29 {
                depth -= 1;
                j += 1;
            } else {
                j += 1;
            }
        }
        blank_region(&mut out, i, j);
        i = j;
    }
    out
}

// ---------------------------------------------------------------------------
// Loadability scan.
// ---------------------------------------------------------------------------

/// `(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']file:\/\//g` match
/// end (exclusive), if any. The caller reports `at` as the offset.
fn match_file_url_import(units: &[u16], at: usize) -> Option<usize> {
    // Alternative 1: `\bfrom\s*`.
    if is_boundary_before(units, at) && literal_at(units, at, "from") {
        let p = scan_spaces(units, at + 4);
        if p < units.len() && is_quote(units[p]) && literal_at(units, p + 1, "file://") {
            return Some(p + 8);
        }
    }
    // Alternative 2: `\bimport\s*\(\s*`.
    if is_boundary_before(units, at) && literal_at(units, at, "import") {
        let p = scan_spaces(units, at + 6);
        if p < units.len() && units[p] == 0x28 {
            let q = scan_spaces(units, p + 1);
            if q < units.len() && is_quote(units[q]) && literal_at(units, q + 1, "file://") {
                return Some(q + 8);
            }
        }
        // Alternative 3: `\bimport\s+`.
        let q = scan_spaces(units, at + 6);
        if q > at + 6
            && q < units.len()
            && is_quote(units[q])
            && literal_at(units, q + 1, "file://")
        {
            return Some(q + 8);
        }
    }
    None
}

fn lookbehind_ok(units: &[u16], at: usize) -> bool {
    if at == 0 {
        return true;
    }
    let p = units[at - 1];
    !(is_word_unit(p) || p == 0x24 || p == 0x2E)
}

/// `/(?<![\w$.])require\s*\(/g` match end (exclusive), if any.
fn match_bare_require(units: &[u16], at: usize) -> Option<usize> {
    if !lookbehind_ok(units, at) || !literal_at(units, at, "require") {
        return None;
    }
    let p = scan_spaces(units, at + 7);
    if p < units.len() && units[p] == 0x28 {
        Some(p + 1)
    } else {
        None
    }
}

/// `/(?<![\w$.])module\.exports/g` match end, if any.
fn match_module_exports(units: &[u16], at: usize) -> Option<usize> {
    if !lookbehind_ok(units, at) || !literal_at(units, at, "module.exports") {
        return None;
    }
    Some(at + 14)
}

/// `/(?<![\w$.])exports(?![\w$])(?!\s*:)/g` match end, if any.
fn match_free_exports(units: &[u16], at: usize) -> Option<usize> {
    if !lookbehind_ok(units, at) || !literal_at(units, at, "exports") {
        return None;
    }
    let after = at + 7;
    if after < units.len() && (is_word_unit(units[after]) || units[after] == 0x24) {
        return None;
    }
    let p = scan_spaces(units, after);
    if p < units.len() && units[p] == 0x3A {
        return None;
    }
    Some(after)
}

/// `/function\s+$/` over the ≤9 units before a `require(` match.
fn is_stdlib_require_guard(stripped: &[u16], match_index: usize) -> bool {
    let from = match_index.saturating_sub(9);
    let window = &stripped[from..match_index];
    let mut end = window.len();
    while end > 0 && is_space_unit(window[end - 1]) {
        end -= 1;
    }
    if end == window.len() {
        return false;
    }
    end >= 8 && window[end - 8..end] == [0x66, 0x75, 0x6E, 0x63, 0x74, 0x69, 0x6F, 0x6E]
}

/// Exact `scanModuleIssues`: file-URL scan over the RAW source, then
/// `require`/`module.exports`/`exports` over the blanked source.
fn scan_module_issues(source: &[u16]) -> Vec<String> {
    let mut issues = Vec::new();
    let mut at = 0;
    while at < source.len() {
        match match_file_url_import(source, at) {
            Some(end) => {
                issues.push(format!("node file-URL import at offset {at}"));
                at = end;
            }
            None => at += 1,
        }
    }
    let stripped = blank_commonjs_wrappers(&blank_strings_and_comments(source, false));
    let mut at = 0;
    while at < stripped.len() {
        match match_bare_require(&stripped, at) {
            Some(end) => {
                if !is_stdlib_require_guard(&stripped, at) {
                    issues.push(format!("bare require( call at offset {at}"));
                }
                at = end;
            }
            None => at += 1,
        }
    }
    let mut at = 0;
    while at < stripped.len() {
        match match_module_exports(&stripped, at) {
            Some(end) => {
                issues.push(format!("CommonJS module.exports at offset {at}"));
                at = end;
            }
            None => at += 1,
        }
    }
    let mut at = 0;
    while at < stripped.len() {
        match match_free_exports(&stripped, at) {
            Some(end) => {
                issues.push(format!("CommonJS free exports at offset {at}"));
                at = end;
            }
            None => at += 1,
        }
    }
    issues
}

/// Refuse any module that workerd cannot load as ESM: node file-URL
/// imports or real (unwrapped) CommonJS. Modules iterate in slice
/// order (the map's insertion order); the first issue wins with a
/// `(+N more)` suffix when several exist.
pub fn assert_workerd_loadable(modules: &[(&[u16], &[u16])]) -> Result<(), ModulesError> {
    for (name, contents) in modules {
        let issues = scan_module_issues(contents);
        if !issues.is_empty() {
            let extra = if issues.len() > 1 {
                format!(" (+{} more)", issues.len() - 1)
            } else {
                String::new()
            };
            return Err(ModulesError {
                message: format!(
                    "deploy bundle: module {} is not workerd-loadable: {}{extra}",
                    json_quote(name),
                    issues[0]
                ),
            });
        }
    }
    Ok(())
}

/// Refuse dangling imports: every relative specifier must resolve to
/// a staged key, and no bare specifier may survive (workerd has no
/// package resolution). Same blanking honesty as the loadability
/// scan, plus the guarded specifier collection.
pub fn assert_links_resolve(modules: &[(&[u16], &[u16])]) -> Result<(), ModulesError> {
    let keys: HashSet<Vec<u16>> = modules.iter().map(|(k, _)| k.to_vec()).collect();
    for (name, contents) in modules {
        let stripped = blank_commonjs_wrappers(&blank_strings_and_comments(contents, true));
        for (spec_start, spec_end) in collect_link_specifiers(&stripped) {
            let spec = &stripped[spec_start..spec_end];
            if !is_relative_specifier(spec) {
                return Err(ModulesError {
                    message: format!(
                        "deploy bundle: module {} has bare import {} (no package resolution in workerd)",
                        json_quote(name),
                        json_quote(spec)
                    ),
                });
            }
            let target = posix_normalize(&posix_join(&[&posix_dirname(name), spec]));
            if !keys.contains(&target) {
                return Err(ModulesError {
                    message: format!(
                        "deploy bundle: module {} imports {} (resolves to {}): no such staged module",
                        json_quote(name),
                        json_quote(spec),
                        json_quote(&target)
                    ),
                });
            }
        }
    }
    Ok(())
}

/// The frozen check order: loadability BEFORE links (bundle.ts
/// assembly position). One entry point so the order lives in exactly
/// one place.
pub fn assert_bundle_checks(modules: &[(&[u16], &[u16])]) -> Result<(), ModulesError> {
    assert_workerd_loadable(modules)?;
    assert_links_resolve(modules)
}

// ---------------------------------------------------------------------------
// Rewriting.
// ---------------------------------------------------------------------------

/// Apply the three import-pattern replaces in sequence (FROM, then
/// DYNAMIC, then SIDE-EFFECT), remapping known specifiers and
/// passing everything else through byte-identically.
fn rewrite_with(js: &[u16], mapped: &dyn Fn(&[u16]) -> Option<Vec<u16>>) -> Vec<u16> {
    let mut out = js.to_vec();
    for matcher in [match_from, match_dynamic_import, match_side_effect_import] {
        let mut next: Vec<u16> = Vec::with_capacity(out.len());
        let mut at = 0;
        let mut cursor = 0;
        while at < out.len() {
            match matcher(&out, at) {
                Some(m) => {
                    next.extend_from_slice(&out[cursor..m.spec_start]);
                    match mapped(&out[m.spec_start..m.spec_end]) {
                        Some(remapped) => next.extend_from_slice(&remapped),
                        None => next.extend_from_slice(&out[m.spec_start..m.spec_end]),
                    }
                    cursor = m.spec_end;
                    at = m.end;
                }
                None => at += 1,
            }
        }
        next.extend_from_slice(&out[cursor..]);
        out = next;
    }
    out
}

fn ascii_entry(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Rewrite artifact producer imports to module-relative vendor keys.
pub fn rewrite_artifact_imports(js: &[u16], module_path: &[u16]) -> Vec<u16> {
    rewrite_with(js, &|spec| {
        if units_eq_ascii(spec, STDLIB_SPECIFIER) {
            Some(relative_specifier(
                module_path,
                &ascii_entry(STDLIB_VENDOR_ENTRY),
            ))
        } else if units_eq_ascii(spec, UI_SPECIFIER) {
            Some(relative_specifier(
                module_path,
                &ascii_entry(UI_VENDOR_ENTRY),
            ))
        } else {
            None
        }
    })
}

/// Rewrite pinned-runtime producer imports to module-relative vendor
/// keys, including the P-C join const literals (`import(X)` forms the
/// import-syntax pass cannot see get their source literals rewritten
/// too, by exact split/join).
pub fn rewrite_runtime_imports(js: &[u16], module_key: &[u16]) -> Vec<u16> {
    let pairs: &[(&str, &str)] = &[
        (IDENTITY_SOURCE_SPECIFIER, IDENTITY_VENDOR_ENTRY),
        (STATE_D1_SOURCE_SPECIFIER, STATE_D1_VENDOR_ENTRY),
        (
            STATE_RECEIPT_JOIN_SOURCE_SPECIFIER,
            STATE_RECEIPT_JOIN_VENDOR_ENTRY,
        ),
        (
            STATE_RECEIPT_OBSERVER_SOURCE_SPECIFIER,
            STATE_RECEIPT_OBSERVER_VENDOR_ENTRY,
        ),
        (CONTRACTS_SOURCE_SPECIFIER, CONTRACTS_VENDOR_ENTRY),
    ];
    let mut out = rewrite_with(js, &|spec| {
        for (source, entry) in pairs {
            if units_eq_ascii(spec, source) {
                return Some(relative_specifier(module_key, &ascii_entry(entry)));
            }
        }
        None
    });
    for (source, entry) in pairs {
        let from = ascii_entry(source);
        let to = relative_specifier(module_key, &ascii_entry(entry));
        out = split_join(&out, &from, &to);
    }
    out
}

/// Rewrite producer imports inside staged vendor trees (the full map
/// applies; mappings with no occurrence are exact no-ops).
pub fn rewrite_vendor_imports(js: &[u16], module_key: &[u16]) -> Vec<u16> {
    rewrite_with(js, &|spec| {
        for (source, entry) in [
            (STDLIB_SPECIFIER, STDLIB_VENDOR_ENTRY),
            (UI_SPECIFIER, UI_VENDOR_ENTRY),
            (IDENTITY_SOURCE_SPECIFIER, IDENTITY_VENDOR_ENTRY),
            (VALUES_SOURCE_SPECIFIER, VALUES_VENDOR_ENTRY),
        ] {
            if units_eq_ascii(spec, source) {
                return Some(relative_specifier(module_key, &ascii_entry(entry)));
            }
        }
        None
    })
}

/// Exact `string.split(sep).join(replacement)` over units
/// (non-overlapping leftmost, like the regex-free split).
fn split_join(units: &[u16], from: &[u16], to: &[u16]) -> Vec<u16> {
    if from.is_empty() {
        return units.to_vec();
    }
    let mut out: Vec<u16> = Vec::new();
    let mut at = 0;
    while at + from.len() <= units.len() {
        if units[at..at + from.len()] == *from {
            out.extend_from_slice(to);
            at += from.len();
        } else {
            out.push(units[at]);
            at += 1;
        }
    }
    out.extend_from_slice(&units[at..]);
    out
}

// ---------------------------------------------------------------------------
// Artifact staging + validation.
// ---------------------------------------------------------------------------

/// One validated artifact module (mirrors `ModuleView`).
pub struct StagingModule<'a> {
    pub path: &'a [u16],
    pub js: &'a [u16],
}

/// One page's module reference (`page.path` renders raw in refusals).
pub struct PageRef<'a> {
    pub path: &'a [u16],
    pub module: &'a [u16],
}

/// One callable's module reference (`callable.id` renders raw).
pub struct CallableRef<'a> {
    pub id: &'a [u16],
    pub module: &'a [u16],
}

/// Validate artifact imports: stdlib/ui skip, relative specs must
/// resolve to known modules, anything else refuses (mirrors
/// `validateArtifactImports`, including pattern-major order).
pub fn validate_artifact_imports(modules: &[StagingModule]) -> Result<(), ModulesError> {
    let known: HashSet<Vec<u16>> = modules.iter().map(|m| m.path.to_vec()).collect();
    for module in modules {
        for (spec_start, spec_end) in collect_specifiers(module.js) {
            let spec = &module.js[spec_start..spec_end];
            if units_eq_ascii(spec, STDLIB_SPECIFIER) || units_eq_ascii(spec, UI_SPECIFIER) {
                continue;
            }
            if is_relative_specifier(spec) {
                let target = posix_normalize(&posix_join(&[&posix_dirname(module.path), spec]));
                if !known.contains(&target) {
                    return Err(ModulesError {
                        message: format!(
                            "deploy bundle: module {} imports {} (resolves to {}): no such artifact module",
                            json_quote(module.path),
                            json_quote(spec),
                            json_quote(&target)
                        ),
                    });
                }
                continue;
            }
            return Err(ModulesError {
                message: format!(
                    "deploy bundle: module {} has unresolvable import {} (only {}, {}, and relative imports are supported)",
                    json_quote(module.path),
                    json_quote(spec),
                    STDLIB_SPECIFIER,
                    UI_SPECIFIER
                ),
            });
        }
    }
    Ok(())
}

/// Stage artifact modules (production only): non-empty check, import
/// validation, page/callable module checks, safe paths, rewrites.
pub fn stage_artifact_modules(
    modules: &[StagingModule],
    pages: &[PageRef],
    callables: &[CallableRef],
) -> Result<ModuleMap, ModulesError> {
    if modules.is_empty() {
        return Err(ModulesError {
            message: "deploy bundle: artifact has no modules; modules[0] must be the entrypoint"
                .to_string(),
        });
    }
    validate_artifact_imports(modules)?;
    let known: HashSet<Vec<u16>> = modules.iter().map(|m| m.path.to_vec()).collect();
    for page in pages {
        if !known.contains(page.module) {
            return Err(ModulesError {
                message: format!(
                    "deploy bundle: page {} references unknown module {} (recompile with the fixed `can compile`)",
                    render_text(page.path),
                    json_quote(page.module)
                ),
            });
        }
    }
    for callable in callables {
        if !known.contains(callable.module) {
            return Err(ModulesError {
                message: format!(
                    "deploy bundle: callable {} references unknown module {} (recompile with the fixed `can compile`)",
                    render_text(callable.id),
                    json_quote(callable.module)
                ),
            });
        }
    }
    let mut staged = Vec::with_capacity(modules.len());
    for module in modules {
        assert_safe_relative_path(module.path, "to stage module")?;
        staged.push((
            module.path.to_vec(),
            rewrite_artifact_imports(module.js, module.path),
        ));
    }
    Ok(staged)
}

// ---------------------------------------------------------------------------
// Inventory merging, digest, manifest, assembly.
// ---------------------------------------------------------------------------

/// Duplicate-last-wins merge over ordered layers (exact
/// spread/`Object.assign` semantics: the LAST value wins, the FIRST
/// insertion position is kept).
pub fn merge_module_layers(layers: &[ModuleMap]) -> ModuleMap {
    let mut index: HashMap<Vec<u16>, usize> = HashMap::new();
    let mut merged: Vec<(Vec<u16>, Vec<u16>)> = Vec::new();
    for layer in layers {
        for (key, text) in layer {
            match index.get(key) {
                Some(position) => {
                    merged[*position].1 = text.clone();
                }
                None => {
                    index.insert(key.clone(), merged.len());
                    merged.push((key.clone(), text.clone()));
                }
            }
        }
    }
    merged
}

/// Sort staged keys in place (UTF-16 code-unit order, exact
/// `Object.keys(modules).sort()`).
pub fn sort_module_keys(modules: &mut [(Vec<u16>, Vec<u16>)]) {
    modules.sort_by(|a, b| a.0.cmp(&b.0));
}

/// Legacy v1 serialization + digest (mirrors `bundleSha256` and the
/// frozen `ASSET_DIGEST_V1`): sha256 over
/// `JSON.stringify({ mainModule, modules: sorted })`. Sorts
/// defensively (like the TS helper) so any order yields the digest.
pub fn bundle_sha256(main_module: &[u16], modules: &[(&[u16], &[u16])]) -> String {
    let mut sorted: Vec<(&[u16], &[u16])> = modules.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut modules_obj = Node::Obj(Vec::with_capacity(sorted.len()));
    if let Node::Obj(entries) = &mut modules_obj {
        for (key, text) in sorted {
            entries.push((key.to_vec(), Node::Text(text.to_vec())));
        }
    }
    let root = Node::Obj(vec![
        (ascii_entry("mainModule"), Node::Text(main_module.to_vec())),
        (ascii_entry("modules"), modules_obj),
    ]);
    crate::release::sha256_hex(crate::render::json_stringify(&root).as_bytes())
}

/// Portable `AssembledModules`: URLs resolve against
/// `worker/assembly.js`; `moduleUrls` covers the sorted paths while
/// `entryUrl` uses modules[0] (document order, like the TS helper).
/// Empty input refuses (TS throws a version-dependent `TypeError`
/// there; the assembler always stages ≥1 module).
pub fn portable_assembled_modules(module_paths: &[&[u16]]) -> Result<Node, ModulesError> {
    let entry = module_paths.first().ok_or_else(|| ModulesError {
        message: "deploy bundle: cannot assemble zero modules".to_string(),
    })?;
    let mut sorted: Vec<&[u16]> = module_paths.to_vec();
    sorted.sort();
    let assembly = ascii_entry(ASSEMBLY_MODULE_KEY);
    let mut urls: Vec<(Vec<u16>, Node)> = Vec::with_capacity(sorted.len());
    for path in sorted {
        urls.push((
            path.to_vec(),
            Node::Text(relative_specifier(&assembly, path)),
        ));
    }
    Ok(Node::Obj(vec![
        (ascii_entry("dir"), Node::Text(Vec::new())),
        (
            ascii_entry("entryUrl"),
            Node::Text(relative_specifier(&assembly, entry)),
        ),
        (ascii_entry("moduleUrls"), Node::Obj(urls)),
    ]))
}

/// Render the P-B staged deployment (`worker/artifact.js`) source:
/// the generated header plus artifact/modules/verdict consts with
/// compact JSON bodies.
pub fn render_staged_deployment(artifact: &Node, modules: &Node, verdict: &Node) -> String {
    format!(
        "// Generated by can-platform deploy (P-B staged deployment). Do not edit.\n\
         export const artifact = {};\n\
         export const modules = {};\n\
         export const verdict = {};\n",
        crate::render::json_stringify(artifact),
        crate::render::json_stringify(modules),
        crate::render::json_stringify(verdict)
    )
}

/// Deploy-dir main as written into `wrangler.main` (relative to the
/// toml): `./{stem}.deploy/worker/main.js`.
pub fn deploy_bundle_main(stem: &[u16]) -> String {
    format!("./{}.deploy/{}", render_text(stem), DEPLOY_MAIN_MODULE)
}

/// `bundle.json` manifest node (mirrors `writeDeployBundle`'s shape;
/// serialize with the canonical JSON renderer): mainModule, sha256,
/// moduleCount, mcp/http bundle bytes, and per-module `{key, bytes}`
/// with `string.length` (UTF-16 unit) counts over the sorted keys.
/// The MCP/HTTP keys must be staged (the assembler always stages
/// both; anything else fails closed here instead of throwing on
/// `.length` downstream).
pub fn bundle_manifest(
    main_module: &[u16],
    sha256: &str,
    modules: &[(&[u16], &[u16])],
) -> Result<Node, ModulesError> {
    let mut sorted: Vec<(&[u16], &[u16])> = modules.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let byte_len = |key: &str| {
        sorted
            .iter()
            .find(|(k, _)| units_eq_ascii(k, key))
            .map(|(_, text)| text.len() as u64)
            .ok_or_else(|| ModulesError {
                message: format!("deploy bundle: bundle manifest needs staged module {key:?}"),
            })
    };
    let num = |value: u64| Node::Num {
        bits: (value as f64).to_bits(),
        spelling: value.to_string(),
    };
    let mut entries: Vec<Node> = Vec::with_capacity(sorted.len());
    for (key, text) in &sorted {
        entries.push(Node::Obj(vec![
            (ascii_entry("key"), Node::Text(key.to_vec())),
            (ascii_entry("bytes"), num(text.len() as u64)),
        ]));
    }
    Ok(Node::Obj(vec![
        (ascii_entry("mainModule"), Node::Text(main_module.to_vec())),
        (
            ascii_entry("sha256"),
            Node::Text(sha256.encode_utf16().collect()),
        ),
        (ascii_entry("moduleCount"), num(sorted.len() as u64)),
        (
            ascii_entry("mcpBundleBytes"),
            num(byte_len(MCP_HANDLER_MODULE)?),
        ),
        (
            ascii_entry("httpOperationsBytes"),
            num(byte_len(HTTP_OPERATIONS_MODULE)?),
        ),
        (ascii_entry("modules"), Node::Arr(entries)),
    ]))
}
