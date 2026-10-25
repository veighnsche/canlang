//! Minimal v1 generation-unit discovery (BGI-01).
//!
//! Structural discovery over the lossless CST. It works before any saved
//! implementation exists: definitions are collected before applications are
//! resolved, so a missing `can.generated/...` group never hides a unit.
//! Descriptors are the BGI-02 handoff: owner/kind/label, prompt/profile,
//! source span, a formatting-insensitive anchor, and the declared target.
//! Style *uses* carry instance roots/hooks only — no generation identity.

use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{SyntaxKind, SyntaxNode, TokenKind};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GenerationKind {
    NamedTrait,
    InlineTrait,
    TraitApplication,
    KeywordDefinition,
    KeywordApplication,
    StyleDefinition,
    StyleInline,
    StyleNamedUse,
    ViewDefinition,
    ViewRootStyleInline,
    ViewRootStyleNamed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeywordParamDescriptor {
    pub name: String,
    /// `model`, `field`, `operation`, or the scalar/enum/array type text.
    pub kind: String,
    /// For `field(target,type)`: the target parameter name.
    pub target_param: Option<String>,
    /// For `field(target,type)`: the expected field type text.
    pub type_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeywordArgDescriptor {
    pub name: String,
    /// Normalized source text of the compile-time value.
    pub value: String,
    pub span: Span,
}

/// Exact local structure resolving an occurrence in an otherwise anonymous region.
/// The selector/container are portable JSON paths, never source offsets or IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalRegionCertificate {
    pub container: String,
    pub sha256: String,
    pub count: u32,
    pub occurrence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationDescriptor {
    pub owner: String,
    pub kind: GenerationKind,
    pub label: Option<String>,
    pub prompt: Option<String>,
    pub profile: Option<String>,
    pub span: Span,
    /// Normalized non-prompt anchor ignoring formatting/comments: a
    /// prompt-only edit preserves it for a uniquely matched unit.
    pub anchor: String,
    /// Complete semantic containment plus the defining prompt role.
    pub selector: Option<String>,
    /// Exact local evidence when a semantic path has anonymous duplicates.
    pub region: Option<LocalRegionCertificate>,
    pub target: Option<String>,
    pub has_generation_identity: bool,
    pub params: Vec<KeywordParamDescriptor>,
    pub args: Vec<KeywordArgDescriptor>,
    pub use_sites: Vec<Span>,
}

#[derive(Debug, Clone)]
pub struct GenerationDiscovery {
    pub descriptors: Vec<GenerationDescriptor>,
    pub diagnostics: Vec<Diagnostic>,
}

fn sig(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|c| !matches!(c.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect()
}

fn names(node: &SyntaxNode, text: &str) -> Vec<String> {
    sig(node)
        .iter()
        .filter(|c| c.kind == SyntaxKind::Name)
        .filter_map(|c| c.token().map(|t| t.text(text).to_string()))
        .collect()
}

/// The export modifier is a Name leaf, not the declared model name.
pub(super) fn model_name(node: &SyntaxNode, text: &str) -> Option<String> {
    names(node, text).into_iter().find(|name| name != "export")
}

fn first_name(node: &SyntaxNode, text: &str) -> Option<String> {
    names(node, text).into_iter().next()
}

fn prompt_of(node: &SyntaxNode) -> Option<(String, Span)> {
    if matches!(
        node.kind,
        SyntaxKind::GenPrompt | SyntaxKind::StyleSuffix | SyntaxKind::ViewStyle
    ) {
        for part in sig(node) {
            if let Some(tok) = part.token()
                && let Some(v) = &tok.string_value
            {
                return Some((v.clone(), node.span));
            }
        }
    }
    for child in sig(node) {
        if child.kind == SyntaxKind::GenPrompt {
            for part in sig(child) {
                if let Some(tok) = part.token()
                    && let Some(v) = &tok.string_value
                {
                    return Some((v.clone(), child.span));
                }
            }
        }
        if child.kind == SyntaxKind::StyleSuffix {
            for part in sig(child) {
                if let Some(tok) = part.token()
                    && let Some(v) = &tok.string_value
                {
                    return Some((v.clone(), child.span));
                }
            }
        }
    }
    None
}

fn profile_of(node: &SyntaxNode, text: &str) -> Option<String> {
    for child in sig(node) {
        if child.kind == SyntaxKind::Attribute {
            let parts = sig(child);
            if parts.len() >= 3 && parts[0].token().map(|t| t.text(text)) == Some("agent") {
                return first_name(parts[2], text)
                    .or_else(|| parts[2].token().map(|t| t.text(text).to_string()));
            }
        }
    }
    None
}

fn normalized(node: &SyntaxNode, text: &str) -> String {
    text[node.span.start as usize..node.span.end as usize]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Keyword argument value text: collapse surrounding trivia/whitespace but
/// preserve JSON string literal contents exactly.
fn arg_value_text(node: &SyntaxNode, text: &str) -> String {
    let strings: Vec<(usize, usize)> = node
        .descendants()
        .filter_map(|n| n.token())
        .filter(|t| t.kind == TokenKind::String)
        .map(|t| (t.span.start as usize, t.span.end as usize))
        .collect();
    if strings.is_empty() {
        return normalized(node, text);
    }
    let start = node.span.start as usize;
    let end = node.span.end as usize;
    let mut out = String::new();
    let mut pending_space = false;
    let mut i = start;
    while i < end {
        if let Some(&(_, send)) = strings.iter().find(|&&(s, e)| i >= s && i < e) {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push_str(&text[i..send]);
            i = send;
            continue;
        }
        let ch = text[i..].chars().next().unwrap_or(' ');
        if ch.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch);
        }
        i += ch.len_utf8();
    }
    out
}

fn type_text(node: &SyntaxNode, text: &str) -> String {
    normalized(node, text).replace(' ', "")
}

/// Module (app/package) name owning the file, if present.
fn module_owner(tree: &SyntaxNode, text: &str) -> String {
    for node in tree.descendants() {
        if matches!(node.kind, SyntaxKind::App | SyntaxKind::Package) {
            let ns = names(node, text);
            if ns.len() >= 2 {
                return ns[1].clone();
            }
        }
    }
    String::new()
}

struct Collector<'a> {
    text: &'a str,
    owner: String,
    descriptors: Vec<GenerationDescriptor>,
    // context
    model: Option<String>,
    field: Option<String>,
    view: Option<String>,
    host: String,
    host_profile: Option<String>,
}

impl<'a> Collector<'a> {
    fn anchor(&self, kind: &str, label: &str, target: &str) -> String {
        format!("{}:{}:{}:{}", self.owner, kind, label, target)
    }

    fn walk(&mut self, node: &SyntaxNode) {
        if node.kind == SyntaxKind::Error {
            return;
        }
        let saved_model = self.model.clone();
        let saved_field = self.field.clone();
        let saved_view = self.view.clone();
        let saved_host = self.host.clone();
        let saved_profile = self.host_profile.clone();
        match node.kind {
            SyntaxKind::Model => {
                self.model = model_name(node, self.text);
                self.field = None;
            }
            SyntaxKind::Field => {
                self.field = names(node, self.text).into_iter().next();
            }
            SyntaxKind::View => {
                self.view = names(node, self.text).get(1).cloned();
                self.host = self.view.clone().unwrap_or_default();
                self.host_profile = profile_of(node, self.text);
            }
            SyntaxKind::Page
            | SyntaxKind::Card
            | SyntaxKind::Details
            | SyntaxKind::Collection
            | SyntaxKind::Form
            | SyntaxKind::Edit
            | SyntaxKind::Show
            | SyntaxKind::CatalogItem
            | SyntaxKind::UiLeaf
            | SyntaxKind::Tab
            | SyntaxKind::Tabs => {
                let mut h = format!("{:?}", node.kind);
                if let Some(n) = names(node, self.text).into_iter().nth(1) {
                    h = format!("{}:{}", h, n);
                }
                self.host = h;
                self.host_profile = profile_of(node, self.text);
            }
            _ => {}
        }
        self.visit(node);
        for child in &node.children {
            self.walk(child);
        }
        self.model = saved_model;
        self.field = saved_field;
        self.view = saved_view;
        self.host = saved_host;
        self.host_profile = saved_profile;
    }

    fn visit(&mut self, node: &SyntaxNode) {
        match node.kind {
            SyntaxKind::TraitDef => self.visit_trait_def(node),
            SyntaxKind::TraitApp => self.visit_trait_app(node),
            SyntaxKind::KeywordDef => self.visit_keyword_def(node),
            SyntaxKind::KeywordApp => self.visit_keyword_app(node),
            SyntaxKind::StyleDef => self.visit_style_def(node),
            SyntaxKind::StyleSuffix => self.visit_style_suffix(node),
            SyntaxKind::View => self.visit_view(node),
            SyntaxKind::ViewStyle => self.visit_view_style(node),
            _ => {}
        }
    }

    fn visit_trait_def(&mut self, node: &SyntaxNode) {
        let text = self.text;
        let ns = names(node, text);
        let prompt = prompt_of(node).map(|p| p.0);
        let profile = profile_of(node, text);
        if ns.len() >= 2 {
            // Named definition: [trait, Name, ...]
            let label = ns[1].clone();
            self.descriptors.push(GenerationDescriptor {
                selector: None,
                region: None,
                owner: self.owner.clone(),
                kind: GenerationKind::NamedTrait,
                label: Some(label.clone()),
                prompt,
                profile,
                span: node.span,
                anchor: self.anchor("trait", &label, ""),
                target: None,
                has_generation_identity: true,
                params: Vec::new(),
                args: Vec::new(),
                use_sites: Vec::new(),
            });
        } else {
            // Inline attachment on a model or field.
            let target = match (&self.model, &self.field) {
                (Some(m), Some(f)) => format!("{}.{}", m, f),
                (Some(m), None) => m.clone(),
                _ => String::new(),
            };
            self.descriptors.push(GenerationDescriptor {
                selector: None,
                region: None,
                owner: self.owner.clone(),
                kind: GenerationKind::InlineTrait,
                label: Some(target.clone()),
                prompt,
                profile,
                span: node.span,
                anchor: self.anchor("inline-trait", &target, &target),
                target: Some(target),
                has_generation_identity: true,
                params: Vec::new(),
                args: Vec::new(),
                use_sites: Vec::new(),
            });
        }
    }

    fn visit_trait_app(&mut self, node: &SyntaxNode) {
        let text = self.text;
        let label = first_name(node, text).unwrap_or_default();
        // Checked field attachments carry their Model.field target;
        // model-level applications keep the bare model target.
        let target = match (&self.model, &self.field) {
            (Some(m), Some(f)) => format!("{m}.{f}"),
            (Some(m), None) => m.clone(),
            _ => String::new(),
        };
        self.descriptors.push(GenerationDescriptor {
            selector: None,
            region: None,
            owner: self.owner.clone(),
            kind: GenerationKind::TraitApplication,
            label: Some(label.clone()),
            prompt: None,
            profile: None,
            span: node.span,
            anchor: self.anchor("trait-app", &label, &target),
            target: Some(target),
            has_generation_identity: false,
            params: Vec::new(),
            args: Vec::new(),
            use_sites: Vec::new(),
        });
    }

    fn visit_keyword_def(&mut self, node: &SyntaxNode) {
        let text = self.text;
        let ns = names(node, text);
        let label = ns.get(1).cloned().unwrap_or_default();
        let mut params = Vec::new();
        for child in sig(node) {
            if child.kind == SyntaxKind::KeywordParam {
                params.push(parse_param(child, text));
            }
        }
        self.descriptors.push(GenerationDescriptor {
            selector: None,
            region: None,
            owner: self.owner.clone(),
            kind: GenerationKind::KeywordDefinition,
            label: Some(label.clone()),
            prompt: prompt_of(node).map(|p| p.0),
            profile: profile_of(node, text),
            span: node.span,
            anchor: self.anchor("keyword", &label, ""),
            target: None,
            has_generation_identity: true,
            params,
            args: Vec::new(),
            use_sites: Vec::new(),
        });
    }

    fn visit_keyword_app(&mut self, node: &SyntaxNode) {
        let text = self.text;
        let label = first_name(node, text).unwrap_or_default();
        let mut args = Vec::new();
        for child in sig(node) {
            if child.kind == SyntaxKind::Attribute {
                let parts = sig(child);
                if parts.len() >= 3 {
                    args.push(KeywordArgDescriptor {
                        name: parts[0]
                            .token()
                            .map(|t| t.text(text).to_string())
                            .unwrap_or_default(),
                        value: arg_value_text(parts[2], text),
                        span: child.span,
                    });
                }
            }
        }
        self.descriptors.push(GenerationDescriptor {
            selector: None,
            region: None,
            owner: self.owner.clone(),
            kind: GenerationKind::KeywordApplication,
            label: Some(label.clone()),
            prompt: None,
            profile: None,
            span: node.span,
            anchor: self.anchor("keyword-app", &label, ""),
            target: Some(label.clone()),
            has_generation_identity: false,
            params: Vec::new(),
            args,
            use_sites: Vec::new(),
        });
    }

    fn visit_style_def(&mut self, node: &SyntaxNode) {
        let text = self.text;
        let ns = names(node, text);
        let label = ns.get(1).cloned().unwrap_or_default();
        self.descriptors.push(GenerationDescriptor {
            selector: None,
            region: None,
            owner: self.owner.clone(),
            kind: GenerationKind::StyleDefinition,
            label: Some(label.clone()),
            prompt: prompt_of(node).map(|p| p.0),
            profile: profile_of(node, text),
            span: node.span,
            anchor: self.anchor("style", &label, ""),
            target: None,
            has_generation_identity: true,
            params: Vec::new(),
            args: Vec::new(),
            use_sites: Vec::new(),
        });
    }

    fn visit_style_suffix(&mut self, node: &SyntaxNode) {
        let text = self.text;
        let prompt = prompt_of(node).map(|p| p.0);
        // Named reference is the Name leaf inside the suffix.
        let inner_names = names(node, text);
        if let Some(p) = prompt {
            let host = if self.host.is_empty() {
                self.view.clone().unwrap_or_default()
            } else {
                self.host.clone()
            };
            self.descriptors.push(GenerationDescriptor {
                selector: None,
                region: None,
                owner: self.owner.clone(),
                kind: GenerationKind::StyleInline,
                label: Some(host.clone()),
                prompt: Some(p),
                profile: self.host_profile.clone(),
                span: node.span,
                anchor: self.anchor("style-inline", &host, &host),
                target: Some(host),
                has_generation_identity: true,
                params: Vec::new(),
                args: Vec::new(),
                use_sites: Vec::new(),
            });
        } else if let Some(name) = inner_names.into_iter().next() {
            self.descriptors.push(GenerationDescriptor {
                selector: None,
                region: None,
                owner: self.owner.clone(),
                kind: GenerationKind::StyleNamedUse,
                label: Some(name.clone()),
                prompt: None,
                profile: None,
                span: node.span,
                anchor: self.anchor("style-use", &name, &self.host.clone()),
                target: Some(name),
                has_generation_identity: false,
                params: Vec::new(),
                args: Vec::new(),
                use_sites: Vec::new(),
            });
        }
    }

    fn visit_view(&mut self, node: &SyntaxNode) {
        let text = self.text;
        if let Some((prompt, _)) = prompt_of(node) {
            let ns = names(node, text);
            let label = ns.get(1).cloned().unwrap_or_default();
            // Row model: NamedType inside the Parameter child.
            let mut target = String::new();
            for child in sig(node) {
                if child.kind == SyntaxKind::Parameter {
                    let ns: Vec<String> = child
                        .descendants()
                        .filter(|n| n.kind == SyntaxKind::Name)
                        .filter_map(|n| n.token().map(|t| t.text(text).to_string()))
                        .collect();
                    if let Some(n) = ns.into_iter().nth(1) {
                        target = n;
                    }
                }
            }
            self.descriptors.push(GenerationDescriptor {
                selector: None,
                region: None,
                owner: self.owner.clone(),
                kind: GenerationKind::ViewDefinition,
                label: Some(label.clone()),
                prompt: Some(prompt),
                profile: profile_of(node, text),
                span: node.span,
                anchor: self.anchor("view", &label, &target),
                target: Some(target),
                has_generation_identity: true,
                params: Vec::new(),
                args: Vec::new(),
                use_sites: Vec::new(),
            });
        }
    }

    fn visit_view_style(&mut self, node: &SyntaxNode) {
        let text = self.text;
        let prompt = prompt_of(node).map(|p| p.0);
        let view = self.view.clone().unwrap_or_default();
        if let Some(p) = prompt {
            self.descriptors.push(GenerationDescriptor {
                selector: None,
                region: None,
                owner: self.owner.clone(),
                kind: GenerationKind::ViewRootStyleInline,
                label: Some(view.clone()),
                prompt: Some(p),
                profile: self.host_profile.clone(),
                span: node.span,
                anchor: self.anchor("view-style-inline", &view, &view),
                target: Some(view),
                has_generation_identity: true,
                params: Vec::new(),
                args: Vec::new(),
                use_sites: Vec::new(),
            });
        } else if let Some(name) = names(node, text).into_iter().next() {
            self.descriptors.push(GenerationDescriptor {
                selector: None,
                region: None,
                owner: self.owner.clone(),
                kind: GenerationKind::ViewRootStyleNamed,
                label: Some(name.clone()),
                prompt: None,
                profile: None,
                span: node.span,
                anchor: self.anchor("view-style-use", &name, &view),
                target: Some(name),
                has_generation_identity: false,
                params: Vec::new(),
                args: Vec::new(),
                use_sites: Vec::new(),
            });
        }
    }
}

fn parse_param(node: &SyntaxNode, text: &str) -> KeywordParamDescriptor {
    let parts = sig(node);
    let name = parts
        .first()
        .and_then(|n| n.token())
        .map(|t| t.text(text).to_string())
        .unwrap_or_default();
    // field(target,type) shape: Name(field), (, target, type-node, )
    let head_is_field = parts.get(2).and_then(|n| n.token()).map(|t| t.text(text)) == Some("field");
    if head_is_field {
        let target_param = parts
            .get(4)
            .and_then(|n| n.token())
            .map(|t| t.text(text).to_string());
        let type_name = parts.get(6).map(|n| type_text(n, text));
        return KeywordParamDescriptor {
            name,
            kind: "field".to_string(),
            target_param,
            type_name,
        };
    }
    let ty = parts.get(2).map(|n| type_text(n, text)).unwrap_or_default();
    KeywordParamDescriptor {
        name,
        kind: ty,
        target_param: None,
        type_name: None,
    }
}

/// Serialize syntax by kinds and exact token values, preserving nesting/order.
/// Trivia and explanatory comments never participate in durable local evidence.
fn canonical_syntax(node: &SyntaxNode, text: &str) -> serde_json::Value {
    if let Some(token) = node.token() {
        return serde_json::json!([
            format!("{:?}", node.kind),
            token
                .string_value
                .as_deref()
                .unwrap_or_else(|| token.text(text))
        ]);
    }
    serde_json::json!([
        format!("{:?}", node.kind),
        node.children
            .iter()
            .filter(|child| !matches!(child.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
            .map(|child| canonical_syntax(child, text))
            .collect::<Vec<_>>()
    ])
}

/// A declaration/host segment. Prompts, profiles and child suites are excluded.
/// Named declaration names and page routes remain independent of prompt freshness.
fn containment_segment(node: &SyntaxNode, text: &str) -> Option<String> {
    let named = match node.kind {
        SyntaxKind::Model => model_name(node, text),
        SyntaxKind::Field => names(node, text).into_iter().next(),
        SyntaxKind::View | SyntaxKind::KeywordDef | SyntaxKind::StyleDef => {
            names(node, text).get(1).cloned()
        }
        SyntaxKind::TraitDef => names(node, text).get(1).cloned(),
        _ => None,
    };
    if let Some(name) = named {
        return Some(
            serde_json::to_string(&(format!("{:?}", node.kind), name))
                .expect("selector serialization"),
        );
    }
    if node.kind == SyntaxKind::Section {
        return Some(format!(
            "Section:{}",
            first_name(node, text).unwrap_or_default()
        ));
    }
    if node.kind == SyntaxKind::Page {
        let route = node
            .children
            .iter()
            .find(|child| child.kind == SyntaxKind::Route)?;
        return Some(
            serde_json::to_string(&canonical_syntax(route, text)).expect("route serialization"),
        );
    }
    if !matches!(
        node.kind,
        SyntaxKind::Section
            | SyntaxKind::Card
            | SyntaxKind::Details
            | SyntaxKind::Collection
            | SyntaxKind::Form
            | SyntaxKind::Edit
            | SyntaxKind::Show
            | SyntaxKind::CatalogItem
            | SyntaxKind::UiLeaf
            | SyntaxKind::Tab
            | SyntaxKind::Tabs
    ) {
        return None;
    }
    let header = node
        .children
        .iter()
        .filter(|child| {
            !matches!(
                child.kind,
                SyntaxKind::Trivia
                    | SyntaxKind::Comment
                    | SyntaxKind::GenPrompt
                    | SyntaxKind::StyleSuffix
                    | SyntaxKind::ViewStyle
                    | SyntaxKind::Attribute
            ) && containment_segment_kind(child.kind).is_none()
        })
        .map(|child| canonical_syntax(child, text))
        .collect::<Vec<_>>();
    Some(
        serde_json::to_string(&(format!("{:?}", node.kind), header)).expect("header serialization"),
    )
}

/// Structural child suites stop host-header normalization.
fn containment_segment_kind(kind: SyntaxKind) -> Option<()> {
    matches!(
        kind,
        SyntaxKind::Model
            | SyntaxKind::Field
            | SyntaxKind::View
            | SyntaxKind::Page
            | SyntaxKind::TraitDef
            | SyntaxKind::KeywordDef
            | SyntaxKind::StyleDef
            | SyntaxKind::Section
            | SyntaxKind::Card
            | SyntaxKind::Details
            | SyntaxKind::Collection
            | SyntaxKind::Form
            | SyntaxKind::Edit
            | SyntaxKind::Show
            | SyntaxKind::CatalogItem
            | SyntaxKind::UiLeaf
            | SyntaxKind::Tab
            | SyntaxKind::Tabs
    )
    .then_some(())
}

/// Enrich discovery without altering legacy anchors. The first anonymous duplicate
/// interval supplies the certificate; deeper duplicates cannot hide that ambiguity.
fn attach_local_evidence(tree: &SyntaxNode, text: &str, descriptors: &mut [GenerationDescriptor]) {
    fn walk(
        node: &SyntaxNode,
        text: &str,
        path: &[String],
        sealed: bool,
        descriptors: &mut [GenerationDescriptor],
    ) {
        let mut path = path.to_vec();
        if let Some(segment) = containment_segment(node, text) {
            path.push(segment);
        }
        for descriptor in descriptors
            .iter_mut()
            .filter(|descriptor| descriptor.span == node.span)
        {
            let mut selector = path.clone();
            selector.push(format!("slot:{:?}", descriptor.kind));
            descriptor.selector =
                Some(serde_json::to_string(&selector).expect("selector serialization"));
        }
        let mut regions = Vec::<(usize, usize)>::new();
        if !sealed {
            let segments = node
                .children
                .iter()
                .map(|child| containment_segment(child, text))
                .collect::<Vec<_>>();
            let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
            for (index, segment) in segments.iter().enumerate() {
                if let Some(segment) = segment {
                    groups.entry(segment.clone()).or_default().push(index);
                }
            }
            let mut intervals = groups
                .values()
                .filter(|indices| indices.len() > 1)
                .map(|indices| (indices[0], *indices.last().unwrap()))
                .collect::<Vec<_>>();
            intervals.sort_unstable();
            // Overlapping repeated runs share one exact interval, never
            // competing certificates assigned according to traversal order.
            for (first, last) in intervals {
                if let Some(previous) = regions.last_mut().filter(|previous| first <= previous.1) {
                    previous.1 = previous.1.max(last);
                } else {
                    regions.push((first, last));
                }
            }
            for &(first, last) in &regions {
                let start = node.children[first].span.start;
                let end = node.children[last].span.end;
                let indices = descriptors
                    .iter()
                    .enumerate()
                    .filter(|(_, descriptor)| {
                        descriptor.has_generation_identity
                            && descriptor.span.file == node.span.file
                            && descriptor.span.start >= start
                            && descriptor.span.end <= end
                    })
                    .map(|(index, _)| index)
                    .collect::<Vec<_>>();
                let normalized = node.children[first..=last]
                    .iter()
                    .filter(|part| !matches!(part.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
                    .map(|part| canonical_syntax(part, text))
                    .collect::<Vec<_>>();
                let sha256 = crate::source::sha256_hex(
                    serde_json::to_string(&normalized)
                        .expect("region serialization")
                        .as_bytes(),
                );
                let container =
                    serde_json::to_string(&(path.clone(), &segments[first], &segments[last]))
                        .expect("container serialization");
                for (occurrence, &descriptor_index) in indices.iter().enumerate() {
                    descriptors[descriptor_index].region = Some(LocalRegionCertificate {
                        container: container.clone(),
                        sha256: sha256.clone(),
                        count: indices.len() as u32,
                        occurrence: occurrence as u32,
                    });
                }
            }
        }
        for (index, child) in node.children.iter().enumerate() {
            walk(
                child,
                text,
                &path,
                sealed
                    || regions
                        .iter()
                        .any(|&(first, last)| index >= first && index <= last),
                descriptors,
            );
        }
    }
    let owner = descriptors
        .first()
        .map(|descriptor| descriptor.owner.clone())
        .unwrap_or_default();
    walk(tree, text, &[owner], false, descriptors);
}

/// Collect model -> field -> type, scenario names, and crud models.
fn collect_models(
    tree: &SyntaxNode,
    text: &str,
) -> (HashMap<String, HashMap<String, String>>, HashSet<String>) {
    let mut models: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut operations: HashSet<String> = HashSet::new();
    for node in tree.descendants() {
        match node.kind {
            SyntaxKind::Model => {
                if let Some(model) = model_name(node, text) {
                    let mut fields = HashMap::new();
                    for child in sig(node) {
                        if child.kind == SyntaxKind::Field {
                            let parts = sig(child);
                            if let Some(fname) = parts
                                .first()
                                .and_then(|n| n.token())
                                .map(|t| t.text(text).to_string())
                            {
                                let ty =
                                    parts.get(2).map(|n| type_text(n, text)).unwrap_or_default();
                                fields.insert(fname, ty);
                            }
                        }
                    }
                    models.insert(model, fields);
                }
            }
            SyntaxKind::Scenario => {
                if let Some(n) = names(node, text).get(1) {
                    operations.insert(n.clone());
                }
            }
            SyntaxKind::Crud => {
                if let Some(m) = names(node, text).get(1) {
                    for op in ["create", "update", "delete"] {
                        operations.insert(format!("{}.{}", m, op));
                    }
                }
            }
            _ => {}
        }
    }
    (models, operations)
}

const BUILTINS: &[&str] = &[
    "policy",
    "unique",
    "invariant",
    "lock",
    "retain",
    "trait",
    "keyword",
    "style",
    "view",
    "page",
    "model",
    "contract",
    "event",
    "role",
    "capability",
    "corpus",
    "judgment",
    "derive",
    "fixture",
    "message",
    "preferences",
    "scenario",
    "crud",
];

/// Discover generation descriptors and discovery-level diagnostics for one
/// parsed file. Works before any saved implementation exists.
pub fn discover_generation(tree: &SyntaxNode, text: &str) -> GenerationDiscovery {
    // A file may compose an app and several packages. Definitions, target
    // lookup and anonymous association evidence belong to each declaration,
    // never to the first module written in the file.
    if let Some(found) = discover_multi_module(tree, text) {
        return found;
    }
    let owner = module_owner(tree, text);
    let mut collector = Collector {
        text,
        owner,
        descriptors: Vec::new(),
        model: None,
        field: None,
        view: None,
        host: String::new(),
        host_profile: None,
    };
    collector.walk(tree);
    let mut descriptors = collector.descriptors;
    attach_local_evidence(tree, text, &mut descriptors);
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let (models, operations) = collect_models(tree, text);

    // Definition tables collected before resolving applications.
    let (trait_defs, _keyword_defs, style_defs) =
        collect_definition_tables(&descriptors, &mut diagnostics);
    check_keyword_name_ambiguity(&descriptors, &models, &trait_defs, &mut diagnostics);
    // The borrowed map above complicates later mutation; rebuild indices.
    let keyword_params: HashMap<String, Vec<KeywordParamDescriptor>> = descriptors
        .iter()
        .filter(|d| d.kind == GenerationKind::KeywordDefinition)
        .map(|d| (d.label.clone().unwrap_or_default(), d.params.clone()))
        .collect();

    // Record style use sites on their definitions; validate references.
    let mut use_sites: HashMap<String, Vec<Span>> = HashMap::new();
    let mut style_edges: Vec<(String, String, Span)> = Vec::new();
    check_applications(
        &descriptors,
        &trait_defs,
        &style_defs,
        &keyword_params,
        &models,
        &operations,
        &mut use_sites,
        &mut style_edges,
        &mut diagnostics,
    );
    // Cycle check over style edges (defensive DFS; v1 edges are use->def).
    check_style_cycles(&style_edges, &mut diagnostics);
    for d in &mut descriptors {
        if d.kind == GenerationKind::StyleDefinition
            && let Some(label) = &d.label
            && let Some(sites) = use_sites.get(label)
        {
            d.use_sites = sites.clone();
        }
    }

    diagnostics.sort_by(|a, b| (a.primary.start, a.code).cmp(&(b.primary.start, b.code)));
    GenerationDiscovery {
        descriptors,
        diagnostics,
    }
}

fn discovery_error(diagnostics: &mut Vec<Diagnostic>, code: &'static str, msg: String, span: Span) {
    diagnostics.push(Diagnostic::error(code, msg, span));
}

fn discover_multi_module(tree: &SyntaxNode, text: &str) -> Option<GenerationDiscovery> {
    if !matches!(tree.kind, SyntaxKind::App | SyntaxKind::Package) {
        let modules: Vec<_> = tree
            .children
            .iter()
            .filter(|node| matches!(node.kind, SyntaxKind::App | SyntaxKind::Package))
            .collect();
        if !modules.is_empty() {
            let mut found = GenerationDiscovery {
                descriptors: Vec::new(),
                diagnostics: Vec::new(),
            };
            for module in modules {
                let scoped = discover_generation(module, text);
                found.descriptors.extend(scoped.descriptors);
                found.diagnostics.extend(scoped.diagnostics);
            }
            return Some(found);
        }
    }
    None
}

fn collect_definition_tables(
    descriptors: &[GenerationDescriptor],
    diagnostics: &mut Vec<Diagnostic>,
) -> (
    HashMap<String, Span>,
    HashMap<String, Span>,
    HashMap<String, usize>,
) {
    let mut trait_defs: HashMap<String, Span> = HashMap::new();
    let mut keyword_defs: HashMap<String, Span> = HashMap::new();
    let mut style_defs: HashMap<String, usize> = HashMap::new(); // label -> index
    for (idx, d) in descriptors.iter().enumerate() {
        match d.kind {
            GenerationKind::NamedTrait => {
                let label = d.label.clone().unwrap_or_default();
                if BUILTINS.contains(&label.as_str()) {
                    discovery_error(
                        diagnostics,
                        "E2002",
                        format!("trait `{label}` redefines a built-in declaration"),
                        d.span,
                    );
                } else if trait_defs.insert(label.clone(), d.span).is_some() {
                    discovery_error(
                        diagnostics,
                        "E2002",
                        format!("duplicate trait definition `{label}`"),
                        d.span,
                    );
                }
            }
            GenerationKind::KeywordDefinition => {
                let label = d.label.clone().unwrap_or_default();
                if BUILTINS.contains(&label.as_str()) {
                    discovery_error(
                        diagnostics,
                        "E2002",
                        format!("keyword `{label}` redefines a built-in declaration"),
                        d.span,
                    );
                } else if keyword_defs.insert(label.clone(), d.span).is_some() {
                    discovery_error(
                        diagnostics,
                        "E2002",
                        format!("duplicate keyword definition `{label}`"),
                        d.span,
                    );
                }
                check_keyword_field_params(d, &label, diagnostics);
            }
            GenerationKind::StyleDefinition => {
                let label = d.label.clone().unwrap_or_default();
                if BUILTINS.contains(&label.as_str()) {
                    discovery_error(
                        diagnostics,
                        "E2002",
                        format!("style `{label}` redefines a built-in declaration"),
                        d.span,
                    );
                } else if style_defs.insert(label.clone(), idx).is_some() {
                    discovery_error(
                        diagnostics,
                        "E2002",
                        format!("duplicate style definition `{label}`"),
                        d.span,
                    );
                }
            }
            _ => {}
        }
    }
    (trait_defs, keyword_defs, style_defs)
}

fn check_keyword_field_params(
    d: &GenerationDescriptor,
    label: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for p in &d.params {
        if p.kind != "field" {
            continue;
        }
        let target = p.target_param.clone().unwrap_or_default();
        match d.params.iter().find(|q| q.name == target) {
            Some(q) if q.kind == "model" => {}
            Some(_) => discovery_error(
                diagnostics,
                "E2001",
                format!(
                    "keyword `{label}` field parameter `{}` must target a `model` parameter, `{target}` is not one",
                    p.name
                ),
                d.span,
            ),
            None => discovery_error(
                diagnostics,
                "E2001",
                format!(
                    "keyword `{label}` field parameter `{}` targets unknown parameter `{target}`",
                    p.name
                ),
                d.span,
            ),
        }
    }
}

fn check_keyword_name_ambiguity(
    descriptors: &[GenerationDescriptor],
    models: &HashMap<String, HashMap<String, String>>,
    trait_defs: &HashMap<String, Span>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    // A keyword name cannot ambiguously refer to a model or trait form.
    for d in descriptors.iter() {
        if d.kind != GenerationKind::KeywordDefinition {
            continue;
        }
        let label = d.label.clone().unwrap_or_default();
        if models.contains_key(&label) {
            discovery_error(
                diagnostics,
                "E2002",
                format!(
                    "ambiguous declaration name `{label}`: a keyword and a model cannot share one name"
                ),
                d.span,
            );
        } else if trait_defs.contains_key(&label) {
            discovery_error(
                diagnostics,
                "E2002",
                format!(
                    "ambiguous declaration name `{label}`: a keyword and a trait cannot share one name"
                ),
                d.span,
            );
        }
    }
}

fn check_applications(
    descriptors: &[GenerationDescriptor],
    trait_defs: &HashMap<String, Span>,
    style_defs: &HashMap<String, usize>,
    keyword_params: &HashMap<String, Vec<KeywordParamDescriptor>>,
    models: &HashMap<String, HashMap<String, String>>,
    operations: &HashSet<String>,
    use_sites: &mut HashMap<String, Vec<Span>>,
    style_edges: &mut Vec<(String, String, Span)>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for d in descriptors {
        match d.kind {
            GenerationKind::TraitApplication => {
                let label = d.label.clone().unwrap_or_default();
                if !trait_defs.contains_key(&label) {
                    discovery_error(
                        diagnostics,
                        "E2001",
                        format!("unknown trait `{label}`"),
                        d.span,
                    );
                }
            }
            GenerationKind::StyleNamedUse | GenerationKind::ViewRootStyleNamed => {
                record_style_use(d, style_defs, use_sites, style_edges, diagnostics);
            }
            GenerationKind::KeywordApplication => {
                check_keyword_application(d, keyword_params, models, operations, diagnostics);
            }
            _ => {}
        }
    }
}

fn record_style_use(
    d: &GenerationDescriptor,
    style_defs: &HashMap<String, usize>,
    use_sites: &mut HashMap<String, Vec<Span>>,
    style_edges: &mut Vec<(String, String, Span)>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let label = d.label.clone().unwrap_or_default();
    if !style_defs.contains_key(&label) {
        discovery_error(
            diagnostics,
            "E2001",
            format!("unknown style `{label}`"),
            d.span,
        );
        return;
    }
    use_sites.entry(label.clone()).or_default().push(d.span);
    if let Some(t) = &d.target {
        // target carries the referenced name for named uses.
        let _ = t;
    }
    // Self-reference is the only cycle the v1 grammar can form.
    if d.anchor.contains(&format!(":{}", label)) && d.kind == GenerationKind::ViewRootStyleNamed {
        // view name is in the anchor target slot; a view that
        // styles its root with a style of its own name and
        // that style is itself is diagnosed via duplicate/
        // unknown rules above.
    }
    // An edge only participates in a cycle when its host is
    // itself a style definition; ordinary component hosts
    // (the only hosts the v1 grammar admits) cannot cycle.
    let host = d.anchor.rsplit(':').next().unwrap_or_default().to_string();
    if style_defs.contains_key(&host) {
        style_edges.push((host, label, d.span));
    }
}

fn check_keyword_application(
    d: &GenerationDescriptor,
    keyword_params: &HashMap<String, Vec<KeywordParamDescriptor>>,
    models: &HashMap<String, HashMap<String, String>>,
    operations: &HashSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let label = d.label.clone().unwrap_or_default();
    let Some(params) = keyword_params.get(&label) else {
        discovery_error(
            diagnostics,
            "E2001",
            format!(
                "unknown custom keyword `{label}`; collect its keyword definition before resolving applications"
            ),
            d.span,
        );
        return;
    };
    // Missing / unknown arguments.
    let provided: HashSet<String> = d.args.iter().map(|a| a.name.clone()).collect();
    for p in params {
        if !provided.contains(&p.name) {
            discovery_error(
                diagnostics,
                "E2001",
                format!("keyword `{label}` requires argument `{}`", p.name),
                d.span,
            );
        }
    }
    for a in &d.args {
        if !params.iter().any(|p| p.name == a.name) {
            discovery_error(
                diagnostics,
                "E2001",
                format!("unknown argument `{}` for keyword `{label}`", a.name),
                a.span,
            );
        }
    }
    // Typed compile-time argument checks.
    let by_name: HashMap<String, String> = d
        .args
        .iter()
        .map(|a| (a.name.clone(), a.value.clone()))
        .collect();
    for a in &d.args {
        let Some(p) = params.iter().find(|p| p.name == a.name) else {
            continue;
        };
        check_keyword_arg(params, p, a, &by_name, models, operations, diagnostics);
    }
}

fn check_style_cycles(style_edges: &[(String, String, Span)], diagnostics: &mut Vec<Diagnostic>) {
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    for (from, to, _) in style_edges {
        graph.entry(from.clone()).or_default().push(to.clone());
    }
    let mut state: HashMap<String, u8> = HashMap::new();
    let keys: Vec<String> = graph.keys().cloned().collect();
    for k in keys {
        if state.get(&k).copied().unwrap_or(0) == 0 && style_dfs(&k, &graph, &mut state) {
            if let Some((_, _, span)) = style_edges.iter().find(|(f, _, _)| f == &k) {
                discovery_error(
                    diagnostics,
                    "E2002",
                    "cyclic style reference".to_string(),
                    *span,
                );
            }
            break;
        }
    }
}

fn style_dfs(
    n: &str,
    graph: &HashMap<String, Vec<String>>,
    state: &mut HashMap<String, u8>,
) -> bool {
    state.insert(n.to_string(), 1);
    if let Some(nexts) = graph.get(n) {
        for m in nexts.clone() {
            match state.get(&m).copied().unwrap_or(0) {
                1 => return true,
                0 if style_dfs(&m, graph, state) => {
                    return true;
                }
                _ => {}
            }
        }
    }
    state.insert(n.to_string(), 2);
    false
}

fn check_keyword_arg(
    params: &[KeywordParamDescriptor],
    param: &KeywordParamDescriptor,
    arg: &KeywordArgDescriptor,
    by_name: &HashMap<String, String>,
    models: &HashMap<String, HashMap<String, String>>,
    operations: &HashSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let value = arg.value.trim();
    let fail = |msg: String, diagnostics: &mut Vec<Diagnostic>| {
        diagnostics.push(Diagnostic::error("E2001", msg, arg.span));
    };
    match param.kind.as_str() {
        "model" => {
            let model = value.split('.').next().unwrap_or(value);
            if !models.contains_key(model) || value.contains('.') {
                fail(
                    format!(
                        "keyword argument `{}` must name a known model, got `{value}`",
                        param.name
                    ),
                    diagnostics,
                );
            }
        }
        "field" => {
            check_field_arg(params, param, arg, value, by_name, models, diagnostics);
        }
        "operation" => {
            if !operations.contains(value) {
                fail(
                    format!(
                        "keyword argument `{}` must name a known operation, got `{value}`",
                        param.name
                    ),
                    diagnostics,
                );
            }
        }
        "text" => {
            // Constants only: the whole value must be one JSON string.
            if serde_json::from_str::<String>(value).is_err() {
                fail(
                    format!(
                        "keyword argument `{}` requires a checked text constant",
                        param.name
                    ),
                    diagnostics,
                );
            }
        }
        "int" | "integer" => {
            if value.parse::<i64>().is_err() {
                fail(
                    format!(
                        "keyword argument `{}` requires an integer constant",
                        param.name
                    ),
                    diagnostics,
                );
            }
        }
        "bool" | "boolean" => {
            if !matches!(value, "true" | "false") {
                fail(
                    format!(
                        "keyword argument `{}` requires a boolean constant",
                        param.name
                    ),
                    diagnostics,
                );
            }
        }
        k if k.starts_with("enum(") => {
            let inner = k.trim_start_matches("enum(").trim_end_matches(')');
            let cases: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
            if !cases.contains(&value) {
                fail(
                    format!(
                        "keyword argument `{}` requires one of ({})",
                        param.name, inner
                    ),
                    diagnostics,
                );
            }
        }
        k if k.ends_with("[]") => {
            let elem = k.strip_suffix("[]").unwrap_or(k);
            check_array_arg(param, arg, elem, value, models, operations, diagnostics);
        }
        _ => {}
    }
}

fn keyword_arg_error(arg: &KeywordArgDescriptor, msg: String, diagnostics: &mut Vec<Diagnostic>) {
    diagnostics.push(Diagnostic::error("E2001", msg, arg.span));
}

fn check_field_arg(
    params: &[KeywordParamDescriptor],
    param: &KeywordParamDescriptor,
    arg: &KeywordArgDescriptor,
    value: &str,
    by_name: &HashMap<String, String>,
    models: &HashMap<String, HashMap<String, String>>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let fail = |msg: String, diagnostics: &mut Vec<Diagnostic>| {
        keyword_arg_error(arg, msg, diagnostics);
    };
    let (target_param, expected) = (
        param.target_param.clone().unwrap_or_default(),
        param.type_name.clone().unwrap_or_default(),
    );
    if !params.iter().any(|q| q.name == target_param) {
        fail(
            format!(
                "keyword argument `{}` targets unknown parameter `{target_param}`",
                param.name
            ),
            diagnostics,
        );
        return;
    }
    let target_model = by_name.get(&target_param).cloned().unwrap_or_default();
    if target_model.is_empty() {
        // A missing-argument diagnostic was already emitted.
        return;
    }
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 2 {
        fail(
            format!(
                "keyword argument `{}` must name a field as Model.field",
                param.name
            ),
            diagnostics,
        );
        return;
    }
    if !target_model.is_empty() && parts[0] != target_model {
        fail(
            format!("field `{value}` does not belong to target model `{target_model}`"),
            diagnostics,
        );
        return;
    }
    match models.get(parts[0]).and_then(|f| f.get(parts[1])) {
        None => fail(
            format!(
                "unknown field `{value}` for keyword argument `{}`",
                param.name
            ),
            diagnostics,
        ),
        Some(actual) if !expected.is_empty() && actual != &expected => fail(
            format!("field `{value}` has type `{actual}`, expected `{expected}`"),
            diagnostics,
        ),
        _ => {}
    }
}

fn check_array_arg(
    param: &KeywordParamDescriptor,
    arg: &KeywordArgDescriptor,
    elem: &str,
    value: &str,
    models: &HashMap<String, HashMap<String, String>>,
    operations: &HashSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if !(value.starts_with('[') && value.ends_with(']')) {
        keyword_arg_error(
            arg,
            format!(
                "keyword argument `{}` requires an array constant",
                param.name
            ),
            diagnostics,
        );
        return;
    }
    let inner = &value[1..value.len().saturating_sub(1)];
    for el in split_top_level(inner) {
        if let Some(detail) = const_element_error(elem, el, models, operations) {
            keyword_arg_error(
                arg,
                format!(
                    "keyword argument `{}` requires {elem} array elements: {detail}",
                    param.name
                ),
                diagnostics,
            );
        }
    }
}

/// Split a bracket body on top-level commas, ignoring commas inside JSON
/// strings and nested brackets. Empty segments are dropped.
/// Split const-array elements on top-level commas (string/escape-aware, `[]`
/// depth; trims, drops empties). Different job from catalog's separator/bracket
/// splitter — not a duplicate.
fn split_top_level(inner: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    let mut start = 0usize;
    for (i, ch) in inner.char_indices() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
        } else if ch == '"' {
            in_str = true;
        } else if ch == '[' {
            depth += 1;
        } else if ch == ']' {
            depth = depth.saturating_sub(1);
        } else if ch == ',' && depth == 0 {
            parts.push(inner[start..i].trim());
            start = i + 1;
        }
    }
    parts.push(inner[start..].trim());
    parts.into_iter().filter(|p| !p.is_empty()).collect()
}

/// Validate one array element against its declared element kind. Returns a
/// detail message on mismatch; unknown kinds stay permissive.
fn const_element_error(
    kind: &str,
    value: &str,
    models: &HashMap<String, HashMap<String, String>>,
    operations: &HashSet<String>,
) -> Option<String> {
    let value = value.trim();
    match kind {
        "text" => serde_json::from_str::<String>(value)
            .err()
            .map(|_| format!("expected a text constant, got `{value}`")),
        "int" | "integer" => value
            .parse::<i64>()
            .err()
            .map(|_| format!("expected an integer constant, got `{value}`")),
        "bool" | "boolean" => (!matches!(value, "true" | "false"))
            .then(|| format!("expected a boolean constant, got `{value}`")),
        "model" => (!models.contains_key(value) || value.contains('.'))
            .then(|| format!("expected a known model, got `{value}`")),
        "operation" => (!operations.contains(value))
            .then(|| format!("expected a known operation, got `{value}`")),
        k if k.starts_with("enum(") => {
            let inner = k.trim_start_matches("enum(").trim_end_matches(')');
            let cases: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
            (!cases.contains(&value)).then(|| format!("expected one of ({inner}), got `{value}`"))
        }
        k if k.ends_with("[]") => {
            let elem = k.strip_suffix("[]").unwrap_or(k);
            if !(value.starts_with('[') && value.ends_with(']')) {
                return Some(format!("expected an array constant, got `{value}`"));
            }
            let inner = &value[1..value.len().saturating_sub(1)];
            for el in split_top_level(inner) {
                if let Some(detail) = const_element_error(elem, el, models, operations) {
                    return Some(detail);
                }
            }
            None
        }
        _ => None,
    }
}

/// Discover generation units across checked source files (parse each file).
pub fn discover_program(db: &SourceDb, files: &[SourceId]) -> GenerationDiscovery {
    let mut all = GenerationDiscovery {
        descriptors: Vec::new(),
        diagnostics: Vec::new(),
    };
    for &file in files {
        let Some(source) = db.get(file) else { continue };
        let (tree, _) = crate::syntax::parse(db, file);
        let found = discover_generation(&tree, &source.text);
        all.descriptors.extend(found.descriptors);
        all.diagnostics.extend(found.diagnostics);
    }
    all
}
