//! BGI-10 scoped CSS parsing and ownership enforcement.
//!
//! Generated and directly edited style CSS pass through this one path. The
//! maintained Servo `cssparser` crate tokenizes and structures the sheet;
//! this module adds Can ownership: every element-matching selector compound
//! gains a `[data-can-style~="<unit>"]` guard, local keyframes and custom
//! properties are namespaced per unit, and global/child-interior/URL
//! escapes refuse. Shared theme variables stay readable but not
//! redefinable. Output is a canonical serialization, so ordinary builds
//! and generation checks observe identical bytes for identical intent.

use cssparser::{
    AtRuleParser, CowRcStr, DeclarationParser, ParseError, ParseErrorKind, Parser, ParserState,
    QualifiedRuleParser, RuleBodyItemParser, RuleBodyParser, SourceLocation, StyleSheetParser,
    ToCss, Token, parse_important,
};
use std::collections::HashSet;
use std::fmt::Write as _;

/// Version of the scope contract shared with the UI hook emitters.
pub const CSS_SCOPE_VERSION: &str = "canlang.css-scope/1";
/// Ownership marker; the value is the owning unit, nearest first. A child
/// host carries its own unit here plus the parent unit in [`STYLE_HOST_ATTR`].
pub const STYLE_OWNERSHIP_ATTR: &str = "data-can-style";
/// Per-use root hook; the value is `<unit>:<use>` for one style use site.
pub const STYLE_ROOT_ATTR: &str = "data-can-style-root";
/// Child-host hook; the value is the parent unit allowed to place the host.
pub const STYLE_HOST_ATTR: &str = "data-can-style-host";

/// Shared readable theme variables from `packages/ui/themes.css`. A local
/// style may read these through `var()` but cannot define them; every other
/// `--*` definition is unit-local and namespaced. The BGI-09/10 test pins
/// this list against the theme file so drift fails loudly.
pub const SHARED_THEME_VARS: &[&str] = &[
    "--border",
    "--color-accent",
    "--color-accent-content",
    "--color-base-100",
    "--color-base-200",
    "--color-base-300",
    "--color-base-content",
    "--color-error",
    "--color-error-content",
    "--color-info",
    "--color-info-content",
    "--color-neutral",
    "--color-neutral-content",
    "--color-primary",
    "--color-primary-content",
    "--color-secondary",
    "--color-secondary-content",
    "--color-success",
    "--color-success-content",
    "--color-warning",
    "--color-warning-content",
    "--depth",
    "--noise",
    "--radius-box",
    "--radius-field",
    "--radius-selector",
    "--size-field",
    "--size-selector",
];

/// One deterministic scope refusal with its CSS source position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CssError {
    pub code: &'static str,
    pub message: String,
    pub line: u32,
    pub column: u32,
}

/// Scoped output plus the checked facts the generation pipeline consumes:
/// namespaced keyframes/properties, shared theme reads, and owned assets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedStylesheet {
    pub css: String,
    pub keyframes: Vec<String>,
    pub properties: Vec<String>,
    pub theme_reads: Vec<String>,
    pub assets: Vec<String>,
}

#[derive(Debug, Clone)]
struct ScopeError {
    code: &'static str,
    message: String,
    line: u32,
    column: u32,
}

/// Scope one unit's CSS. `unit_id` is the opaque `can.generated` unit id
/// (`u7`); it lands in attribute guards and local namespaces, so only
/// `[a-z0-9][a-z0-9-]*` is admitted.
pub fn scope_stylesheet(unit_id: &str, css: &str) -> Result<ScopedStylesheet, Vec<CssError>> {
    scope_stylesheet_with_asset_routes(unit_id, css, false)
}

/// Emit host-owned deployment routes after ordinary owned-URL admission.
pub fn scope_deployed_stylesheet(unit_id: &str, css: &str) -> Result<ScopedStylesheet, Vec<CssError>> {
    scope_stylesheet_with_asset_routes(unit_id, css, true)
}

fn scope_stylesheet_with_asset_routes(unit_id: &str, css: &str, deploy_assets: bool) -> Result<ScopedStylesheet, Vec<CssError>> {
    if !is_unit_id(unit_id) {
        return Err(vec![CssError {
            code: "E2101",
            message: format!("invalid style unit id {unit_id:?}"),
            line: 1,
            column: 1,
        }]);
    }
    // Pass one collects local keyframes names so `animation`/`animation-name`
    // references rewrite even when they precede their definition.
    let keyframes = collect_keyframe_names(css)?;
    let mut scoper = Scoper::new(unit_id, keyframes);
    scoper.deploy_assets = deploy_assets;
    let mut parser = Parser::new(css);
    let mut out = String::new();
    let mut errors: Vec<CssError> = Vec::new();
    for item in StyleSheetParser::new(&mut parser, &mut scoper) {
        match item {
            Ok(rule) => {
                out.push_str(&rule);
                out.push('\n');
            }
            Err((error, _, location)) => errors.push(css_error(error, location)),
        }
    }
    // Surface declaration/nesting failures recorded inside rule bodies.
    errors.append(&mut scoper.errors);
    if !errors.is_empty() {
        errors.sort_by(|a, b| (a.line, a.column, a.code).cmp(&(b.line, b.column, b.code)));
        errors.dedup();
        return Err(errors);
    }
    // Keyframes/properties/theme/assets were recorded during the walk.
    let mut scoped = ScopedStylesheet {
        css: out,
        keyframes: scoper.keyframes_defined.into_iter().collect(),
        properties: scoper.properties_defined.into_iter().collect(),
        theme_reads: scoper.theme_reads.into_iter().collect(),
        assets: scoper.assets.into_iter().collect(),
    };
    scoped.keyframes.sort();
    scoped.properties.sort();
    scoped.theme_reads.sort();
    scoped.assets.sort();
    Ok(scoped)
}

