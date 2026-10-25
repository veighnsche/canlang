//! CST-based folding and selection, including incomplete authoring buffers.

use crate::ide::queries::{Snapshot, offset_at_position};
use crate::source::LineIndex;
use crate::syntax::{SyntaxKind, SyntaxNode};
use lsp_types::{FoldingRange, Position, Range, SelectionRange};

/// Line folds for meaningful multiline declarations and blocks. Trailing
/// whitespace is excluded so a following header or blank line stays visible.
pub fn folding_ranges(snapshot: &Snapshot<'_>) -> Vec<FoldingRange> {
    let text = snapshot.text();
    let index = LineIndex::new(text);
    let mut ranges: Vec<_> = snapshot
        .tree()
        .descendants()
        .filter(|node| foldable(node.kind))
        .filter_map(|node| {
            let raw = node.text(text);
            let content = raw.trim();
            let start = node.span.start + (raw.len() - raw.trim_start().len()) as u32;
            let last = content.char_indices().next_back()?.0 as u32 + start;
            let (start_line, _) = index.to_lsp(text, start, true);
            let (end_line, _) = index.to_lsp(text, last, true);
            (end_line > start_line).then_some(FoldingRange {
                start_line,
                end_line,
                start_character: None,
                end_character: None,
                kind: None,
                collapsed_text: None,
            })
        })
        .collect();
    ranges.sort_by_key(|range| (range.start_line, std::cmp::Reverse(range.end_line)));
    ranges.dedup_by_key(|range| (range.start_line, range.end_line));
    ranges
}

fn foldable(kind: SyntaxKind) -> bool {
    use SyntaxKind::*;
    matches!(
        kind,
        Section
            | Context
            | ContextDecl
            | Import
            | Migration
            | Preferences
            | Model
            | Contract
            | Event
            | Role
            | Derive
            | Policy
            | Invariant
            | Unique
            | Lock
            | Retain
            | Fixture
            | Corpus
            | Capability
            | CapabilityOp
            | Judgment
            | JudgmentItem
            | JudgmentOption
            | Message
            | Label
            | CrudLabels
            | OrderCases
            | OrderCase
            | Crud
            | Scenario
            | DoBlock
            | If
            | For
            | Match
            | MatchArm
            | Examples
            | View
            | Show
            | Page
            | Card
            | Details
            | Tabs
            | Tab
            | Collection
            | Form
            | Edit
            | CatalogItem
            | Slot
            | PreferencePanel
            | Backfill
    )
}

/// One strictly expanding CST selection chain per requested position. Token
/// boundaries and all emitted ranges use UTF-16. Trivia leaves are skipped;
/// their enclosing block remains selectable. Invalid source coordinates clamp
/// to the nearest valid position, like the other IDE position queries.
pub fn selection_ranges(snapshot: &Snapshot<'_>, positions: &[Position]) -> Vec<SelectionRange> {
    let text = snapshot.text();
    let index = LineIndex::new(text);
    positions
        .iter()
        .map(|position| {
            let offset = offset_at_position(text, position.line, position.character)
                .unwrap_or(text.len() as u32);
            let mut spans = Vec::new();
            let mut current = snapshot.tree();
            loop {
                if current.kind != SyntaxKind::Trivia {
                    let range = node_range(current, &index, text);
                    if spans.last() != Some(&range) && (spans.is_empty() || range.start < range.end)
                    {
                        spans.push(range);
                    }
                }
                let Some(child) = current.children.iter().find(|child| {
                    child.span.start <= offset
                        && (offset < child.span.end
                            || (offset == text.len() as u32 && offset == child.span.end))
                }) else {
                    break;
                };
                current = child;
            }
            // CST spans are nested. Wrapping from outside in yields the
            // smallest range first, with only strict containing parents.
            let mut parent = None;
            for range in spans {
                parent = Some(Box::new(SelectionRange { range, parent }));
            }
            *parent.expect("a file CST always supplies a selection range")
        })
        .collect()
}

fn node_range(node: &SyntaxNode, index: &LineIndex, text: &str) -> Range {
    let (line, character) = index.to_lsp(text, node.span.start, true);
    let start = Position { line, character };
    let (line, character) = index.to_lsp(text, node.span.end, true);
    Range {
        start,
        end: Position { line, character },
    }
}
