//! Lossless recoverable concrete syntax tree.
//!
//! Every source byte is covered by exactly one leaf ([`SyntaxKind::Trivia`]
//! for gaps, [`SyntaxKind::Comment`] for `##` lines, token leaves
//! otherwise), verified by [`SyntaxNode::verify_coverage`]. Internal nodes
//! carry the union span of their children. [`SyntaxKind::Error`] nodes hold
//! recovered invalid declarations so one bad declaration never cascades.
//!
//! Dependency-free by design (no rowan): the parser builds this tree
//! directly while flushing trivia in document order.

use crate::source::Span;
use crate::syntax::layout::DescriptionData;
use crate::syntax::lexer::{Token, TokenKind};

/// Concrete node kind. Leaf kinds hold source bytes; the rest are interior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SyntaxKind {
    // Leaves -------------------------------------------------------------
    /// Whitespace/newline gap between tokens (text sliced from source).
    Trivia,
    /// A `##` comment line.
    Comment,
    /// A lexer-level bad token (unexpected character, bad number tail).
    BadToken,
    Name,
    Integer,
    Decimal,
    Duration,
    Bytes,
    String,
    Punct,
    /// An attached `#` description set (all its line tokens + decoded data).
    Description,
    // File structure -----------------------------------------------------
    File,
    App,
    Package,
    Migration,
    Context,
    ContextDecl,
    Import,
    ImportMember,
    Section,
    // Given --------------------------------------------------------------
    Preferences,
    Model,
    Contract,
    Event,
    Role,
    Derive,
    Policy,
    Invariant,
    Unique,
    Lock,
    Retain,
    Fixture,
    Corpus,
    Capability,
    CapabilityOp,
    Judgment,
    JudgmentItem,
    JudgmentOption,
    Message,
    Field,
    Parameter,
    // Types and labels ---------------------------------------------------
    NamedType,
    UnionType,
    ArrayType,
    NullableType,
    EnumType,
    ActionType,
    DeliveryType,
    InvocationType,
    Label,
    LabelCase,
    CrudLabels,
    MessageValue,
    MessageVariant,
    // Attributes and selectors -------------------------------------------
    Attribute,
    Selectors,
    Descending,
    Path,
    // When: scenarios, CRUD, execution -----------------------------------
    Crud,
    Scenario,
    DoBlock,
    Let,
    Create,
    Set,
    Delete,
    Call,
    Emit,
    Send,
    Schedule,
    Cancel,
    Return,
    Require,
    If,
    For,
    // Examples -----------------------------------------------------------
    Examples,
    ExampleRow,
    ExampleAssert,
    ExampleCall,
    ExpectedError,
    // Presentation -------------------------------------------------------
    Page,
    Route,
    RouteStatic,
    RouteRecord,
    RouteScalar,
    Card,
    Details,
    Tabs,
    Tab,
    Collection,
    Form,
    Edit,
    CatalogItem,
    Slot,
    PreferencePanel,
    UiLeaf,
    PreferenceOrder,
    OrderList,
    OrderCases,
    OrderCase,
    // Expressions and values ---------------------------------------------
    Literal,
    NameRef,
    Group,
    Array,
    Object,
    ObjectEntry,
    Construct,
    Member,
    Argument,
    Unary,
    Binary,
    Query,
    QueryClause,
    // Migration directives -----------------------------------------------
    Rename,
    Drop,
    Invalidate,
    Backfill,
    // Recovery -----------------------------------------------------------
    Error,
}

impl SyntaxKind {
    /// Whether nodes of this kind are always leaves.
    pub fn is_leaf(self) -> bool {
        matches!(
            self,
            SyntaxKind::Trivia
                | SyntaxKind::Comment
                | SyntaxKind::BadToken
                | SyntaxKind::Name
                | SyntaxKind::Integer
                | SyntaxKind::Decimal
                | SyntaxKind::Duration
                | SyntaxKind::Bytes
                | SyntaxKind::String
                | SyntaxKind::Punct
                | SyntaxKind::Description
        )
    }
}

