//! MCP P1 golden: operation descriptors in the artifact + `canApp()` registry.
//!
//! TEST-ONLY: hermetic golden catalog + `EmitOptions::test_only`, following
//! `codegen.rs`. Compiles one inline app covering every P1 descriptor rule
//! and pins the shared contract P2 codes against:
//!
//! * `operations[]` entries are `{name, kind, description, inputs}` with
//!   `inputs = {fields: [{name, field, required}]}`.
//! * `name` is the canonical operation identity; `kind` is an
//!   `McpOperationKind` (`scenario`, `read` for `read=true`, `create`,
//!   `update`, `delete`).
//! * `description` is the verbatim `#` source text (`""` when the operation
//!   carries none). Generated CRUD ops inherit their `label=` caption when
//!   the declaration captions them (P4 follow-up), else `""`.
//! * Every `policy Model read=` publishes a no-input `package.Model.read`
//!   descriptor (kind `read`, description `""` — P4 follow-up), so denied
//!   reads answer denied-not-unknown.
//! * Scenario inputs follow the signature in order (`=` defaults and `?`
//!   nullability clear `required`); record params are `ref` with
//!   `requireVersion` set for mutations and clear for reads.
//! * CRUD inputs flatten the field allowlist minus `server=`-owned
//!   fields, which are never caller-provided: create takes the fields,
//!   update takes `record` plus optional fields, delete takes `record`.
//! * The entrypoint `canApp()` registry carries the same descriptors.
//! * Array inputs map to their element kind plus the T09 ordinary-vs-required
//!   marker (here `ids:int[]` → `integer` with `array:{required:false}`,
//!   ordinary since params never carry `!`). An operation with any input
//!   that still has no MCP mapping stays absent with zero diagnostics —
//!   never a skewed partial entry, never a blocked compilation.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use std::sync::atomic::{AtomicU32, Ordering};

static CATALOG_COUNTER: AtomicU32 = AtomicU32::new(0);
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::artifact::{self, CompileArtifact};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult, Severity};
use canlang_compiler::json::Json;
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

const FIXTURE: &str = r#"app Shop
Given
 Gadget { title:text trim max=200, price:money, stock:int=0, active:bool=true, note:text?, kind:enum(new,used)=new, keeper:member?, manual:file? }
 policy Gadget read=members
 Token { code:text, minted_by:user server=actor }
 policy Token read=members
When
 crud Gadget by=members fields=title,price,stock,active,note,kind,keeper,manual
 crud Token by=members fields=code
 # Approve a gadget for sale, optionally recording a note.
 scenario approve(gadget:Gadget,note:text?) by=members
  require gadget.stock>0
  do set gadget {active=true}
 # Describe one gadget briefly.
 scenario describe(gadget:Gadget) read=true -> text by=members
  do return gadget.title
 # Restock many gadgets at once.
 scenario restock(ids:int[]) by=members
  do
   let picked=ids as n where n > 1
Then
 # Browse the shop.
 page / title="Shop"
  breadcrumbs
"#;

/// Hermetic golden catalog (mirrors `codegen.rs`): availability is pinned
/// so `E6007` cannot fire.
fn golden_catalog() -> (Catalog, std::path::PathBuf) {
    // Unique per call: parallel tests share the process (and pid), and each
    // caller deletes its file — a pid-only name races write/load/delete.
    let path = std::env::temp_dir().join(format!(
        "mcp-p1-catalog-{}-{}.json",
        std::process::id(),
        CATALOG_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::write(
        &path,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[
{"id":"count","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"first","kind":"builtin","signature":"first(domain:C<T>)->T?","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"sum","kind":"builtin","signature":"sum(domain:C<T>,currency:currency)->money","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"money","kind":"builtin","signature":"money(minor:int,currency:currency)->money","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"trim","kind":"builtin","signature":"trim(value:text)->text","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"format","kind":"builtin","signature":"format(descriptor:message)->text","effects":"pure","availability":"implemented","owner":"lane-02"}
]}"#,
    )
    .expect("write golden catalog");
    let primary = Span::new(SourceId(0), 0, 0);
    let cwd = std::env::temp_dir();
    let request = CatalogRequest {
        flag: Some(path.as_path()),
        env: None,
        cwd: cwd.as_path(),
        primary,
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "golden catalog loads: {diags:?}");
    (catalog.expect("catalog"), path)
}

fn compile_source(src: &str) -> (CompileArtifact, Vec<Diagnostic>, std::path::PathBuf) {
    let mut db = SourceDb::new();
    let id = db.add("mcp-p1.can".to_string(), src.to_string());
    let (catalog, path) = golden_catalog();
    let (program, analysis_diags): (CheckedProgram, Vec<Diagnostic>) =
        check_program(&db, &[id], Some(&catalog));
    let blocking: Vec<&Diagnostic> = analysis_diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(blocking.is_empty(), "source analyzes cleanly: {blocking:?}");
    let mut result = DiagnosticResult::new("mcp-p1", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.diagnostics = analysis_diags;
    result.complete = false;
    result.finish();
    let sources = EmitSources {
        db: &db,
        result: &result,
        catalog: Some(&catalog),
        options: EmitOptions::test_only(),
    };
    let (artifact, emit_diags) = emit(&program, &sources);
    (artifact, emit_diags, path)
}

fn op_by_name<'a>(ops: &'a [Json], name: &str) -> &'a Json {
    ops.iter()
        .find(|op| op.get("name").and_then(Json::as_str) == Some(name))
        .unwrap_or_else(|| panic!("operations[] lacks {name}: {ops:?}"))
}

fn field_by_name<'a>(op: &'a Json, name: &str) -> &'a Json {
    let fields = op
        .get("inputs")
        .and_then(|i| i.get("fields"))
        .and_then(Json::as_arr)
        .unwrap_or_else(|| panic!("{op:?} lacks inputs.fields"));
    fields
        .iter()
        .find(|f| f.get("name").and_then(Json::as_str) == Some(name))
        .unwrap_or_else(|| panic!("inputs.fields lacks {name}: {fields:?}"))
}

