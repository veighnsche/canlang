//! Captured authored help -> private saved index -> help/detail/ranking workflows.
use super::fixtures::{empty_inventory, fixture};
use can_dev_server::{
    capture::{self, NamedInputPath},
    construct,
    files::Payloads,
};
use serde_json::json;
use std::{fs, path::Path, sync::atomic::AtomicBool};
#[test]
fn captured_help_and_saved_file_index_bind_authored_provenance_and_ranking_policy() {
    let (root, mut request) = fixture();
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for directory in [
        "docs/specification",
        "packages/values/src",
        "packages/ui/src",
    ] {
        fs::create_dir_all(root.path().join(directory)).unwrap();
    }
    for entry in fs::read_dir(workspace.join("docs/specification")).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            fs::copy(
                &path,
                root.path()
                    .join("docs/specification")
                    .join(path.file_name().unwrap()),
            )
            .unwrap();
        }
    }
    for path in [
        "packages/values/src/catalog.ts",
        "packages/ui/src/catalog.ts",
        "packages/cloudflare/dist/native-dev-catalog.json",
        "docs/design/UI-COMPONENTS.md",
    ] {
        fs::create_dir_all(root.path().join(path).parent().unwrap()).unwrap();
        fs::copy(workspace.join(path), root.path().join(path)).unwrap();
    }
    fs::write(
        root.path().join("app.can"),
        "app Office\nGiven\n rules PRIVATE_LITERAL\n",
    )
    .unwrap();
    request.help_index_path = "docs/specification/CONSTRUCT-HELP.md".into();
    request.extra_input_paths = vec![
        NamedInputPath {
            name: "grammar".into(),
            path: "docs/specification/GRAMMAR.md".into(),
        },
        NamedInputPath {
            name: "source:@canlang/values@1/src/catalog.ts".into(),
            path: "packages/values/src/catalog.ts".into(),
        },
        NamedInputPath {
            name: "source:@canlang/ui@1/src/catalog.ts".into(),
            path: "packages/ui/src/catalog.ts".into(),
        },
        NamedInputPath {
            name: "construct-catalog".into(),
            path: "packages/cloudflare/dist/native-dev-catalog.json".into(),
        },
    ];
    let cancel = AtomicBool::new(false);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    let index = construct::run(&captured, &json!({"action":"index"}), &cancel).unwrap();
    assert!(index["cards"].as_array().unwrap().len() > 250);
    let mut files = Payloads::new().unwrap();
    let saved = files.json(&index).unwrap();
    let help = construct::run(
        &captured,
        &json!({"action":"help","index":saved,"id":"can.v1.policy"}),
        &cancel,
    )
    .unwrap();
    assert_eq!(
        help["card"]["signature"],
        "policy path read=expr [where=expr] [fields=selectors]"
    );
    assert_eq!(help["card"]["status"], "working");
    assert_eq!(help["index_revision"], index["index_revision"]);
    let routing = json!({"version":1,"disposition":"exact","slot":"given.rule","ids":["can.v1.policy","can.v1.invariant"],"complete":true,
 "context":{"version":1,"messageKind":"unrecognized_keyword","section":"Given","guess":"rules","exactSourceSpan":true,"structuralRecovery":false,"recoveryComplete":true,"nameFilterComplete":true,"materialIntentChoice":false,"evidenceSufficient":true,"unsupportedBehaviorProven":false}});
    let start = captured.source_text.find("rules").unwrap();
    let mut payload = json!({"action":"rank","index":saved,"complete":true,"omitted":0,"diagnostic":{"code":"E2001","primary":{"start":start,"end":start+5},"construct_candidates":routing}});
    let rank = construct::run(&captured, &payload, &cancel).unwrap();
    assert_eq!(rank["result"]["state"], "ranking_disallowed");
    assert!(!rank.to_string().contains("PRIVATE_LITERAL"));
    payload["diagnostic"]["construct_candidates"]["ids"] = json!(["can.v1.policy"]);
    assert_eq!(
        construct::run(&captured, &payload, &cancel).unwrap()["result"]["state"],
        "deterministic"
    );
    payload["action"] = json!("detail");
    payload["candidates"] = json!({"version":1,"disposition":"exact","slot":"given.rule","ids":["can.v1.fake"],"complete":true});
    assert_eq!(
        construct::run(&captured, &payload, &cancel).unwrap()["construct_help"]["grammarCoverage"],
        "unknown"
    );
    fs::write(
        root.path().join(&request.help_index_path),
        "changed after capture",
    )
    .unwrap();
    assert!(
        construct::run(&captured, &json!({"action":"index"}), &cancel)
            .unwrap_err()
            .contains("changed after capture")
    );
    // Retained help remains bound to the exact private index, even after a working-tree edit.
    assert_eq!(
        construct::run(
            &captured,
            &json!({"action":"help","index":saved,"id":"can.v1.policy"}),
            &cancel
        )
        .unwrap()["card"]["status"],
        "working"
    );
    let mut stale = captured.clone();
    stale
        .inputs
        .iter_mut()
        .find(|i| i.name == "compiler")
        .unwrap()
        .sha256 = Some("0".repeat(64));
    assert!(
        construct::run(
            &stale,
            &json!({"action":"help","index":saved,"id":"can.v1.policy"}),
            &cancel
        )
        .unwrap_err()
        .contains("identity mismatch")
    );
}
