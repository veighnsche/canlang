//! BGI-09 prompted row-bound view lowering and BGI-10 use inspection.
//!
//! Structural lowering over the lossless CST, beside (not inside) the
//! BGI-07-owned `ir.rs`/`js.rs` emission. For every prompted
//! `view Name(row:Model) $"..."` this produces the checked renderer
//! contract: the row model, opaque canonical cards, declared controls,
//! presentation leaves, the optional definition-owned root style, and the
//! once-only row evaluation marker the
//! runtime join honors. Instance identity mirrors the ordinary
//! `can-view-m..-f..-s..` occurrence shape, so repeated instances keep
//! separate roots while sharing the definition's saved renderer.
//!
//! The same module walks checked trait/keyword/style/view uses for
//! inspection (no persistent index) and collects the Then prompt set a
//! manual full-app retry regenerates.

use crate::analysis::generation::{GenerationDescriptor, GenerationKind};
use crate::diagnostic::Diagnostic;
use crate::source::Span;
use crate::syntax::{SyntaxKind, SyntaxNode};
use std::collections::{HashMap, HashSet};

/// Version of the checked Then view contract shared with the UI join.
pub const THEN_VIEW_CONTRACT_VERSION: &str = "canlang.then-view/1";

/// The `show` row argument is evaluated exactly once per instance; the
/// saved `render({row, bindings, ui})` receives the value, never the
/// expression. Mirrors the ordinary expansion in `js.rs`.
pub const ROW_EVALUATED_ONCE: bool = true;

/// Saved renderer entry signature.
pub const RENDER_SIGNATURE: &str = "render({row, bindings, ui})";

/// Optional browser enhancement entry; returns cleanup for replaced roots.
pub const MOUNT_SIGNATURE: &str = "mount(root, presentation) => cleanup";

/// One canonical control binding a prompted view declares. The host renders
/// these through the existing canonical factories; the saved renderer only
/// arranges the resulting bindings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThenControl {
    Edit {
        fields: Vec<String>,
    },
    Delete,
    Form {
        operation: String,
        fields: Vec<String>,
    },
    Action {
        operation: String,
    },
    Actions {
        operations: Vec<String>,
    },
    Primary,
    Secondary,
}

impl ThenControl {
    /// Declared field names (edit/form inputs); admission decides refusal.
    pub fn declared_fields(&self) -> Vec<String> {
        match self {
            ThenControl::Edit { fields } | ThenControl::Form { fields, .. } => fields.clone(),
            _ => Vec::new(),
        }
    }
}

/// Definition-owned root style suffix of a prompted view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThenRootStyle {
    /// Named root style (`$Name`), if any.
    pub named: Option<String>,
    /// Inline root style prompt (`$"..."`), if any.
    pub inline_prompt: Option<String>,
}

/// Checked contract for one prompted row-bound view definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThenView {
    pub name: String,
    pub row_model: String,
    pub prompt: String,
    pub profile: Option<String>,
    pub controls: Vec<ThenControl>,
    /// Source-owned renderer binding names before public factory lowering.
    pub binding_names: Vec<(Span, String)>,
    /// Definition-level `require` predicates gating the whole expansion.
    pub gates: Vec<String>,
    /// Presentation roots (`card`/`history`/`text`/`content`) the host
    /// pre-renders alongside controls, retaining each card's checked subtree.
    pub leaves: Vec<String>,
    pub root_style: Option<ThenRootStyle>,
    pub span: Span,
    pub anchor: String,
}

/// One use edge for inspection: definition anchor plus the checked use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UseEdge {
    pub definition_anchor: String,
    pub definition_label: String,
    pub definition_kind: GenerationKind,
    pub use_span: Span,
    /// Host description (`Show`, `Page`, `CatalogItem:title`, ...).
    pub host: String,
    pub owner: String,
}

/// One Then prompt a manual full-app retry regenerates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThenPrompt {
    pub anchor: String,
    pub kind: GenerationKind,
    pub label: String,
    pub prompt: String,
    pub profile: Option<String>,
}

