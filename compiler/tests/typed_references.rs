//! Fixed reference wire witnesses authored independently of either serializer.
use canlang_compiler::docs::*;
use canlang_compiler::json;

fn location() -> ReferenceSourceLocation {
    ReferenceSourceLocation {
        source_id: "x.can".into(),
        start: 1,
        end: 9,
    }
}

#[test]
fn empty_reference_preserves_explicit_null_and_empty_arrays() {
    let model = ReferenceModel {
        version: 1,
        source_revision: "revision".into(),
        catalog_version: None,
        language_version: "1.0".into(),
        app_default_locale: "en".into(),
        owners: vec![],
        availability: ReferenceAvailability::Unknown,
    };
    let expected = r#"{"version":1,"sourceRevision":"revision","catalogVersion":null,"languageVersion":"1.0","appDefaultLocale":"en","owners":[],"availability":{"status":"unknown"}}"#;
    assert_eq!(model.to_json_string(), expected);
    assert_eq!(json::render(&model.to_json()), expected);
}

#[test]
fn populated_reference_preserves_source_strings_order_and_presence() {
    let description = ReferenceDescriptionValue {
        source: "é/🦀\n\u{8}\u{c}".into(),
        source_lang: "fr".into(),
        variants: vec![
            ReferenceDescriptionVariant {
                tag: "nl".into(),
                text: None,
            },
            ReferenceDescriptionVariant {
                tag: "en".into(),
                text: Some("".into()),
            },
        ],
        location: location(),
    };
    let field = ReferenceField {
        name: "value".into(),
        ty: "text?".into(),
        nullable: true,
        creation_required: false,
        default: Some("\"\\n\"".into()),
        constraints: vec![ReferenceConstraint {
            kind: "min".into(),
            detail: "1.00e+2".into(),
        }],
        description: None,
    };
    let bare_field = ReferenceField {
        name: "bare".into(),
        ty: "bool".into(),
        nullable: false,
        creation_required: true,
        default: None,
        constraints: vec![],
        description: None,
    };
    let example = ReferenceExample {
        label: "first".into(),
        source: "do\n  emit(\"\\t\")\r\n".into(),
        expected: Some("false".into()),
    };
    let model = ReferenceModel {
        version: 1,
        source_revision: "revision".into(),
        catalog_version: Some("".into()),
        language_version: "1.0".into(),
        app_default_locale: "fr".into(),
        owners: vec![ReferenceOwner {
            name: "Shop".into(),
            declarations: vec![ReferenceDeclaration {
                owner: "Shop".into(),
                name: "Order".into(),
                kind: ReferenceDeclarationKind::Model,
                description: Some(description),
                fields: vec![field, bare_field],
                examples: vec![
                    example,
                    ReferenceExample {
                        label: "second".into(),
                        source: "".into(),
                        expected: None,
                    },
                ],
                location: location(),
            }],
            operations: vec![ReferenceOperation {
                id: "Shop.send".into(),
                description: None,
                inputs: vec![ReferenceOperationInput {
                    name: "request".into(),
                    ty: "text".into(),
                    nullable: false,
                    creation_required: false,
                    default: Some("".into()),
                    constraints: vec![],
                    description: None,
                }],
                result: ReferenceOperationResult {
                    ty: "void".into(),
                    nullable: false,
                    description: None,
                },
                examples: vec![ReferenceExample {
                    label: "empty".into(),
                    source: "".into(),
                    expected: Some("".into()),
                }],
                location: location(),
            }],
        }],
        availability: ReferenceAvailability::Available {
            owner: "owner".into(),
            catalog: "catalog".into(),
        },
    };
    let expected = r#"{"version":1,"sourceRevision":"revision","catalogVersion":"","languageVersion":"1.0","appDefaultLocale":"fr","owners":[{"name":"Shop","declarations":[{"owner":"Shop","name":"Order","kind":"model","description":{"source":"é/🦀\n\u0008\u000c","sourceLang":"fr","variants":[{"tag":"nl","text":null},{"tag":"en","text":""}],"location":{"sourceId":"x.can","start":1,"end":9}},"fields":[{"name":"value","type":"text?","nullable":true,"creationRequired":false,"default":"\"\\n\"","constraints":[{"kind":"min","detail":"1.00e+2"}]},{"name":"bare","type":"bool","nullable":false,"creationRequired":true,"constraints":[]}],"examples":[{"label":"first","source":"do\n  emit(\"\\t\")\r\n","expected":"false"},{"label":"second","source":""}],"location":{"sourceId":"x.can","start":1,"end":9}}],"operations":[{"id":"Shop.send","inputs":[{"name":"request","type":"text","nullable":false,"creationRequired":false,"default":"","constraints":[]}],"result":{"type":"void","nullable":false},"examples":[{"label":"empty","source":"","expected":""}],"location":{"sourceId":"x.can","start":1,"end":9}}]}],"availability":{"status":"available","owner":"owner","catalog":"catalog"}}"#;
    assert_eq!(model.to_json_string(), expected);
    assert_eq!(json::render(&model.to_json()), expected);
    let owner = &model.owners[0];
    // Every public compatibility adapter must retain the typed wire shape.
    assert_eq!(
        owner.to_json(),
        json::parse(&json::to_compact_string(owner).unwrap()).unwrap()
    );
    let declaration = &owner.declarations[0];
    assert_eq!(
        declaration.to_json(),
        json::parse(&json::to_compact_string(declaration).unwrap()).unwrap()
    );
    assert_eq!(
        declaration.fields[0]
            .to_json()
            .get("default")
            .unwrap()
            .as_str(),
        Some("\"\\n\"")
    );
    assert_eq!(
        declaration.examples[0]
            .to_json()
            .get("expected")
            .unwrap()
            .as_str(),
        Some("false")
    );
}