/// Rendered hook attributes for one named-style use root. The root belongs
/// to the unit and carries the per-use hook; interior elements inherit the
/// unit marker from their owning factory.
pub fn style_use_attributes(unit_id: &str, use_id: &str) -> String {
    format!("{STYLE_OWNERSHIP_ATTR}=\"{unit_id}\" {STYLE_ROOT_ATTR}=\"{unit_id}:{use_id}\"")
}

/// Rendered hook attributes for a nested child root. The host element
/// belongs to the child unit and exposes the parent hook so parent rules
/// match the host's placement but structurally cannot reach its interior:
/// interior elements carry neither the parent guard nor the host hook.
pub fn style_host_attributes(child_unit: &str, parent_unit: &str) -> String {
    format!("{STYLE_OWNERSHIP_ATTR}=\"{child_unit}\" {STYLE_HOST_ATTR}=\"{parent_unit}\"")
}

/// Whether a BGI-01 style-use host kind may carry a style attachment. The
/// parser already refuses nonvisual `require` attachments; this closed list
/// keeps the contract explicit at the use site.
pub fn compatible_style_host(host: &str) -> bool {
    matches!(
        host.split(':').next().unwrap_or_default(),
        "Page"
            | "Card"
            | "Details"
            | "Collection"
            | "Form"
            | "Edit"
            | "Show"
            | "CatalogItem"
            | "UiLeaf"
            | "Tab"
            | "Tabs"
    )
}

fn is_unit_id(unit_id: &str) -> bool {
    let mut chars = unit_id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn css_error(error: ParseError<ScopeError>, location: SourceLocation) -> CssError {
    match error.kind {
        ParseErrorKind::Custom(custom) => CssError {
            code: custom.code,
            message: custom.message,
            line: custom.line,
            column: custom.column,
        },
        ParseErrorKind::Basic(basic) => CssError {
            code: "E2100",
            message: format!("invalid CSS: {basic:?}"),
            line: location.line + 1,
            column: location.column + 1,
        },
    }
}

fn custom<T>(
    parser: &Parser,
    code: &'static str,
    message: String,
) -> Result<T, ParseError<ScopeError>> {
    let location = parser.current_source_location();
    Err(ParseError {
        kind: ParseErrorKind::Custom(ScopeError {
            code,
            message,
            line: location.line + 1,
            column: location.column + 1,
        }),
    })
}

/// Body mode for the shared rule-body parser: style bodies admit nested
/// style rules (CSS nesting); keyframes and `@property` bodies admit
/// declarations only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyMode {
    Style,
    Keyframes,
    Keyframe,
    Property,
}

struct Scoper {
    unit: String,
    guard: String,
    /// Local keyframes names collected in pass one (unnamespaced).
    keyframes_known: HashSet<String>,
    keyframes_defined: HashSet<String>,
    properties_defined: HashSet<String>,
    theme_reads: HashSet<String>,
    assets: HashSet<String>,
    deploy_assets: bool,
    /// Declaration/nesting failures inside otherwise kept rules.
    errors: Vec<CssError>,
    mode: BodyMode,
    keyframe_prelude: bool,
    depth: usize,
    /// Enclosing style rules; only they admit the `&` nesting selector.
    style_nesting: usize,
}

impl Scoper {
    fn new(unit_id: &str, keyframes: Vec<String>) -> Self {
        Scoper {
            unit: unit_id.to_string(),
            // `:where` keeps the guard specificity-free. The host
            // alternative lets parent rules place child hosts; the host
            // element carries it, its interior carries neither marker.
            guard: format!(
                ":where([{STYLE_OWNERSHIP_ATTR}~=\"{unit_id}\"],\
                 [{STYLE_HOST_ATTR}~=\"{unit_id}\"])"
            ),
            keyframes_known: keyframes.into_iter().collect(),
            keyframes_defined: HashSet::new(),
            properties_defined: HashSet::new(),
            theme_reads: HashSet::new(),
            assets: HashSet::new(),
            deploy_assets: false,
            errors: Vec::new(),
            mode: BodyMode::Style,
            keyframe_prelude: false,
            depth: 0,
            style_nesting: 0,
        }
    }

    fn namespaced(&self, name: &str) -> String {
        format!("u{}-{name}", self.unit)
    }

    fn namespaced_property(&self, name: &str) -> String {
        format!("--u{}-{}", self.unit, &name[2..])
    }

    fn indent(&self) -> String {
        "  ".repeat(self.depth)
    }

    fn root_marker(&self) -> String {
        format!(":is([{STYLE_ROOT_ATTR}^=\"{0}:\"],[{STYLE_ROOT_ATTR}*=\" {0}:\"]){1}", self.unit, self.guard)
    }
}