/// Checked style-use contract feeding the generation pipeline: the unit
/// whose CSS applies, the use root hook, and host compatibility.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThenUseContract {
    pub unit_anchor: String,
    pub style_name: String,
    pub use_span: Span,
    pub host: String,
    pub compatible: bool,
}

#[derive(Debug, Clone)]
pub struct ThenLowering {
    pub views: Vec<ThenView>,
    pub diagnostics: Vec<Diagnostic>,
}

fn significant(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|c| {
            !matches!(
                c.kind,
                SyntaxKind::Trivia | SyntaxKind::Comment | SyntaxKind::Punct
            )
        })
        .collect()
}

fn names(node: &SyntaxNode, text: &str) -> Vec<String> {
    significant(node)
        .iter()
        .filter(|c| c.kind == SyntaxKind::Name)
        .filter_map(|c| c.token().map(|t| t.text(text).to_string()))
        .collect()
}

fn has_prompt(node: &SyntaxNode) -> bool {
    significant(node)
        .iter()
        .any(|c| c.kind == SyntaxKind::GenPrompt)
}

fn prompt_text(node: &SyntaxNode) -> Option<String> {
    if node.kind == SyntaxKind::ViewStyle {
        return significant(node)
            .iter()
            .find_map(|c| c.token().and_then(|t| t.string_value.clone()));
    }
    significant(node).iter().find_map(|c| {
        if c.kind != SyntaxKind::GenPrompt {
            return None;
        }
        significant(c)
            .iter()
            .find_map(|p| p.token().and_then(|t| t.string_value.clone()))
    })
}

fn profile_text(node: &SyntaxNode, text: &str) -> Option<String> {
    significant(node).iter().find_map(|c| {
        if c.kind != SyntaxKind::Attribute {
            return None;
        }
        let parts = significant(c);
        if parts.len() >= 2 && parts[0].token().map(|t| t.text(text)) == Some("agent") {
            return names(parts[1], text)
                .into_iter()
                .next()
                .or_else(|| parts[1].token().map(|t| t.text(text).to_string()));
        }
        None
    })
}

/// Whitespace-collapsed source text of a node.
fn flat(node: &SyntaxNode, text: &str) -> String {
    text[node.span.start as usize..node.span.end as usize]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Attribute value for `key=` on a control node, if present.
fn attribute_value<'a>(node: &'a SyntaxNode, text: &str, key: &str) -> Option<&'a SyntaxNode> {
    significant(node).iter().find_map(|c| {
        if c.kind != SyntaxKind::Attribute {
            return None;
        }
        let parts = significant(c);
        if parts.len() >= 2 && parts[0].token().map(|t| t.text(text)) == Some(key) {
            Some(parts[1])
        } else {
            None
        }
    })
}

/// Field names from a `fields=` selector list (`Selectors > Path > Name`).
fn selector_fields(node: &SyntaxNode, text: &str) -> Vec<String> {
    if node.kind != SyntaxKind::Selectors {
        // A single `fields=title` still parses as one selector path.
        if node.kind == SyntaxKind::Path {
            return names(node, text);
        }
        return Vec::new();
    }
    significant(node)
        .iter()
        .filter(|c| c.kind == SyntaxKind::Path)
        .flat_map(|p| names(p, text))
        .collect()
}

/// Operation text for `form`/`action` (`Todo.create`, possibly member path).
fn operation_text(node: &SyntaxNode, text: &str) -> String {
    flat(node, text).replace(' ', "")
}

/// Collect model names declared in the file.
///
/// Leading `export` markers are declaration heads, not names (mirrors the
/// checker's `Model => &["export"]` posture): `export Task` declares
/// `Task`, and an unskipped head would silently drop every prompted view
/// over an exported row model.
fn collect_models(tree: &SyntaxNode, text: &str) -> HashSet<String> {
    tree.descendants()
        .filter(|n| n.kind == SyntaxKind::Model)
        .filter_map(|n| names(n, text).into_iter().find(|w| w != "export"))
        .collect()
}

