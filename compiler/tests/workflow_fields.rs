//! Existing workflow wire fields and contextual empty-array fallback typing.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::types::{ResolvedType, Scalar};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};

fn check(source: &str) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let file = db.add("workflow-fields.can".into(), source.into());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    check_program(&db, &[file], catalog.as_ref())
}

fn field_type() -> ResolvedType {
    ResolvedType::Object(
        ["node", "key", "kind", "label"]
            .into_iter()
            .map(|name| (name.to_string(), ResolvedType::Scalar(Scalar::Text)))
            .collect(),
    )
}

fn fields_type() -> ResolvedType {
    ResolvedType::Array {
        element: Box::new(field_type()),
        ordered: true,
        nonempty: false,
    }
}

fn type_at<'a>(program: &'a CheckedProgram, source: &str, expression: &str) -> &'a ResolvedType {
    program
        .types
        .node_types
        .iter()
        .find_map(|(node, ty)| {
            (source[node.start as usize..node.end as usize].trim() == expression).then_some(ty)
        })
        .unwrap_or_else(|| panic!("missing checked expression {expression}"))
}

const SOURCE: &str = r#"app WorkflowFields
use std {WorkflowInspection as Inspection}
use std {ImagesV1 as Images} from=deployment.images
Given
 Template {inspection:delivery(Images.inspect)?}
 policy Template read=members
When
 scenario inspect(inspection:Inspection?,template:Template) -> bool by=members
  do
   let fields=inspection?.fields ?? []
   let receiptFields=template.inspection?.result?.fields ?? []
   for field in fields limit=10
    let node=field.node
    let key=field.key
    let kind=field.kind
    let label=field.label
   return true
Then
"#;

// Original Creative list/empty/pagination/text shape, with a finite owning model.
const ROW_SOURCE: &str = r#"app WorkflowRows
use std {ImagesV1 as Images} from=deployment.images
Given
 Template {inspection:delivery(Images.inspect)?}
 policy Template read=members
When
Then
 page /templates title="Templates"
  list Template
   text row.inspection
   list (row.inspection?.result?.fields ?? []) empty="No input fields found"@{nl="Geen invoervelden gevonden"}
    pagination
    text row.node,row.key,row.kind,row.label
   text row.inspection
"#;

#[test]
fn original_workflow_field_list_seeds_its_value_row_and_preserves_outer_stored_row() {
    let (program, diagnostics) = check(ROW_SOURCE);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for field in ["node", "key", "kind", "label"] {
        assert_eq!(
            type_at(&program, ROW_SOURCE, &format!("row.{field}")),
            &ResolvedType::Scalar(Scalar::Text)
        );
    }
    let outer = program
        .types
        .node_types
        .iter()
        .filter(|(node, _)| {
            ROW_SOURCE[node.start as usize..node.end as usize].trim() == "row.inspection"
        })
        .collect::<Vec<_>>();
    assert_eq!(
        outer.len(),
        3,
        "outer text before/after plus the nested list's outer receipt"
    );
    for (_, ty) in outer {
        assert!(
            matches!(ty, ResolvedType::Nullable(inner) if matches!(inner.as_ref(), ResolvedType::StdDelivery { capability: "std.ImagesV1", op } if op.name == "inspect"))
        );
    }
    let missing = ROW_SOURCE.replace("row.label", "row.inspection");
    let (_, diagnostics) = check(&missing);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E2013"),
        "inner row must not fall through to outer stored row: {diagnostics:?}"
    );
    let wrong = ROW_SOURCE.replace(
        "fields ?? []",
        "fields ?? [{node=\"n\",key=\"k\",kind=\"provider-kind\",label=1}]",
    );
    let (_, diagnostics) = check(&wrong);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3004"),
        "{diagnostics:?}"
    );
}

#[test]
fn inspection_and_receipt_fields_have_the_actual_nested_schema_and_empty_fallback() {
    let (program, diagnostics) = check(SOURCE);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for expression in [
        "inspection?.fields ?? []",
        "template.inspection?.result?.fields ?? []",
        "[]",
    ] {
        assert_eq!(
            type_at(&program, SOURCE, expression),
            &fields_type(),
            "{expression}"
        );
    }
    for field in ["node", "key", "kind", "label"] {
        assert_eq!(
            type_at(&program, SOURCE, &format!("field.{field}")),
            &ResolvedType::Scalar(Scalar::Text)
        );
    }
    let grouped = SOURCE.replace("inspection?.fields ?? []", "inspection?.fields ?? ([]) ");
    let (program, diagnostics) = check(&grouped);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        type_at(&program, &grouped, "inspection?.fields ?? ([])"),
        &fields_type()
    );
}

#[test]
fn coalesce_refuses_wrong_elements_missing_fields_and_wrong_scalar_types() {
    for fallback in [
        "[1]",
        "[\"field\"]",
        "[null]",
        "0",
        "[{node=\"n\",key=\"k\",kind=\"provider-kind\"}]",
        "[{node=\"n\",key=\"k\",kind=\"provider-kind\",label=1}]",
    ] {
        let source = SOURCE.replace(
            "inspection?.fields ?? []",
            &format!("inspection?.fields ?? {fallback}"),
        );
        let (_, diagnostics) = check(&source);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E3004"),
            "{source}\n{diagnostics:?}"
        );
    }
    let source = SOURCE.replace("field.label", "field.missing");
    let (_, diagnostics) = check(&source);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E2013"),
        "{diagnostics:?}"
    );
}

#[test]
fn empty_fallback_does_not_admit_nonnullable_or_scalar_left_operands() {
    for source in [
        "app Nonnullable\nuse std {WorkflowInspection}\nGiven\nWhen\n scenario inspect(inspection:WorkflowInspection) -> bool by=members\n  do\n   let fields=inspection.fields ?? []\n   return true\nThen\n",
        "app ScalarFallback\nGiven\nWhen\n scenario inspect(value:int?) -> bool by=members\n  do\n   let fields=value ?? []\n   return true\nThen\n",
    ] {
        let (_, diagnostics) = check(source);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E3004"),
            "{diagnostics:?}"
        );
    }
}

#[test]
fn workflow_field_is_nested_only_and_bound_unknown_aliases_stay_opaque() {
    let source = "app DirectWorkflowField\nuse std {WorkflowField}\nGiven\nWhen\n scenario inspect(value:WorkflowField) -> bool by=members\n  do return true\nThen\n";
    let (_, diagnostics) = check(source);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E2004"),
        "{diagnostics:?}"
    );
    let source = "app BoundWorkflowField\nuse std {WorkflowField as External} from=deployment.fields\nGiven\nWhen\n scenario inspect(value:External) -> bool by=members\n  do\n   let constructed=External {node=\"n\",key=\"k\",kind=\"provider-kind\",label=\"Label\"}\n   return true\nThen\n";
    let (program, diagnostics) = check(source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let scenario = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "BoundWorkflowField.inspect")
        .unwrap();
    let parameter = program.effects.scenarios[&scenario.id].params[0].param;
    assert!(matches!(
        program.types.symbol_types[&parameter],
        ResolvedType::Opaque(_)
    ));
    assert!(matches!(
        type_at(
            &program,
            source,
            "External {node=\"n\",key=\"k\",kind=\"provider-kind\",label=\"Label\"}"
        ),
        ResolvedType::Opaque(_)
    ));
}
