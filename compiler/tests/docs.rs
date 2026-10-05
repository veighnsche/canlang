//! D04b extractor tests: the Rust reference extractor builds frozen
//! ReferenceModel v1 from analysis (extraction only — rendering is D05a's,
//! CLI is D05b's). Fixtures pin the model shape against
//! `packages/contracts/src/reference.ts`: declaration set, types and
//! nullability vs creation requiredness, defaults, resolved constraints,
//! user operations, labeled authored examples, canonical links, explicit
//! unknown availability and determinism. No execution status, inferred
//! authorization or invented results anywhere.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::docs::{
    REFERENCE_MODEL_VERSION, ReferenceAvailability, ReferenceModel, extract_reference,
};
use canlang_compiler::json::{self, Json};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use std::path::Path;

// --- Fixtures ---------------------------------------------------------------

/// Rich shop source: model + contract, a full field/description matrix, user
/// scenarios plus one trusted handler (excluded), and a fixture recipe.
/// Field order follows the parser: type, default/server, modifiers, desc.
const SHOP_SRC: &str = concat!(
    "app Shop\n",
    "Given\n",
    " # Gadgets for sale. @{nl=\"Gadgets te koop.\"}\n",
    " Gadget { title:text trim max=200 desc=\"Display title.\"@{nl=\"Titel.\", fr=null},",
    " stock:int=0 min=0 max=100, state:enum(open,done)=open, note:text?,",
    " owner:user server=actor, alias:text desc=\"\" }\n",
    " policy Gadget read=members\n",
    " contract Spec { summary:text, count:int=1 }\n",
    " fixture g0=Gadget {title=\"Sprocket\", alias=\"sp\"}\n",
    " event Pinged { g:Gadget }\n",
    "When\n",
    " # Restock a gadget. @{nl=\"Vul een gadget aan.\"}\n",
    " scenario restock(g:Gadget, amount:int=1, note:text? desc=\"Why restocked.\") by=members -> int\n",
    "  do\n",
    "   return 1\n",
    " scenario ping() by=members\n",
    "  do\n",
    "   let x = 1\n",
    " scenario onping on=Pinged\n",
    "  do\n",
    "   let x = 1\n",
    "Then\n",
);

/// Table-form `examples` attach to operations (unlabeled in source): they
/// must not leak into declaration examples. (Source mirrors the known-clean
/// header shape from `b4_examples.rs`.)
const TABLE_SRC: &str = concat!(
    "app Probe\n",
    "Given\n",
    " Task { title:text, state:enum(open,done)=open }\n",
    " policy Task read=members\n",
    " fixture one=Task { title=\"a\", state=open }\n",
    "When\n",
    " scenario close(task:Task,state:Task.state) by=members\n",
    "  require task.state==open\n",
    "  do set task {state=done}\n",
    "  examples seed=[one] task=one state=done\n",
    "   as,task.state -> task.state\n",
    "   members,open -> done\n",
    "   members,done -> error(rule_failed)\n",
    "Then\n",
);

/// Declaration `#= message` references resolve to recorded message wording.
const MESSAGE_REF_SRC: &str = concat!(
    "app Shop\n",
    "Given\n",
    " message blurb = \"Shared wording.\"@{nl=\"Gedeelde tekst.\"}\n",
    " #= blurb\n",
    " Gadget { title:text }\n",
    " policy Gadget read=members\n",
    "When\n",
    "Then\n",
);

/// Required-array `!` spelling reconstructs the declared field-type spelling.
const ARRAY_SRC: &str = concat!(
    "app Shop\n",
    "Given\n",
    " Gadget { tags:text[]! }\n",
    " policy Gadget read=members\n",
    "When\n",
    "Then\n",
);

/// Check one inline source without a catalog (fixtures use no builtins),
/// asserting clean diagnostics and returning db + program for extraction.
fn check_clean(path: &str, src: &str) -> (SourceDb, SourceId, CheckedProgram) {
    let mut db = SourceDb::new();
    let id = db.add(path.to_string(), src.to_string());
    let (program, diags) = check_program(&db, &[id], None);
    assert!(diags.is_empty(), "fixture must check clean: {diags:?}");
    (db, id, program)
}

fn extract(path: &str, src: &str) -> (String, ReferenceModel) {
    let (db, id, program) = check_clean(path, src);
    let model = extract_reference(&db, &[id], &program);
    (model.to_json_string(), model)
}

