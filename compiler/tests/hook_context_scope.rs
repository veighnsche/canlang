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

#[test]
fn precommit_actor_proof_uses_only_the_exact_authenticated_crud_grant() {
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::source::SourceDb;

    let source = |grant: &str, trigger: &str, crud_first: bool| {
        let crud = format!(" crud M {grant} fields=title delete=none\n");
        let hook = format!(
            " scenario changed on={trigger}\n  do\n   create Attribution {{author_note=\"Original caller\"}} as attribution\n"
        );
        format!(
            "app Hooks\nGiven\n role manager\n M {{title:text}}\n Attribution {{author_note:text,author:user server=actor,at:datetime server=now}}\nWhen\n{}{}Then\n",
            if crud_first {
                crud.as_str()
            } else {
                hook.as_str()
            },
            if crud_first {
                hook.as_str()
            } else {
                crud.as_str()
            }
        )
    };
    let check = |source: String| {
        let mut db = SourceDb::new();
        let id = db.add("hooks.can".into(), source);
        check_program(&db, &[id], None).1
    };
    for crud_first in [true, false] {
        for grant in [
            "by=manager",
            "by=members",
            "by=manager and public",
            "by=manager or members",
        ] {
            for trigger in ["M.create", "M.update"] {
                let diagnostics = check(source(grant, trigger, crud_first));
                assert!(
                    diagnostics.is_empty(),
                    "{grant}/{trigger}/{crud_first}: {diagnostics:?}"
                );
            }
        }
        for grant in ["by=public", "", "by=manager or public", "by=missing"] {
            let diagnostics = check(source(grant, "M.update", crud_first));
            if grant == "by=missing" {
                assert_eq!(
                    diagnostics
                        .iter()
                        .filter(|diagnostic| diagnostic.code == "E2001")
                        .count(),
                    1,
                    "owning grant is resolved once: {diagnostics:?}"
                );
            }
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "E3001"
                        && diagnostic
                            .message
                            .contains("initializer needs an authenticated actor")),
                "{grant}/{crud_first}: {diagnostics:?}"
            );
        }
    }
    for trigger in ["M.created", "M.updated", "M.deleted", "Unknown.update"] {
        let diagnostics = check(source("by=manager", trigger, false));
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E3001"
                    && diagnostic
                        .message
                        .contains("initializer needs an authenticated actor")),
            "{trigger}: {diagnostics:?}"
        );
    }
    let disabled =
        source("by=manager", "M.update", false).replace("fields=title", "fields=title update=none");
    let diagnostics = check(disabled);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3001"
                && diagnostic
                    .message
                    .contains("initializer needs an authenticated actor")),
        "disabled CRUD cannot provide attribution: {diagnostics:?}"
    );
    let declared_event =
        source("by=manager", "Ping", false).replace("Given\n", "Given\n event Ping {}\n");
    let diagnostics = check(declared_event);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3001"
                && diagnostic
                    .message
                    .contains("initializer needs an authenticated actor")),
        "trusted declared event stays actor-null: {diagnostics:?}"
    );
    let imported = "package foreign\n Given\n  role manager\n  export M {title:text}\n When\n  crud M by=manager fields=title\n Then\npackage local\n use foreign {M}\n Given\n  Attribution {author_note:text,author:user server=actor}\n When\n  scenario h on=M.update\n   do create Attribution {author_note=\"Caller\"} as attribution\n Then\n";
    let diagnostics = check(imported.into());
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3001"
                && diagnostic
                    .message
                    .contains("initializer needs an authenticated actor")),
        "foreign grant cannot supply local hook attribution: {diagnostics:?}"
    );
    for grant in ["by=manager", "by=public"] {
        let deletion = source(grant, "M.delete", false)
            .replace(" delete=none", "")
            .replace(
                "create Attribution {author_note=\"Original caller\"} as attribution",
                "let initiating_actor=actor",
            );
        let mut db = SourceDb::new();
        let id = db.add("deletion.can".into(), deletion.clone());
        let (program, diagnostics) = check_program(&db, &[id], None);
        assert!(diagnostics.is_empty(), "{grant}: {diagnostics:?}");
        let start = deletion.find("initiating_actor=actor").unwrap() + "initiating_actor=".len();
        let ty = program
            .types
            .node_types
            .iter()
            .find(|(key, _)| key.start as usize == start && key.end as usize == start + 5)
            .map(|(_, ty)| ty);
        use canlang_compiler::analysis::types::{ResolvedType, Scalar};
        assert_eq!(
            ty,
            Some(&if grant == "by=manager" {
                ResolvedType::Scalar(Scalar::User)
            } else {
                ResolvedType::Null
            }),
            "delete hooks use their own enabled grant: {ty:?}"
        );
    }
    let scratch = tempfile::tempdir().unwrap();
    let native = source("by=manager", "M.update", false).replace(
        "   create Attribution",
        "   let initiating_actor=actor\n   create Attribution",
    );
    let (output, result) = compile(scratch.path(), &native);
    assert!(!output.status.success(), "{result}");
    assert!(
        result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"
                && diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("hook contextual binding `actor`")),
        "native hook context remains gated: {result}"
    );
}