fn assert_scalar_field(op: &Json, name: &str, kind: &str, required: bool) {
    let field = field_by_name(op, name);
    assert_eq!(
        field.get("required").and_then(Json::as_bool),
        Some(required),
        "{name} required"
    );
    let schema = field.get("field").expect("field schema");
    assert_eq!(
        schema.get("kind").and_then(Json::as_str),
        Some(kind),
        "{name} kind"
    );
}

fn assert_ref_field(op: &Json, name: &str, model: &str, require_version: bool, required: bool) {
    let field = field_by_name(op, name);
    assert_eq!(
        field.get("required").and_then(Json::as_bool),
        Some(required),
        "{name} required"
    );
    let schema = field.get("field").expect("field schema");
    assert_eq!(
        schema.get("kind").and_then(Json::as_str),
        Some("ref"),
        "{name} kind"
    );
    assert_eq!(
        schema.get("model").and_then(Json::as_str),
        Some(model),
        "{name} model"
    );
    assert_eq!(
        schema.get("requireVersion").and_then(Json::as_bool),
        Some(require_version),
        "{name} requireVersion"
    );
}

#[test]
fn operations_descriptors_golden() {
    let (artifact, diags, catalog_path) = compile_source(FIXTURE);
    let _ = std::fs::remove_file(&catalog_path);
    for diag in &diags {
        assert!(
            diag.code == "E6006" || diag.code == "E6007" || diag.code == "E6008",
            "unexpected codegen code {}: {}",
            diag.code,
            diag.message
        );
    }
    assert!(
        diags.is_empty(),
        "fixture emits with zero diagnostics: {diags:?}"
    );

    let json = artifact::to_json(&artifact);
    assert!(
        json.contains("\"operations\":["),
        "artifact JSON carries operations[]"
    );
    let parsed = canlang_compiler::json::parse(&json).expect("artifact JSON parses");
    let ops = parsed
        .get("operations")
        .and_then(Json::as_arr)
        .expect("operations is an array");
    let names: Vec<&str> = ops
        .iter()
        .map(|op| op.get("name").and_then(Json::as_str).unwrap_or("<missing>"))
        .collect();
    assert_eq!(
        names,
        [
            "Shop.Gadget.read",
            "Shop.Token.read",
            "Shop.Gadget.create",
            "Shop.Gadget.update",
            "Shop.Gadget.delete",
            "Shop.Token.create",
            "Shop.Token.update",
            "Shop.Token.delete",
            "Shop.approve",
            "Shop.describe",
            "Shop.restock",
        ],
        "every operation in declaration order"
    );

    // Policy read ops: no inputs, empty description, kind read.
    for read_name in ["Shop.Gadget.read", "Shop.Token.read"] {
        let read = op_by_name(ops, read_name);
        assert_eq!(read.get("kind").and_then(Json::as_str), Some("read"));
        assert_eq!(
            read.get("description").and_then(Json::as_str),
            Some(""),
            "policies carry no caption source"
        );
        assert_eq!(
            read.get("inputs")
                .and_then(|i| i.get("fields"))
                .and_then(Json::as_arr)
                .map(|f| f.len()),
            Some(0),
            "policy read ops take no inputs"
        );
    }

    // Every entry carries exactly the contract keys.
    for op in ops {
        let mut keys: Vec<&str> = match op {
            Json::Obj(pairs) => pairs.iter().map(|(k, _)| k.as_str()).collect(),
            other => panic!("operation entry is an object: {other:?}"),
        };
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["description", "inputs", "kind", "name"],
            "contract keys for {op:?}"
        );
    }

    // CRUD create: allowlisted fields flattened, required from
    // no-default + non-nullable.
    let create = op_by_name(ops, "Shop.Gadget.create");
    assert_eq!(create.get("kind").and_then(Json::as_str), Some("create"));
    assert_eq!(
        create.get("description").and_then(Json::as_str),
        Some(""),
        "generated ops carry no authored description"
    );
    assert_scalar_field(create, "title", "string", true);
    assert_scalar_field(create, "price", "money", true);
    assert_scalar_field(create, "stock", "integer", false);
    assert_scalar_field(create, "active", "boolean", false);
    assert_scalar_field(create, "note", "string", false);
    assert_scalar_field(create, "keeper", "string", false);
    assert_scalar_field(create, "manual", "file", false);
    let kind_field = field_by_name(create, "kind");
    let kind_schema = kind_field.get("field").expect("kind schema");
    assert_eq!(
        kind_schema.get("kind").and_then(Json::as_str),
        Some("enum"),
        "kind enum"
    );
    assert_eq!(
        kind_schema.get("values").and_then(Json::as_arr),
        Some([Json::Str("new".to_string()), Json::Str("used".to_string())].as_slice()),
        "kind enum values"
    );
    assert_eq!(
        kind_field.get("required").and_then(Json::as_bool),
        Some(false),
        "defaulted enum is optional"
    );
    assert_eq!(
        create
            .get("inputs")
            .and_then(|i| i.get("fields"))
            .and_then(Json::as_arr)
            .map(|f| f.len()),
        Some(8),
        "create inputs are exactly the allowlist"
    );

    // CRUD update: versioned record plus optional allowlisted fields.
    let update = op_by_name(ops, "Shop.Gadget.update");
    assert_eq!(update.get("kind").and_then(Json::as_str), Some("update"));
    assert_ref_field(update, "record", "Shop.Gadget", true, true);
    assert_scalar_field(update, "title", "string", false);
    assert_scalar_field(update, "price", "money", false);
    assert_scalar_field(update, "stock", "integer", false);
    assert_scalar_field(update, "kind", "enum", false);
    assert_scalar_field(update, "manual", "file", false);

    // CRUD delete: versioned record only.
    let delete = op_by_name(ops, "Shop.Gadget.delete");
    assert_eq!(delete.get("kind").and_then(Json::as_str), Some("delete"));
    assert_ref_field(delete, "record", "Shop.Gadget", true, true);
    assert_eq!(
        delete
            .get("inputs")
            .and_then(|i| i.get("fields"))
            .and_then(Json::as_arr)
            .map(|f| f.len()),
        Some(1),
        "delete takes only the record"
    );

    // Non-allowlisted fields (including `server=`-owned `minted_by`,
    // which analysis E3009 also bars from allowlists) are never inputs.
    let token_create = op_by_name(ops, "Shop.Token.create");
    assert_scalar_field(token_create, "code", "string", true);
    assert_eq!(
        token_create
            .get("inputs")
            .and_then(|i| i.get("fields"))
            .and_then(Json::as_arr)
            .map(|f| f.len()),
        Some(1),
        "create inputs are exactly the allowlist"
    );
    let token_update = op_by_name(ops, "Shop.Token.update");
    assert_ref_field(token_update, "record", "Shop.Token", true, true);
    assert_scalar_field(token_update, "code", "string", false);

    // Scenario: verbatim `#` description, signature-ordered typed inputs.
    let approve = op_by_name(ops, "Shop.approve");
    assert_eq!(approve.get("kind").and_then(Json::as_str), Some("scenario"));
    assert_eq!(
        approve.get("description").and_then(Json::as_str),
        Some("Approve a gadget for sale, optionally recording a note."),
        "description is the verbatim `#` text"
    );
    assert_ref_field(approve, "gadget", "Shop.Gadget", true, true);
    assert_scalar_field(approve, "note", "string", false);

    // T15a re-pin (T04a §6 array mapping; coordinator-verified live via
    // a `can compile` probe): `int[]` scenario params now map, so `restock`
    // is present with zero diagnostics (asserted above). Parameters never
    // carry the field-only `!`, so parameter arrays are always ordinary.
    let restock = op_by_name(ops, "Shop.restock");
    assert_eq!(restock.get("kind").and_then(Json::as_str), Some("scenario"));
    assert_eq!(
        restock.get("description").and_then(Json::as_str),
        Some("Restock many gadgets at once."),
        "description is the verbatim `#` text"
    );
    let ids = field_by_name(restock, "ids");
    assert_eq!(
        ids.get("required").and_then(Json::as_bool),
        Some(false),
        "ordinary arrays omit to empty, never required"
    );
    let ids_schema = ids.get("field").expect("ids schema");
    assert_eq!(
        ids_schema.get("kind").and_then(Json::as_str),
        Some("integer"),
        "ids element kind"
    );
    assert_eq!(
        ids.get("array")
            .and_then(|a| a.get("required"))
            .and_then(Json::as_bool),
        Some(false),
        "ordinary-array marker per T09: `int[]` has no `!`"
    );
    assert_eq!(
        restock
            .get("inputs")
            .and_then(|i| i.get("fields"))
            .and_then(Json::as_arr)
            .map(|f| f.len()),
        Some(1),
        "restock takes only ids"
    );

    // `read=true` scenarios are reads with versionless refs.
    let describe = op_by_name(ops, "Shop.describe");
    assert_eq!(describe.get("kind").and_then(Json::as_str), Some("read"));
    assert_eq!(
        describe.get("description").and_then(Json::as_str),
        Some("Describe one gadget briefly.")
    );
    assert_ref_field(describe, "gadget", "Shop.Gadget", false, true);

    // The entrypoint `canApp()` registry carries the same descriptors.
    let entry = &artifact.modules[0].js;
    assert!(
        entry.contains("operations:["),
        "canApp() carries an operations registry"
    );
    for verbatim in [
        "Approve a gadget for sale, optionally recording a note.",
        "Describe one gadget briefly.",
    ] {
        assert!(
            entry.contains(verbatim),
            "canApp() carries the verbatim description {verbatim:?}"
        );
    }
    for marker in [
        "\"Shop.Gadget.create\"",
        "\"kind\":\"update\"",
        "\"requireVersion\":true",
        "\"requireVersion\":false",
        "\"kind\":\"enum\"",
    ] {
        assert!(
            entry.contains(marker),
            "canApp() operations carry typed inputs ({marker})"
        );
    }
}

