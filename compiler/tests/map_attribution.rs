//! DEP-02: current production CLI output reaches the actual public assembler
//! and Node's independent source-map engine, including an emitted failure.
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn bounded(mut command: Command) -> std::process::Output {
    use std::io::{Read, Seek, SeekFrom};
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    command.stdout(Stdio::from(stdout.try_clone().unwrap()));
    command.stderr(Stdio::from(stderr.try_clone().unwrap()));
    let mut child = command
        .spawn()
        .expect("DEP-02 consumer prerequisites are required");
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("DEP-02 child exceeded 20 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    stdout.seek(SeekFrom::Start(0)).unwrap();
    stderr.seek(SeekFrom::Start(0)).unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    stdout.read_to_end(&mut out).unwrap();
    stderr.read_to_end(&mut err).unwrap();
    std::process::Output {
        status,
        stdout: out,
        stderr: err,
    }
}

#[test]
fn production_failure_reaches_node_source_maps() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap();
    let fixture = root.join("implementation/compiler-completion/map-attribution");
    let scratch = tempfile::tempdir().unwrap();
    // Absolute source identity allows the host to resolve it without guessing
    // project roots. Original bytes are used unchanged by the compiler.
    let source = fixture.join("failure.can");
    let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
    command
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(&root);
    let compiled = bounded(command);
    assert!(
        compiled.status.success(),
        "CLI: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let mut command = Command::new("node");
    command
        .arg("--enable-source-maps")
        .arg(fixture.join("consumer.mjs"))
        .arg(&root)
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("staged"))
        .current_dir(&root);
    let consumed = bounded(command);
    assert!(
        consumed.status.success(),
        "Node: {}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&consumed.stdout));
}
