//! C04F outcome witnesses through the real fmt/docs CLI. The docs producer
//! stub qualifies the existing renderer interface and writer, not rendering.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const INPUT: &str = "app F   \nGiven\nWhen\nThen";
const FORMATTED: &str = "app F\nGiven\nWhen\nThen\n";

struct Scratch(tempfile::TempDir);
impl Scratch {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.path().join(name)
    }
    fn write(&self, name: &str, text: &str, mode: u32) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, text).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }
    fn entries(&self) -> Vec<PathBuf> {
        let mut paths: Vec<_> = fs::read_dir(self.0.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        paths.sort();
        paths
    }
    fn can(&self, mask: &str, args: &[&str]) -> Output {
        Command::new("sh")
            .arg("-c")
            .arg("umask \"$1\"; shift; exec \"$@\"")
            .arg("can-mode-witness")
            .arg(mask)
            .arg(env!("CARGO_BIN_EXE_can"))
            .env("CAN_PLATFORM_BIN", self.path("platform"))
            .args(args)
            .current_dir(self.0.path())
            .output()
            .unwrap()
    }
    fn docs(&self, mask: &str, out: &str) -> Output {
        self.write("input.can", FORMATTED, 0o600);
        self.write(
            "platform",
            "#!/bin/sh\ncat > /dev/null\nprintf '# Reference\\n'\n",
            0o700,
        );
        let catalog =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/values/dist/catalog.json");
        self.can(
            mask,
            &[
                "docs",
                "--catalog",
                catalog.to_str().unwrap(),
                "--out",
                out,
                "input.can",
            ],
        )
    }
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

fn successful(output: &Output) {
    assert!(output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "file writes remain silent");
}

#[test]
fn fmt_preserves_modes_including_private_readonly_and_special_bits() {
    for (original, mask) in [
        (0o600, "0022"),
        (0o640, "0077"),
        (0o750, "0077"),
        (0o444, "0022"),
        (0o4750, "0077"),
    ] {
        let scratch = Scratch::new();
        let path = scratch.write("input.can", INPUT, original);
        if original & 0o7000 != 0 && mode(&path) != original {
            eprintln!(
                "SKIP mode {original:o}: this host did not retain the requested fixture bits"
            );
            continue;
        }
        assert_eq!(
            mode(&path),
            original,
            "ordinary fixture mode must be established"
        );
        let entries = scratch.entries();
        successful(&scratch.can(mask, &["fmt", "input.can"]));
        assert_eq!(fs::read_to_string(&path).unwrap(), FORMATTED);
        assert_eq!(mode(&path), original);
        assert_eq!(scratch.entries(), entries, "owned staging file cleaned up");
    }
}

#[test]
fn fmt_noop_preserves_inode_links_and_mode() {
    for linked in [false, true] {
        let scratch = Scratch::new();
        let real = scratch.write("real.can", FORMATTED, 0o600);
        let input = if linked {
            symlink("real.can", scratch.path("input.can")).unwrap();
            scratch.path("input.can")
        } else {
            real.clone()
        };
        let before = fs::symlink_metadata(&input).unwrap();
        let entries = scratch.entries();
        successful(&scratch.can("0022", &["fmt", input.to_str().unwrap()]));
        let after = fs::symlink_metadata(&input).unwrap();
        assert_eq!(after.ino(), before.ino());
        assert_eq!(after.file_type(), before.file_type());
        assert_eq!(mode(&real), 0o600);
        assert_eq!(scratch.entries(), entries);
    }
}

#[test]
fn fmt_changed_symlink_replaces_entry_and_keeps_target_private_and_unchanged() {
    let scratch = Scratch::new();
    let target = scratch.write("target.can", INPUT, 0o600);
    let link = scratch.path("link.can");
    symlink("target.can", &link).unwrap();
    let before = fs::metadata(&target).unwrap().ino();
    successful(&scratch.can("0022", &["fmt", "link.can"]));
    assert!(fs::symlink_metadata(&link).unwrap().is_file());
    assert_eq!(fs::read_to_string(&link).unwrap(), FORMATTED);
    assert_eq!(mode(&link), 0o600);
    assert_eq!(fs::read_to_string(&target).unwrap(), INPUT);
    assert_eq!(fs::metadata(&target).unwrap().ino(), before);
    assert_eq!(mode(&target), 0o600);
}

#[test]
fn fmt_changed_hardlink_replaces_only_requested_entry() {
    let scratch = Scratch::new();
    let target = scratch.write("target.can", INPUT, 0o640);
    let input = scratch.path("input.can");
    fs::hard_link(&target, &input).unwrap();
    let before = fs::metadata(&target).unwrap().ino();
    successful(&scratch.can("0077", &["fmt", "input.can"]));
    assert_ne!(fs::metadata(&input).unwrap().ino(), before);
    assert_eq!(fs::metadata(&target).unwrap().ino(), before);
    assert_eq!(fs::read_to_string(&target).unwrap(), INPUT);
    assert_eq!(fs::read_to_string(&input).unwrap(), FORMATTED);
    assert_eq!(mode(&input), 0o640);
}

#[test]
fn fmt_repeated_operands_and_already_formatted_alias_are_noops() {
    let scratch = Scratch::new();
    let target = scratch.write("target.can", INPUT, 0o600);
    symlink("target.can", scratch.path("link.can")).unwrap();
    successful(&scratch.can("0022", &["fmt", "target.can", "target.can", "link.can"]));
    assert_eq!(fs::read_to_string(&target).unwrap(), FORMATTED);
    assert_eq!(mode(&target), 0o600);
    assert!(
        fs::symlink_metadata(scratch.path("link.can"))
            .unwrap()
            .is_symlink()
    );
    assert_eq!(scratch.entries().len(), 2);
}

#[test]
fn fmt_missing_input_is_e7002_and_does_not_create_output() {
    let scratch = Scratch::new();
    let output = scratch.can("0022", &["fmt", "missing.can"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("E7002"));
    assert!(scratch.entries().is_empty());
}

#[test]
fn docs_new_output_obeys_umask_and_existing_output_keeps_mode() {
    for existing in [false, true] {
        let scratch = Scratch::new();
        if existing {
            scratch.write("reference.md", "old", 0o600);
        }
        let output = scratch.docs("0027", "reference.md");
        successful(&output);
        let path = scratch.path("reference.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Reference\n");
        assert_eq!(mode(&path), if existing { 0o600 } else { 0o640 });
        assert_eq!(scratch.entries().len(), 3);
    }
}

#[test]
fn docs_write_failure_keeps_directory_and_removes_staging() {
    let scratch = Scratch::new();
    fs::create_dir(scratch.path("reference.md")).unwrap();
    let output = scratch.docs("0022", "reference.md");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("E7007"));
    assert!(scratch.path("reference.md").is_dir());
    assert_eq!(scratch.entries().len(), 3);
}

#[test]
fn docs_symlink_outputs_replace_entry_and_keep_targets() {
    for target_kind in ["regular", "missing", "directory"] {
        let scratch = Scratch::new();
        match target_kind {
            "regular" => {
                scratch.write("target.md", "old", 0o600);
            }
            "directory" => fs::create_dir(scratch.path("target.md")).unwrap(),
            _ => {}
        }
        symlink("target.md", scratch.path("reference.md")).unwrap();
        successful(&scratch.docs("0027", "reference.md"));
        assert!(
            fs::symlink_metadata(scratch.path("reference.md"))
                .unwrap()
                .is_file()
        );
        assert_eq!(
            mode(&scratch.path("reference.md")),
            if target_kind == "regular" {
                0o600
            } else {
                0o640
            }
        );
        match target_kind {
            "regular" => assert_eq!(
                fs::read_to_string(scratch.path("target.md")).unwrap(),
                "old"
            ),
            "directory" => assert!(scratch.path("target.md").is_dir()),
            _ => assert!(!scratch.path("target.md").exists()),
        }
    }
}