/// Pass one: collect local `@keyframes` names (including conditional ones
/// nested in `@media`) so animation references rewrite deterministically.
/// Bodies are skipped; the main pass reports structural failures.
fn collect_keyframe_names(css: &str) -> Result<Vec<String>, Vec<CssError>> {
    struct Collector {
        names: Vec<String>,
    }
    enum Prelude {
        Keyframes,
        Skip,
    }
    impl<'i> AtRuleParser<'i> for Collector {
        type Prelude = Prelude;
        type AtRule = ();
        type Error = ScopeError;
        fn parse_prelude(
            &mut self,
            name: CowRcStr<'i>,
            input: &mut Parser<'i>,
        ) -> Result<Prelude, ParseError<ScopeError>> {
            if name.eq_ignore_ascii_case("keyframes") {
                let key = input.expect_ident_or_string()?.to_string();
                self.names.push(key);
                Ok(Prelude::Keyframes)
            } else {
                // Skip any other prelude; the main pass validates it.
                while input.next().is_ok() {}
                Ok(Prelude::Skip)
            }
        }
        fn parse_block(
            &mut self,
            _prelude: Prelude,
            _start: &ParserState,
            input: &mut Parser<'i>,
        ) -> Result<(), ParseError<ScopeError>> {
            // Recurse so conditional `@media` bodies still expose names.
            let mut inner = StyleSheetParser::new(input, self);
            while inner.next().is_some() {}
            Ok(())
        }
        fn rule_without_block(
            &mut self,
            _prelude: Prelude,
            _start: &ParserState,
        ) -> Result<(), ()> {
            Ok(())
        }
    }
    impl<'i> QualifiedRuleParser<'i> for Collector {
        type Prelude = ();
        type QualifiedRule = ();
        type Error = ScopeError;
    }
    let mut collector = Collector { names: Vec::new() };
    let mut parser = Parser::new(css);
    let mut rules = StyleSheetParser::new(&mut parser, &mut collector);
    // The collector never fails; drain to completion.
    while rules.next().is_some() {}
    Ok(collector.names)
}

enum AtPrelude {
    Condition { name: String, prelude: String },
    Keyframes { name: String },
    Property { name: String },
}

impl<'i> AtRuleParser<'i> for Scoper {
    type Prelude = AtPrelude;
    type AtRule = String;
    type Error = ScopeError;

    fn parse_prelude(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
    ) -> Result<AtPrelude, ParseError<ScopeError>> {
        if name.eq_ignore_ascii_case("media")
            || name.eq_ignore_ascii_case("supports")
            || name.eq_ignore_ascii_case("container")
        {
            let scope_selectors = name.eq_ignore_ascii_case("supports");
            let prelude = serialize_condition_prelude(input, self, scope_selectors)?;
            return Ok(AtPrelude::Condition {
                name: name.to_ascii_lowercase(),
                prelude,
            });
        }
        if name.eq_ignore_ascii_case("keyframes") {
            let key = input.expect_ident_or_string()?.to_string();
            input.expect_exhausted()?;
            let namespaced = self.namespaced(&key);
            self.keyframes_defined.insert(namespaced.clone());
            return Ok(AtPrelude::Keyframes { name: namespaced });
        }
        if name.eq_ignore_ascii_case("property") {
            let property = input.expect_ident()?.to_string();
            input.expect_exhausted()?;
            if !property.starts_with("--") {
                return custom(
                    input,
                    "E2105",
                    format!("@property name {property:?} must be a custom property"),
                );
            }
            if SHARED_THEME_VARS.contains(&property.as_str()) {
                return custom(
                    input,
                    "E2105",
                    format!("{property} is a shared theme variable and cannot be redefined"),
                );
            }
            let namespaced = self.namespaced_property(&property);
            self.properties_defined.insert(namespaced.clone());
            return Ok(AtPrelude::Property { name: namespaced });
        }
        if name.eq_ignore_ascii_case("import") {
            return custom(
                input,
                "E2106",
                "remote @import is not admitted in scoped styles".to_string(),
            );
        }
        if name.eq_ignore_ascii_case("font-face") {
            return custom(
                input,
                "E2106",
                "@font-face is not admitted; use existing theme/system fonts".to_string(),
            );
        }
        custom(
            input,
            "E2106",
            format!("unsupported at-rule @{name} in scoped styles"),
        )
    }

    fn parse_block(
        &mut self,
        prelude: AtPrelude,
        _start: &ParserState,
        input: &mut Parser<'i>,
    ) -> Result<String, ParseError<ScopeError>> {
        let indent = self.indent();
        self.depth += 1;
        let saved = self.mode;
        let saved_keyframe = self.keyframe_prelude;
        let rendered = match prelude {
            AtPrelude::Condition { name, prelude } => {
                self.mode = BodyMode::Style;
                self.keyframe_prelude = false;
                let body = self.parse_rule_body(input);
                format!("{indent}@{name} {prelude} {{\n{body}{indent}}}\n")
            }
            AtPrelude::Keyframes { name } => {
                self.mode = BodyMode::Keyframes;
                self.keyframe_prelude = true;
                let body = self.parse_rule_body(input);
                format!("{indent}@keyframes {name} {{\n{body}{indent}}}\n")
            }
            AtPrelude::Property { name } => {
                self.mode = BodyMode::Property;
                self.keyframe_prelude = false;
                let body = self.parse_rule_body(input);
                format!("{indent}@property {name} {{\n{body}{indent}}}\n")
            }
        };
        self.mode = saved;
        self.keyframe_prelude = saved_keyframe;
        self.depth -= 1;
        Ok(rendered)
    }

    fn rule_without_block(
        &mut self,
        _prelude: AtPrelude,
        _start: &ParserState,
    ) -> Result<String, ()> {
        // Supported at-rules all require blocks; the prelude parser already
        // refused `@import`/`@font-face`/unknown names.
        Err(())
    }
}

impl<'i> QualifiedRuleParser<'i> for Scoper {
    type Prelude = String;
    type QualifiedRule = String;
    type Error = ScopeError;

    fn parse_prelude(&mut self, input: &mut Parser<'i>) -> Result<String, ParseError<ScopeError>> {
        if self.keyframe_prelude {
            parse_keyframe_prelude(input)
        } else {
            parse_selector_list(input, self)
        }
    }

