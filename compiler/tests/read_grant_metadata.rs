//! Checked actor and direct row-subject read metadata through the compiler CLI.
use std::path::Path;
use std::process::Command;

#[test]
fn checked_read_grants_preserve_unrepresentable_rules() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let fixture = std::fs::read_to_string(
        root.join("packages/cloudflare/test/fixtures/typed-authorized-reads.can"),
    )
    .unwrap();
    // Keep the real owner/auditor workflow and add predicates that static
    // policy metadata cannot fully enforce.
    let source = fixture.replace(
        "\nWhen\n",
        concat!(
            "\n derive permitted():bool = true\n",
            " policy Entry read=auditor where=row.count>0 fields=secret\n",
            " policy Entry read=permitted() fields=secret\n",
            " Subject { person:user }\n policy Subject read=auditor(row.person)\n",
            " NullableSubject { person:user? }\n policy NullableSubject read=auditor(row.person)\n",
            " policy Subject read=auditor(row.person) and authenticated\n",
            " policy Subject read=auditor(row.person) where=row.person==actor\n",
            " MemberSubject { person:member }\n policy MemberSubject read=auditor(row.person)\n",
            " Identity { person:user }\n NestedSubject { identity:Identity }\n",
            " policy NestedSubject read=auditor(row.identity.person)\n",
            " policy Entry read=auditor and authenticated fields=count\n",
            "When\n",
        ),
    );
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("reads.can");
    std::fs::write(&path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let result: serde_json::Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    assert!(output.status.success(), "{result}");
    let emitted = result["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        emitted.contains(concat!(
            "readGrants:[{rule:\"Entry.read.1\",by:[\"owner\"]},",
            "{rule:\"Entry.read.2\",fields:[\"count\"],by:[\"TypedAuthorizedReads.auditor\"]},",
            "{rule:\"Entry.read.3\",fields:[\"secret\"]},",
            "{rule:\"Entry.read.4\",fields:[\"secret\"]},",
            "{rule:\"Entry.read.5\",fields:[\"count\"]}]",
        )),
        "{emitted}",
    );
    assert!(
        emitted.contains(concat!(
            "readGrants:[{rule:\"Subject.read.1\",by:[{roleSubject:{",
            "role:\"TypedAuthorizedReads.auditor\",person:{model:\"TypedAuthorizedReads.Subject\",field:\"person\"}}}]},",
            "{rule:\"Subject.read.2\"},{rule:\"Subject.read.3\"}]",
        )),
        "{emitted}"
    );
    assert!(
        emitted.contains(concat!(
            "readGrants:[{rule:\"NullableSubject.read.1\",by:[{roleSubject:{",
            "role:\"TypedAuthorizedReads.auditor\",person:{model:\"TypedAuthorizedReads.NullableSubject\",field:\"person\"}}}]}]",
        )),
        "{emitted}"
    );
    assert!(
        emitted.contains(concat!(
            "(($roleSubject)=>$roleSubject==null?false:hasRole(c,",
            "\"TypedAuthorizedReads.auditor\",$roleSubject))((row.person ?? null))",
        )),
        "{emitted}"
    );
    for model in ["MemberSubject", "NestedSubject"] {
        assert!(
            emitted.contains(&format!("readGrants:[{{rule:\"{model}.read.1\"}}]")),
            "{emitted}",
        );
    }
    // Registry predicates stay present, including filters; metadata adds
    // no substitute policy evaluator. Explicit actor calls still refuse
    // E4020 at the owning effects pass, as the B4 source check witnesses.
    for predicate in [
        "hasRole(c,\"owner\")",
        "hasRole(c,\"TypedAuthorizedReads.auditor\")",
        "row.count",
        "hasRole(c,\"TypedAuthorizedReads.auditor\",row.person)",
        "hasRole(c,\"TypedAuthorizedReads.auditor\",row.identity.person)",
        "hasRole(c,\"authenticated\")",
    ] {
        assert!(emitted.contains(predicate), "{predicate}: {emitted}");
    }
    assert!(emitted.contains("\"Entry.read.4\":"), "{emitted}");
    assert!(
        emitted.contains("read:[\"Entry.read.1\",\"Entry.read.2\",\"Entry.read.3\",\"Entry.read.4\",\"Entry.read.5\"]"),
        "{emitted}",
    );
}