/// Lower every prompted view in one parsed file. The parser already admits
/// canonical cards, controls, presentation leaves and direct gates, plus one
/// root style suffix; this step checks the row target and exposes the renderer
/// contract. Card descendants keep their ordinary checked UI profiles.
fn lower_composed_modules(tree: &SyntaxNode, text: &str) -> Option<ThenLowering> {
    // A composed file has independent app/package namespaces. Row targets
    // and view anchors belong to the declaration that contains each view.
    if matches!(tree.kind, SyntaxKind::App | SyntaxKind::Package) {
        return None;
    }
    let modules: Vec<_> = tree
        .children
        .iter()
        .filter(|node| matches!(node.kind, SyntaxKind::App | SyntaxKind::Package))
        .collect();
    if modules.is_empty() {
        return None;
    }
    let mut out = ThenLowering {
        views: Vec::new(),
        diagnostics: Vec::new(),
    };
    for module in modules {
        let scoped = lower_then_views(module, text);
        out.views.extend(scoped.views);
        out.diagnostics.extend(scoped.diagnostics);
    }
    Some(out)
}

// Row model from the single `row:Model` parameter.
fn view_row_model(node: &SyntaxNode, text: &str) -> String {
    let mut row_model = String::new();
    for child in significant(node) {
        if child.kind != SyntaxKind::Parameter {
            continue;
        }
        let parts: Vec<String> = child
            .descendants()
            .filter(|n| n.kind == SyntaxKind::Name)
            .filter_map(|n| n.token().map(|t| t.text(text).to_string()))
            .collect();
        if let Some(model) = parts.into_iter().nth(1) {
            row_model = model;
        }
    }
    row_model
}

fn control_binding_name(child: &SyntaxNode, text: &str) -> Option<String> {
    match child.kind {
        SyntaxKind::Card => Some("card".to_string()),
        SyntaxKind::Edit => Some("edit".to_string()),
        SyntaxKind::Form => Some(
            names(child, text)
                .into_iter()
                .next()
                .unwrap_or_else(|| "form".into()),
        ),
        SyntaxKind::UiLeaf => names(child, text)
            .into_iter()
            .next()
            .filter(|name| name != "require"),
        SyntaxKind::CatalogItem => names(child, text)
            .into_iter()
            .next()
            .filter(|name| name == "button"),
        _ => None,
    }
}

fn lower_uileaf_control(
    child: &SyntaxNode,
    text: &str,
    name: &str,
    controls: &mut Vec<ThenControl>,
    leaves: &mut Vec<String>,
    gates: &mut Vec<String>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let word = names(child, text).into_iter().next().unwrap_or_default();
    match word.as_str() {
        "primary" | "secondary" => diagnostics.push(Diagnostic::error("E2001", "a generated view must declare an owning card or supported action owner around priorities".into(), child.span)),
        "delete" => controls.push(ThenControl::Delete),
        "action" => {
            let operation = significant(child)
                .iter()
                .find(|c| c.kind != SyntaxKind::Name)
                .map(|c| operation_text(c, text))
                .unwrap_or_default();
            controls.push(ThenControl::Action { operation });
        }
        "actions" => {
            let operations = significant(child)
                .iter()
                .filter(|c| c.kind != SyntaxKind::Name)
                .map(|c| operation_text(c, text))
                .collect();
            controls.push(ThenControl::Actions { operations });
        }
        "require" => {
            let predicate = significant(child)
                .iter()
                .find(|c| c.kind != SyntaxKind::Name)
                .map(|c| flat(c, text))
                .unwrap_or_default();
            gates.push(predicate);
        }
        "history" | "text" | "content" => leaves.push(word),
        other => diagnostics.push(Diagnostic::error(
            "E2001",
            format!(
                "view `{name}` admits no `{other}` child in a prompted renderer"
            ),
            child.span,
        )),
    }
}