    fn parse_block(
        &mut self,
        prelude: String,
        _start: &ParserState,
        input: &mut Parser<'i>,
    ) -> Result<String, ParseError<ScopeError>> {
        let indent = self.indent();
        self.depth += 1;
        let saved = self.mode;
        // Keyframe selectors carry declaration bodies without nesting.
        let style_rule = self.mode == BodyMode::Style;
        if self.mode == BodyMode::Keyframes {
            self.mode = BodyMode::Keyframe;
        }
        if style_rule {
            self.style_nesting += 1;
        }
        let body = self.parse_rule_body(input);
        if style_rule {
            self.style_nesting -= 1;
        }
        self.mode = saved;
        self.depth -= 1;
        Ok(format!("{indent}{prelude} {{\n{body}{indent}}}\n"))
    }
}

impl<'i> DeclarationParser<'i> for Scoper {
    type Declaration = String;
    type Error = ScopeError;

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _start: &ParserState,
    ) -> Result<String, ParseError<ScopeError>> {
        let rendered_name = if name.starts_with("--") {
            if SHARED_THEME_VARS.contains(&name.as_ref()) {
                return custom(
                    input,
                    "E2105",
                    format!("{name} is a shared theme variable and cannot be redefined"),
                );
            }
            let namespaced = self.namespaced_property(&name);
            self.properties_defined.insert(namespaced.clone());
            namespaced
        } else {
            name.to_string()
        };
        let animate =
            name.eq_ignore_ascii_case("animation-name") || name.eq_ignore_ascii_case("animation");
        let value = transform_value(input, self, animate)?;
        let important = input.try_parse(parse_important).is_ok();
        input.expect_exhausted()?;
        let indent = self.indent();
        Ok(format!(
            "{indent}{rendered_name}: {value}{};\n",
            if important { " !important" } else { "" }
        ))
    }
}

impl<'i> RuleBodyItemParser<'i, String, ScopeError> for Scoper {
    fn parse_declarations(&self) -> bool {
        // A `@keyframes` body holds keyframe rules only; `from`/`to` are
        // preludes there, never declarations.
        !matches!(self.mode, BodyMode::Keyframes)
    }
    fn parse_qualified(&self) -> bool {
        matches!(self.mode, BodyMode::Style | BodyMode::Keyframes)
    }
}

impl Scoper {
    fn parse_rule_body(&mut self, input: &mut Parser) -> String {
        let mut body = String::new();
        let mut failed: Vec<CssError> = Vec::new();
        for item in RuleBodyParser::new(input, self) {
            match item {
                Ok(rendered) => body.push_str(&rendered),
                Err((error, _, location)) => failed.push(css_error(error, location)),
            }
        }
        self.errors.extend(failed);
        body
    }
}

/// Type selectors that escape the unit: the document root and its shell.
/// Ordinary element names stay local through the ownership guard.
fn is_global_type(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "html" | "head" | "body")
}

/// Parse a comma-separated selector list, guarding every compound.
fn parse_selector_list(
    input: &mut Parser,
    scope: &mut Scoper,
) -> Result<String, ParseError<ScopeError>> {
    let mut out = String::new();
    let mut first = true;
    loop {
        input.skip_whitespace();
        if input.is_exhausted() {
            break;
        }
        if !first {
            out.push_str(", ");
        }
        first = false;
        out.push_str(&parse_complex_selector(input, scope)?);
        input.skip_whitespace();
        if input.is_exhausted() {
            break;
        }
        // `parse_complex_selector` stops before the comma or the end.
        match input.next()? {
            Token::Comma => {}
            _ => return custom(input, "E2100", "expected `,` in selector list".to_string()),
        }
    }
    if first {
        return custom(input, "E2100", "empty selector".to_string());
    }
    Ok(out)
}

/// Parse one complex selector: compounds joined by combinators. Stops
/// before a top-level comma or the prelude end, leaving it unconsumed.
fn parse_complex_selector(
    input: &mut Parser,
    scope: &mut Scoper,
) -> Result<String, ParseError<ScopeError>> {
    let mut out = String::new();
    let mut compounds = 0usize;
    // Whitespace seen since the last compound: a descendant combinator once
    // another compound follows.
    let mut pending_space = false;
    loop {
        let state = input.state();
        let token = match input.next_including_whitespace() {
            Ok(token) => token.clone(),
            Err(_) => break,
        };
        match token {
            Token::WhiteSpace(_) | Token::Comment(_) => {
                pending_space = true;
            }
            Token::Comma | Token::Semicolon | Token::CloseCurlyBracket => {
                input.reset(&state);
                break;
            }
            Token::Delim('>') | Token::Delim('+') | Token::Delim('~') => {
                if compounds == 0 {
                    return custom(
                        input,
                        "E2100",
                        "selector cannot start with a combinator".to_string(),
                    );
                }
                let key = match token {
                    Token::Delim(key) => key,
                    _ => unreachable!(),
                };
                out.push(' ');
                out.push(key);
                out.push(' ');
                pending_space = false;
                // A second combinator (or end) after this one fails in the
                // compound parser below through the empty-compound check.
                compounds = 0;
            }
            Token::Delim('|') => {
                return custom(
                    input,
                    "E2102",
                    "namespace and column combinators are not admitted in scoped styles"
                        .to_string(),
                );
            }
            _ => {
                input.reset(&state);
                if compounds > 0 && pending_space {
                    out.push(' ');
                }
                pending_space = false;
                out.push_str(&parse_compound(input, scope)?);
                compounds += 1;
            }
        }
    }
    if compounds == 0 {
        return custom(input, "E2100", "expected a selector compound".to_string());
    }
    Ok(out)
}

