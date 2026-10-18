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

use crate::input::{as_arr, as_num, as_text, json_quote, obj_get, render_text, Node};
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
/// Whether a bare word permits a regex literal after it (keywords
/// taking an expression operand, including control heads). Any other
/// word is an operand: a following `/` divides.
fn is_regex_keyword(word: &[u16]) -> bool {
    units_eq_slice(word, "return")
        || units_eq_slice(word, "typeof")
        || units_eq_slice(word, "instanceof")
        || units_eq_slice(word, "in")
        || units_eq_slice(word, "new")
        || units_eq_slice(word, "delete")
        || units_eq_slice(word, "void")
        || units_eq_slice(word, "throw")
        || units_eq_slice(word, "case")
        || units_eq_slice(word, "do")
        || units_eq_slice(word, "else")
        || units_eq_slice(word, "yield")
        || units_eq_slice(word, "await")
        || units_eq_slice(word, "if")
        || units_eq_slice(word, "for")
        || units_eq_slice(word, "while")
        || units_eq_slice(word, "switch")
        || units_eq_slice(word, "with")
        || units_eq_slice(word, "catch")
}

/// True for the six control heads whose `(…)` closes into statement
/// position (`if/for/while/switch/with/catch`): a `/` there opens a
/// regex literal. Any other `)` closes an operand: `/` divides.
fn is_control_word(word: &[u16]) -> bool {
    units_eq_slice(word, "if")
        || units_eq_slice(word, "for")
        || units_eq_slice(word, "while")
        || units_eq_slice(word, "switch")
        || units_eq_slice(word, "with")
        || units_eq_slice(word, "catch")
}

/// Paren flavor for statement-position regex (020): only a control
/// head closes into regex context, and only `for` heads make a bare
/// `of` regex-capable.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ParenKind {
    Plain,
    Control,
    For,
}

/// Previous significant token class for the `of` aftermath.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PrevKind {
    None,
    Word,
    Operand,
    Operator,
}

/// Division-vs-regex scanner state for `/` (see
/// `blank_strings_and_comments`).
struct SlashCtx {
    division: bool,
    prev: PrevKind,
    dot: bool,
    parens: Vec<ParenKind>,
}

/// Word aftermath for `/` (020): a member-access property (after
/// `.`) is always an operand, even for reserved names (`obj.return
/// / x` divides). Contextual `of` admits a regex only directly
/// inside a `for` head after an operand (`for (x of /…/)`); a bare
/// use (`of / x / 2` divides, matching the oracle), as does `of`
/// anywhere else. All other words use the keyword table.
fn word_division(ctx: &SlashCtx, word: &[u16]) -> bool {
    if ctx.dot {
        return true;
    }
    if units_eq_slice(word, "of") {
        return !(ctx.parens.last() == Some(&ParenKind::For)
            && matches!(ctx.prev, PrevKind::Word | PrevKind::Operand));
    }
    !is_regex_keyword(word)
}

/// Read the previous significant word before `open` (exclusive);
/// returns its start, or None for a non-word head.
fn prev_word(units: &[u16], open: usize) -> Option<usize> {
    let mut j = open;
    while j > 0 {
        j -= 1;
        let c = units[j];
        if is_space_unit(c) {
            continue;
        }
        if is_word_unit(c) || c == 0x24 {
            let mut s = j + 1;
            while s > 0 && (is_word_unit(units[s - 1]) || units[s - 1] == 0x24) {
                s -= 1;
            }
            return Some(s);
        }
        return None;
    }
    None
}

/// Flavor of the `(` at `open`: a control keyword in operator
/// position makes a head (`else if (` nests through the inner head;
/// `for await (` looks one word further back). A keyword reached
/// through member access (`obj.if (`) is a property, never a head.
fn paren_kind(units: &[u16], open: usize) -> ParenKind {
    let Some(s) = prev_word(units, open) else {
        return ParenKind::Plain;
    };
    let mut e = s;
    while e < units.len() && (is_word_unit(units[e]) || units[e] == 0x24) {
        e += 1;
    }
    if s > 0 && units[s - 1] == 0x2E {
        return ParenKind::Plain;
    }
    let word = &units[s..e];
    if units_eq_slice(word, "for") {
        return ParenKind::For;
    }
    if is_control_word(word) {
        return ParenKind::Control;
    }
    // `for await (`: the word before `await` is `for`.
    if units_eq_slice(word, "await") {
        if let Some(s3) = prev_word(units, s) {
            let mut e3 = s3;
            while e3 < units.len() && (is_word_unit(units[e3]) || units[e3] == 0x24) {
                e3 += 1;
            }
            if units_eq_slice(&units[s3..e3], "for") {
                return ParenKind::For;
            }
        }
    }
    ParenKind::Plain
}

/// Skip (and blank) one `/…/flags` regex literal at `at`; returns the
/// resume position past the flags. Character classes (which may hold
/// unescaped `/`, quotes and braces) and escapes are honored; an
/// unterminated body stops at the line end. Regex bodies never carry
/// import specifiers, so they blank in both keeper modes.
fn skip_regex_literal(source: &[u16], out: &mut [u16], at: usize) -> usize {
    let length = source.len();
    let mut j = at + 1;
    let mut in_class = false;
    while j < length {
        let c = source[j];
        if c == 0x5C {
            j += 2;
            continue;
        }
        if c == 0x5B && !in_class {
            in_class = true;
        } else if c == 0x5D && in_class {
            in_class = false;
        } else if c == 0x2F && !in_class {
            j += 1;
            break;
        } else if (c == 0x0A || c == 0x0D) && !in_class {
            break;
        }
        j += 1;
    }
    while j < length && matches!(source[j], 0x61..=0x7A) {
        j += 1;
    }
    blank_region(out, at, j.min(length));
    j
}

/// `//…`/`/*…*/` comment at `i`: blank it, resume past. Comments
/// carry no token context.
fn step_comment(source: &[u16], out: &mut [u16], i: usize) -> usize {
    let length = source.len();
    if source.get(i + 1) == Some(&0x2F) {
        let mut j = i + 2;
        while j < length && source[j] != 0x0A {
            j += 1;
        }
        blank_region(out, i, j);
        return j;
    }
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
    blank_region(out, i, end);
    end
}

