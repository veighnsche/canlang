//! Ordered input transport arena (V03.2).
//!
//! The arena is built from HOST-PRODUCED frames, never by parsing text in
//! Rust: host `JSON.parse` outcomes arrive as f64 bits, UTF-16 code units
//! and explicit entries (key order plus duplicates, which a parsed object
//! cannot carry). Decisions follow `abi-decisions.md` D1–D8:
//!
//! - D1: f64 crosses as exact bits (`-0`, rounded huge ints, `Infinity`
//!   stay distinct); NaN bits are a corrupt frame, never a value.
//! - D2: text/keys cross as lossless UTF-16 units (lone surrogates kept;
//!   `__proto__` is data); duplicates preserved as entries arrays.
//! - D3: only `missing`/`own-null`/own-value arise from JSON; the
//!   `own-undefined`/`inherited`/`accessor` tags are unrepresentable in
//!   frames (statically impossible, pinned by test).
//! - D4–D6: default tags, sentinels and drops are MINTED with identity,
//!   never parsed; caller-shaped lookalikes stay data.
//! - D7: node/depth/text-units/entries counts are checked iteratively
//!   BEFORE any node is usable; breaches reject at stage `transport`
//!   with `length/*` codes. The text-units point covers entry keys as
//!   well as text values (N1). Only the id check (`MAX_ID_LENGTH =
//!   256` units) carries a pinned number; other budgets are explicit
//!   inputs.
//!
//! No `serde_json` touches the transport path: fixture loading may parse
//! JSON elsewhere, but arena construction and observation never
//! serialize, canonicalize, or re-render through it.

/// Pinned record-id bound in UTF-16 units (D7; mirrors `refs.ts`).
pub const MAX_ID_LENGTH_UNITS: usize = 256;

/// Explicit construction budgets (D7: numbers are caller inputs, not pins,
/// except the id check above).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budgets {
    pub max_nodes: usize,
    pub max_depth: usize,
    pub max_text_units: usize,
    pub max_entries: usize,
}

/// Transport-stage failure: `{ stage: "transport", code, check? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    pub code: &'static str,
    pub check: Option<&'static str>,
}

impl TransportError {
    fn length(code: &'static str, check: &'static str) -> Self {
        TransportError {
            code,
            check: Some(check),
        }
    }

    fn corrupt(code: &'static str) -> Self {
        TransportError { code, check: None }
    }

    /// Rejection stage: always `transport`, never a semantic result.
    pub fn stage(&self) -> &'static str {
        "transport"
    }
}

/// A host-produced input frame. Only JSON-admissible shapes exist here:
/// there is no variant for `own-undefined`, `inherited` or `accessor`
/// (D3 exclusion), no sentinel lookalike, and no text-as-`String`
/// (D2 forbids lossy conversion on the compat path).
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// Exact IEEE-754 bits from host number parsing. NaN bits are corrupt.
    F64Bits(u64),
    /// Lossless UTF-16 code units (lone surrogates kept as-is).
    TextUnits(Vec<u16>),
    Bool(bool),
    /// Explicit JSON `null`: an own-null position, never a hole.
    OwnNull,
    /// Ordered elements; JSON arrays have no holes or accessors.
    Array(Vec<Frame>),
    /// Ordered entries: `(key units, value)`. Preserves insertion order
    /// AND duplicates; `__proto__` keys are data.
    Entries(Vec<(Vec<u16>, Frame)>),
    /// Absent key. Only constructible explicitly, never from a value.
    Missing,
}

/// Minted presence/default/sentinel/drop tags (D3–D6). These are never
/// built from JSON frames; each constructor names its minting stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MintedTag {
    /// A fill the registry default applied; carries fill identity.
    DefaultApplied { registry: String, plan_rev: String },
    /// A position with no fill.
    DefaultAbsent,
    /// Profile-minted omission marker (cf. `UPDATE_OMITTED`).
    UpdateOmitted,
    /// A profile-dropped unknown position, carrying its dropped path
    /// as key-unit segments.
    DroppedUnknown { path: Vec<Vec<u16>> },
}

/// One arena node: the tag decision for one frame position.
#[derive(Debug, Clone, PartialEq)]
pub enum TransportNode {
    F64 { bits: u64 },
    Text { units: Vec<u16> },
    Bool(bool),
    OwnNull,
    Missing,
    Array { items: Vec<usize> },
    Entries { entries: Vec<Entry> },
    Tagged { tag: MintedTag, value: usize },
}

/// One ordered entry: key units plus value node. Duplicates kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: Vec<u16>,
    pub node: usize,
}

/// JSON-admissible tag names. The D3-excluded lineage tags
/// (`own-undefined`, `inherited`, `accessor`) are absent by
/// construction; this list pins that exclusion executably.
pub fn json_admissible_tags() -> &'static [&'static str] {
    &[
        "f64", "text", "bool", "own-null", "array", "entries", "missing",
    ]
}

/// The built arena: nodes plus the root. Only obtainable through the
/// checked iterative build, so every observable node passed every
/// length check before any profile stage could run.
#[derive(Debug, Clone, PartialEq)]
pub struct InputArena {
    nodes: Vec<TransportNode>,
    root: usize,
}