/// Parse one compound selector and append the ownership guard. `&` keeps
/// its nesting meaning; `:host` rewrites to the unit's use-root marker.
fn parse_pseudo_element(
    input: &mut Parser,
    scope: &mut Scoper,
    tail: &mut String,
) -> Result<(), ParseError<ScopeError>> {
    let element = input.next()?.clone();
    match element {
        Token::Ident(name) => {
            write!(tail, "::{name}").expect("selector push");
        }
        Token::Function(name) => {
            let args = input.parse_nested_block(|inner| {
                if name.eq_ignore_ascii_case("slotted") {
                    parse_compound(inner, scope)
                } else {
                    serialize_generic_block(inner, scope)
                }
            })?;
            write!(tail, "::{name}({args})").expect("selector push");
        }
        _ => {
            return custom(
                input,
                "E2100",
                "expected a pseudo-element".to_string(),
            );
        }
    }
    Ok(())
}

fn parse_pseudo_ident(
    input: &mut Parser,
    scope: &mut Scoper,
    name: String,
    head: &mut String,
    tail: &mut String,
    host_only: &mut bool,
    simple: usize,
) -> Result<(), ParseError<ScopeError>> {
    if name.eq_ignore_ascii_case("root") || name.eq_ignore_ascii_case("scope") {
        return custom(
            input,
            "E2103",
            format!(":{name} escapes the style unit"),
        );
    }
    if name.eq_ignore_ascii_case("host") {
        if simple > 0 || !tail.is_empty() {
            return custom(
                input,
                "E2100",
                ":host takes no compound siblings; use :host(x)".to_string(),
            );
        }
        *host_only = true;
        head.push_str(&scope.root_marker());
    } else if matches!(
        name.to_ascii_lowercase().as_str(),
        "before" | "after" | "first-line" | "first-letter"
    ) {
        write!(tail, ":{name}").expect("selector push");
    } else {
        write!(head, ":{name}").expect("selector push");
    }
    Ok(())
}

fn parse_functional_pseudo(
    input: &mut Parser,
    scope: &mut Scoper,
    name: String,
    head: &mut String,
    tail: &mut String,
    host_only: &mut bool,
    simple: usize,
) -> Result<(), ParseError<ScopeError>> {
    if name.eq_ignore_ascii_case("has") {
        return custom(
            input,
            "E2102",
            ":has() relational selectors are not admitted in scoped styles"
                .to_string(),
        );
    }
    if name.eq_ignore_ascii_case("host") {
        if simple > 0 || !tail.is_empty() {
            return custom(
                input,
                "E2100",
                ":host() takes no compound siblings".to_string(),
            );
        }
        let inner = input.parse_nested_block(|inner| {
            let compound = parse_compound(inner, scope)?;
            inner.expect_exhausted()?;
            Ok::<_, ParseError<ScopeError>>(compound)
        })?;
        *host_only = true;
        head.push_str(&scope.root_marker());
        head.push_str(&inner);
    } else if name.eq_ignore_ascii_case("not")
        || name.eq_ignore_ascii_case("is")
        || name.eq_ignore_ascii_case("where")
    {
        let inner = input
            .parse_nested_block(|inner| parse_selector_list(inner, scope))?;
        write!(head, ":{name}({inner})").expect("selector push");
    } else if name.eq_ignore_ascii_case("nth-child")
        || name.eq_ignore_ascii_case("nth-last-child")
    {
        let args =
            input.parse_nested_block(|inner| transform_nth(inner, scope))?;
        write!(head, ":{name}({args})").expect("selector push");
    } else {
        let args = input.parse_nested_block(|inner| {
            serialize_generic_block(inner, scope)
        })?;
        write!(head, ":{name}({args})").expect("selector push");
    }
    Ok(())
}

fn parse_pseudo(
    input: &mut Parser,
    scope: &mut Scoper,
    pseudo: Token,
    head: &mut String,
    tail: &mut String,
    simple: &mut usize,
    host_only: &mut bool,
) -> Result<(), ParseError<ScopeError>> {
    match pseudo {
        Token::Colon => {
            // Pseudo-element: the guard lands before it.
            parse_pseudo_element(input, scope, tail)?;
        }
        Token::Ident(name) => {
            parse_pseudo_ident(input, scope, name.to_string(), head, tail, host_only, *simple)?;
        }
        Token::Function(name) => {
            parse_functional_pseudo(input, scope, name.to_string(), head, tail, host_only, *simple)?;
        }
        _ => return custom(input, "E2100", "expected a pseudo-class".to_string()),
    }
    *simple += 1;
    Ok(())
}

fn finish_compound(
    input: &mut Parser,
    guard: &str,
    head: String,
    tail: String,
    simple: usize,
    bare_star: bool,
    host_only: bool,
) -> Result<String, ParseError<ScopeError>> {
    if simple == 0 {
        if bare_star {
            return custom(
                input,
                "E2103",
                "`*` escapes the style unit; style owned elements only".to_string(),
            );
        }
        return custom(input, "E2100", "expected a selector compound".to_string());
    }
    let mut head = head;
    if host_only {
        head.push_str(&tail);
        return Ok(head);
    }
    head.push_str(guard);
    head.push_str(&tail);
    Ok(head)
}