/// Minimal test-only catalog pinning `catalog_version` (temp-dir pattern
/// from `b4_examples.rs`).
fn fixture_catalog() -> (TempfileGuard, Catalog) {
    let json = r#"{
  "language_version": "1.0",
  "catalog_version": "2.5.0-test",
  "entries": [
    {"id": "count", "js": "count", "owner": "test", "kind": "builtin", "signature": "count(domain:C<T>)->int", "effects": "pure", "availability": "implemented"}
  ]
}"#;
    let dir = std::env::temp_dir().join(format!(
        "can-docs-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("catalog.json");
    std::fs::write(&path, json).unwrap();
    let mut db = SourceDb::new();
    let id = db.add("dummy.can".to_string(), String::new());
    let request = CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(id, 0, 0),
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "fixture catalog loads clean: {diags:?}");
    (TempfileGuard { dir }, catalog.expect("fixture catalog"))
}

/// Removes the temp catalog dir on drop (test-only cleanup).
struct TempfileGuard {
    dir: std::path::PathBuf,
}

impl Drop for TempfileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Byte span of the first appearance of `needle` in `src`.
fn span_of(src: &str, needle: &str) -> (u32, u32) {
    let at = src
        .find(needle)
        .unwrap_or_else(|| panic!("needle {needle:?} missing"));
    (at as u32, (at + needle.len()) as u32)
}

// --- Declaration set ---------------------------------------------------------

/// (D04b) Owners, models/contracts and fields extract with canonical links:
/// one owner, declarations sorted by name, events excluded, project-relative
/// source ids plus offsets on every location.
#[test]
fn extracts_owners_declarations_and_fields() {
    let (_json, model) = extract("shop.can", SHOP_SRC);
    assert_eq!(model.version, REFERENCE_MODEL_VERSION);
    assert_eq!(model.owners.len(), 1);
    let owner = &model.owners[0];
    assert_eq!(owner.name, "Shop");
    let names: Vec<(&str, &str)> = owner
        .declarations
        .iter()
        .map(|d| {
            (
                d.name.as_str(),
                match d.kind {
                    canlang_compiler::docs::ReferenceDeclarationKind::Model => "model",
                    canlang_compiler::docs::ReferenceDeclarationKind::Contract => "contract",
                },
            )
        })
        .collect();
    // Sorted by name; the `Pinged` event is not a model/contract.
    assert_eq!(names, vec![("Gadget", "model"), ("Spec", "contract")]);
    for declaration in &owner.declarations {
        assert_eq!(declaration.owner, "Shop");
        assert_eq!(declaration.location.source_id, "shop.can");
        let slice =
            &SHOP_SRC[declaration.location.start as usize..declaration.location.end as usize];
        assert!(
            slice.contains(&declaration.name),
            "location covers the declaration: {slice:?}"
        );
    }
    let gadget = &owner.declarations[0];
    let fields: Vec<&str> = gadget.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        fields,
        vec!["title", "stock", "state", "note", "owner", "alias"]
    );
    let spec = &owner.declarations[1];
    let spec_fields: Vec<&str> = spec.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(spec_fields, vec!["summary", "count"]);
}

/// (D04b) Field matrix: declared spellings, nullability, creation
/// requiredness distinct from nullability, defaults and resolved constraints
/// in written order.
#[test]
fn field_type_nullability_requiredness_defaults_constraints() {
    let (_json, model) = extract("shop.can", SHOP_SRC);
    let gadget = &model.owners[0].declarations[0];
    let field = |name: &str| {
        gadget
            .fields
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("field {name} missing"))
    };
    // Plain required text: non-null, creation-required, no default.
    let title = field("title");
    assert_eq!(title.ty, "text");
    assert!(!title.nullable);
    assert!(title.creation_required);
    assert_eq!(title.default, None);
    assert_eq!(
        title
            .constraints
            .iter()
            .map(|c| (c.kind.as_str(), c.detail.as_str()))
            .collect::<Vec<_>>(),
        vec![("trim", "trim"), ("max", "200")]
    );
    // Defaulted int with bounds: not creation-required despite non-null.
    let stock = field("stock");
    assert_eq!(stock.ty, "int");
    assert!(!stock.nullable);
    assert!(!stock.creation_required);
    assert_eq!(stock.default.as_deref(), Some("0"));
    assert_eq!(
        stock
            .constraints
            .iter()
            .map(|c| (c.kind.as_str(), c.detail.as_str()))
            .collect::<Vec<_>>(),
        vec![("min", "0"), ("max", "100")]
    );
    // Enum with default: declared spelling kept, not required.
    let state = field("state");
    assert_eq!(state.ty, "enum(open,done)");
    assert!(!state.nullable);
    assert!(!state.creation_required);
    assert_eq!(state.default.as_deref(), Some("open"));
    assert!(state.constraints.is_empty());
    // Nullable without default: fills null when omitted, not required.
    let note = field("note");
    assert_eq!(note.ty, "text?");
    assert!(note.nullable);
    assert!(!note.creation_required);
    assert_eq!(note.default, None);
    // Server-owned: never caller-provided, never creation-required.
    let owner = field("owner");
    assert_eq!(owner.ty, "user");
    assert!(!owner.nullable);
    assert!(!owner.creation_required);
    // Contract field with default.
    let spec = &model.owners[0].declarations[1];
    let count = spec.fields.iter().find(|f| f.name == "count").unwrap();
    assert_eq!(count.ty, "int");
    assert!(!count.creation_required);
    assert_eq!(count.default.as_deref(), Some("1"));
}