fn lower_child_control(
    child: &SyntaxNode,
    text: &str,
    name: &str,
    controls: &mut Vec<ThenControl>,
    leaves: &mut Vec<String>,
    gates: &mut Vec<String>,
    root_style: &mut Option<ThenRootStyle>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    match child.kind {
        SyntaxKind::Card => {
            leaves.push("card".into());
            collect_card_controls(child, text, controls);
        }
        SyntaxKind::Edit => {
            let fields = attribute_value(child, text, "fields")
                .map(|v| selector_fields(v, text))
                .unwrap_or_default();
            controls.push(ThenControl::Edit { fields });
        }
        SyntaxKind::CatalogItem
            if names(child, text).first().map(String::as_str) == Some("button") =>
        {
            collect_button_control(child, text, controls);
        }
        SyntaxKind::Form => {
            let priority = names(child, text).into_iter().next().unwrap_or_default();
            if matches!(priority.as_str(), "primary" | "secondary") {
                diagnostics.push(Diagnostic::error("E2001", "a generated view must declare an owning card or supported action owner around priorities".into(), child.span));
            }
            let operation = attribute_value(child, text, "action")
                .or_else(|| {
                    significant(child)
                        .iter()
                        .find(|c| {
                            !matches!(c.kind, SyntaxKind::Name | SyntaxKind::Attribute)
                        })
                        .copied()
                })
                .map(|c| operation_text(c, text))
                .unwrap_or_default();
            let fields = attribute_value(child, text, "fields")
                .map(|v| selector_fields(v, text))
                .unwrap_or_default();
            controls.push(ThenControl::Form { operation, fields });
        }
        SyntaxKind::UiLeaf => {
            lower_uileaf_control(child, text, name, controls, leaves, gates, diagnostics);
        }
        SyntaxKind::ViewStyle => {
            let style_names = names(child, text);
            if let Some(inline) = prompt_text(child) {
                *root_style = Some(ThenRootStyle {
                    named: None,
                    inline_prompt: Some(inline),
                });
            } else if let Some(style) = style_names.into_iter().next() {
                *root_style = Some(ThenRootStyle {
                    named: Some(style),
                    inline_prompt: None,
                });
            }
        }
        SyntaxKind::Name
        | SyntaxKind::Parameter
        | SyntaxKind::GenPrompt
        | SyntaxKind::Attribute
        | SyntaxKind::Error => {}
        _ => {
            diagnostics.push(Diagnostic::error(
                "E2001",
                format!(
                    "view `{name}` admits only canonical cards, controls, history/text/content leaves, require gates and one root style suffix"
                ),
                child.span,
            ));
        }
    }
}

fn lower_view_node(
    node: &SyntaxNode,
    text: &str,
    models: &HashSet<String>,
    owner: &str,
    views: &mut Vec<ThenView>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let ns = names(node, text);
    let name = ns.get(1).cloned().unwrap_or_default();
    let prompt = prompt_text(node).unwrap_or_default();
    let profile = profile_text(node, text);
    let row_model = view_row_model(node, text);
    if !models.contains(&row_model) {
        diagnostics.push(Diagnostic::error(
            "E2001",
            format!("view `{name}` binds unknown model `{row_model}` as its row"),
            node.span,
        ));
        return;
    }
    let mut controls = Vec::new();
    let mut binding_names = Vec::new();
    let mut gates = Vec::new();
    let mut leaves = Vec::new();
    let mut root_style: Option<ThenRootStyle> = None;
    for child in significant(node) {
        if let Some(binding) = control_binding_name(child, text) {
            binding_names.push((child.span, binding));
        }
        lower_child_control(
            child,
            text,
            &name,
            &mut controls,
            &mut leaves,
            &mut gates,
            &mut root_style,
            diagnostics,
        );
    }
    views.push(ThenView {
        anchor: format!("{owner}:view:{name}:{row_model}"),
        name,
        row_model,
        prompt,
        profile,
        controls,
        binding_names,
        gates,
        leaves,
        root_style,
        span: node.span,
    });
}