fn parse_compound(
    input: &mut Parser,
    scope: &mut Scoper,
) -> Result<String, ParseError<ScopeError>> {
    let mut head = String::new();
    let mut tail = String::new();
    let mut bare_star = false;
    let mut simple = 0usize;
    let mut host_only = false;
    loop {
        let state = input.state();
        let token = match input.next_including_whitespace() {
            Ok(token) => token.clone(),
            Err(_) => break,
        };
        match token {
            Token::WhiteSpace(_)
            | Token::Comment(_)
            | Token::Comma
            | Token::Semicolon
            | Token::CloseCurlyBracket
            | Token::CloseParenthesis
            | Token::CloseSquareBracket => {
                input.reset(&state);
                break;
            }
            Token::Delim('>' | '+' | '~' | '|' | '{' | '}' | ';') => {
                input.reset(&state);
                break;
            }
            Token::Delim('*') => {
                bare_star = simple == 0;
                // A combined `*` is redundant; a bare one escapes the unit.
            }
            Token::Delim('&') => {
                if scope.style_nesting == 0 {
                    return custom(
                        input,
                        "E2100",
                        "`&` needs an enclosing style rule".to_string(),
                    );
                }
                head.push('&');
                simple += 1;
            }
            Token::Delim('.') => {
                let class = input.expect_ident()?.to_string();
                write!(head, ".{class}").expect("selector push");
                simple += 1;
            }
            Token::Delim(other) => {
                return custom(input, "E2100", format!("unexpected {other:?} in selector"));
            }
            Token::Ident(name) => {
                if is_global_type(&name) {
                    return custom(
                        input,
                        "E2103",
                        format!("{name} escapes the style unit; style owned elements only"),
                    );
                }
                write!(head, "{name}").expect("selector push");
                simple += 1;
            }
            Token::IDHash(name) => {
                write!(head, "#{name}").expect("selector push");
                simple += 1;
            }
            Token::Hash(name) => {
                return custom(input, "E2100", format!("invalid id selector #{name}"));
            }
            Token::SquareBracketBlock => {
                let rendered = input.parse_nested_block(|inner| parse_attribute_selector(inner))?;
                head.push_str(&rendered);
                simple += 1;
            }
            Token::Colon => {
                let pseudo = input.next()?.clone();
                parse_pseudo(
                    input,
                    scope,
                    pseudo,
                    &mut head,
                    &mut tail,
                    &mut simple,
                    &mut host_only,
                )?;
            }
            _ => {
                return custom(input, "E2100", "unexpected token in selector".to_string());
            }
        }
    }
    finish_compound(input, &scope.guard, head, tail, simple, bare_star, host_only)
}

/// Parse `[name op value flag]`, refusing forged ownership attributes.
fn parse_attribute_selector(input: &mut Parser) -> Result<String, ParseError<ScopeError>> {
    let name = input.expect_ident()?.to_string();
    if name.to_ascii_lowercase().starts_with("data-can-") {
        return custom(
            input,
            "E2104",
            format!("{name} is compiler-owned and cannot appear in style selectors"),
        );
    }
    let mut out = format!("[{name}");
    input.skip_whitespace();
    if input.is_exhausted() {
        out.push(']');
        return Ok(out);
    }
    let operator = match input.next()?.clone() {
        Token::Delim('=') => "=",
        Token::IncludeMatch => "~=",
        Token::DashMatch => "|=",
        Token::PrefixMatch => "^=",
        Token::SuffixMatch => "$=",
        Token::SubstringMatch => "*=",
        _ => {
            return custom(
                input,
                "E2100",
                "expected an attribute match operator".to_string(),
            );
        }
    };
    let value = match input.next()?.clone() {
        Token::Ident(value) => value.to_string(),
        Token::QuotedString(value) => {
            let mut rendered = String::new();
            cssparser::serialize_string(&value, &mut rendered).expect("string push");
            rendered
        }
        _ => {
            return custom(
                input,
                "E2100",
                "expected an attribute match value".to_string(),
            );
        }
    };
    out.push_str(operator);
    out.push_str(&value);
    input.skip_whitespace();
    if !input.is_exhausted() {
        let flag = input.expect_ident()?.to_string();
        if !flag.eq_ignore_ascii_case("i") && !flag.eq_ignore_ascii_case("s") {
            return custom(input, "E2100", format!("unknown attribute flag {flag:?}"));
        }
        out.push(' ');
        out.push_str(&flag);
        input.expect_exhausted()?;
    }
    out.push(']');
    Ok(out)
}

/// Keyframe preludes are `from`/`to`/percentage lists only.
fn parse_keyframe_prelude(input: &mut Parser) -> Result<String, ParseError<ScopeError>> {
    let mut out = String::new();
    let mut first = true;
    loop {
        input.skip_whitespace();
        if input.is_exhausted() {
            break;
        }
        if !first {
            match input.next()?.clone() {
                Token::Comma => {}
                _ => {
                    return custom(
                        input,
                        "E2100",
                        "expected `,` in keyframe prelude".to_string(),
                    );
                }
            }
            input.skip_whitespace();
        }
        first = false;
        match input.next()?.clone() {
            Token::Ident(name) if name.eq_ignore_ascii_case("from") => out.push_str("from"),
            Token::Ident(name) if name.eq_ignore_ascii_case("to") => out.push_str("to"),
            token @ Token::Percentage { .. } => {
                token.to_css(&mut out).expect("keyframe push");
            }
            _ => {
                return custom(
                    input,
                    "E2100",
                    "keyframe selectors are from/to/percentage only".to_string(),
                );
            }
        }
        if !first {
            // Separate entries with `, ` when another follows.
            let state = input.state();
            input.skip_whitespace();
            if !input.is_exhausted() {
                out.push_str(", ");
            }
            input.reset(&state);
        }
    }
    if first {
        return custom(input, "E2100", "empty keyframe prelude".to_string());
    }
    Ok(out)
}

fn transform_function_value(
    input: &mut Parser,
    scope: &mut Scoper,
    out: &mut String,
    needs_space: &mut bool,
    name: String,
) -> Result<(), ParseError<ScopeError>> {
    maybe_space(out, needs_space);
    if name.eq_ignore_ascii_case("var") {
        let rendered = input.parse_nested_block(|inner| transform_var(inner, scope))?;
        out.push_str(&rendered);
    } else if name.eq_ignore_ascii_case("url") {
        let rendered =
            input.parse_nested_block(|inner| transform_url_function(inner, scope))?;
        out.push_str(&rendered);
    } else {
        let rendered =
            input.parse_nested_block(|inner| transform_value(inner, scope, false))?;
        write!(out, "{name}({rendered})").expect("value push");
    }
    Ok(())
}

