//! Supported profile: Bash, Python 3 and Zsh execute emitted scripts. Portable
//! hosts missing an engine explicitly skip that engine; CAN_COMPLETION_REQUIRE_ENGINES
//! makes missing engines a failure for qualification runs.
use std::{fs, process::Command};
fn available(engine: &str) -> bool {
    let found = Command::new(engine).arg("--version").output().is_ok();
    if !found {
        assert!(
            std::env::var_os("CAN_COMPLETION_REQUIRE_ENGINES").is_none(),
            "required engine missing: {engine}"
        );
        eprintln!("SKIP completion engine unavailable: {engine}");
    }
    found
}
fn emitted(shell: &str) -> Vec<u8> {
    let out = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["completions", shell])
        .output()
        .unwrap();
    assert!(out.status.success());
    out.stdout
}
#[test]
fn embedded_scripts_match_and_fish_declares_lint_fix() {
    for (shell, source) in [
        ("bash", include_bytes!("../can-completions.bash").as_slice()),
        ("zsh", include_bytes!("../can-completions.zsh").as_slice()),
        ("fish", include_bytes!("../can-completions.fish").as_slice()),
    ] {
        assert_eq!(emitted(shell), source);
    }
    assert!(
        String::from_utf8(emitted("fish"))
            .unwrap()
            .contains("-n '__fish_seen_subcommand_from lint' -l fix")
    );
}
#[test]
fn actual_completion_engines() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("--f-file.can"), "").unwrap();
    fs::write(dir.path().join("unique.can"), "").unwrap();
    fs::write(dir.path().join("completion.bash"), emitted("bash")).unwrap();
    fs::write(dir.path().join("completion.zsh"), emitted("zsh")).unwrap();
    if available("bash") {
        let script = r#"
source ./completion.bash
check() {
 local expected="$1"; shift
 COMP_WORDS=( "$@" ); COMP_CWORD=$((${#COMP_WORDS[@]}-1)); COMPREPLY=(); _can_complete
 [[ "${COMPREPLY[*]}" == "$expected" ]] || { printf 'bad completion: %s => %s (expected %s)\n' "${COMP_WORDS[*]}" "${COMPREPLY[*]}" "$expected"; exit 1; }
}
check '--fix' can lint --fi
check '--fix' can lint --fix
for cmd in check compile policy docs fmt explain lsp; do check '' can "$cmd" --fix; done
check 'json' can check --format j
check '--format=json' can check --format=j
check '--f-file.can' can check -- --f
check '' can check -- --format=j
check '--f-file.can' can lint --catalog -- -- --f
check '--f-file.can' can check -- --format --f
check '--fix' can lint --catalog -- --fi
check '--format=json' can check --catalog -- --format=j
check 'unique.can' can check --catalog uni
check 'unique.can' can docs --out uni
check '' can docs --locale en
check 'lint' can help li
check 'bash' can completions b
for cmd in run test build deploy activate; do
 check '--f-file.can' can "$cmd" --f
 check '' can "$cmd" --format=j
 check '' can "$cmd" --format j
 check '--f-file.can' can "$cmd" --format --f
 check 'unique.can' can "$cmd" --locale uni
 check '--f-file.can' can "$cmd" --catalog -- --f
done
"#;
        let out = Command::new("bash")
            .args(["--noprofile", "--norc", "-c", script])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    if available("zsh") && available("python3") {
        let out = Command::new("python3")
            .arg(format!(
                "{}/tests/fixtures/completion-contract/zsh.py",
                env!("CARGO_MANIFEST_DIR")
            ))
            .arg("zsh")
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
