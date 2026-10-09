//! Source-qualified routing for a finite set of originating parser failures.
use super::{LogicalLine, Punct, SyntaxKind, SyntaxNode, TokenKind};
use crate::diagnostic::{ConstructCandidates, ConstructRankingContext, Diagnostic};

#[derive(Clone, Copy)]
pub(super) enum Branch {
    Root,
    When,
    ExportedWhen,
    FieldLabel,
}

impl Branch {
    fn slot(self) -> &'static str {
        match self {
            Self::Root => "root.declaration",
            Self::When => "when.declaration",
            Self::ExportedWhen => "when.exported-declaration",
            Self::FieldLabel => "field.label",
        }
    }
    fn ids(self) -> Vec<&'static str> {
        match self {
            Self::Root => vec![
                "can.v1.app.implicit",
                "can.v1.app.composed",
                "can.v1.package",
                "can.v1.maintenance.migration",
            ],
            Self::When => vec![
                "can.v1.when.crud",
                "can.v1.when.scenario.user",
                "can.v1.when.scenario.read",
                "can.v1.when.scenario.trusted",
                "can.v1.when.scenario.periodic",
                "can.v1.when.scenario.cohort",
            ],
            Self::ExportedWhen => Self::When
                .ids()
                .into_iter()
                .filter(|id| *id != "can.v1.when.crud")
                .collect(),
            Self::FieldLabel => vec!["can.v1.label.field"],
        }
    }
    pub(super) fn seed(self) -> ConstructCandidates {
        ConstructCandidates {
            version: 1,
            disposition: "unknown",
            slot: Some(self.slot()),
            ids: Vec::new(),
            complete: false,
            context: None,
        }
    }
    fn from_seed(seed: &ConstructCandidates) -> Option<Self> {
        [Self::Root, Self::When, Self::ExportedWhen, Self::FieldLabel]
            .into_iter()
            .find(|branch| seed.slot == Some(branch.slot()))
    }
    fn message_kind(self) -> &'static str {
        match self {
            Self::Root => "unknown_root_declaration",
            Self::When | Self::ExportedWhen => "unknown_when_declaration",
            Self::FieldLabel => "unsupported_field_label_slot",
        }
    }
}

fn lines<'a>(roots: &'a [LogicalLine], found: &mut Vec<&'a LogicalLine>) {
    for line in roots {
        found.push(line);
        lines(&line.children, found);
    }
}

/// Qualify seeds only after lexer, layout, recovery and the CST are available.
/// Unrelated ordinary parse errors do not erase a proven local inventory;
/// structural and lexical/layout errors conservatively do.
pub(super) fn qualify(
    text: &str,
    roots: &[LogicalLine],
    tree: &SyntaxNode,
    diagnostics: &mut [Diagnostic],
) {
    let mut logical = Vec::new();
    lines(roots, &mut logical);
    for index in 0..diagnostics.len() {
        let Some(branch) = diagnostics[index]
            .construct_candidates
            .as_deref()
            .and_then(Branch::from_seed)
        else {
            continue;
        };
        let primary = diagnostics[index].primary;
        let matches: Vec<_> = logical
            .iter()
            .copied()
            .filter(|line| line.tokens.iter().any(|token| token.span == primary))
            .collect();
        let mut context = None;
        if let [line] = matches.as_slice() {
            let token = line
                .tokens
                .iter()
                .find(|token| token.span == primary)
                .unwrap();
            let guess = token.text(text);
            let exact_source_span = token.kind == TokenKind::Name
                && !guess.is_empty()
                && guess.len() <= 64
                && guess.bytes().enumerate().all(|(i, byte)| {
                    byte.is_ascii_alphabetic() || byte == b'_' || (i > 0 && byte.is_ascii_digit())
                });
            let mut stack = Vec::new();
            let mut balanced = true;
            let mut semicolon = false;
            for token in &line.tokens {
                if let TokenKind::Punct(punct) = token.kind {
                    semicolon |= punct == Punct::Semicolon;
                    if punct.is_opener() {
                        stack.push(punct.matching_closer().unwrap());
                    }
                    if punct.is_closer() && stack.pop() != Some(punct) {
                        balanced = false;
                    }
                }
                balanced &= token.kind != TokenKind::Error;
            }
            balanced &= stack.is_empty();
            let sections: Vec<_> = tree
                .descendants()
                .filter(|node| {
                    node.kind == SyntaxKind::Section
                        && node.span.start <= primary.start
                        && node.span.end >= primary.end
                })
                .collect();
            let section =
                if matches!(branch, Branch::Root) && line.indent == 0 && sections.is_empty() {
                    Some("root")
                } else if let [section] = sections.as_slice() {
                    section
                        .children
                        .iter()
                        .filter_map(|node| node.token())
                        .find_map(|token| match token.text(text) {
                            "Given" => Some("Given"),
                            "When" => Some("When"),
                            "Then" => Some("Then"),
                            _ => None,
                        })
                } else {
                    None
                };
            let section_legal = match branch {
                Branch::Root => section == Some("root"),
                Branch::When | Branch::ExportedWhen => section == Some("When"),
                Branch::FieldLabel => section.is_some_and(|value| value != "root"),
            };
            let start = line.tokens.first().unwrap().span.start;
            let end = line.tokens.last().unwrap().span.end;
            let other_fault = diagnostics.iter().enumerate().any(|(other, diagnostic)| {
                other != index
                    && (diagnostic.code.starts_with("E10")
                        || diagnostic.code.starts_with("E11")
                        || diagnostic.code == "E1211"
                        || (diagnostic.primary.start <= end && diagnostic.primary.end >= start))
            });
            let recovery_complete =
                balanced && line.children.is_empty() && !semicolon && !other_fault && section_legal;
            if exact_source_span && recovery_complete {
                let ids = branch.ids();
                let name_filter_complete = !ids.is_empty()
                    && ids.len() <= 8
                    && ids
                        .iter()
                        .enumerate()
                        .all(|(index, id)| !ids[..index].contains(id));
                if name_filter_complete {
                    context = Some(ConstructRankingContext {
                        version: 1,
                        message_kind: branch.message_kind(),
                        section: section.unwrap(),
                        guess: guess.to_owned(),
                        exact_source_span,
                        structural_recovery: !recovery_complete,
                        recovery_complete,
                        name_filter_complete,
                        material_intent_choice: ids.len() > 1,
                        evidence_sufficient: false,
                        unsupported_behavior_proven: false,
                    });
                }
            }
        }
        let seed = diagnostics[index].construct_candidates.as_mut().unwrap();
        if context.is_some() {
            seed.disposition = "exact";
            seed.ids = branch.ids();
            seed.complete = true;
            seed.context = context;
        } else {
            seed.disposition = "structural";
        }
    }
}
