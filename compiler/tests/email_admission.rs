//! SEM-R04 production boundary: 113 finite email cases agree with both public
//! values codec directions; 29 emitted defaults retain authored text. This loads unmodified metadata JS
//! as generated modules, then checks their values with the public codec; it does not execute an application.
//! Missing built packages/catalog/Node skip loudly, without substitutes.

#[cfg(unix)]
#[test]
fn email_admission_matches_public_codecs_and_production_metadata() {
    use std::fs::{self, File};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for relative in [
        "packages/values/dist/catalog.json",
        "node_modules/@canlang/values/dist/src/index.js",
    ] {
        if !root.join(relative).exists() {
            eprintln!("SKIP email production metadata: missing {relative}");
            return;
        }
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "can-email-value-admission-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )));
    fs::create_dir_all(&scratch.0).unwrap();
    std::os::unix::fs::symlink(root.join("node_modules"), scratch.0.join("node_modules")).unwrap();
    let runner = scratch.0.join("check.mjs");
    fs::write(
        &runner,
        include_str!(
            "../../implementation/compiler-completion/email-admission/implementation/probe.mjs"
        ),
    )
    .unwrap();

    // File-backed output avoids pipe deadlock and retains failure detail.
    // Each compiler child has a 10s deadline; the whole Node seam has 90s.
    let stdout = scratch.0.join("node.stdout");
    let stderr = scratch.0.join("node.stderr");
    let spawned = Command::new("node")
        .arg(&runner)
        .arg(&root)
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(&scratch.0)
        .current_dir(&root)
        .stdout(Stdio::from(File::create(&stdout).unwrap()))
        .stderr(Stdio::from(File::create(&stderr).unwrap()))
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("SKIP email production metadata: Node unavailable");
            return;
        }
        Err(error) => panic!("could not start Node: {error}"),
    };
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(90) {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "email production metadata exceeded 90s\n{}\n{}",
                fs::read_to_string(&stdout).unwrap(),
                fs::read_to_string(&stderr).unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = fs::read_to_string(&stdout).unwrap();
    assert!(
        status.success(),
        "email production metadata failed\n{output}\n{}",
        fs::read_to_string(&stderr).unwrap()
    );
    eprint!("{output}");
}

#[cfg(not(unix))]
#[test]
fn email_admission_matches_public_codecs_and_production_metadata() {
    eprintln!("SKIP email production metadata: Unix package symlink setup required");
}