#[test]
fn optional_descriptions_are_omitted_only_when_none() {
    let description = ReferenceDescriptionValue {
        source: "".into(),
        source_lang: "en".into(),
        variants: vec![],
        location: location(),
    };
    let input = ReferenceOperationInput {
        name: "x".into(),
        ty: "bool".into(),
        nullable: false,
        creation_required: false,
        default: None,
        constraints: vec![],
        description: Some(description.clone()),
    };
    assert_eq!(
        json::render(&input.to_json()),
        r#"{"name":"x","type":"bool","nullable":false,"creationRequired":false,"constraints":[],"description":{"source":"","sourceLang":"en","variants":[],"location":{"sourceId":"x.can","start":1,"end":9}}}"#
    );
    let result = ReferenceOperationResult {
        ty: "bool".into(),
        nullable: false,
        description: Some(description.clone()),
    };
    assert_eq!(
        json::render(&result.to_json()),
        r#"{"type":"bool","nullable":false,"description":{"source":"","sourceLang":"en","variants":[],"location":{"sourceId":"x.can","start":1,"end":9}}}"#
    );
    let operation = ReferenceOperation {
        id: "A.x".into(),
        description: Some(description.clone()),
        inputs: vec![],
        result: ReferenceOperationResult {
            ty: "void".into(),
            nullable: false,
            description: None,
        },
        examples: vec![],
        location: location(),
    };
    assert_eq!(
        json::render(&operation.to_json()),
        r#"{"id":"A.x","description":{"source":"","sourceLang":"en","variants":[],"location":{"sourceId":"x.can","start":1,"end":9}},"inputs":[],"result":{"type":"void","nullable":false},"examples":[],"location":{"sourceId":"x.can","start":1,"end":9}}"#
    );
    let field = ReferenceField {
        name: "x".into(),
        ty: "text".into(),
        nullable: false,
        creation_required: false,
        default: Some("".into()),
        constraints: vec![],
        description: Some(description),
    };
    assert_eq!(
        json::render(&field.to_json()),
        r#"{"name":"x","type":"text","nullable":false,"creationRequired":false,"default":"","constraints":[],"description":{"source":"","sourceLang":"en","variants":[],"location":{"sourceId":"x.can","start":1,"end":9}}}"#
    );
    let declaration = ReferenceDeclaration {
        owner: "A".into(),
        name: "X".into(),
        kind: ReferenceDeclarationKind::Contract,
        description: None,
        fields: vec![],
        examples: vec![],
        location: location(),
    };
    assert_eq!(
        json::render(&declaration.to_json()),
        r#"{"owner":"A","name":"X","kind":"contract","fields":[],"examples":[],"location":{"sourceId":"x.can","start":1,"end":9}}"#
    );
}