pub fn lower_then_views(tree: &SyntaxNode, text: &str) -> ThenLowering {
    if let Some(out) = lower_composed_modules(tree, text) {
        return out;
    }
    let mut views = Vec::new();
    let mut diagnostics = Vec::new();
    let models = collect_models(tree, text);
    let owner = module_owner(tree, text);
    for node in tree.descendants() {
        if node.kind != SyntaxKind::View || !has_prompt(node) {
            continue;
        }
        lower_view_node(node, text, &models, &owner, &mut views, &mut diagnostics);
    }
    ThenLowering { views, diagnostics }
}

/// Action buttons lower to protected forms, but retain their source-owned
/// `button` binding name. Navigation/panel buttons add no mutation metadata.
fn collect_button_control(button: &SyntaxNode, text: &str, controls: &mut Vec<ThenControl>) {
    if let Some(operation) = attribute_value(button, text, "action") {
        controls.push(ThenControl::Action {
            operation: operation_text(operation, text),
        });
    }
}

/// Card control metadata describes the canonical subtree; only the whole
/// card is a renderer binding. Local gates stay on their owning IR nodes.
fn collect_card_controls(card: &SyntaxNode, text: &str, controls: &mut Vec<ThenControl>) {
    for child in card.descendants() {
        match child.kind {
            SyntaxKind::CatalogItem
                if names(child, text).first().map(String::as_str) == Some("button") =>
            {
                collect_button_control(child, text, controls);
            }
            SyntaxKind::Edit => controls.push(ThenControl::Edit {
                fields: attribute_value(child, text, "fields")
                    .map(|value| selector_fields(value, text))
                    .unwrap_or_default(),
            }),
            SyntaxKind::Form => {
                let word = names(child, text).into_iter().next().unwrap_or_default();
                if word == "primary" {
                    controls.push(ThenControl::Primary);
                }
                if word == "secondary" {
                    controls.push(ThenControl::Secondary);
                }
                let operation = attribute_value(child, text, "action")
                    .or_else(|| {
                        significant(child).into_iter().find(|node| {
                            !matches!(node.kind, SyntaxKind::Name | SyntaxKind::Attribute)
                        })
                    })
                    .map(|node| operation_text(node, text))
                    .unwrap_or_default();
                let fields = attribute_value(child, text, "fields")
                    .map(|value| selector_fields(value, text))
                    .unwrap_or_default();
                controls.push(ThenControl::Form { operation, fields });
            }
            SyntaxKind::UiLeaf => match names(child, text).into_iter().next().as_deref() {
                Some("primary") => controls.push(ThenControl::Primary),
                Some("secondary") => controls.push(ThenControl::Secondary),
                Some("delete") => controls.push(ThenControl::Delete),
                Some("action") => controls.push(ThenControl::Action {
                    operation: significant(child)
                        .into_iter()
                        .find(|node| node.kind != SyntaxKind::Name)
                        .map(|node| operation_text(node, text))
                        .unwrap_or_default(),
                }),
                Some("actions") => controls.push(ThenControl::Actions {
                    operations: significant(child)
                        .into_iter()
                        .filter(|node| node.kind != SyntaxKind::Name)
                        .map(|node| operation_text(node, text))
                        .collect(),
                }),
                _ => {}
            },
            _ => {}
        }
    }
}

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

/// Instance identity for one `show` use site. Mirrors the ordinary
/// `can-view-m..-f..-s..` occurrence so each repeated instance keeps a
/// separate root/hook identity under the shared saved renderer.
pub fn view_instance_id(module: u32, span: Span) -> String {
    format!("can-view-m{}-f{}-s{}", module, span.file.0, span.start)
}