/// Quoted string at `i`: blank unless kept, resume past, operand context.
fn step_string(source: &[u16], out: &mut [u16], ctx: &mut SlashCtx, i: usize, keep: bool) -> usize {
    let length = source.len();
    let c = source[i];
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
    if !keep {
        blank_region(out, i, j.min(length));
    }
    ctx.division = true;
    ctx.prev = PrevKind::Operand;
    ctx.dot = false;
    j
}

/// Template literal at `i`: text blanks while `${…}` code stays live
/// (naive brace counting, no string awareness inside interpolations
/// — transcribed literally). Operand context.
fn step_template(source: &[u16], out: &mut [u16], ctx: &mut SlashCtx, i: usize) -> usize {
    let length = source.len();
    let mut j = i + 1;
    let mut segment = i;
    while j < length {
        if source[j] == 0x5C {
            j += 2;
            continue;
        }
        if source[j] == 0x60 {
            blank_region(out, segment, j + 1);
            j += 1;
            break;
        }
        if source[j] == 0x24 && source.get(j + 1) == Some(&0x7B) {
            blank_region(out, segment, j);
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
        blank_region(out, segment, length);
    }
    ctx.division = true;
    ctx.prev = PrevKind::Operand;
    ctx.dot = false;
    j
}

/// Lone `/` at `i`: divides after an operand, else opens a regex literal.
fn step_slash(source: &[u16], out: &mut [u16], ctx: &mut SlashCtx, i: usize) -> usize {
    if ctx.division {
        ctx.division = false;
        ctx.prev = PrevKind::Operator;
        ctx.dot = false;
        return i + 1;
    }
    let resume = skip_regex_literal(source, out, i);
    ctx.division = true;
    ctx.prev = PrevKind::Operand;
    ctx.dot = false;
    resume
}

/// Word at `i`: keyword/property/`of` aftermath; records its tail.
fn step_word(source: &[u16], ctx: &mut SlashCtx, i: usize) -> usize {
    if let Some((_, end)) = read_word(source, i) {
        ctx.division = word_division(ctx, &source[i..end]);
        ctx.prev = PrevKind::Word;
        ctx.dot = false;
        return end;
    }
    ctx.division = true;
    ctx.prev = PrevKind::Operand;
    ctx.dot = false;
    i + 1
}

/// `(`/`)` at `i`: control-head tracking — only a control head closes
/// into statement-position regex context (020).
fn step_paren(source: &[u16], ctx: &mut SlashCtx, i: usize) -> usize {
    if source[i] == 0x28 {
        ctx.parens.push(paren_kind(source, i));
        ctx.division = false;
    } else {
        ctx.division = !matches!(ctx.parens.pop().unwrap_or(ParenKind::Plain), ParenKind::Control | ParenKind::For);
    }
    ctx.prev = if source[i] == 0x29 { PrevKind::Operand } else { PrevKind::Operator };
    ctx.dot = false;
    i + 1
}

fn blank_strings_and_comments(source: &[u16], keep_strings: bool) -> Vec<u16> {
    let mut out = source.to_vec();
    let length = out.len();
    let mut i = 0;
    // Division-vs-regex context for `/`: operator holes (and the
    // start) admit a regex literal; operands divide. `}` counts as an
    // operand (division): erring toward visibility keeps the gate
    // fail-closed on genuinely ambiguous `{} /…/` shapes.
    let mut ctx = SlashCtx { division: false, prev: PrevKind::None, dot: false, parens: Vec::new() };
    while i < length {
        let c = source[i];
        let d = source.get(i + 1).copied();
        if c == 0x2F && (d == Some(0x2F) || d == Some(0x2A)) {
            i = step_comment(source, &mut out, i);
        } else if c == 0x27 || c == 0x22 {
            i = step_string(source, &mut out, &mut ctx, i, keep_strings);
        } else if c == 0x60 {
            i = step_template(source, &mut out, &mut ctx, i);
        } else if c == 0x2F {
            i = step_slash(source, &mut out, &mut ctx, i);
        } else if is_ident_start(c) {
            i = step_word(source, &mut ctx, i);
        } else if c == 0x28 || c == 0x29 {
            i = step_paren(source, &mut ctx, i);
        } else if matches!(c, 0x30..=0x39 | 0x5D | 0x7D) {
            ctx.division = true;
            ctx.prev = PrevKind::Operand;
            ctx.dot = false;
            i += 1;
        } else if c == 0x2B || c == 0x2D {
            // Doubled `++`/`--` is postfix (an operand divides); a
            // lone sign is an operator (a regex may follow).
            ctx.division = d != Some(c);
            ctx.prev = if d == Some(c) { PrevKind::Operand } else { PrevKind::Operator };
            ctx.dot = false;
            i += if d == Some(c) { 2 } else { 1 };
        } else if matches!(
            c,
            0x2C | 0x3D | 0x3A | 0x5B | 0x21 | 0x26 | 0x7C | 0x3F | 0x7B | 0x3B | 0x2A
                | 0x25 | 0x3C | 0x3E | 0x5E | 0x7E
        ) {
            ctx.division = false;
            ctx.prev = PrevKind::Operator;
            ctx.dot = c == 0x2E;
            i += 1;
        } else if is_space_unit(c) {
            // Whitespace (like comments) carries no token context.
            i += 1;
        } else {
            // Member access and other operand punctuation (notably `.`).
            ctx.division = true;
            ctx.prev = PrevKind::Operand;
            ctx.dot = c == 0x2E;
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

fn units_eq_slice(units: &[u16], text: &str) -> bool {
    units.len() == text.len()
        && units.iter().zip(text.bytes()).all(|(u, b)| *u == b as u16)
}

/// Whether `word` is one of the three gate-watched bindings.
fn is_gate_name(word: &[u16]) -> bool {
    units_eq_slice(word, "require") || units_eq_slice(word, "module") || units_eq_slice(word, "exports")
}

/// Identifier start (ASCII alpha/`_`/`$`; digits excluded).
fn is_ident_start(u: u16) -> bool {
    matches!(u, 0x41..=0x5A | 0x5F | 0x61..=0x7A | 0x24)
}

/// Read one identifier at `at`; returns (start, end).
fn read_word(units: &[u16], at: usize) -> Option<(usize, usize)> {
    if !units.get(at).is_some_and(|u| is_ident_start(*u)) {
        return None;
    }
    let mut end = at + 1;
    while end < units.len() && (is_word_unit(units[end]) || units[end] == 0x24) {
        end += 1;
    }
    Some((at, end))
}

/// One lexically declared gate binding with its block span. Uses are
/// excused only inside the span, order-insensitive within the block
/// (matching the oracle's scope resolution; hoisted uses before the
/// declaration still flag).
struct GateDecl {
    name: Vec<u16>,
    start: usize,
    end: usize,
}

/// Skip one balanced `{…}`/`[…]`/`(…)` group; None when unbalanced.
fn skip_balanced(units: &[u16], at: usize) -> Option<usize> {
    let (open, close) = match units.get(at)? {
        0x7B => (0x7Bu16, 0x7Du16),
        0x5B => (0x5Bu16, 0x5Du16),
        0x28 => (0x28u16, 0x29u16),
        _ => return None,
    };
    let mut depth = 0;
    let mut i = at;
    while i < units.len() {
        if units[i] == open {
            depth += 1;
        } else if units[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

/// Whether `word` (`of`/`in`) ends declarator binding position: what
/// follows is a value expression, never a bound name.
fn is_of_in(word: &[u16]) -> bool {
    units_eq_slice(word, "of") || units_eq_slice(word, "in")
}

/// After `var|let|const`: record bound gate names into `pending`.
/// Binding patterns are skipped wholesale (fail-closed). A name is
/// recorded only in binding position (followed by `=`/`,`/end);
/// value expressions (`of`/`in` tails, anything else) stop the parse.
fn parse_var_decls(units: &[u16], mut at: usize, pending: &mut Vec<Vec<u16>>) -> usize {
    loop {
        at = scan_spaces(units, at);
        if at >= units.len() || units[at] == 0x3B || units[at] == 0x7D || units[at] == 0x29 {
            return at;
        }
        if units[at] == 0x7B || units[at] == 0x5B {
            at = skip_balanced(units, at).unwrap_or(units.len());
            continue;
        }
        let Some((_, end)) = read_word(units, at) else {
            return at;
        };
        if is_of_in(&units[at..end]) {
            return at;
        }
        let next = scan_spaces(units, end);
        let follower = units.get(next).copied().unwrap_or(0);
        // Binding position: `=`/`,`/`;`/end-of-head/`}`/EOF, or a
        // `for`-head (`of`/`in` follows). Anything else (notably a
        // value expression) stops the parse without recording.
        let mut binding = follower == 0x3D
            || follower == 0x2C
            || follower == 0x3B
            || follower == 0x29
            || follower == 0x7D
            || next >= units.len();
        if !binding && is_ident_start(follower) {
            if let Some((w0, w1)) = read_word(units, next) {
                binding = is_of_in(&units[w0..w1]);
            }
        }
        if !binding {
            return at;
        }
        if is_gate_name(&units[at..end]) {
            pending.push(units[at..end].to_vec());
        }
        at = if follower == 0x3D {
            skip_initializer(units, next + 1)
        } else if follower == 0x2C {
            next + 1
        } else {
            next
        };
    }
}

/// Skip one `= …` initializer to the next top-level `,`/`;`/closer.
fn skip_initializer(units: &[u16], mut at: usize) -> usize {
    let mut depth = 0;
    while at < units.len() {
        let c = units[at];
        if c == 0x28 || c == 0x5B || c == 0x7B {
            depth += 1;
        } else if c == 0x29 || c == 0x5D || c == 0x7D {
            if depth == 0 {
                return at;
            }
            depth -= 1;
        } else if depth == 0 && (c == 0x2C || c == 0x3B) {
            return at + if c == 0x2C { 1 } else { 0 };
        }
        at += 1;
    }
    at
}

/// After `(`: record bare-identifier params into `pending` up to the
/// matching `)`. Binding patterns are skipped (fail-closed). Names
/// inside a default RHS (`=` seen at depth 1 until the next `,`) are
/// expressions in the enclosing scope, never bindings.
fn parse_paren_params(units: &[u16], at: usize, pending: &mut Vec<Vec<u16>>) -> usize {
    let mut depth = 1;
    let mut i = at;
    let mut in_default = false;
    while i < units.len() {
        let c = units[i];
        if c == 0x28 {
            depth += 1;
            i += 1;
        } else if c == 0x29 {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
            i += 1;
        } else if c == 0x7B || c == 0x5B {
            i = skip_balanced(units, i).unwrap_or(units.len());
        } else if c == 0x3D && depth == 1 {
            in_default = true;
            i += 1;
        } else if c == 0x2C && depth == 1 {
            in_default = false;
            i += 1;
        } else if let Some((_, end)) = read_word(units, i) {
            // Binding position only (`,`/`)`/`=` follow, outside any
            // default RHS). Calls, member uses and default-value
            // expressions never bind.
            if depth == 1 && !in_default {
                let next = scan_spaces(units, end);
                let follower = units.get(next).copied().unwrap_or(0);
                if (follower == 0x2C || follower == 0x29 || follower == 0x3D)
                    && is_gate_name(&units[i..end])
                {
                    pending.push(units[i..end].to_vec());
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    i
}

/// Park header params for the body block: a header without an
/// intervening body (invalid JS) keeps the old enclosing behavior.
/// Parked names carry their header position so the declaration
/// sites themselves stay excused without leaking into the
/// enclosing scope.
fn defer_header_params(
    deferred: &mut Vec<(Vec<u16>, usize)>,
    pending: &mut Vec<Vec<u16>>,
    names: Vec<Vec<u16>>,
    header: usize,
) {
    if !deferred.is_empty() {
        pending.extend(deferred.drain(..).map(|(name, _)| name));
    }
    deferred.extend(names.into_iter().map(|name| (name, header)));
}

/// Header-span cover for one body frame: the declaration site (at
/// the header) excuses without extending the body's scope outward.
fn cover_start(
    covers: &mut Vec<(Vec<u16>, usize, usize)>,
    name: &[u16],
    frame_start: usize,
) -> usize {
    covers
        .iter()
        .position(|(covered, _, frame)| covered == name && *frame == frame_start)
        .map(|index| covers.remove(index).1)
        .unwrap_or(frame_start)
}

/// Dispatch one keyword at a word start; returns the resume position.
/// `function` names bind in the enclosing scope, but `function`/`catch`
/// params scope to the upcoming body block, so they park in `deferred`
/// until the next `{` seeds its frame (020: enclosing-block leak).
fn dispatch_decl_keyword(
    units: &[u16],
    at: usize,
    end: usize,
    pending: &mut Vec<Vec<u16>>,
    deferred: &mut Vec<(Vec<u16>, usize)>,
) -> usize {
    let word = &units[at..end];
    if units_eq_slice(word, "var") || units_eq_slice(word, "let") || units_eq_slice(word, "const") {
        return parse_var_decls(units, end, pending);
    }
    if units_eq_slice(word, "function") {
        let mut i = scan_spaces(units, end);
        while i < units.len() && units[i] == 0x2A {
            i = scan_spaces(units, i + 1);
        }
        if let Some((_, name_end)) = read_word(units, i) {
            if is_gate_name(&units[i..name_end]) {
                pending.push(units[i..name_end].to_vec());
            }
            i = name_end;
        }
        i = scan_spaces(units, i);
        if i < units.len() && units[i] == 0x28 {
            let mut names = Vec::new();
            let resume = parse_paren_params(units, i + 1, &mut names);
            defer_header_params(deferred, pending, names, at);
            return resume;
        }
        return i;
    }
    if units_eq_slice(word, "class") {
        let i = scan_spaces(units, end);
        if let Some((_, name_end)) = read_word(units, i) {
            if is_gate_name(&units[i..name_end]) {
                pending.push(units[i..name_end].to_vec());
            }
            return name_end;
        }
        return i;
    }
    if units_eq_slice(word, "catch") {
        let i = scan_spaces(units, end);
        if i < units.len() && units[i] == 0x28 {
            let mut names = Vec::new();
            let resume = parse_paren_params(units, i + 1, &mut names);
            defer_header_params(deferred, pending, names, at);
            return resume;
        }
        return i;
    }
    end
}

/// Collect lexically declared gate bindings with block spans over the
/// blanked source. Returns None on unbalanced braces (e.g. inside
/// regex literals the blanker keeps): the caller then applies no
/// excuses and the gate keeps its current fail-closed behavior.
/// Destructuring, arrow params, methods and imports stay unhandled
/// (still flag, as today).
fn collect_gate_decls(units: &[u16]) -> Option<Vec<GateDecl>> {
    let mut out = Vec::new();
    let mut stack: Vec<(usize, Vec<Vec<u16>>)> = vec![(0, Vec::new())];
    // Header params parked for the upcoming body block (020), plus
    // their header-span covers (name, header pos, body frame start).
    let mut deferred: Vec<(Vec<u16>, usize)> = Vec::new();
    let mut covers: Vec<(Vec<u16>, usize, usize)> = Vec::new();
    let mut at = 0;
    while at < units.len() {
        let c = units[at];
        if c == 0x7B {
            let seeds: Vec<Vec<u16>> = deferred
                .drain(..)
                .map(|(name, header)| {
                    covers.push((name.clone(), header, at));
                    name
                })
                .collect();
            stack.push((at, seeds));
            at += 1;
        } else if c == 0x7D {
            let (start, names) = stack.pop()?;
            for name in names {
                let decl_start = cover_start(&mut covers, &name, start);
                out.push(GateDecl { name, start: decl_start, end: at });
            }
            at += 1;
        } else if let Some((_, end)) = read_word(units, at) {
            // Disjoint borrows: the top frame and the parked params.
            let pending = &mut stack.last_mut()?.1;
            at = dispatch_decl_keyword(units, at, end, pending, &mut deferred);
        } else {
            at += 1;
        }
    }
    if stack.len() != 1 {
        return None;
    }
    let (start, names) = stack.pop()?;
    for name in names {
        let decl_start = cover_start(&mut covers, &name, start);
        out.push(GateDecl { name, start: decl_start, end: units.len() });
    }
    Some(out)
}

/// True when a gate-name use at `pos` sits inside a block that
/// declares it.
fn gate_declared(decls: &[GateDecl], name: &[u16], pos: usize) -> bool {
    decls.iter().any(|d| d.name == name && d.start <= pos && pos < d.end)
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
    // Lexically declared `require`/`module`/`exports` are module-local
    // bindings, not CommonJS free references (oracle scope rule). No
    // excuses on unbalanced braces: the gate keeps failing closed.
    let decls = collect_gate_decls(&stripped);
    let excused = |name: &[u16], pos: usize| -> bool {
        decls.as_ref().is_some_and(|ds| gate_declared(ds, name, pos))
    };
    let mut at = 0;
    while at < stripped.len() {
        match match_bare_require(&stripped, at) {
            Some(end) => {
                if !is_stdlib_require_guard(&stripped, at) && !excused(&stripped[at..at + 7], at) {
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
                if !excused(&stripped[at..at + 6], at) {
                    issues.push(format!("CommonJS module.exports at offset {at}"));
                }
                at = end;
            }
            None => at += 1,
        }
    }
    let mut at = 0;
    while at < stripped.len() {
        match match_free_exports(&stripped, at) {
            Some(end) => {
                if !excused(&stripped[at..at + 7], at) {
                    issues.push(format!("CommonJS free exports at offset {at}"));
                }
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
// Host-frontend facts gate (025). The host's single frontend
// (`scanModuleFacts` over Acorn 2025 scope analysis) observes syntax;
// Rust validates shape, unit-coordinate bounds and per-module
// correspondence against the exact bundle strings, then applies
// stage/module key/graph/link and diagnostic policy itself. The
// lexical recognizer above stays as tested library only: CLI
// admission never consults it.
// ---------------------------------------------------------------------------

/// One owner import record: spans address the exact module UTF-16
/// units. `raw` is the exact literal slice (escapes keep raw
/// distinct from decoded); `specifier` is the owner-decoded value
/// trusted at the decoder boundary, absent for
/// computed-dynamic/import-meta records (observed, never certified
/// as resolved edges).
#[derive(Clone)]
pub struct ImportFact {
    pub group_rank: u32,
    pub statement: (usize, usize),
    pub argument: (usize, usize),
    pub content: Option<(usize, usize)>,
    pub raw: Option<Vec<u16>>,
    pub specifier: Option<Vec<u16>>,
}

/// One owner scope fact: original UTF-16 coordinates plus the
/// Acorn-decoded name (binds escaped spellings without a second
/// token parser).
#[derive(Clone)]
pub struct UnresolvedFact {
    pub group: u8,
    pub start: usize,
    pub end: usize,
    pub name: Vec<u16>,
}

/// Owner syntax facts for one module: import-lexer records, Acorn
/// scope facts and parser-error observations from the single host
/// frontend. `frontend_error` carries an exact non-offset owner
/// message opaquely (never parsed).
#[derive(Clone)]
pub struct ModuleFacts {
    pub imports: Vec<ImportFact>,
    pub lexer_error: Option<usize>,
    pub frontend_error: Option<Vec<u16>>,
    pub syntax_error: Option<usize>,
    pub file_url: Vec<usize>,
    pub unresolved: Vec<UnresolvedFact>,
}

/// Exact non-negative integer offset from a Num node.
fn as_offset(node: &Node) -> Option<usize> {
    let (bits, _) = as_num(node)?;
    let value = f64::from_bits(bits);
    if value < 0.0 || value.fract() != 0.0 || value > usize::MAX as f64 {
        return None;
    }
    Some(value as usize)
}

/// Text-or-null member: absent specifiers and absent errors ride null.
fn as_text_or_null(node: &Node) -> Option<Option<Vec<u16>>> {
    match node {
        Node::Null => Some(None),
        Node::Text(units) => Some(Some(units.clone())),
        _ => None,
    }
}

/// Offset-or-null member: absent parser errors ride null.
fn as_offset_or_null(node: &Node) -> Option<Option<usize>> {
    match node {
        Node::Null => Some(None),
        _ => Some(Some(as_offset(node)?)),
    }
}

fn decode_import(node: &Node) -> Option<ImportFact> {
    let rank = as_offset(obj_get(node, "groupRank")?)?;
    if rank > 3 {
        return None;
    }
    let span = |start_key: &str, end_key: &str| {
        Some((as_offset(obj_get(node, start_key)?)?, as_offset(obj_get(node, end_key)?)?))
    };
    let content = {
        let start = obj_get(node, "contentStart")?;
        let end = obj_get(node, "contentEnd")?;
        let neg = |item: &Node| matches!(as_num(item), Some((bits, _)) if f64::from_bits(bits) == -1.0);
        if neg(start) && neg(end) {
            None
        } else {
            Some((as_offset(start)?, as_offset(end)?))
        }
    };
    Some(ImportFact {
        group_rank: rank as u32,
        statement: span("statementStart", "statementEnd")?,
        argument: span("argumentStart", "argumentEnd")?,
        content,
        raw: as_text_or_null(obj_get(node, "raw")?)?,
        specifier: as_text_or_null(obj_get(node, "specifier")?)?,
    })
}

fn decode_unresolved(node: &Node) -> Option<UnresolvedFact> {
    let group = as_offset(obj_get(node, "group")?)?;
    if group > 2 {
        return None;
    }
    Some(UnresolvedFact {
        group: group as u8,
        start: as_offset(obj_get(node, "start")?)?,
        end: as_offset(obj_get(node, "end")?)?,
        name: as_text(obj_get(node, "name")?)?.clone(),
    })
}

/// Typed `facts` member: shape failures are transport (BAD_NODE at
/// the call site), never bundle diagnostics.
pub fn decode_module_facts(node: &Node) -> Result<ModuleFacts, String> {
    let malformed = "LOAD_MODULES resume: modules[*].facts is malformed".to_string();
    let imports = as_arr(obj_get(node, "imports").ok_or_else(|| malformed.clone())?)
        .ok_or_else(|| malformed.clone())?
        .iter()
        .map(decode_import)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| malformed.clone())?;
    let lexer_error = as_offset_or_null(obj_get(node, "lexerError").ok_or_else(|| malformed.clone())?)
        .ok_or_else(|| malformed.clone())?;
    let frontend_error = as_text_or_null(obj_get(node, "frontendError").ok_or_else(|| malformed.clone())?)
        .ok_or_else(|| malformed.clone())?;
    let syntax_error = as_offset_or_null(obj_get(node, "syntaxError").ok_or_else(|| malformed.clone())?)
        .ok_or_else(|| malformed.clone())?;
    let file_url = as_arr(obj_get(node, "fileUrl").ok_or_else(|| malformed.clone())?)
        .ok_or_else(|| malformed.clone())?
        .iter()
        .map(as_offset)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| malformed.clone())?;
    let unresolved = as_arr(obj_get(node, "unresolved").ok_or_else(|| malformed.clone())?)
        .ok_or_else(|| malformed.clone())?
        .iter()
        .map(decode_unresolved)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| malformed.clone())?;
    Ok(ModuleFacts { imports, lexer_error, frontend_error, syntax_error, file_url, unresolved })
}

fn starts_with_ascii(units: &[u16], prefix: &str) -> bool {
    units.len() >= prefix.len() && units.iter().zip(prefix.bytes()).all(|(u, b)| *u == b as u16)
}

fn import_spans_ok(js: &[u16], import: &ImportFact) -> bool {
    let (ss, se) = import.statement;
    let (as_, ae) = import.argument;
    if ss > se || se > js.len() || as_ > ae || ae > js.len() || as_ < ss || ae > se {
        return false;
    }
    // Raw literal bytes must match exactly (028: decoded specifiers
    // may differ through escapes, so Rust never re-decodes); raw and
    // decoded ride together or are both absent.
    match (&import.raw, &import.specifier, import.content) {
        (None, None, None) => true,
        (Some(raw), Some(_), Some((cs, ce))) => {
            cs <= ce && ce <= js.len() && cs >= as_ && ce <= ae && js[cs..ce] == raw[..]
        }
        _ => false,
    }
}

fn imports_ordered(imports: &[ImportFact]) -> bool {
    let mut last = (0u32, 0usize, 0usize);
    let mut first = true;
    for import in imports {
        let key = (import.group_rank, import.statement.0, import.argument.0);
        if !first && key < last {
            return false;
        }
        first = false;
        last = key;
    }
    true
}

fn file_url_ok(facts: &ModuleFacts) -> bool {
    facts.file_url.iter().all(|offset| {
        facts.imports.iter().any(|import| {
            import.statement.0 == *offset
                && import.specifier.as_ref().is_some_and(|s| starts_with_ascii(s, "file://"))
        })
    })
}

/// Identifier-shaped span (028/029: the minimal binder for an
/// owner scope fact — word units, `$`, escape introducers, or the
/// braces of `\u{…}` escapes; the decoded name carries identity, so
/// Rust never re-parses escapes. At least one word/`$` unit keeps
/// brace-only spans out.
fn span_is_ident_like(span: &[u16]) -> bool {
    !span.is_empty()
        && span.iter().all(|u| is_word_unit(*u) || *u == 0x24 || *u == 0x5C || *u == 0x7B || *u == 0x7D)
        && span.iter().any(|u| is_word_unit(*u) || *u == 0x24)
}

const GROUP_TOKENS: [&str; 3] = ["require", "module", "exports"];

/// Scope-fact correspondence: the span binds identifier-shaped
/// source at owner coordinates, and the decoded name is the group's
/// token — checked byte-exactly for plain spellings, trusted from
/// the owner decoder for escaped ones (028).
fn unresolved_ok(facts: &ModuleFacts, js: &[u16]) -> bool {
    let mut last: Option<(u8, usize)> = None;
    for fact in &facts.unresolved {
        if fact.group > 2 || fact.start >= fact.end || fact.end > js.len() {
            return false;
        }
        let span = &js[fact.start..fact.end];
        if !span_is_ident_like(span) {
            return false;
        }
        if fact.name.len() != GROUP_TOKENS[fact.group as usize].len()
            || !fact.name.iter().zip(GROUP_TOKENS[fact.group as usize].bytes()).all(|(u, b)| *u == b as u16)
        {
            return false;
        }
        if !span.contains(&0x5C) && span != &fact.name[..] {
            return false;
        }
        if last.is_some_and(|prev| (fact.group, fact.start) < prev) {
            return false;
        }
        last = Some((fact.group, fact.start));
    }
    true
}

fn errors_shape_ok(facts: &ModuleFacts) -> bool {
    // Frontend errors precede parsing: nothing else rides along. A
    // syntax error rides with imports/file-URL observations (the
    // owner collects those first) but never scope facts.
    if facts.lexer_error.is_some() || facts.frontend_error.is_some() {
        if facts.lexer_error.is_some() && facts.frontend_error.is_some() {
            return false;
        }
        if facts.syntax_error.is_some() {
            return false;
        }
        return facts.imports.is_empty() && facts.file_url.is_empty() && facts.unresolved.is_empty();
    }
    if facts.syntax_error.is_some() && !facts.unresolved.is_empty() {
        return false;
    }
    true
}

/// Shape, bound and correspondence validation against the exact
/// module bytes. Failures are host-transport defects (BAD_NODE at
/// the call site), never bundle diagnostics.
pub fn validate_module_facts(key: &[u16], js: &[u16], facts: &ModuleFacts) -> Result<(), String> {
    let bad = |detail: &str| format!("LOAD_MODULES resume: module {} has malformed facts ({detail})", json_quote(key));
    if !imports_ordered(&facts.imports) || !facts.imports.iter().all(|i| import_spans_ok(js, i)) {
        return Err(bad("imports"));
    }
    if !file_url_ok(facts) {
        return Err(bad("fileUrl"));
    }
    if !unresolved_ok(facts, js) {
        return Err(bad("unresolved"));
    }
    if !errors_shape_ok(facts) {
        return Err(bad("errors"));
    }
    // Parser-error offsets are diagnostic only (never indexed): the
    // owner emits past-end positions, so exact non-negative integer
    // decoding is the whole check. Spans above stay strictly bounded
    // because they bind checked source bytes.
    Ok(())
}

/// Sorted per-group gate offsets: file-URL issues keep record order
/// first, then require/module/exports groups in UTF-16 order (the
/// owner diagnostic order).
fn loadability_issues(facts: &ModuleFacts) -> Vec<String> {
    const LABELS: [&str; 3] = ["bare require( call", "CommonJS module.exports", "CommonJS free exports"];
    let mut out: Vec<String> = facts.file_url.iter().map(|o| format!("node file-URL import at offset {o}")).collect();
    for group in 0..3u8 {
        let mut starts: Vec<usize> =
            facts.unresolved.iter().filter(|f| f.group == group).map(|f| f.start).collect();
        starts.sort_unstable();
        for start in starts {
            out.push(format!("{} at offset {start}", LABELS[group as usize]));
        }
    }
    out
}

fn deploy_module_error(key: &[u16], detail: String) -> ModulesError {
    ModulesError { message: format!("deploy bundle: module {} {detail}", json_quote(key)) }
}

/// Deploy LOAD_MODULES policy over validated owner facts: frontend
/// errors first (opaque owner message, then lexer offset, then
/// syntax offset), then the loadability groups, then link resolution
/// across the staged key closure (text modules plus staged binary
/// asset keys; executables stay excluded). Build never calls this
/// (its admitted domain has no module gate).
pub fn check_deploy_modules(
    modules: &[(Vec<u16>, Vec<u16>, ModuleFacts)],
    binary_keys: &[Vec<u16>],
) -> Result<usize, ModulesError> {
    // Phase 1: parser + loadability policy per module, in stage order.
    for (key, _, facts) in modules {
        if let Some(message) = &facts.frontend_error {
            let detail = String::from_utf16(message).map_err(|_| ModulesError {
                message: format!(
                    "LOAD_MODULES resume: module {} serves non-text frontend facts",
                    json_quote(key)
                ),
            })?;
            return Err(ModulesError { message: detail });
        }
        if let Some(offset) = facts.lexer_error {
            return Err(deploy_module_error(key, format!("has invalid import syntax at offset {offset}")));
        }
        if let Some(offset) = facts.syntax_error {
            return Err(deploy_module_error(key, format!("has invalid JavaScript syntax at offset {offset}")));
        }
        let issues = loadability_issues(facts);
        if !issues.is_empty() {
            let extra = if issues.len() > 1 { format!(" (+{} more)", issues.len() - 1) } else { String::new() };
            return Err(deploy_module_error(
                key,
                format!("is not workerd-loadable: {}{extra}", issues[0]),
            ));
        }
    }
    // Phase 2: link resolution over the staged key closure.
    let mut keys: HashSet<Vec<u16>> = modules.iter().map(|(k, _, _)| k.clone()).collect();
    for binary in binary_keys {
        keys.insert(binary.clone());
    }
    for (key, _, facts) in modules {
        for import in &facts.imports {
            let Some(spec) = &import.specifier else { continue };
            if !is_relative_specifier(spec) {
                return Err(deploy_module_error(
                    key,
                    format!("has bare import {} (no package resolution in workerd)", json_quote(spec)),
                ));
            }
            let target = posix_normalize(&posix_join(&[&posix_dirname(key), spec]));
            if !keys.contains(&target) {
                return Err(deploy_module_error(
                    key,
                    format!(
                        "imports {} (resolves to {}): no such staged module",
                        json_quote(spec),
                        json_quote(&target)
                    ),
                ));
            }
        }
    }
    Ok(modules.len())
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
/// `source_maps` is the staged `Record<string, SourceMap>` node
/// (mirrors `portableAssembledModules`'s `sourceMaps` member, carried
/// alongside the text stages, never through them).
/// Empty input refuses (TS throws a version-dependent `TypeError`
/// there; the assembler always stages ≥1 module).
pub fn portable_assembled_modules(
    module_paths: &[&[u16]],
    source_maps: &Node,
) -> Result<Node, ModulesError> {
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
        (ascii_entry("sourceMaps"), source_maps.clone()),
    ]))
}

/// Render the P-B staged deployment (`worker/artifact.js`) source in full
/// (mirrors `renderStagedDeployment` byte-for-byte): the generated header
/// plus artifact/modules/verdict consts, the frozen-assembly guard
/// (`freezeAssemblyData` + `verifyInstalledAssembly`), the literal
/// `importInstalledModule` switch over the staged production modules, and
/// the `registerAssemblerModuleCapability` join. `assembly` is the full
/// `AssembledModules` node (carrying `moduleUrls`); `staged_paths` are the
/// staged production module paths in artifact order. Any disagreement
/// between the two refuses loudly instead of staging a skewed bundle.
pub fn render_staged_deployment(
    artifact: &Node,
    assembly: &Node,
    staged_paths: &[Vec<u16>],
    verdict: &Node,
) -> Result<String, ModulesError> {
    let artifact_json = crate::render::json_stringify(artifact);
    let assembly_json = crate::render::json_stringify(assembly);
    let verdict_json = crate::render::json_stringify(verdict);
    let urls: &Vec<(Vec<u16>, Node)> = match assembly {
        Node::Obj(entries) => match entries.iter().find(|(key, _)| units_eq_ascii(key, "moduleUrls")) {
            Some((_, Node::Obj(urls))) => urls,
            _ => return disagree(),
        },
        _ => return disagree(),
    };
    if urls.len() != staged_paths.len() {
        return disagree();
    }
    let artifact_key = ascii_entry(ARTIFACT_MODULE);
    let mut seen: HashSet<&Vec<u16>> = HashSet::new();
    let mut import_lines: Vec<String> = Vec::with_capacity(staged_paths.len());
    let mut entry_nodes: Vec<Node> = Vec::with_capacity(staged_paths.len());
    for path in staged_paths {
        if !seen.insert(path) {
            return disagree();
        }
        let url = match urls.iter().find(|(key, _)| key == path) {
            Some((_, Node::Text(url))) if !url.is_empty() => url,
            _ => return disagree(),
        };
        import_lines.push(format!(
            "    case {}: return import({});",
            json_quote(path),
            json_quote(&relative_specifier(&artifact_key, path))
        ));
        entry_nodes.push(Node::Obj(vec![
            (ascii_entry("path"), Node::Text(path.clone())),
            (ascii_entry("url"), Node::Text(url.clone())),
        ]));
    }
    let entries_json = crate::render::json_stringify(&Node::Arr(entry_nodes));
    let mut out = String::new();
    out.push_str("// Generated by can-platform deploy (P-B staged deployment). Do not edit.\n");
    out.push_str("import { registerAssemblerModuleCapability } from \"../runtime/assembly-verification.js\";\n");
    out.push_str(&format!("export const artifact = {artifact_json};\n"));
    out.push_str(&format!("export const modules = {assembly_json};\n"));
    out.push_str(&format!("export const verdict = {verdict_json};\n"));
    out.push_str(&format!(
        "const assembledArtifactJson = {};\n",
        json_quote(&artifact_json.encode_utf16().collect::<Vec<_>>())
    ));
    out.push_str(&format!(
        "const assembledMetadataJson = {};\n",
        json_quote(&assembly_json.encode_utf16().collect::<Vec<_>>())
    ));
    out.push_str("function freezeAssemblyData(value) {\n");
    out.push_str("  if (value === null || typeof value !== \"object\") return value;\n");
    out.push_str("  const prototype = Object.getPrototypeOf(value);\n");
    out.push_str("  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error(\"portable assembly: invalid metadata prototype\");\n");
    out.push_str("  for (const key of Reflect.ownKeys(value)) {\n");
    out.push_str("    const member = Object.getOwnPropertyDescriptor(value, key);\n");
    out.push_str("    if (typeof key !== \"string\" || !Object.hasOwn(member, \"value\")) throw new Error(\"portable assembly: metadata must be own data\");\n");
    out.push_str("    freezeAssemblyData(member.value);\n");
    out.push_str("  }\n");
    out.push_str("  return Object.freeze(value);\n");
    out.push_str("}\n");
    out.push_str("freezeAssemblyData(artifact);\n");
    out.push_str("freezeAssemblyData(modules);\n");
    out.push_str("async function verifyInstalledAssembly() {\n");
    out.push_str("  if (!Object.isFrozen(artifact) || !Object.isFrozen(modules) || !Object.isFrozen(modules.moduleUrls) || JSON.stringify(artifact) !== assembledArtifactJson || JSON.stringify(modules) !== assembledMetadataJson) throw new Error(\"portable assembly: installed artifact or module graph changed\");\n");
    out.push_str("}\n");
    out.push_str("async function importInstalledModule(path) {\n");
    out.push_str("  switch (path) {\n");
    out.push_str(&import_lines.join("\n"));
    out.push('\n');
    out.push_str("    default: throw new Error(\"portable assembly: unknown production module\");\n");
    out.push_str("  }\n");
    out.push_str("}\n");
    out.push_str(&format!("registerAssemblerModuleCapability(modules, assembledArtifactJson, {entries_json}, verifyInstalledAssembly, importInstalledModule);\n"));
    Ok(out)
}

fn disagree<T>() -> Result<T, ModulesError> {
    Err(ModulesError {
        message: "deploy bundle: portable assembly disagrees with staged production modules"
            .to_string(),
    })
}

// ---------------------------------------------------------------------------
// Artifact staging ownership, inline maps, map status.
// ---------------------------------------------------------------------------

/// Output-tree roots owned by the platform (mirror `platformDirectories`
/// in `stageArtifactModules`): artifact modules may not stage under them.
const PLATFORM_DIRECTORIES: [&str; 3] = ["worker", "runtime", "vendor"];
/// Writer-owned manifest roots (mirror `RESERVED_MIXED_OUTPUTS` plus
/// `bundle.resources.json`): artifact modules may not claim them.
const WRITER_MANIFEST_ROOTS: [&str; 3] = [
    "bundle.json",
    "bundle.mixed.json",
    "bundle.resources.json",
];

/// Staging ownership for one authored artifact module list, in order
/// (mirrors the ownership loop in `stageArtifactModules`): safe relative
/// paths, no platform-directory or writer-manifest roots, no normalized
/// aliases. Domain is the original authored inventory at its staging
/// checkpoint, before host producer effects — never the merged final
/// platform/package map served at LOAD_MODULES, which legitimately
/// carries worker/runtime/vendor keys. Graph membership (page/callable
/// refs) is checked separately below; this covers output-tree ownership
/// before any byte is staged.
pub fn check_artifact_module_ownership(paths: &[&[u16]]) -> Result<(), ModulesError> {
    let mut seen: HashMap<Vec<u16>, Vec<u16>> = HashMap::new();
    for path in paths {
        assert_safe_relative_path(path, "to stage module")?;
        let normalized = posix_normalize(path);
        let root: Vec<u16> = normalized
            .iter()
            .cloned()
            .take_while(|unit| *unit != 0x2F)
            .collect();
        if PLATFORM_DIRECTORIES
            .iter()
            .any(|dir| units_eq_ascii(&root, dir))
        {
            return Err(ModulesError {
                message: format!(
                    "deploy bundle: artifact module {} reserves platform directory {}",
                    json_quote(path),
                    json_quote(&root)
                ),
            });
        }
        if WRITER_MANIFEST_ROOTS
            .iter()
            .any(|name| units_eq_ascii(&root, name))
        {
            return Err(ModulesError {
                message: format!(
                    "deploy bundle: artifact module {} reserves writer manifest path {}",
                    json_quote(path),
                    json_quote(&root)
                ),
            });
        }
        if let Some(prior) = seen.get(&normalized) {
            return Err(ModulesError {
                message: format!(
                    "deploy bundle: artifact module {} aliases {} after normalization",
                    json_quote(path),
                    json_quote(prior)
                ),
            });
        }
        seen.insert(normalized, path.to_vec());
    }
    Ok(())
}

/// Empty-artifact refusal (mirrors `stageArtifactModules`):
/// `modules[0]` must be the entrypoint.
pub fn check_artifact_not_empty(module_count: usize) -> Result<(), ModulesError> {
    if module_count == 0 {
        return Err(ModulesError {
            message:
                "deploy bundle: artifact has no modules; modules[0] must be the entrypoint"
                    .to_string(),
        });
    }
    Ok(())
}

/// Page/callable module-membership check (mirrors `stageArtifactModules`):
/// `label` is `page` or `callable`, `id` its path/id, `module` the
/// referenced module, `known` the staged module-path set.
pub fn check_staged_module_ref(
    label: &str,
    id: &[u16],
    module: &[u16],
    known: &HashSet<Vec<u16>>,
) -> Result<(), ModulesError> {
    if !known.contains(module) {
        return Err(ModulesError {
            message: format!(
                "deploy bundle: {label} {} references unknown module {} (recompile with the fixed `can compile`)",
                render_text(id),
                json_quote(module)
            ),
        });
    }
    Ok(())
}

/// Standard base64 (mirrors `Buffer.toString("base64")` for the inline
/// source-map suffix): UTF-8 bytes in, padded base64 out.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len() / 3 * 4 + 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Inline source-map suffix for one staged module (mirrors
/// `stageArtifactModules`): empty when the module has no composed map,
/// otherwise the base64 data-URL comment with leading/trailing newline.
pub fn inline_sourcemap_suffix(map_json: Option<&str>) -> String {
    match map_json {
        None => String::new(),
        Some(json) => format!(
            "\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,{}\n",
            base64_encode(json.as_bytes())
        ),
    }
}

/// Pure status core of `composeModuleMap` before the host `remapping()`
/// merge (mirrors `module-maps.ts`): with no import-edit stages the
/// original passes through (`absent`/`unchanged`); a missing original
/// stays missing even with stages. A present original WITH stages needs
/// the host merge (`None` here): the remapping library, VLQ codec and
/// bundler stay host-executed at their original positions while Rust
/// owns the deterministic validation around them.
pub fn module_map_fast_status(has_original: bool, stage_count: usize) -> Option<&'static str> {
    if stage_count == 0 {
        Some(if has_original { "unchanged" } else { "absent" })
    } else if !has_original {
        Some("absent")
    } else {
        None
    }
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
