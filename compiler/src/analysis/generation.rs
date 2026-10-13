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
use crate::syntax::{SyntaxKind, SyntaxNode};
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

fn first_name(node: &SyntaxNode, text: &str) -> Option<String> {
    names(node, text).into_iter().next()
}

fn prompt_of(node: &SyntaxNode) -> Option<(String, Span)> {
    if matches!(node.kind, SyntaxKind::GenPrompt | SyntaxKind::StyleSuffix) {
        for part in sig(node) {
            if let Some(tok) = part.token()
                && let Some(v) = &tok.string_value {
                    return Some((v.clone(), node.span));
                }
        }
    }
    for child in sig(node) {
        if child.kind == SyntaxKind::GenPrompt {
            for part in sig(child) {
                if let Some(tok) = part.token()
                    && let Some(v) = &tok.string_value {
                        return Some((v.clone(), child.span));
                    }
            }
        }
        if child.kind == SyntaxKind::StyleSuffix {
            for part in sig(child) {
                if let Some(tok) = part.token()
                    && let Some(v) = &tok.string_value {
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
        match node.kind {
            SyntaxKind::Model => {
                self.model = names(node, self.text).into_iter().next();
                self.field = None;
            }
            SyntaxKind::Field => {
                self.field = names(node, self.text).into_iter().next();
            }
            SyntaxKind::View => {
                self.view = names(node, self.text).get(1).cloned();
                self.host = self.view.clone().unwrap_or_default();
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
    }

    fn visit(&mut self, node: &SyntaxNode) {
        let text = self.text;
        match node.kind {
            SyntaxKind::TraitDef => {
                let ns = names(node, text);
                let prompt = prompt_of(node).map(|p| p.0);
                let profile = profile_of(node, text);
                if ns.len() >= 2 {
                    // Named definition: [trait, Name, ...]
                    let label = ns[1].clone();
                    self.descriptors.push(GenerationDescriptor {
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
            SyntaxKind::TraitApp => {
                let label = first_name(node, text).unwrap_or_default();
                let target = self.model.clone().unwrap_or_default();
                self.descriptors.push(GenerationDescriptor {
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
            SyntaxKind::KeywordDef => {
                let ns = names(node, text);
                let label = ns.get(1).cloned().unwrap_or_default();
                let mut params = Vec::new();
                for child in sig(node) {
                    if child.kind == SyntaxKind::KeywordParam {
                        params.push(parse_param(child, text));
                    }
                }
                self.descriptors.push(GenerationDescriptor {
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
            SyntaxKind::KeywordApp => {
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
                                value: normalized(parts[2], text),
                                span: child.span,
                            });
                        }
                    }
                }
                self.descriptors.push(GenerationDescriptor {
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
            SyntaxKind::StyleDef => {
                let ns = names(node, text);
                let label = ns.get(1).cloned().unwrap_or_default();
                self.descriptors.push(GenerationDescriptor {
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
            SyntaxKind::StyleSuffix => {
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
                        owner: self.owner.clone(),
                        kind: GenerationKind::StyleInline,
                        label: Some(host.clone()),
                        prompt: Some(p),
                        profile: None,
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
            SyntaxKind::View => {
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
            SyntaxKind::ViewStyle => {
                let prompt = prompt_of(node).map(|p| p.0);
                let view = self.view.clone().unwrap_or_default();
                if let Some(p) = prompt {
                    self.descriptors.push(GenerationDescriptor {
                        owner: self.owner.clone(),
                        kind: GenerationKind::ViewRootStyleInline,
                        label: Some(view.clone()),
                        prompt: Some(p),
                        profile: profile_of(node, text),
                        span: node.span,
                        anchor: self.anchor("view-style-inline", &view, &view),
                        target: Some(view),
                        has_generation_identity: true,
                        params: Vec::new(),
                        args: Vec::new(),
                        use_sites: Vec::new(),
                    });
                } else if let Some(name) = names(node, text).into_iter().nth(1) {
                    self.descriptors.push(GenerationDescriptor {
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
            _ => {}
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
                if let Some(model) = names(node, text).into_iter().next() {
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
    let owner = module_owner(tree, text);
    let mut collector = Collector {
        text,
        owner,
        descriptors: Vec::new(),
        model: None,
        field: None,
        view: None,
        host: String::new(),
    };
    collector.walk(tree);
    let mut descriptors = collector.descriptors;
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let (models, operations) = collect_models(tree, text);

    let err = |code: &'static str, msg: String, span: Span, diags: &mut Vec<Diagnostic>| {
        diags.push(Diagnostic::error(code, msg, span));
    };

    // Definition tables collected before resolving applications.
    let mut trait_defs: HashMap<String, Span> = HashMap::new();
    let mut keyword_defs: HashMap<String, Span> = HashMap::new();
    let mut style_defs: HashMap<String, usize> = HashMap::new(); // label -> index
    for (idx, d) in descriptors.iter().enumerate() {
        match d.kind {
            GenerationKind::NamedTrait => {
                let label = d.label.clone().unwrap_or_default();
                if BUILTINS.contains(&label.as_str()) {
                    err(
                        "E2002",
                        format!("trait `{label}` redefines a built-in declaration"),
                        d.span,
                        &mut diagnostics,
                    );
                } else if trait_defs.insert(label.clone(), d.span).is_some() {
                    err(
                        "E2002",
                        format!("duplicate trait definition `{label}`"),
                        d.span,
                        &mut diagnostics,
                    );
                }
            }
            GenerationKind::KeywordDefinition => {
                let label = d.label.clone().unwrap_or_default();
                if BUILTINS.contains(&label.as_str()) {
                    err(
                        "E2002",
                        format!("keyword `{label}` redefines a built-in declaration"),
                        d.span,
                        &mut diagnostics,
                    );
                } else if keyword_defs.insert(label.clone(), d.span).is_some() {
                    err(
                        "E2002",
                        format!("duplicate keyword definition `{label}`"),
                        d.span,
                        &mut diagnostics,
                    );
                }
            }
            GenerationKind::StyleDefinition => {
                let label = d.label.clone().unwrap_or_default();
                if BUILTINS.contains(&label.as_str()) {
                    err(
                        "E2002",
                        format!("style `{label}` redefines a built-in declaration"),
                        d.span,
                        &mut diagnostics,
                    );
                } else if style_defs.insert(label.clone(), idx).is_some() {
                    err(
                        "E2002",
                        format!("duplicate style definition `{label}`"),
                        d.span,
                        &mut diagnostics,
                    );
                }
            }
            _ => {}
        }
    }
    // The borrowed map above complicates later mutation; rebuild indices.
    let keyword_params: HashMap<String, Vec<KeywordParamDescriptor>> = descriptors
        .iter()
        .filter(|d| d.kind == GenerationKind::KeywordDefinition)
        .map(|d| (d.label.clone().unwrap_or_default(), d.params.clone()))
        .collect();

    // Record style use sites on their definitions; validate references.
    let mut use_sites: HashMap<String, Vec<Span>> = HashMap::new();
    let mut style_edges: Vec<(String, String, Span)> = Vec::new();
    for d in &descriptors {
        match d.kind {
            GenerationKind::TraitApplication => {
                let label = d.label.clone().unwrap_or_default();
                if !trait_defs.contains_key(&label) {
                    err(
                        "E2001",
                        format!("unknown trait `{label}`"),
                        d.span,
                        &mut diagnostics,
                    );
                }
            }
            GenerationKind::StyleNamedUse | GenerationKind::ViewRootStyleNamed => {
                let label = d.label.clone().unwrap_or_default();
                if !style_defs.contains_key(&label) {
                    err(
                        "E2001",
                        format!("unknown style `{label}`"),
                        d.span,
                        &mut diagnostics,
                    );
                } else {
                    use_sites.entry(label.clone()).or_default().push(d.span);
                    if let Some(t) = &d.target {
                        // target carries the referenced name for named uses.
                        let _ = t;
                    }
                    // Self-reference is the only cycle the v1 grammar can form.
                    if d.anchor.contains(&format!(":{}", label))
                        && d.kind == GenerationKind::ViewRootStyleNamed
                    {
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
            }
            GenerationKind::KeywordApplication => {
                let label = d.label.clone().unwrap_or_default();
                let Some(params) = keyword_params.get(&label) else {
                    err(
                        "E2001",
                        format!(
                            "unknown custom keyword `{label}`; collect its keyword definition before resolving applications"
                        ),
                        d.span,
                        &mut diagnostics,
                    );
                    continue;
                };
                // Missing / unknown arguments.
                let provided: HashSet<String> = d.args.iter().map(|a| a.name.clone()).collect();
                for p in params {
                    if !provided.contains(&p.name) {
                        err(
                            "E2001",
                            format!("keyword `{label}` requires argument `{}`", p.name),
                            d.span,
                            &mut diagnostics,
                        );
                    }
                }
                for a in &d.args {
                    if !params.iter().any(|p| p.name == a.name) {
                        err(
                            "E2001",
                            format!("unknown argument `{}` for keyword `{label}`", a.name),
                            a.span,
                            &mut diagnostics,
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
                    check_keyword_arg(p, a, &by_name, &models, &operations, &mut diagnostics);
                }
            }
            _ => {}
        }
    }
    // Cycle check over style edges (defensive DFS; v1 edges are use->def).
    {
        let mut graph: HashMap<String, Vec<String>> = HashMap::new();
        for (from, to, _) in &style_edges {
            graph.entry(from.clone()).or_default().push(to.clone());
        }
        let mut state: HashMap<String, u8> = HashMap::new();
        fn dfs(
            n: &str,
            graph: &HashMap<String, Vec<String>>,
            state: &mut HashMap<String, u8>,
        ) -> bool {
            state.insert(n.to_string(), 1);
            if let Some(nexts) = graph.get(n) {
                for m in nexts.clone() {
                    match state.get(&m).copied().unwrap_or(0) {
                        1 => return true,
                        0
                            if dfs(&m, graph, state) => {
                                return true;
                            }
                        _ => {}
                    }
                }
            }
            state.insert(n.to_string(), 2);
            false
        }
        let keys: Vec<String> = graph.keys().cloned().collect();
        for k in keys {
            if state.get(&k).copied().unwrap_or(0) == 0 && dfs(&k, &graph, &mut state) {
                if let Some((_, _, span)) = style_edges.iter().find(|(f, _, _)| f == &k) {
                    err(
                        "E2002",
                        "cyclic style reference".to_string(),
                        *span,
                        &mut diagnostics,
                    );
                }
                break;
            }
        }
    }
    for d in &mut descriptors {
        if d.kind == GenerationKind::StyleDefinition
            && let Some(label) = &d.label
                && let Some(sites) = use_sites.get(label) {
                    d.use_sites = sites.clone();
                }
    }

    diagnostics.sort_by(|a, b| (a.primary.start, a.code).cmp(&(b.primary.start, b.code)));
    GenerationDiscovery {
        descriptors,
        diagnostics,
    }
}

fn check_keyword_arg(
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
            let (target_param, expected) = (
                param.target_param.clone().unwrap_or_default(),
                param.type_name.clone().unwrap_or_default(),
            );
            let target_model = by_name.get(&target_param).cloned().unwrap_or_default();
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
        "operation" => {
            if !operations.contains(value)
                && !models.contains_key(value.split('.').next().unwrap_or(value))
            {
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
            if !value.starts_with('"') {
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
        k if k.ends_with("[]")
            && !value.starts_with('[') => {
                fail(
                    format!(
                        "keyword argument `{}` requires an array constant",
                        param.name
                    ),
                    diagnostics,
                );
            }
        _ => {}
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