/// Leaf payload. Interior nodes use [`NodeDetail::Interior`].
#[derive(Debug, Clone)]
pub enum NodeDetail {
    Interior,
    /// A single source token.
    Token(Token),
    /// A whitespace/newline gap; text is the node's span sliced from source.
    Trivia,
    /// Description lines with their decoded set data.
    Description {
        tokens: Vec<Token>,
        data: DescriptionData,
    },
}

/// One concrete syntax node with its typed source span.
#[derive(Debug, Clone)]
pub struct SyntaxNode {
    pub kind: SyntaxKind,
    pub span: Span,
    pub detail: NodeDetail,
    pub children: Vec<SyntaxNode>,
}

impl SyntaxNode {
    /// Interior node; `span` must cover exactly the children's range.
    pub fn interior(kind: SyntaxKind, span: Span, children: Vec<SyntaxNode>) -> Self {
        debug_assert!(!kind.is_leaf(), "leaf kind needs a detail: {kind:?}");
        Self {
            kind,
            span,
            detail: NodeDetail::Interior,
            children,
        }
    }

    /// Interior node spanning its children (which must be nonempty).
    pub fn enclosing(kind: SyntaxKind, children: Vec<SyntaxNode>) -> Self {
        assert!(
            !children.is_empty(),
            "enclosing node needs children: {kind:?}"
        );
        let span = Span::new(
            children[0].span.file,
            children[0].span.start,
            children[children.len() - 1].span.end,
        );
        Self::interior(kind, span, children)
    }

    /// Token leaf with the kind matching the token.
    pub fn token_leaf(token: Token) -> Self {
        let kind = match token.kind {
            TokenKind::Name => SyntaxKind::Name,
            TokenKind::Integer => SyntaxKind::Integer,
            TokenKind::Decimal => SyntaxKind::Decimal,
            TokenKind::Duration => SyntaxKind::Duration,
            TokenKind::Bytes => SyntaxKind::Bytes,
            TokenKind::String => SyntaxKind::String,
            TokenKind::Punct(_) => SyntaxKind::Punct,
            TokenKind::Comment => SyntaxKind::Comment,
            TokenKind::Error => SyntaxKind::BadToken,
            TokenKind::Desc => panic!("Desc tokens belong in Description nodes"),
        };
        let span = token.span;
        Self {
            kind,
            span,
            detail: NodeDetail::Token(token),
            children: Vec::new(),
        }
    }

    /// Trivia leaf covering `span` (whitespace/newlines only by construction).
    pub fn trivia(span: Span) -> Self {
        Self {
            kind: SyntaxKind::Trivia,
            span,
            detail: NodeDetail::Trivia,
            children: Vec::new(),
        }
    }

    /// Description leaf covering all its line tokens.
    pub fn description(tokens: Vec<Token>, data: DescriptionData) -> Self {
        assert!(!tokens.is_empty(), "description needs its line tokens");
        let span = Span::new(
            tokens[0].span.file,
            tokens[0].span.start,
            tokens[tokens.len() - 1].span.end,
        );
        Self {
            kind: SyntaxKind::Description,
            span,
            detail: NodeDetail::Description { tokens, data },
            children: Vec::new(),
        }
    }

    /// Source text covered by this node.
    pub fn text<'a>(&self, source: &'a str) -> &'a str {
        &source[self.span.start as usize..self.span.end as usize]
    }

    /// Whether this node has no children.
    pub fn is_leaf(&self) -> bool {
        self.children.is_empty()
    }

    /// The token of a token leaf, if any.
    pub fn token(&self) -> Option<&Token> {
        match &self.detail {
            NodeDetail::Token(token) => Some(token),
            _ => None,
        }
    }

    /// Preorder traversal including self.
    pub fn descendants(&self) -> impl Iterator<Item = &SyntaxNode> {
        Descendants { stack: vec![self] }
    }

    /// Leaf nodes in document order.
    pub fn leaves(&self) -> impl Iterator<Item = &SyntaxNode> {
        self.descendants().filter(|node| node.is_leaf())
    }

    /// Whether the subtree contains an [`SyntaxKind::Error`] node.
    pub fn has_errors(&self) -> bool {
        self.descendants().any(|n| n.kind == SyntaxKind::Error)
    }

    /// Verify lossless coverage: leaves in order must partition `[0, len)`.
    pub fn verify_coverage(&self, len: u32) -> Result<(), CoverageError> {
        let mut cursor = 0u32;
        for leaf in self.leaves() {
            if leaf.span.start != cursor {
                return Err(CoverageError {
                    expected_start: cursor,
                    found: leaf.span,
                    kind: leaf.kind,
                });
            }
            if leaf.span.end < leaf.span.start {
                return Err(CoverageError {
                    expected_start: cursor,
                    found: leaf.span,
                    kind: leaf.kind,
                });
            }
            cursor = leaf.span.end;
        }
        if cursor != len {
            return Err(CoverageError {
                expected_start: len,
                found: Span::new(self.span.file, cursor, cursor),
                kind: SyntaxKind::File,
            });
        }
        Ok(())
    }

    /// Compact s-expression dump for golden tests and debugging.
    pub fn dump(&self, source: &str) -> String {
        let mut out = String::new();
        dump_into(&mut out, self, source, 0);
        out
    }
}

