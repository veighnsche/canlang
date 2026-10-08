//! Hook context admission through the production CLI.
use std::path::Path;
use std::process::Command;

fn compile(dir: &Path, source: &str) -> (std::process::Output, serde_json::Value) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let path = dir.join("hooks.can");
    std::fs::write(&path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let result = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    (output, result)
}

#[test]
fn hooks_preserve_candidate_events_and_refuse_unsupported_context() {
    let scratch = tempfile::tempdir().unwrap();
    let supported = "app Hooks\nGiven\n M { title:text }\nWhen\n scenario adjust on=M.create\n  do\n   let title=event.after.title\n   require title==\"candidate\"\n   set event.after {title=\"adjusted\"}\n scenario context() by=members\n  do\n   let a=actor\n   let n=now\n   let t=team.id\n   let o=operation.id\nThen\n";
    let (output, result) = compile(scratch.path(), supported);
    assert!(output.status.success(), "{result}");
    let emitted = result["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(emitted.contains("event.after.title"), "{emitted}");
    assert!(
        emitted.contains("Object.assign($candidate,$pending)"),
        "{emitted}"
    );
    for field in ["actor", "now", "team", "operation"] {
        assert!(emitted.contains(&format!("c.{field}")), "{emitted}");
    }

    for expression in ["actor", "now", "team.id", "operation.id"] {
        let source = format!(
            "app Hooks\nGiven\n M {{ title:text }}\nWhen\n scenario h on=M.create\n  do\n   let value={expression}\nThen\n"
        );
        let (output, result) = compile(scratch.path(), &source);
        assert!(!output.status.success(), "{expression}: {result}");
        let binding = expression.split('.').next().unwrap();
        let diagnostic = result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .find(|diagnostic| {
                diagnostic["code"] == "E6008"
                    && diagnostic["message"]
                        .as_str()
                        .unwrap()
                        .contains(&format!("hook contextual binding `{binding}`"))
            })
            .unwrap_or_else(|| panic!("{expression}: {result}"));
        let span = &diagnostic["primary"];
        assert_eq!(
            &source
                [span["start"].as_u64().unwrap() as usize..span["end"].as_u64().unwrap() as usize],
            binding
        );
        assert!(result.get("modules").is_none(), "{expression}: {result}");
    }
}