impl InputArena {
    /// Builds the arena from a host frame, checking node/depth/text/
    /// entries counts iteratively. On breach returns the transport
    /// error WITHOUT a partial arena (never coerce-then-check).
    pub fn build(frame: &Frame, budgets: &Budgets) -> Result<Self, TransportError> {
        // Pass 1 (validate): iterative pre-order walk. Every count is
        // checked before ANY node is materialized, and the node count
        // is enforced DURING the walk (D2: reject before traversal
        // completes, never after a full unbounded walk).
        let mut preorder: Vec<(&Frame, usize)> = vec![(frame, 0)];
        let mut order: Vec<(&Frame, usize)> = Vec::new();
        while let Some((current, depth)) = preorder.pop() {
            if depth > budgets.max_depth {
                // E-D1 ruling: KEEP-V1 length/bound-exceeded+depth.
                return Err(TransportError::length("length/bound-exceeded", "depth"));
            }
            order.push((current, depth));
            if order.len() > budgets.max_nodes {
                // E-D1 ruling: KEEP-V1 length/oversized+nodes.
                return Err(TransportError::length("length/oversized", "nodes"));
            }
            match current {
                Frame::Array(items) => {
                    for child in items.iter().rev() {
                        preorder.push((child, depth + 1));
                    }
                }
                Frame::Entries(entries) => {
                    if entries.len() > budgets.max_entries {
                        return Err(TransportError::length("length/entries", "entries"));
                    }
                    for (key, child) in entries.iter().rev() {
                        // N1: keys are text units too — the text budget
                        // covers entry keys, not just text values.
                        if key.len() > budgets.max_text_units {
                            return Err(TransportError::length("length/text", "text-units"));
                        }
                        preorder.push((child, depth + 1));
                    }
                }
                Frame::TextUnits(units) if units.len() > budgets.max_text_units => {
                    return Err(TransportError::length("length/text", "text-units"));
                }
                Frame::F64Bits(bits) if f64::from_bits(*bits).is_nan() => {
                    return Err(TransportError::corrupt("corrupt/nan-bits"));
                }
                _ => {}
            }
        }
        // Pass 2 (materialize): post-order via an explicit visited-flag
        // stack; finished child indices accumulate on `values`.
        let mut nodes: Vec<TransportNode> = Vec::with_capacity(order.len());
        let mut values: Vec<usize> = Vec::new();
        let mut work: Vec<(&Frame, bool)> = vec![(frame, false)];
        while let Some((current, visited)) = work.pop() {
            if !visited {
                work.push((current, true));
                match current {
                    Frame::Array(items) => {
                        for child in items.iter().rev() {
                            work.push((child, false));
                        }
                    }
                    Frame::Entries(entries) => {
                        for (_key, child) in entries.iter().rev() {
                            work.push((child, false));
                        }
                    }
                    _ => {}
                }
                continue;
            }
            let node = match current {
                Frame::F64Bits(bits) => TransportNode::F64 { bits: *bits },
                Frame::TextUnits(units) => TransportNode::Text {
                    units: units.clone(),
                },
                Frame::Bool(flag) => TransportNode::Bool(*flag),
                Frame::OwnNull => TransportNode::OwnNull,
                Frame::Missing => TransportNode::Missing,
                Frame::Array(items) => {
                    let start = values.len() - items.len();
                    let items: Vec<usize> = values.drain(start..).collect();
                    TransportNode::Array { items }
                }
                Frame::Entries(entries) => {
                    let start = values.len() - entries.len();
                    let children: Vec<usize> = values.drain(start..).collect();
                    let entries: Vec<Entry> = entries
                        .iter()
                        .zip(children)
                        .map(|((key, _), node)| Entry {
                            key: key.clone(),
                            node,
                        })
                        .collect();
                    TransportNode::Entries { entries }
                }
            };
            nodes.push(node);
            values.push(nodes.len() - 1);
        }
        debug_assert_eq!(values.len(), 1);
        let root = values.pop().unwrap_or(0);
        Ok(InputArena { nodes, root })
    }

    /// Root node index.
    pub fn root(&self) -> usize {
        self.root
    }

    /// Node count (checked against the budget at build).
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Arenas always hold at least the root; always false.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Reads one node. Indices come from the arena itself, so lookup
    /// cannot fail; out-of-range access panics like any bad index.
    pub fn node(&self, index: usize) -> &TransportNode {
        &self.nodes[index]
    }

    /// Mints a tag node over an existing value node (D4–D6). Minting is
    /// the ONLY way tag nodes arise: frames cannot express them.
    pub fn mint_tag(&mut self, tag: MintedTag, value: usize) -> usize {
        let _ = &self.nodes[value];
        self.nodes.push(TransportNode::Tagged { tag, value });
        self.nodes.len() - 1
    }

    /// Record-id length check with the pinned bound (D7).
    /// E-D1 ruling (SPLIT): v1 code `length/bound-exceeded` with the
    /// adopted `id-units` check — the pinned 256 contract bound stays
    /// distinct from caller text budgets.
    pub fn check_id_length(units: &[u16]) -> Result<(), TransportError> {
        if units.len() > MAX_ID_LENGTH_UNITS {
            return Err(TransportError::length("length/bound-exceeded", "id-units"));
        }
        Ok(())
    }
}