/// Trusted (`on=`) event handlers are not user operations: they stay out
/// of the descriptors (here only the policy read op is described). The
/// handler trigger itself keeps its pre-existing `E6008`; descriptor
/// derivation adds nothing.
#[test]
fn trusted_handlers_excluded_from_descriptors() {
    let src = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\n scenario audit on=teams.member_removed\n  do\n   let x = 1\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (artifact, diags, catalog_path) = compile_source(src);
    let _ = std::fs::remove_file(&catalog_path);
    assert_eq!(diags.len(), 1, "only the trigger diagnostic: {diags:?}");
    assert_eq!(diags[0].code, "E6008");
    assert!(
        diags[0].message.contains("handler triggers"),
        "trigger diagnostic: {:?}",
        diags[0].message
    );
    let json = artifact::to_json(&artifact);
    let parsed = canlang_compiler::json::parse(&json).expect("artifact JSON parses");
    let ops = parsed
        .get("operations")
        .and_then(Json::as_arr)
        .expect("operations is an array");
    let names: Vec<&str> = ops
        .iter()
        .filter_map(|op| op.get("name").and_then(Json::as_str))
        .collect();
    assert_eq!(
        names,
        ["Shop.Gadget.read"],
        "handlers stay out; the policy read op is still published"
    );
    assert!(
        artifact.modules[0].js.contains("operations:["),
        "canApp() carries the policy read descriptor"
    );
}

