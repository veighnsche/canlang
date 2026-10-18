//! Logical URL identity survives the legacy string wire tag and field reuse.
use canlang_compiler::{
    analysis::{
        catalog::{CatalogRequest, load_catalog},
        check_program,
    },
    codegen::{EmitOptions, EmitSources, emit, to_json_string},
    diagnostic::DiagnosticResult,
    source::{SourceDb, Span},
};
use std::path::Path;

#[test]
fn authored_and_imported_model_url_fields_retain_exact_logical_wrappers() {
    for scalar in ["url", "text"] {
        let source = format!(
            r#"app LinkFields uses=[consumer]
package catalog
 Given
  export Source {{destination:{scalar}}}
 When
 Then
package consumer
 use catalog {{Source as Original}}
 Given
  Link {{destination:Original.destination,optional:{scalar}?,many:{scalar}[],optional_many:{scalar}[]?,target:Original,optional_target:Original?,targets:Original[],required_targets:Original[]!}}
 When
  scenario ping()->bool by=members
   do
    return true
 Then
"#
        );
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut db = SourceDb::new();
        let file = db.add("model-url-fields.can".into(), source);
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let mut result = DiagnosticResult::new("model-url-fields", "1.0", 1);
        result.add_sources(&db);
        let (artifact, diagnostics) = emit(
            &program,
            &EmitSources {
                db: &db,
                result: &result,
                catalog: catalog.as_ref(),
                options: EmitOptions {
                    allow_incomplete_test_only: false,
                    native_scenario_receipts: false,
                },
            },
        );
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let artifact: serde_json::Value = serde_json::from_str(&to_json_string(&artifact)).unwrap();
        let model = artifact["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["name"] == "consumer.Link")
            .unwrap();
        for (name, suffix, nullable, array) in [
            ("destination", "", false, false),
            ("optional", "?", true, false),
            ("many", "[]", false, true),
            ("optional_many", "[]?", true, true),
        ] {
            let field = model["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|field| field["name"] == name)
                .unwrap();
            assert_eq!(field["field"]["kind"], "string");
            assert_eq!(field["valueType"], format!("{scalar}{suffix}"), "{name}");
            assert_eq!(field["nullable"].as_bool().unwrap_or(false), nullable);
            assert_eq!(field.get("array").is_some(), array);
        }
        for (name, suffix, array_required) in [
            ("target", "", None),
            ("optional_target", "?", None),
            ("targets", "[]", Some(false)),
            ("required_targets", "[]!", Some(true)),
        ] {
            let field = model["fields"].as_array().unwrap().iter()
                .find(|field| field["name"] == name).unwrap();
            assert_eq!(field["valueType"], format!("catalog.Source{suffix}"));
            assert_eq!(field["field"]["kind"], "ref");
            assert_eq!(field["field"]["model"], "catalog.Source");
            assert_eq!(field.get("array").map(|array| array["required"].as_bool().unwrap()), array_required);
        }
        let source = artifact["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["name"] == "catalog.Source")
            .unwrap();
        assert_eq!(source["fields"][0]["valueType"], scalar);
    }
}
