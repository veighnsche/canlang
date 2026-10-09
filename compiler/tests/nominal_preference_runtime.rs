//! Borrowed enum preferences retain their receiving save identity.
#[test]
fn borrowed_enum_preference_uses_generated_page_and_versioned_save() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let output = std::process::Command::new("node")
        .arg(root.join("compiler/tests/fixtures/nominal-preference-consumer.mjs"))
        .arg(root)
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .current_dir(root)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