// --- Operations ---------------------------------------------------------------

/// (D04b) User scenarios extract with inputs in signature order and declared
/// results; trusted handlers are not user operations. Operation JSON carries
/// the callable surface only — no `by=` gate, role or permission material.
#[test]
fn extracts_user_operations_without_authorization() {
    let (json, model) = extract("shop.can", SHOP_SRC);
    let operations = &model.owners[0].operations;
    let ids: Vec<&str> = operations.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(ids, vec!["Shop.ping", "Shop.restock"]);
    assert!(
        !ids.iter().any(|id| id.contains("onping")),
        "trusted handler excluded: {ids:?}"
    );
    let restock = operations.iter().find(|o| o.id == "Shop.restock").unwrap();
    let inputs: Vec<(&str, &str, bool, bool, Option<&str>)> = restock
        .inputs
        .iter()
        .map(|i| {
            (
                i.name.as_str(),
                i.ty.as_str(),
                i.nullable,
                i.creation_required,
                i.default.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        inputs,
        vec![
            ("g", "Gadget", false, true, None),
            ("amount", "int", false, false, Some("1")),
            ("note", "text?", true, false, None),
        ]
    );
    for input in &restock.inputs {
        assert!(
            input.constraints.is_empty(),
            "parameters carry no modifiers"
        );
    }
    assert_eq!(restock.result.ty, "int");
    assert!(!restock.result.nullable);
    assert_eq!(restock.result.description, None);
    assert_eq!(restock.location.source_id, "shop.can");
    // Void scenario: no inputs, `void` result, never nullable.
    let ping = operations.iter().find(|o| o.id == "Shop.ping").unwrap();
    assert!(ping.inputs.is_empty());
    assert_eq!(ping.result.ty, "void");
    assert!(!ping.result.nullable);
    // Callable surface only: the `by=members` gate must not leak.
    assert!(
        !json.contains("members"),
        "no caller gate in reference JSON"
    );
    let value = json::parse(&json).expect("reference JSON parses");
    let owners = value.get("owners").and_then(Json::as_arr).unwrap();
    let ops = owners[0].get("operations").and_then(Json::as_arr).unwrap();
    for op in ops {
        let Json::Obj(members) = op else {
            panic!("operation must be an object");
        };
        let keys: Vec<&str> = members.iter().map(|(k, _)| k.as_str()).collect();
        assert!(
            keys.iter()
                .all(|k| matches!(*k, "id" | "description" | "inputs" | "result" | "location")),
            "operation keys are the callable surface only: {keys:?}"
        );
    }
}

// --- Descriptions ---------------------------------------------------------------

/// (D04b) Field/parameter descriptions come from the frozen checked seam:
/// source text, ordered variants with `null` kept distinct from text, owning
/// source language and authored-value locations. Undescribed slots stay
/// absent; authored-empty text (`desc=""`) stays present-but-empty.
#[test]
fn field_and_param_descriptions_use_checked_seam() {
    let (_json, model) = extract("shop.can", SHOP_SRC);
    let gadget = &model.owners[0].declarations[0];
    let title = gadget.fields.iter().find(|f| f.name == "title").unwrap();
    let description = title.description.as_ref().expect("title described");
    assert_eq!(description.source, "Display title.");
    assert_eq!(description.source_lang, "en");
    assert_eq!(
        description
            .variants
            .iter()
            .map(|v| (v.tag.as_str(), v.text.as_deref()))
            .collect::<Vec<_>>(),
        vec![("nl", Some("Titel.")), ("fr", None)]
    );
    assert_eq!(description.location.source_id, "shop.can");
    let slice = &SHOP_SRC[description.location.start as usize..description.location.end as usize];
    assert!(
        slice.contains("desc=\"Display title.\""),
        "value location covers desc=: {slice:?}"
    );
    // Undescribed sibling: absent, never empty.
    let stock = gadget.fields.iter().find(|f| f.name == "stock").unwrap();
    assert_eq!(stock.description, None);
    // Authored-empty text is present-but-empty, distinct from absence.
    let alias = gadget.fields.iter().find(|f| f.name == "alias").unwrap();
    let empty = alias.description.as_ref().expect("empty desc present");
    assert_eq!(empty.source, "");
    assert!(empty.variants.is_empty());
    // Parameter description from the same seam.
    let restock = model.owners[0]
        .operations
        .iter()
        .find(|o| o.id == "Shop.restock")
        .unwrap();
    let note = restock.inputs.iter().find(|i| i.name == "note").unwrap();
    assert_eq!(
        note.description.as_ref().map(|d| d.source.as_str()),
        Some("Why restocked.")
    );
    let amount = restock.inputs.iter().find(|i| i.name == "amount").unwrap();
    assert_eq!(amount.description, None);
}

/// (D04b) Attached `#` sets describe owning model/operation declarations;
/// undescribed declarations stay absent.
#[test]
fn declaration_descriptions_attach_from_hash_sets() {
    let (_json, model) = extract("shop.can", SHOP_SRC);
    let owner = &model.owners[0];
    let gadget = owner
        .declarations
        .iter()
        .find(|d| d.name == "Gadget")
        .unwrap();
    let description = gadget.description.as_ref().expect("model described");
    assert_eq!(description.source, "Gadgets for sale.");
    assert_eq!(description.source_lang, "en");
    assert_eq!(
        description
            .variants
            .iter()
            .map(|v| (v.tag.as_str(), v.text.as_deref()))
            .collect::<Vec<_>>(),
        vec![("nl", Some("Gadgets te koop."))]
    );
    let restock = owner
        .operations
        .iter()
        .find(|o| o.id == "Shop.restock")
        .unwrap();
    assert_eq!(
        restock.description.as_ref().map(|d| d.source.as_str()),
        Some("Restock a gadget.")
    );
    let spec = owner
        .declarations
        .iter()
        .find(|d| d.name == "Spec")
        .unwrap();
    assert_eq!(spec.description, None);
    let ping = owner
        .operations
        .iter()
        .find(|o| o.id == "Shop.ping")
        .unwrap();
    assert_eq!(ping.description, None);
}

/// (D04b) Declaration `#= message` references resolve to recorded message
/// wording under the message's owning source language.
#[test]
fn message_reference_descriptions_resolve() {
    let (_json, model) = extract("shop.can", MESSAGE_REF_SRC);
    let gadget = &model.owners[0].declarations[0];
    assert_eq!(gadget.name, "Gadget");
    let description = gadget.description.as_ref().expect("ref described");
    assert_eq!(description.source, "Shared wording.");
    assert_eq!(description.source_lang, "en");
    assert_eq!(
        description
            .variants
            .iter()
            .map(|v| (v.tag.as_str(), v.text.as_deref()))
            .collect::<Vec<_>>(),
        vec![("nl", Some("Gedeelde tekst."))]
    );
    let (start, _) = span_of(MESSAGE_REF_SRC, "#= blurb");
    assert_eq!(description.location.source_id, "shop.can");
    assert!(
        description.location.start <= start && start < description.location.end,
        "location covers the `#=` leaf"
    );
}

/// (D04b) Required-array `!` reconstructs the declared field-type spelling.
#[test]
fn required_array_spelling_is_preserved() {
    let (_json, model) = extract("shop.can", ARRAY_SRC);
    let gadget = &model.owners[0].declarations[0];
    let tags = gadget.fields.iter().find(|f| f.name == "tags").unwrap();
    assert_eq!(tags.ty, "text[]!");
    assert!(!tags.nullable);
    assert!(tags.creation_required);
}

// --- Examples -------------------------------------------------------------------

/// (D04b) Fixtures targeting a declaration become its labeled authored
/// examples (source label, recipe slice, no expected result, no execution
/// status). Operation-attached `examples` blocks are unlabeled in source and
/// v1 carries no operation-examples slot, so tables never leak in.
#[test]
fn fixtures_become_labeled_declaration_examples() {
    let (json, model) = extract("shop.can", SHOP_SRC);
    let owner = &model.owners[0];
    let gadget = owner
        .declarations
        .iter()
        .find(|d| d.name == "Gadget")
        .unwrap();
    assert_eq!(gadget.examples.len(), 1);
    let example = &gadget.examples[0];
    assert_eq!(example.label, "g0");
    assert!(
        example.source.contains("fixture g0=Gadget"),
        "recipe slice: {:?}",
        example.source
    );
    assert_eq!(example.expected, None);
    let spec = owner
        .declarations
        .iter()
        .find(|d| d.name == "Spec")
        .unwrap();
    assert!(spec.examples.is_empty());
    // No execution status invented anywhere in the payload.
    for forbidden in ["passed", "failed", "executed", "execution", "error("] {
        assert!(
            !json.contains(forbidden),
            "no {forbidden:?} in reference JSON"
        );
    }
    // Tables attach to operations, not declarations: only the fixture lands.
    let (_table_json, table_model) = extract("probe.can", TABLE_SRC);
    let task = &table_model.owners[0].declarations[0];
    assert_eq!(task.name, "Task");
    let labels: Vec<&str> = task.examples.iter().map(|e| e.label.as_str()).collect();
    assert_eq!(labels, vec!["one"]);
}

// --- Availability, versions, determinism ------------------------------------------

/// (D04b) Availability is explicitly unknown without a verified fact, and the
/// catalog version is `null` when no catalog contributed. Even with a
/// catalog, passing analysis never flips availability to available.
#[test]
fn availability_is_unknown_and_catalog_version_nullable() {
    let (json, model) = extract("shop.can", SHOP_SRC);
    assert_eq!(model.availability, ReferenceAvailability::Unknown);
    assert_eq!(model.catalog_version, None);
    assert_eq!(model.language_version, "1.0");
    assert_eq!(model.app_default_locale, "en");
    let value = json::parse(&json).expect("reference JSON parses");
    assert_eq!(
        value.get("catalogVersion"),
        Some(&Json::Null),
        "null catalog version without a catalog"
    );
    assert_eq!(
        value.get("availability"),
        Some(&Json::Obj(vec![(
            "status".to_string(),
            Json::Str("unknown".to_string())
        )]))
    );
    // With a catalog: version passes through, availability stays unknown.
    let (_guard, catalog) = fixture_catalog();
    let mut db = SourceDb::new();
    let id = db.add("shop.can".to_string(), SHOP_SRC.to_string());
    let (program, diags): (CheckedProgram, Vec<Diagnostic>) =
        check_program(&db, &[id], Some(&catalog));
    assert!(diags.is_empty(), "catalog run must check clean: {diags:?}");
    let model = extract_reference(&db, &[id], &program);
    assert_eq!(model.catalog_version.as_deref(), Some("2.5.0-test"));
    assert_eq!(model.availability, ReferenceAvailability::Unknown);
}

/// (D04b) The `available` shape conforms to the frozen contract when a
/// verified fact constructs it (renderer agreement; the extractor itself
/// never invents one).
#[test]
fn available_shape_conforms_when_constructed() {
    let available = ReferenceAvailability::Available {
        owner: "TeamTasks".to_string(),
        catalog: "catalog-7".to_string(),
    };
    let value = available.to_json();
    assert_eq!(
        value,
        Json::Obj(vec![
            ("status".to_string(), Json::Str("available".to_string())),
            ("owner".to_string(), Json::Str("TeamTasks".to_string())),
            ("catalog".to_string(), Json::Str("catalog-7".to_string())),
        ])
    );
}

/// (D04b) Output is deterministic: repeated extraction is identical, owners
/// sort by name, and file order never affects the payload or revision.
#[test]
fn output_is_deterministic() {
    let (json_a, model_a) = extract("shop.can", SHOP_SRC);
    let (json_b, model_b) = extract("shop.can", SHOP_SRC);
    assert_eq!(model_a, model_b);
    assert_eq!(json_a, json_b);
    assert_eq!(model_a.version, 1);
    // Two files added out of order: owners sort, revision is order-free.
    let mut db = SourceDb::new();
    let zed = db.add(
        "zed.can".to_string(),
        "app Zed\nGiven\n Widget { title:text }\n policy Widget read=members\nWhen\nThen\n"
            .to_string(),
    );
    let amy = db.add(
        "amy.can".to_string(),
        "app Amy\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\nThen\n"
            .to_string(),
    );
    let (program, diags) = check_program(&db, &[zed, amy], None);
    assert!(diags.is_empty(), "two-file run checks clean: {diags:?}");
    let first = extract_reference(&db, &[zed, amy], &program);
    let second = extract_reference(&db, &[amy, zed], &program);
    assert_eq!(first, second);
    assert_eq!(first.to_json_string(), second.to_json_string());
    let names: Vec<&str> = first.owners.iter().map(|o| o.name.as_str()).collect();
    assert_eq!(names, vec!["Amy", "Zed"]);
}

// --- Contract conformance -------------------------------------------------------

/// (D04b) The JSON payload matches `reference.ts` exactly: top-level keys in
/// contract order, `version` 1, camelCase throughout, `None` optionals
/// omitted (never `null` except `catalogVersion`/variant `text`).
#[test]
fn v1_json_conforms_to_reference_ts() {
    let (json, _model) = extract("shop.can", SHOP_SRC);
    let value = json::parse(&json).expect("reference JSON parses");
    let Json::Obj(top) = &value else {
        panic!("model must be an object");
    };
    let keys: Vec<&str> = top.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        vec![
            "version",
            "sourceRevision",
            "catalogVersion",
            "languageVersion",
            "appDefaultLocale",
            "owners",
            "availability"
        ]
    );
    assert_eq!(value.get("version"), Some(&Json::Num("1".to_string())));
    assert_eq!(
        value.get("languageVersion").and_then(Json::as_str),
        Some("1.0")
    );
    assert_eq!(
        value.get("appDefaultLocale").and_then(Json::as_str),
        Some("en")
    );
    let revision = value.get("sourceRevision").and_then(Json::as_str).unwrap();
    assert_eq!(revision.len(), 64, "hex SHA-256 revision");
    assert!(revision.bytes().all(|b| b.is_ascii_hexdigit()));
    // Declaration/field/operation/example key shapes + optional omission.
    let owners = value.get("owners").and_then(Json::as_arr).unwrap();
    let gadget = owners[0]
        .get("declarations")
        .and_then(Json::as_arr)
        .unwrap()[0]
        .clone();
    let Json::Obj(decl) = &gadget else {
        panic!("declaration must be an object");
    };
    let decl_keys: Vec<&str> = decl.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        decl_keys,
        vec![
            "owner",
            "name",
            "kind",
            "description",
            "fields",
            "examples",
            "location"
        ]
    );
    assert_eq!(gadget.get("kind").and_then(Json::as_str), Some("model"));
    let fields = gadget.get("fields").and_then(Json::as_arr).unwrap();
    let title = &fields[0];
    assert!(title.get("default").is_none(), "no default: key omitted");
    assert!(title.get("description").is_some(), "described: key present");
    let stock = &fields[1];
    assert_eq!(stock.get("default").and_then(Json::as_str), Some("0"));
    assert!(
        stock.get("description").is_none(),
        "undescribed: key omitted"
    );
    assert_eq!(stock.get("creationRequired"), Some(&Json::Bool(false)));
    let description = title.get("description").unwrap();
    let Json::Obj(desc) = description else {
        panic!("description must be an object");
    };
    let desc_keys: Vec<&str> = desc.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        desc_keys,
        vec!["source", "sourceLang", "variants", "location"]
    );
    let variants = description.get("variants").and_then(Json::as_arr).unwrap();
    assert_eq!(variants.len(), 2);
    assert_eq!(variants[1].get("text"), Some(&Json::Null));
    let examples = gadget.get("examples").and_then(Json::as_arr).unwrap();
    assert_eq!(examples.len(), 1);
    assert!(
        examples[0].get("expected").is_none(),
        "no expected: omitted"
    );
    assert!(examples[0].get("label").and_then(Json::as_str).is_some());
    let location = gadget.get("location").unwrap();
    let Json::Obj(loc) = location else {
        panic!("location must be an object");
    };
    let loc_keys: Vec<&str> = loc.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(loc_keys, vec!["sourceId", "start", "end"]);
    assert_eq!(
        location.get("sourceId").and_then(Json::as_str),
        Some("shop.can")
    );
}