/// Walk checked trait/keyword/style/view uses for inspection: every edge
/// carries its definition anchor and the use site/owner. Computed from the
/// descriptors plus `show` references on demand; no persistent index.
pub fn walk_generation_uses(
    tree: &SyntaxNode,
    text: &str,
    descriptors: &[GenerationDescriptor],
) -> Vec<UseEdge> {
    // Bare labels resolve only inside their owning app/package namespace.
    if !matches!(tree.kind, SyntaxKind::App | SyntaxKind::Package) {
        let modules: Vec<_> = tree
            .children
            .iter()
            .filter(|node| matches!(node.kind, SyntaxKind::App | SyntaxKind::Package))
            .collect();
        if !modules.is_empty() {
            let mut edges = Vec::new();
            for module in modules {
                let scoped: Vec<_> = descriptors
                    .iter()
                    .filter(|descriptor| {
                        descriptor.span.file == module.span.file
                            && descriptor.span.start >= module.span.start
                            && descriptor.span.end <= module.span.end
                    })
                    .cloned()
                    .collect();
                edges.extend(walk_generation_uses(module, text, &scoped));
            }
            edges.sort_by(|a, b| {
                (a.definition_anchor.as_str(), a.use_span.start)
                    .cmp(&(b.definition_anchor.as_str(), b.use_span.start))
            });
            return edges;
        }
    }
    let mut defs: HashMap<(GenerationKind, String), &GenerationDescriptor> = HashMap::new();
    for descriptor in descriptors {
        let label = descriptor.label.clone().unwrap_or_default();
        match descriptor.kind {
            GenerationKind::NamedTrait
            | GenerationKind::KeywordDefinition
            | GenerationKind::StyleDefinition
            | GenerationKind::ViewDefinition => {
                defs.insert((descriptor.kind, label), descriptor);
            }
            _ => {}
        }
    }
    let mut edges = Vec::new();
    for descriptor in descriptors {
        let label = descriptor.label.clone().unwrap_or_default();
        let target = match descriptor.kind {
            GenerationKind::TraitApplication => {
                defs.get(&(GenerationKind::NamedTrait, label)).copied()
            }
            GenerationKind::KeywordApplication => defs
                .get(&(GenerationKind::KeywordDefinition, label))
                .copied(),
            GenerationKind::StyleNamedUse | GenerationKind::ViewRootStyleNamed => {
                defs.get(&(GenerationKind::StyleDefinition, label)).copied()
            }
            _ => None,
        };
        if let Some(definition) = target {
            edges.push(UseEdge {
                definition_anchor: definition.anchor.clone(),
                definition_label: definition.label.clone().unwrap_or_default(),
                definition_kind: definition.kind,
                use_span: descriptor.span,
                host: host_of(descriptor),
                owner: descriptor.owner.clone(),
            });
        }
    }
    // `show` references to prompted views are the view use edges.
    let views: HashMap<String, &GenerationDescriptor> = descriptors
        .iter()
        .filter(|d| d.kind == GenerationKind::ViewDefinition)
        .map(|d| (d.label.clone().unwrap_or_default(), d))
        .collect();
    for node in tree.descendants() {
        if node.kind != SyntaxKind::Show {
            continue;
        }
        let name = names(node, text).into_iter().nth(1).unwrap_or_default();
        if let Some(definition) = views.get(&name) {
            edges.push(UseEdge {
                definition_anchor: definition.anchor.clone(),
                definition_label: name,
                definition_kind: GenerationKind::ViewDefinition,
                use_span: node.span,
                host: "Show".to_string(),
                owner: definition.owner.clone(),
            });
        }
    }
    edges.sort_by(|a, b| {
        (a.definition_anchor.clone(), a.use_span.start)
            .cmp(&(b.definition_anchor.clone(), b.use_span.start))
    });
    edges
}

