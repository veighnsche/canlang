//! Frozen policy byte layout, including its unusual nested closing indents.
use canlang_compiler::policy::*;

#[test]
fn empty_dump_has_one_serializer_newline() {
    assert_eq!(
        policy_dump_json(&PolicyDump::default()),
        "{\n  \"version\": 1,\n  \"roles\": [],\n  \"models\": [],\n  \"operations\": []\n}\n"
    );
}

#[test]
fn populated_dump_preserves_controls_blanks_and_inline_arrays() {
    let dump = PolicyDump {
        roles: vec![RoleEntry {
            package: "P".into(),
            name: "admin".into(),
            canonical: "P.admin".into(),
            label: Some("".into()),
        }],
        models: vec![ModelEntry {
            canonical: "P.Row".into(),
            policies: vec![PolicyEntry {
                kind: "read".into(),
                grantee: "admin".into(),
                where_predicate: Some("".into()),
                source: "policy Row read=admin\n\t\u{8}\u{c}\u{0}\"\\é😀".into(),
            }],
            invariants: vec![InvariantEntry {
                predicate: "value > 0".into(),
                source: "invariant Row: value > 0".into(),
            }],
        }],
        operations: vec![OperationEntry {
            canonical: "P.go".into(),
            kind: "scenario".into(),
            by: Some("".into()),
            when: Some("".into()),
            requires: vec!["z".into(), "a".into()],
            params: vec![
                ParamEntry {
                    name: "z".into(),
                    typ: "text?".into(),
                },
                ParamEntry {
                    name: "a".into(),
                    typ: "int[]".into(),
                },
            ],
            source: "scenario go(z:text?, a:int[])".into(),
        }],
    };
    assert_eq!(
        policy_dump_json(&dump),
        concat!(
            r#"{
  "version": 1,
  "roles": [
    {"package": "P", "name": "admin", "canonical": "P.admin", "label": ""}
  ],
  "models": [
    {"canonical": "P.Row", "policies": [
      {"kind": "read", "grantee": "admin", "where": "", "source": "policy Row read=admin\n\t\u0008\u000c\u0000\"\\é😀"}
      ], "invariants": [
      {"predicate": "value > 0", "source": "invariant Row: value > 0"}
      ]}
  ],
  "operations": [
    {"canonical": "P.go", "kind": "scenario", "by": "", "when": "", "requires": ["z", "a"], "params": [{"name": "z", "type": "text?"}, {"name": "a", "type": "int[]"}], "source": "scenario go(z:text?, a:int[])"}
  ]
}"#,
            "\n"
        )
    );
}

#[test]
fn multiple_records_empty_nested_arrays_and_omitted_options() {
    let dump = PolicyDump {
        roles: vec![
            RoleEntry {
                package: "Z".into(),
                name: "z".into(),
                canonical: "Z.z".into(),
                label: None,
            },
            RoleEntry {
                package: "A".into(),
                name: "a".into(),
                canonical: "A.a".into(),
                label: None,
            },
        ],
        models: vec![
            ModelEntry {
                canonical: "Z.Row".into(),
                policies: vec![],
                invariants: vec![],
            },
            ModelEntry {
                canonical: "A.Row".into(),
                policies: vec![
                    PolicyEntry {
                        kind: "read".into(),
                        grantee: "z".into(),
                        where_predicate: None,
                        source: "first".into(),
                    },
                    PolicyEntry {
                        kind: "read".into(),
                        grantee: "a".into(),
                        where_predicate: None,
                        source: "second".into(),
                    },
                ],
                invariants: vec![],
            },
        ],
        operations: vec![
            OperationEntry {
                canonical: "Z.Row.create".into(),
                kind: "create".into(),
                by: None,
                when: None,
                requires: vec![],
                params: vec![],
                source: "crud Row create".into(),
            },
            OperationEntry {
                canonical: "A.Row.update".into(),
                kind: "update".into(),
                by: None,
                when: None,
                requires: vec![],
                params: vec![],
                source: "crud Row update".into(),
            },
        ],
    };
    assert_eq!(
        policy_dump_json(&dump),
        concat!(
            r#"{
  "version": 1,
  "roles": [
    {"package": "Z", "name": "z", "canonical": "Z.z"},
    {"package": "A", "name": "a", "canonical": "A.a"}
  ],
  "models": [
    {"canonical": "Z.Row", "policies": [], "invariants": []},
    {"canonical": "A.Row", "policies": [
      {"kind": "read", "grantee": "z", "source": "first"},
      {"kind": "read", "grantee": "a", "source": "second"}
      ], "invariants": []}
  ],
  "operations": [
    {"canonical": "Z.Row.create", "kind": "create", "requires": [], "params": [], "source": "crud Row create"},
    {"canonical": "A.Row.update", "kind": "update", "requires": [], "params": [], "source": "crud Row update"}
  ]
}"#,
            "\n"
        )
    );
}

#[test]
fn real_cli_keeps_the_existing_second_trailing_newline() {
    let folder = std::env::temp_dir().join(format!("can-typed-policy-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let source = folder.join("empty.can");
    let catalog = folder.join("catalog.json");
    std::fs::write(&source, "app Demo\nGiven\nWhen\nThen\n").unwrap();
    std::fs::write(
        &catalog,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[]}"#,
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
        .arg("policy")
        .arg("--format=json")
        .arg("--catalog")
        .arg(&catalog)
        .arg(&source)
        .output()
        .unwrap();
    std::fs::remove_file(source).unwrap();
    std::fs::remove_file(catalog).unwrap();
    std::fs::remove_dir(folder).unwrap();
    assert!(
        output.status.success(),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&output.stderr), String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "{\n  \"version\": 1,\n  \"roles\": [],\n  \"models\": [],\n  \"operations\": []\n}\n\n"
    );
}
