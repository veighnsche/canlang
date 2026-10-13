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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceDb;

    #[test]
    fn folds_sections_declarations_execution_and_ui_without_adjacent_lines() {
        let text = "app Tasks\r\nGiven\r\n Todo {\r\n  title:text }\r\n\r\nWhen\r\n scenario done(task:Todo) by=members\r\n  do\r\n   if true\r\n    require true\r\nThen\r\n page / title=\"Home\"\r\n  card \"Task\"\r\n   text \"Task title\"\r\n\r\n";
        let mut db = SourceDb::new();
        let id = db.add("structure.can".into(), text.into());
        let snapshot = Snapshot::analyze(&db, id, None);
        assert!(
            !snapshot.tree().has_errors(),
            "fixture must parse: {:?}",
            snapshot.diagnostics()
        );
        let folds: Vec<_> = folding_ranges(&snapshot)
            .into_iter()
            .map(|range| (range.start_line, range.end_line))
            .collect();
        assert_eq!(
            folds,
            [
                (1, 3),
                (2, 3),
                (5, 9),
                (6, 9),
                (7, 9),
                (8, 9),
                (10, 13),
                (11, 13),
                (12, 13)
            ]
        );
    }

    #[test]
    fn single_line_blocks_do_not_fold() {
        let mut db = SourceDb::new();
        let id = db.add(
            "flat.can".into(),
            "app Tasks\nGiven\n Todo {title:text}\nWhen\nThen\n".into(),
        );
        let snapshot = Snapshot::analyze(&db, id, None);
        let folds = folding_ranges(&snapshot);
        assert_eq!(folds.len(), 1);
        assert_eq!((folds[0].start_line, folds[0].end_line), (1, 2));
    }

    #[test]
    fn selections_expand_strictly_and_count_unicode_in_utf16() {
        let text = "app Tasks\r\nGiven\r\n message greet = \"😀 hello\"\r\nWhen\r\nThen\r\n";
        let mut db = SourceDb::new();
        let id = db.add("unicode.can".into(), text.into());
        let snapshot = Snapshot::analyze(&db, id, None);
        let positions = [
            Position::new(2, 21),
            Position::new(2, 0),
            Position::new(5, 0),
        ];
        let selections = selection_ranges(&snapshot, &positions);
        assert_eq!(selections.len(), positions.len());
        assert_eq!(
            selections[0].range,
            Range::new(Position::new(2, 17), Position::new(2, 27))
        );
        for (selection, position) in selections.iter().zip(positions) {
            let mut current = selection;
            assert!(current.range.start <= position && position <= current.range.end);
            while let Some(parent) = &current.parent {
                assert!(parent.range.start <= current.range.start);
                assert!(current.range.end <= parent.range.end);
                assert_ne!(parent.range, current.range);
                current = parent;
            }
            assert_eq!(
                current.range,
                Range::new(Position::new(0, 0), Position::new(5, 0))
            );
        }
    }

    #[test]
    fn malformed_and_empty_buffers_still_have_selection_chains() {
        for text in ["", "app Tasks\nGiven\n Todo {title:"] {
            let mut db = SourceDb::new();
            let id = db.add("incomplete.can".into(), text.into());
            let snapshot = Snapshot::analyze(&db, id, None);
            assert_eq!(selection_ranges(&snapshot, &[Position::new(0, 0)]).len(), 1);
            assert!(
                folding_ranges(&snapshot)
                    .iter()
                    .all(|r| r.start_line < r.end_line)
            );
        }
    }
}
