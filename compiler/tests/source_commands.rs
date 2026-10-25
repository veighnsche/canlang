//! The native executable owns source-command usage and passes one intact source
//! path to the platform; validation never routes through generation requests.
use std::process::{Command, Stdio};

fn can() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
    command.stdin(Stdio::null());
    command
}

#[test]
fn source_command_help_and_flag_scopes() {
    for command in ["gen", "validate"] {
        let output = can().args([command, "--help"]).output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("FILE.can"));
    }
    for args in [
        vec!["validate"],
        vec!["validate", "one.can", "two.can"],
        vec!["validate", "one.can", "--retry"],
        vec!["validate", "one.can", "--dry-run"],
        vec!["validate", "one.can", "--settings=shared.toml"],
        vec!["gen", "status", "--retry"],
        vec!["gen", "status", "--settings=shared.toml"],
        vec!["gen", "--request", "request.json", "--dry-run"],
        vec!["gen", "--request", "request.json", "--settings=shared.toml"],
        vec!["gen", "source.can", "--format=xml"],
        vec!["gen", "source.can", "--settings"],
        vec!["gen", "source.can", "--settings="],
        vec!["gen", "source.can", "--settings", "--dry-run"],
        vec![
            "gen",
            "source.can",
            "--settings=one.toml",
            "--settings=two.toml",
        ],
    ] {
        let output = can().args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("E7001"),
            "{args:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn source_settings_preserve_caller_relative_path_in_both_flag_forms() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = tempfile::tempdir().unwrap();
    let app = scratch.path().join("apps");
    std::fs::create_dir(&app).unwrap();
    std::fs::write(app.join("App.can"), "app Example\n").unwrap();
    let platform = scratch.path().join("platform");
    let capture = scratch.path().join("capture");
    std::fs::write(
        &platform,
        "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\" > \"$SOURCE_CLI_CAPTURE\"\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&platform, std::fs::Permissions::from_mode(0o755)).unwrap();
    for flags in [
        vec!["--settings=shared ; $literal.toml"],
        vec!["--settings", "shared ; $literal.toml"],
    ] {
        let output = can()
            .current_dir(scratch.path())
            .args(["gen", "apps/App.can", "--retry", "--dry-run"])
            .args(flags)
            .env("CAN_PLATFORM_BIN", &platform)
            .env("SOURCE_CLI_CAPTURE", &capture)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let captured = std::fs::read_to_string(&capture).unwrap();
        let lines: Vec<_> = captured.lines().collect();
        assert_eq!(
            lines[0],
            scratch.path().canonicalize().unwrap().to_str().unwrap()
        );
        assert_eq!(lines[1], "generate");
        assert_eq!(
            lines[2],
            app.join("App.can")
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
        );
        assert_eq!(
            &lines[3..],
            [
                "--retry",
                "--dry-run",
                "--settings=shared ; $literal.toml",
                "--format=text"
            ]
        );
    }
}

#[cfg(unix)]
#[test]
fn source_dispatch_preserves_paths_compiler_identity_and_child_exit() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("app ; literal $name.can");
    std::fs::write(&source, "app Example\n").unwrap();
    let platform = scratch.path().join("platform stub");
    let capture = scratch.path().join("capture");
    // A script is only a stand-in for an executable platform. The native
    // adapter must pass arguments directly, without shell interpretation.
    std::fs::write(&platform, "#!/bin/sh\nprintf '%s\\n' \"$CAN_COMPILER_BIN\" \"$@\" > \"$SOURCE_CLI_CAPTURE\"\nexit 4\n").unwrap();
    std::fs::set_permissions(&platform, std::fs::Permissions::from_mode(0o755)).unwrap();
    for (command, options, expected_operation) in [
        (
            "gen",
            vec!["--retry", "--dry-run", "--format=json"],
            "generate",
        ),
        ("validate", vec!["--format=json"], "validate"),
    ] {
        let output = can()
            .arg(command)
            .arg(&source)
            .args(&options)
            .env("CAN_PLATFORM_BIN", &platform)
            .env("CAN_COMPILER_BIN", "/wrong/compiler")
            .env("SOURCE_CLI_CAPTURE", &capture)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(4));
        let captured = std::fs::read_to_string(&capture).unwrap();
        let lines: Vec<_> = captured.lines().collect();
        assert_eq!(lines[0], env!("CARGO_BIN_EXE_can"));
        assert_eq!(lines[1], expected_operation);
        assert_eq!(lines[2], source.canonicalize().unwrap().to_str().unwrap());
        assert_eq!(&lines[3..], options.as_slice());
    }
}

#[cfg(unix)]
#[test]
fn source_checkout_discovers_platform_without_override_from_app_directory() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = tempfile::tempdir().unwrap();
    let package = scratch.path().join("packages/cloudflare");
    std::fs::create_dir_all(package.join("dist/cli")).unwrap();
    std::fs::write(package.join("package.json"), "{}").unwrap();
    let platform = package.join("dist/cli/platform.js");
    std::fs::write(&platform, "#!/bin/sh\nexit 6\n").unwrap();
    std::fs::set_permissions(&platform, std::fs::Permissions::from_mode(0o755)).unwrap();
    let app = scratch.path().join("apps/my app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("Example.can"), "app Example\n").unwrap();
    for (cwd, source) in [
        (scratch.path(), "apps/my app/Example.can"),
        (app.as_path(), "Example.can"),
    ] {
        let output = can()
            .current_dir(cwd)
            .args(["gen", source, "--dry-run"])
            .env_remove("CAN_PLATFORM_BIN")
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(6),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(unix)]
#[test]
fn executable_symlink_discovers_platform_beside_real_checkout() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let scratch = tempfile::tempdir().unwrap();
    let checkout = scratch.path().join("checkout");
    let package = checkout.join("packages/cloudflare");
    std::fs::create_dir_all(package.join("dist/cli")).unwrap();
    std::fs::write(package.join("package.json"), "{}").unwrap();
    let platform = package.join("dist/cli/platform.js");
    std::fs::write(
        &platform,
        "#!/bin/sh\n[ \"$1\" = build ] || exit 90\nexit 6\n",
    )
    .unwrap();
    std::fs::set_permissions(&platform, std::fs::Permissions::from_mode(0o755)).unwrap();
    let real_bin = checkout.join("bin/can");
    std::fs::create_dir_all(real_bin.parent().unwrap()).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_can"), &real_bin).unwrap();
    let installed = scratch.path().join("local/bin/can");
    std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
    symlink(&real_bin, &installed).unwrap();
    let output = Command::new(&installed)
        .current_dir(scratch.path())
        .arg("build")
        .env_remove("CAN_PLATFORM_BIN")
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(6),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
