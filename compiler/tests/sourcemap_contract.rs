//! Outcome oracle independent of the Rust codec: fixed byte coordinates plus
//! arithmetic VLQ decoding and current Cloudflare source consumers in Node 24.
use canlang_compiler::codegen::{js::JsWriter, sourcemap};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn bounded(mut command: Command) -> std::process::Output {
    // Files avoid pipe-capacity deadlocks while enforcing a finite child budget.
    let stdout = tempfile::tempfile().unwrap();
    let stderr = tempfile::tempfile().unwrap();
    command.stdout(Stdio::from(stdout.try_clone().unwrap()));
    command.stderr(Stdio::from(stderr.try_clone().unwrap()));
    let mut child = command.spawn().expect("source-map consumer must start");
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("source-map consumer exceeded 10 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    use std::io::{Read, Seek, SeekFrom};
    let mut out = stdout;
    let mut err = stderr;
    out.seek(SeekFrom::Start(0)).unwrap();
    err.seek(SeekFrom::Start(0)).unwrap();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    out.read_to_end(&mut stdout).unwrap();
    err.read_to_end(&mut stderr).unwrap();
    std::process::Output {
        status,
        stdout,
        stderr,
    }
}

#[test]
fn byte_point_maps_reach_independent_decoder_and_current_consumers() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let mut db = SourceDb::new();
    let first = db.add("coordinate.can".into(), "é😀x\r\né😀y\r\n".into());
    let second = db.add("coordinate.can".into(), "second\r\né😀z".into());
    let empty = db.add("empty.can".into(), "".into());
    assert_eq!(
        (first, second, empty),
        (SourceId(0), SourceId(1), SourceId(2))
    );
    assert_eq!(db.lookup("coordinate.can"), Some(second));
    assert_eq!(db.get(first).unwrap().text, "é😀x\r\né😀y\r\n");
    let mut writer = JsWriter::new();
    for offset in [0, 2, 6, 7, 8, 9, 15, 16, 17, 18] {
        writer.push(Span::new(first, offset, offset), None, "// witness");
    }
    let module = writer.finish("witness.mjs".into());
    assert_eq!(
        module
            .lines
            .iter()
            .map(|line| line.line)
            .collect::<Vec<_>>(),
        (1..=10).collect::<Vec<_>>()
    );
    let coordinate = sourcemap::build(&module.path, &db, &module.lines);
    assert!(
        coordinate.mappings.starts_with("AAAA;AAAE;AAAI;"),
        "fixed VLQ bytes for byte columns 0, 2, 6"
    );
    let mut writer = JsWriter::new();
    for (file, offset, name) in [
        (second, 14, Some("repeat")),
        (first, 6, Some("")),
        (second, 0, Some("repeat")),
        (empty, 0, Some("")),
        (SourceId(99), 0, Some("missing")),
        (first, 9, None),
    ] {
        writer.push(
            Span::new(file, offset, offset),
            name.map(str::to_owned),
            "// witness",
        );
    }
    let snapshots = sourcemap::build(
        "snapshots.mjs",
        &db,
        &writer.finish("snapshots.mjs".into()).lines,
    );
    assert_eq!(snapshots.names, ["repeat", "", "missing"]);
    let no_lines = sourcemap::build("empty.mjs", &SourceDb::new(), &[]);
    assert_eq!(no_lines.mappings, "");
    #[derive(serde::Serialize)]
    struct Payload<'a> {
        coordinate: &'a sourcemap::SourceMap,
        snapshots: &'a sourcemap::SourceMap,
        empty: &'a sourcemap::SourceMap,
    }
    let payload = Payload {
        coordinate: &coordinate,
        snapshots: &snapshots,
        empty: &no_lines,
    };
    let payload_path = scratch.path().join("maps.json");
    std::fs::write(
        &payload_path,
        canlang_compiler::json::to_compact_string(&payload).unwrap(),
    )
    .unwrap();
    // Preserve exact public map wire shape and order, not a codec round trip.
    let wire = sourcemap::to_json(&coordinate);
    let keys = [
        "\"version\":",
        "\"file\":",
        "\"sources\":",
        "\"sourcesContent\":",
        "\"names\":",
        "\"mappings\":",
    ];
    let positions: Vec<_> = keys.iter().map(|key| wire.find(key).unwrap()).collect();
    assert!(positions.windows(2).all(|p| p[0] < p[1]));

    let source = scratch.path().join("fresh.can");
    let text = "app Shop\r\nGiven\r\n Gadget { title:text=\"é😀\", active:bool=true }\r\n policy Gadget read=members\r\nWhen\r\n crud Gadget by=members fields=title,active\r\nThen\r\n";
    std::fs::write(&source, text).unwrap();
    let mut compile = Command::new(env!("CARGO_BIN_EXE_can"));
    compile
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(&root);
    let compiled = bounded(compile);
    assert!(
        compiled.status.success(),
        "fresh CLI failed: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let runner = scratch.path().join("consumer.mjs");
    std::fs::write(&runner, include_str!("fixtures/sourcemap-consumer.mjs")).unwrap();
    let codec = root.join("node_modules/@jridgewell/sourcemap-codec/dist/sourcemap-codec.mjs");
    let codec = if codec.is_file() {
        codec
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap()).join(
            ".bun/install/cache/@jridgewell/sourcemap-codec@1.6.0@@@1/dist/sourcemap-codec.mjs",
        )
    };
    assert!(
        codec.is_file(),
        "consumer profile requires installed or cached @jridgewell/sourcemap-codec 1.6.0; no installation is performed"
    );
    let mut command = Command::new("node");
    command
        .arg(&runner)
        .arg(&root)
        .arg(&payload_path)
        .arg(&artifact)
        .arg(&source)
        .arg(&codec);
    let consumed = bounded(command);
    assert!(
        consumed.status.success(),
        "actual source consumer failed: {}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&consumed.stdout));
}