/// A model field literally named `record` collides with the synthesized
/// `record` ref on update, so update is omitted. Create (no synthesized
/// input) keeps both fields and delete (only the ref) is unaffected.
/// Never an ambiguous closed schema.
#[test]
fn record_field_collision_omits_update_and_delete() {
    let src = "app Shop\nGiven\n Gadget { title:text, record:text }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,record\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (artifact, diags, catalog_path) = compile_source(src);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "collision omits silently: {diags:?}");
    let json = artifact::to_json(&artifact);
    let parsed = canlang_compiler::json::parse(&json).expect("artifact JSON parses");
    let ops = parsed
        .get("operations")
        .and_then(Json::as_arr)
        .expect("operations is an array");
    let names: Vec<&str> = ops
        .iter()
        .filter_map(|op| op.get("name").and_then(Json::as_str))
        .collect();
    assert_eq!(
        names,
        [
            "Shop.Gadget.read",
            "Shop.Gadget.create",
            "Shop.Gadget.delete"
        ],
        "only the collision-free operations are described"
    );
    let create = op_by_name(ops, "Shop.Gadget.create");
    assert_scalar_field(create, "title", "string", true);
    assert_scalar_field(create, "record", "string", true);
    let delete = op_by_name(ops, "Shop.Gadget.delete");
    assert_ref_field(delete, "record", "Shop.Gadget", true, true);
}