fn is_keyframes_ident(token: &Token, animate: bool, scope: &Scoper) -> bool {
    animate
        && matches!(token, Token::Ident(name) if scope.keyframes_known.contains(name.as_ref()))
}

fn next_value_token<'i>(input: &mut Parser<'i>) -> Option<Token<'i>> {
    match input.next_including_whitespace() {
        Ok(token) => Some(token.clone()),
        Err(_) => None,
    }
}

fn check_important(input: &mut Parser, state: &ParserState) -> bool {
    let important = input
        .try_parse(|inner| {
            inner.expect_ident_matching("important")?;
            Ok::<_, ParseError<ScopeError>>(())
        })
        .is_ok();
    input.reset(state);
    important
}

fn transform_unquoted_url(
    input: &mut Parser,
    scope: &mut Scoper,
    out: &mut String,
    needs_space: &mut bool,
    url: &str,
) -> Result<(), ParseError<ScopeError>> {
    maybe_space(out, needs_space);
    let url = check_owned_url(input, scope, url)?;
    write!(out, "url({url})").expect("value push");
    Ok(())
}

fn transform_bracketed_value(
    input: &mut Parser,
    scope: &mut Scoper,
    out: &mut String,
    needs_space: &mut bool,
    open: char,
    close: char,
) -> Result<(), ParseError<ScopeError>> {
    maybe_space(out, needs_space);
    let rendered =
        input.parse_nested_block(|inner| transform_value(inner, scope, false))?;
    out.push(open);
    out.push_str(&rendered);
    out.push(close);
    Ok(())
}

/// Transform one declaration value: namespace local `var()` references,
/// rewrite local keyframes names inside `animation`/`animation-name`, and
/// admit only owned URLs. Stops before a top-level `!important`, which the
/// declaration parser consumes.
fn transform_value(
    input: &mut Parser,
    scope: &mut Scoper,
    animate: bool,
) -> Result<String, ParseError<ScopeError>> {
    let mut out = String::new();
    let mut needs_space = false;
    loop {
        let state = input.state();
        let Some(token) = next_value_token(input) else {
            break;
        };
        match token {
            Token::WhiteSpace(_) | Token::Comment(_) => {
                needs_space = true;
            }
            Token::Semicolon | Token::CloseCurlyBracket => {
                input.reset(&state);
                break;
            }
            Token::Delim('!') => {
                // A top-level `!important` ends the value.
                if check_important(input, &state) {
                    break;
                }
                push_token(&mut out, &mut needs_space, &Token::Delim('!'));
            }
            Token::Function(name) => {
                transform_function_value(input, scope, &mut out, &mut needs_space, name.to_string())?;
            }
            Token::UnquotedUrl(url) => {
                transform_unquoted_url(input, scope, &mut out, &mut needs_space, &url)?;
            }
            Token::ParenthesisBlock => {
                transform_bracketed_value(input, scope, &mut out, &mut needs_space, '(', ')')?;
            }
            Token::SquareBracketBlock => {
                transform_bracketed_value(input, scope, &mut out, &mut needs_space, '[', ']')?;
            }
            Token::CurlyBracketBlock => {
                transform_bracketed_value(input, scope, &mut out, &mut needs_space, '{', '}')?;
            }
            Token::Ident(name) if is_keyframes_ident(&token, animate, scope) => {
                maybe_space(&mut out, &mut needs_space);
                out.push_str(&scope.namespaced(&name));
            }
            Token::BadUrl(_) | Token::BadString(_) => {
                return custom(
                    input,
                    "E2100",
                    "malformed url or string in declaration".to_string(),
                );
            }
            Token::CloseParenthesis | Token::CloseSquareBracket => {
                return custom(input, "E2100", "unmatched closing bracket".to_string());
            }
            other => push_token(&mut out, &mut needs_space, &other),
        }
    }
    if out.is_empty() {
        return custom(input, "E2100", "empty declaration value".to_string());
    }
    Ok(out)
}

fn maybe_space(out: &mut String, needs_space: &mut bool) {
    if *needs_space && !out.is_empty() {
        out.push(' ');
    }
    *needs_space = false;
}

fn push_token(out: &mut String, needs_space: &mut bool, token: &Token) {
    maybe_space(out, needs_space);
    token.to_css(out).expect("value push");
}

/// Rewrite `var(--x, fallback)`: shared theme reads pass through and are
/// recorded; every other reference is unit-local and namespaced.
fn transform_var(input: &mut Parser, scope: &mut Scoper) -> Result<String, ParseError<ScopeError>> {
    let name = input.expect_ident()?.to_string();
    if !name.starts_with("--") {
        return custom(
            input,
            "E2100",
            format!("var() needs a custom property, got {name:?}"),
        );
    }
    let rendered = if SHARED_THEME_VARS.contains(&name.as_str()) {
        scope.theme_reads.insert(name.clone());
        name
    } else {
        scope.namespaced_property(&name)
    };
    let mut out = format!("var({rendered}");
    input.skip_whitespace();
    if !input.is_exhausted() {
        match input.next()?.clone() {
            Token::Comma => {
                let fallback = transform_value(input, scope, false)?;
                out.push_str(", ");
                out.push_str(&fallback);
            }
            _ => return custom(input, "E2100", "expected `,` in var() fallback".to_string()),
        }
    }
    out.push(')');
    Ok(out)
}