/// Lossless-coverage violation: expected a leaf at one offset, found another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverageError {
    pub expected_start: u32,
    pub found: Span,
    pub kind: SyntaxKind,
}

impl std::fmt::Display for CoverageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "coverage break at byte {}: found {:?} [{}, {})",
            self.expected_start, self.kind, self.found.start, self.found.end
        )
    }
}

impl std::error::Error for CoverageError {}

struct Descendants<'a> {
    stack: Vec<&'a SyntaxNode>,
}

impl<'a> Iterator for Descendants<'a> {
    type Item = &'a SyntaxNode;

    fn next(&mut self) -> Option<Self::Item> {
        let node = self.stack.pop()?;
        for child in node.children.iter().rev() {
            self.stack.push(child);
        }
        Some(node)
    }
}

fn dump_into(out: &mut String, node: &SyntaxNode, source: &str, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
    match &node.detail {
        NodeDetail::Interior => {
            out.push_str(&format!("{:?}", node.kind));
        }
        NodeDetail::Trivia => {
            out.push_str(&format!("Trivia {:?}", node.text(source)));
        }
        NodeDetail::Token(token) => {
            out.push_str(&format!("{:?} {:?}", node.kind, token.text(source)));
        }
        NodeDetail::Description { tokens, .. } => {
            let joined: Vec<&str> = tokens.iter().map(|t| t.text(source)).collect();
            out.push_str(&format!("Description {:?}", joined.join("\n")));
        }
    }
    out.push_str(&format!(" [{}..{}]\n", node.span.start, node.span.end));
    for child in &node.children {
        dump_into(out, child, source, depth + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceId;

    #[test]
    fn coverage_detects_gaps_and_overlaps() {
        let file = SourceId(0);
        let leaf = |start: u32, end: u32| SyntaxNode::trivia(Span::new(file, start, end));
        let good = SyntaxNode::enclosing(SyntaxKind::File, vec![leaf(0, 3), leaf(3, 5)]);
        assert!(good.verify_coverage(5).is_ok());
        let gapped = SyntaxNode::enclosing(SyntaxKind::File, vec![leaf(0, 3), leaf(4, 5)]);
        assert!(gapped.verify_coverage(5).is_err());
        let short = SyntaxNode::enclosing(SyntaxKind::File, vec![leaf(0, 3)]);
        assert!(short.verify_coverage(5).is_err());
    }

    #[test]
    fn traversal_visits_preorder() {
        let file = SourceId(0);
        let leaf = |start: u32, end: u32| SyntaxNode::trivia(Span::new(file, start, end));
        let tree = SyntaxNode::enclosing(
            SyntaxKind::File,
            vec![
                SyntaxNode::enclosing(SyntaxKind::App, vec![leaf(0, 1)]),
                leaf(1, 2),
            ],
        );
        let kinds: Vec<SyntaxKind> = tree.descendants().map(|n| n.kind).collect();
        assert_eq!(
            kinds,
            vec![
                SyntaxKind::File,
                SyntaxKind::App,
                SyntaxKind::Trivia,
                SyntaxKind::Trivia,
            ]
        );
        assert_eq!(tree.descendants().count(), 4);
    }
}
