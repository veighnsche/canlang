//! Independently authored artifact wire fixtures: field order, omitted directive
//! fields, encoded fragments, exact scalar strings, JS controls and map nulls.
use canlang_compiler::codegen::artifact::*;
use canlang_compiler::codegen::js::{
    JsFieldDefault, JsMcpField, JsModel, JsModelField, JsModelFieldType, JsOperation,
    JsOperationField, JsOperationKind,
};
use canlang_compiler::codegen::sourcemap::SourceMap;

fn empty() -> CompileArtifact {
    CompileArtifact {
        language_version: "1.0".into(),
        tool_version: "test".into(),
        sources: vec![],
        modules: vec![],
        callables: vec![],
        operations: vec![],
        models: vec![],
        pages: vec![],
        migrations: vec![],
        requires: vec![],
        tests: vec![],
    }
}

#[test]
fn empty_artifact_has_fixed_fields_and_no_newline() {
    let json = to_json(&empty());
    assert_eq!(
        json,
        r#"{"artifact_version":1,"language_version":"1.0","tool_version":"test","sources":[],"modules":[],"callables":[],"operations":[],"models":[],"pages":[],"migrations":[],"requires":[],"tests":[]}"#
    );
    assert!(!json.ends_with('\n'));
}

fn module(path: &str) -> ArtifactModule {
    ArtifactModule {
        path: path.into(),
        js: "export const x=\"é😀\";\n\\\t\r\u{8}\u{c}\u{1}".into(),
        map: SourceMap {
            file: path.into(),
            sources: vec!["z.can".into(), "a.can".into()],
            sources_content: vec![Some("é😀\n".into()), None],
            names: vec!["z".into(), "a".into()],
            mappings: "AAAA;ACAA".into(),
        },
    }
}

#[test]
fn populated_artifact_preserves_order_omissions_and_embedded_json() {
    let mut artifact = empty();
    artifact.sources = vec![
        ArtifactSource {
            path: "z.can".into(),
            sha256: "zz".into(),
        },
        ArtifactSource {
            path: "a.can".into(),
            sha256: "aa".into(),
        },
    ];
    artifact.modules = vec![module("app/z.mjs")];
    artifact.callables = vec![ArtifactCallable {
        id: "Z.go".into(),
        kind: "operation".into(),
        module: "app/z.mjs".into(),
        export: "canApp".into(),
        input_style: None,
        member: vec!["z".into(), "a".into()],
    }];
    artifact.operations = vec![JsOperation {
        name: "Z.go".into(),
        kind: JsOperationKind::Scenario,
        description: "".into(),
        inputs: vec![
            JsOperationField {
                name: "z".into(),
                field: JsMcpField::Integer,
                required: false,
                nullable: true,
                array_required: Some(false),
                default: Some(JsFieldDefault::Literal("null".into())),
                description: Some("".into()),
            },
            JsOperationField {
                name: "a".into(),
                field: JsMcpField::String,
                required: true,
                nullable: false,
                array_required: None,
                default: None,
                description: None,
            },
        ],
    }];
    artifact.models = vec![JsModel {
        name: "Z.Row".into(),
        fields: vec![JsModelField {
            name: "amount".into(),
            field: JsModelFieldType::Decimal,
            required: false,
            nullable: false,
            server_only: false,
            array_required: None,
            default: Some(JsFieldDefault::Literal(
                r#""12345678901234567890.1200""#.into(),
            )),
            description: None,
            machine: None,
        }],
        delete_mode: "archive".into(),
        unique_keys: vec!["z".into(), "a".into()],
        parent: Some("Z.Parent".into()),
        scope_app: true,
    }];
    artifact.pages = vec![ArtifactPage {
        owner: "Z".into(),
        path: "/".into(),
        module: "app/z.mjs".into(),
        export: "page".into(),
    }];
    artifact.migrations = vec![ArtifactMigration {
        id: "Z@old".into(),
        owner: "Z".into(),
        from: "old".into(),
        body_digest: "digest".into(),
        directives: vec![
            ArtifactMigrationDirective {
                kind: "dropOwner".into(),
                from: None,
                to: None,
                model: None,
                field: None,
                handler_contract: None,
            },
            ArtifactMigrationDirective {
                kind: "renameField".into(),
                from: Some("".into()),
                to: Some("new".into()),
                model: Some("Row".into()),
                field: None,
                handler_contract: Some("H.v1".into()),
            },
        ],
    }];
    artifact.requires = vec![ArtifactRequirement {
        capability: "state".into(),
        min_version: u64::MAX,
    }];
    artifact.tests = vec![ArtifactTestModule {
        scope: "Z.go".into(),
        module: module("test/z.mjs"),
        fixtures: vec!["z".into(), "a".into()],
    }];
    // Literal expectation is authored from the contract, not another encoder.
    let expected = concat!(
        r#"{"artifact_version":1,"language_version":"1.0","tool_version":"test","sources":[{"path":"z.can","sha256":"zz"},{"path":"a.can","sha256":"aa"}],"modules":[{"path":"app/z.mjs","js":"export const x=\"é😀\";\n\\\t\r\u0008\u000c\u0001","map":{"version":3,"file":"app/z.mjs","sources":["z.can","a.can"],"sourcesContent":["é😀\n",null],"names":["z","a"],"mappings":"AAAA;ACAA"}}],"callables":[{"id":"Z.go","kind":"operation","module":"app/z.mjs","export":"canApp","member":["z","a"]}],"#,
        r#""operations":[{"name":"Z.go","kind":"scenario","description":"","inputs":{"fields":[{"name":"z","field":{"kind":"integer"},"required":false,"nullable":true,"array":{"required":false},"default":{"kind":"literal","value":null},"description":""},{"name":"a","field":{"kind":"string"},"required":true}]}}],"models":[{"name":"Z.Row","fields":[{"name":"amount","field":{"kind":"decimal"},"required":false,"serverOnly":false,"default":{"kind":"literal","value":"12345678901234567890.1200"}}],"deleteMode":"archive","uniqueKeys":["z","a"],"parent":"Z.Parent","scope":"app"}],"#,
        r#""pages":[{"owner":"Z","path":"/","module":"app/z.mjs","export":"page"}],"migrations":[{"id":"Z@old","owner":"Z","from":"old","body_digest":"digest","directives":[{"kind":"dropOwner"},{"kind":"renameField","from":"","to":"new","model":"Row","handlerContract":"H.v1"}]}],"requires":[{"capability":"state","min_version":18446744073709551615}],"tests":[{"scope":"Z.go","module":{"path":"test/z.mjs","js":"export const x=\"é😀\";\n\\\t\r\u0008\u000c\u0001","map":{"version":3,"file":"test/z.mjs","sources":["z.can","a.can"],"sourcesContent":["é😀\n",null],"names":["z","a"],"mappings":"AAAA;ACAA"}},"fixtures":["z","a"]}]}"#,
    );
    let json = to_json(&artifact);
    assert_eq!(json, expected);
    let decoded: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(decoded["modules"][0]["map"].is_object());
    assert!(decoded["operations"].is_array());
    assert!(decoded["operations"][0]["inputs"]["fields"][0]["default"]["value"].is_null());
    assert_eq!(
        decoded["models"][0]["fields"][0]["default"]["value"],
        "12345678901234567890.1200"
    );
    assert_eq!(decoded["modules"][0]["js"], artifact.modules[0].js);
}