/// Check the string form `url("...")`.
fn transform_url_function(
    input: &mut Parser,
    scope: &mut Scoper,
) -> Result<String, ParseError<ScopeError>> {
    input.skip_whitespace();
    let url = match input.next()?.clone() {
        Token::QuotedString(url) => url.to_string(),
        Token::Ident(url) => url.to_string(),
        _ => return custom(input, "E2100", "url() needs a string".to_string()),
    };
    input.expect_exhausted()?;
    let url = check_owned_url(input, scope, &url)?;
    let mut rendered = String::from("url(");
    cssparser::serialize_string(&url, &mut rendered).expect("url push");
    rendered.push(')');
    Ok(rendered)
}

/// Admit only owned asset URLs: unit-relative paths, same-document
/// fragments, and self-contained `data:` payloads. Remote URLs, absolute
/// paths and traversal refuse.
fn check_owned_url(
    input: &Parser,
    scope: &mut Scoper,
    url: &str,
) -> Result<String, ParseError<ScopeError>> {
    let url = url.trim();
    if url.is_empty() {
        return custom(input, "E2107", "empty url() is not admitted".to_string());
    }
    if url.starts_with('#') { return Ok(url.to_string()); }
    if url.get(..5).is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:")) { return Ok(url.to_string()); }
    if url.contains('\\') || url.starts_with('/') || url.contains("://") || url.starts_with("//") {
        return custom(
            input,
            "E2107",
            format!("url({url:?}) is not an owned unit asset"),
        );
    }
    if let Some((scheme, _)) = url.split_once(':')
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && !scheme.is_empty()
        && scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
    {
        return custom(
            input,
            "E2107",
            format!("url({url:?}) is not an owned unit asset"),
        );
    }
    if url.split(['/', '?', '#']).any(|segment| segment == "..") {
        return custom(
            input,
            "E2107",
            format!("url({url:?}) traverses outside the style unit"),
        );
    }
    let end = url.find(['?', '#']).unwrap_or(url.len());
    let path = url[..end].split('/').filter(|segment| !segment.is_empty() && *segment != ".").collect::<Vec<_>>().join("/");
    if path.is_empty() { return custom(input, "E2107", "owned asset path is empty".to_string()); }
    scope.assets.insert(path.clone());
    if scope.deploy_assets {
        let encoded = path.as_bytes().iter().map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b'/') { char::from(*byte).to_string() }
            else { format!("%{byte:02X}") }
        }).collect::<String>();
        Ok(format!("/assets/can.generated/{}/{encoded}{}", scope.unit, &url[end..]))
    } else { Ok(url.to_string()) }
}

/// Serialize a `@media`/`@supports`/`@container` prelude. Conditions pass
/// through; `@supports selector(...)` arguments are real selectors and get
/// the same ownership guards.
fn serialize_condition_prelude(
    input: &mut Parser,
    scope: &mut Scoper,
    scope_selectors: bool,
) -> Result<String, ParseError<ScopeError>> {
    let mut out = String::new();
    let mut needs_space = false;
    while let Ok(token) = input.next_including_whitespace().cloned() {
        match token {
            Token::WhiteSpace(_) | Token::Comment(_) => {
                needs_space = true;
            }
            Token::Function(name) if scope_selectors && name.eq_ignore_ascii_case("selector") => {
                maybe_space(&mut out, &mut needs_space);
                let inner = input.parse_nested_block(|inner| parse_selector_list(inner, scope))?;
                write!(out, "selector({inner})").expect("condition push");
            }
            Token::Function(name) => {
                maybe_space(&mut out, &mut needs_space);
                let inner =
                    input.parse_nested_block(|inner| serialize_generic_block(inner, scope))?;
                write!(out, "{name}({inner})").expect("condition push");
            }
            Token::ParenthesisBlock => {
                maybe_space(&mut out, &mut needs_space);
                let inner =
                    input.parse_nested_block(|inner| serialize_generic_block(inner, scope))?;
                out.push('(');
                out.push_str(&inner);
                out.push(')');
            }
            other => push_token(&mut out, &mut needs_space, &other),
        }
    }
    if out.is_empty() {
        return custom(input, "E2100", "empty conditional prelude".to_string());
    }
    Ok(out)
}

/// Serialize non-selector function/block contents (pseudo-class arguments,
/// condition terms), still checking nested `url()`/`var()` uses.
fn serialize_generic_block(
    input: &mut Parser,
    scope: &mut Scoper,
) -> Result<String, ParseError<ScopeError>> {
    transform_value(input, scope, false)
}

/// Serialize `:nth-child()`/`:nth-last-child()` arguments, scoping the
/// selector list after a top-level `of`.
fn transform_nth(input: &mut Parser, scope: &mut Scoper) -> Result<String, ParseError<ScopeError>> {
    let mut out = String::new();
    let mut needs_space = false;
    while let Ok(token) = input.next_including_whitespace().cloned() {
        match token {
            Token::WhiteSpace(_) | Token::Comment(_) => {
                needs_space = true;
            }
            Token::Ident(name) if name.eq_ignore_ascii_case("of") => {
                maybe_space(&mut out, &mut needs_space);
                out.push_str("of ");
                out.push_str(&parse_selector_list(input, scope)?);
                input.expect_exhausted()?;
                return Ok(out);
            }
            Token::Function(name) => {
                maybe_space(&mut out, &mut needs_space);
                let inner =
                    input.parse_nested_block(|inner| serialize_generic_block(inner, scope))?;
                write!(out, "{name}({inner})").expect("nth push");
            }
            Token::ParenthesisBlock => {
                maybe_space(&mut out, &mut needs_space);
                let inner =
                    input.parse_nested_block(|inner| serialize_generic_block(inner, scope))?;
                out.push('(');
                out.push_str(&inner);
                out.push(')');
            }
            other => push_token(&mut out, &mut needs_space, &other),
        }
    }
    if out.is_empty() {
        return custom(input, "E2100", "empty :nth-child()".to_string());
    }
    Ok(out)
}