/// Host description for a use edge: the styled host for style uses, the
/// attached model/field for trait uses, the Given section for keywords.
/// Style anchors carry the host after `owner:kind:name:`; the host itself
/// may contain `:` (`Show:TaskTile`), so only the first three segments
/// are stripped.
fn host_of(descriptor: &GenerationDescriptor) -> String {
    match descriptor.kind {
        GenerationKind::TraitApplication => descriptor.target.clone().unwrap_or_default(),
        GenerationKind::KeywordApplication => "Given".to_string(),
        _ => {
            let mut parts = descriptor.anchor.splitn(4, ':');
            parts.next();
            parts.next();
            parts.next();
            parts.next().unwrap_or_default().to_string()
        }
    }
}

/// Collect the Then prompt set a manual full-app retry regenerates: named
/// style definitions, inline attachments, prompted views, and
/// definition-owned inline root styles. Named definitions appear once no
/// matter how many uses they carry.
pub fn collect_then_prompts(descriptors: &[GenerationDescriptor]) -> Vec<ThenPrompt> {
    let mut prompts = Vec::new();
    for descriptor in descriptors {
        let prompt = match descriptor.kind {
            GenerationKind::StyleDefinition
            | GenerationKind::StyleInline
            | GenerationKind::ViewDefinition
            | GenerationKind::ViewRootStyleInline => descriptor.prompt.clone().unwrap_or_default(),
            _ => continue,
        };
        prompts.push(ThenPrompt {
            anchor: descriptor.anchor.clone(),
            kind: descriptor.kind,
            label: descriptor.label.clone().unwrap_or_default(),
            prompt,
            profile: descriptor.profile.clone(),
        });
    }
    prompts.sort_by(|a, b| a.anchor.cmp(&b.anchor));
    prompts
}

/// Checked style-use contracts for the generation pipeline: each named or
/// inline use binds the owning unit's saved CSS to a compiler-owned root
/// hook after a host compatibility check.
pub fn style_use_contracts(
    descriptors: &[GenerationDescriptor],
) -> (Vec<ThenUseContract>, Vec<Diagnostic>) {
    let mut units: HashMap<String, &GenerationDescriptor> = HashMap::new();
    for descriptor in descriptors {
        if descriptor.kind == GenerationKind::StyleDefinition {
            units.insert(descriptor.label.clone().unwrap_or_default(), descriptor);
        }
    }
    let mut contracts = Vec::new();
    let mut diagnostics = Vec::new();
    for descriptor in descriptors {
        match descriptor.kind {
            GenerationKind::StyleNamedUse | GenerationKind::ViewRootStyleNamed => {
                let name = descriptor.label.clone().unwrap_or_default();
                let Some(unit) = units.get(&name) else {
                    // BGI-01 already diagnosed the unknown style; no edge.
                    continue;
                };
                let host = host_of(descriptor);
                // A view-root style binds the renderer root by construction.
                let compatible = descriptor.kind == GenerationKind::ViewRootStyleNamed
                    || crate::css_scope::compatible_style_host(&host);
                if !compatible {
                    diagnostics.push(Diagnostic::error(
                        "E2001",
                        format!("style `{name}` cannot attach to nonvisual host `{host}`"),
                        descriptor.span,
                    ));
                }
                contracts.push(ThenUseContract {
                    unit_anchor: unit.anchor.clone(),
                    style_name: name,
                    use_span: descriptor.span,
                    host,
                    compatible,
                });
            }
            GenerationKind::StyleInline | GenerationKind::ViewRootStyleInline => {
                let host = host_of(descriptor);
                let compatible = descriptor.kind == GenerationKind::ViewRootStyleInline
                    || crate::css_scope::compatible_style_host(&host);
                if !compatible {
                    diagnostics.push(Diagnostic::error(
                        "E2001",
                        "inline style cannot attach to a nonvisual host".to_string(),
                        descriptor.span,
                    ));
                }
                contracts.push(ThenUseContract {
                    unit_anchor: descriptor.anchor.clone(),
                    style_name: String::new(),
                    use_span: descriptor.span,
                    host,
                    compatible,
                });
            }
            _ => {}
        }
    }
    contracts.sort_by_key(|a| a.use_span.start);
    (contracts, diagnostics)
}
