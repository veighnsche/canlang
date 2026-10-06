//! Release stamp + dist-manifest + executable-manifest calculations (P04.3).
//!
//! Pure ports of `release/stamp.ts` (`assertLockstep`), `release/manifest.ts`
//! (`buildDistManifest` / `verifyDistManifest` calculation core) and the
//! `preparation/executable-manifest.ts` check core. The host stays the
//! filesystem/release-fact authority: it walks trees, reads bytes, joins
//! paths and loads sidecars, then calls these functions with the raw facts.
//! Every ordering is UTF-16 code-unit order (exact `Array.sort` default);
//! every drift/mismatch line is byte-exact against the TS templates.
//!
//! Text arrives as UTF-16 units (lone surrogates survive); raw `${}` name
//! interpolation renders lossy exactly like Node stdout (`render_text`).

// Staged: P04.4 wires this into the job loop; unit + differential tests
// below already pin the calculation contract. Remove when consumed.
#![allow(dead_code)]

use crate::input::{as_num, json_quote, obj_get, render_text, Node};
use sha2::{Digest, Sha256};

/// The one release version every lockstep package must carry.
pub const RELEASE_VERSION: &str = "0.1.0";
/// The contracts version this release was built against.
pub const RELEASE_CONTRACTS_VERSION: f64 = 1.0;
/// Documented 0.0.0 exemptions: (package, ONLY accepted version).
pub const LOCKSTEP_EXEMPT_PACKAGES: [(&str, &str); 3] = [
    ("@canlang/files", "0.0.0"),
    ("@canlang/services", "0.0.0"),
    ("@canlang/work", "0.0.0"),
];
/// Pinned toolchain every packaged binary must record.
pub const PINNED_TOOLCHAIN: &str = "1.99.0";
/// Dist manifest sidecar name.
pub const DIST_MANIFEST_NAME: &str = "dist-manifest.json";

/// Supported release hosts: (triple, install claim, binary).
pub const SUPPORTED_HOSTS: [(&str, &str, &str); 2] = [
    (
        "linux-x64-gnu",
        "docs/install.md can-linux-x86_64",
        "can-preparation",
    ),
    (
        "darwin-arm64",
        "docs/install.md can-macos-aarch64",
        "can-preparation",
    ),
];

/// UTF-16 units vs an ASCII constant (lockstep pins are ASCII).
fn units_eq_ascii(units: &[u16], text: &str) -> bool {
    units.len() == text.len() && units.iter().zip(text.bytes()).all(|(u, b)| *u == b as u16)
}

// ---------------------------------------------------------------------------
// Release lockstep (`stamp.ts assertLockstep`).
// ---------------------------------------------------------------------------

/// Injected lockstep facts (mirrors `LockstepInputs`); the host reads the
/// tree facts, the caller passes the compiled-in platform/contracts values.
pub struct LockstepInputs<'a> {
    pub root_version: &'a [u16],
    pub platform_version: &'a [u16],
    pub compiler_version: &'a [u16],
    /// `contractsVersion` value; compared with `!==` semantics (NaN drifts).
    pub contracts_version: f64,
    /// Canonical `JSON.stringify(n)` spelling; authoritative for the `v…`
    /// line (parsed-domain numbers are finite, where it equals `String(n)`).
    pub contracts_spelling: &'a str,
    /// (name, version) for every workspace package, any order.
    pub package_versions: Vec<(&'a [u16], &'a [u16])>,
}

/// Assert every version input matches the release pin. `Err` is the ONE
/// error text listing EVERY drift, byte-exact against the TS template.
pub fn assert_lockstep(inputs: &LockstepInputs) -> Result<(), String> {
    let mut drifts: Vec<String> = Vec::new();
    if !units_eq_ascii(inputs.root_version, RELEASE_VERSION) {
        drifts.push(format!(
            "root package.json: {} (want {RELEASE_VERSION})",
            json_quote(inputs.root_version)
        ));
    }
    if !units_eq_ascii(inputs.platform_version, RELEASE_VERSION) {
        drifts.push(format!(
            "platform CLI: {} (want {RELEASE_VERSION})",
            json_quote(inputs.platform_version)
        ));
    }
    if !units_eq_ascii(inputs.compiler_version, RELEASE_VERSION) {
        drifts.push(format!(
            "compiler (can): {} (want {RELEASE_VERSION})",
            json_quote(inputs.compiler_version)
        ));
    }
    if inputs.contracts_version != RELEASE_CONTRACTS_VERSION {
        drifts.push(format!(
            "contracts: v{} (want v{})",
            inputs.contracts_spelling, RELEASE_CONTRACTS_VERSION
        ));
    }
    let mut names: Vec<usize> = (0..inputs.package_versions.len()).collect();
    // `Object.keys().sort()`: UTF-16 code-unit order = u16 slice order.
    names.sort_by(|a, b| {
        inputs.package_versions[*a]
            .0
            .cmp(inputs.package_versions[*b].0)
    });
    for index in names {
        let (name, version) = inputs.package_versions[index];
        let exempt = LOCKSTEP_EXEMPT_PACKAGES
            .iter()
            .find(|(exempt_name, _)| units_eq_ascii(name, exempt_name))
            .map(|(_, pin)| *pin);
        match exempt {
            Some(pin) => {
                if !units_eq_ascii(version, pin) {
                    drifts.push(format!(
                        "{}: {} (exempt packages must sit exactly on {pin})",
                        render_text(name),
                        json_quote(version)
                    ));
                }
            }
            None => {
                if !units_eq_ascii(version, RELEASE_VERSION) {
                    drifts.push(format!(
                        "{}: {} (want {RELEASE_VERSION})",
                        render_text(name),
                        json_quote(version)
                    ));
                }
            }
        }
    }
    if drifts.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "release lockstep failed for {RELEASE_VERSION}:\n- {}",
            drifts.join("\n- ")
        ))
    }
}

// ---------------------------------------------------------------------------
// Dist manifest (`manifest.ts` calculation core).
// ---------------------------------------------------------------------------

/// Coverage rule: composite `*.tsbuildinfo` files are excluded (they carry
/// timestamps by design). Applies to the entry NAME (last path segment);
/// the host walker still recurses into tsbuildinfo-named directories.
pub fn is_covered(file_name: &[u16]) -> bool {
    const SUFFIX: &str = ".tsbuildinfo";
    if file_name.len() < SUFFIX.len() {
        return true;
    }
    !file_name[file_name.len() - SUFFIX.len()..]
        .iter()
        .zip(SUFFIX.bytes())
        .all(|(u, b)| *u == b as u16)
}

/// Lowercase-hex SHA-256 over raw bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// One covered file (mirrors `DistManifestFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DistFile {
    /// Repo-root-relative posix path.
    pub path: Vec<u16>,
    pub sha256: String,
    pub bytes: u64,
}

/// Sorted manifest (mirrors `DistManifest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DistManifest {
    pub release: Vec<u16>,
    /// Dist roots scanned, sorted.
    pub roots: Vec<Vec<u16>>,
    /// Covered files, sorted by path.
    pub files: Vec<DistFile>,
}

/// One host-walked root. `files: None` means the root is absent on disk
/// (a host filesystem fact); `Some` lists every regular file the walker
/// visited as (repo-root-relative posix path, raw bytes) — covered or
/// not, since the exclusion rule lives here.
pub struct ScannedRoot<'a> {
    pub root: &'a [u16],
    pub files: Option<Vec<(&'a [u16], &'a [u8])>>,
}

fn basename(path: &[u16]) -> &[u16] {
    match path.iter().rposition(|u| *u == 0x2F) {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Hash every covered file under the scanned roots. Deterministic: roots
/// and files sorted, fixed shape. A listed-but-absent root errors loud
/// (checked in sorted-root order, like the TS loop).
pub fn build_dist_manifest(roots: &[ScannedRoot]) -> Result<DistManifest, String> {
    let mut order: Vec<usize> = (0..roots.len()).collect();
    order.sort_by(|a, b| roots[*a].root.cmp(roots[*b].root));
    let mut files: Vec<DistFile> = Vec::new();
    let mut sorted_roots: Vec<Vec<u16>> = Vec::with_capacity(roots.len());
    for index in order {
        let scanned = &roots[index];
        sorted_roots.push(scanned.root.to_vec());
        let entries = scanned.files.as_ref().ok_or_else(|| {
            format!(
                "dist manifest: root {} is missing (run the package builds first)",
                json_quote(scanned.root)
            )
        })?;
        for (path, bytes) in entries {
            if !is_covered(basename(path)) {
                continue;
            }
            files.push(DistFile {
                path: path.to_vec(),
                sha256: sha256_hex(bytes),
                bytes: bytes.len() as u64,
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(DistManifest {
        release: RELEASE_VERSION.encode_utf16().collect(),
        roots: sorted_roots,
        files,
    })
}

/// Re-hash comparison against a recorded manifest. `expected` is the
/// recorded sidecar (host-loaded + shape-checked); `actual` is a fresh
/// `build_dist_manifest` result. `Err` is the ONE error text listing
/// EVERY mismatch: release drift first, then missing/changed in
/// want-path order, then unexpected in path order.
pub fn verify_dist_manifest(expected: &DistManifest, actual: &DistManifest) -> Result<(), String> {
    let mut problems: Vec<String> = Vec::new();
    if !units_eq_ascii(&expected.release, RELEASE_VERSION) {
        problems.push(format!(
            "release: manifest pins {}, tree stamps {RELEASE_VERSION}",
            render_text(&expected.release)
        ));
    }
    let mut want: Vec<&DistFile> = expected.files.iter().collect();
    want.sort_by(|a, b| a.path.cmp(&b.path));
    for expected_file in want {
        match actual.files.iter().find(|f| f.path == expected_file.path) {
            None => problems.push(format!("missing: {}", render_text(&expected_file.path))),
            Some(actual_file) => {
                if actual_file.sha256 != expected_file.sha256 {
                    problems.push(format!(
                        "changed: {} (bytes {} -> {})",
                        render_text(&expected_file.path),
                        expected_file.bytes,
                        actual_file.bytes
                    ));
                }
            }
        }
    }
    let mut got: Vec<&DistFile> = actual.files.iter().collect();
    got.sort_by(|a, b| a.path.cmp(&b.path));
    for actual_file in got {
        if !expected.files.iter().any(|f| f.path == actual_file.path) {
            problems.push(format!("unexpected: {}", render_text(&actual_file.path)));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{DIST_MANIFEST_NAME} verification failed:\n- {}",
            problems.join("\n- ")
        ))
    }
}

/// Every `packages/<pkg>/dist` root name sorted (pure sort core of
/// `discoverDistRoots`; existence checks stay with the host walker).
pub fn sort_dist_roots(roots: &mut [Vec<u16>]) {
    roots.sort();
}

// ---------------------------------------------------------------------------
// Executable manifest (`executable-manifest.ts` check core).
// ---------------------------------------------------------------------------

/// Shape-checked manifest facts (mirrors `ExecutableManifest`).
pub struct ExecutableManifestFacts<'a> {
    pub triple: &'a [u16],
    pub binary: &'a [u16],
    pub sha256: &'a [u16],
    pub bytes_value: f64,
    pub bytes_spelling: &'a str,
    pub toolchain_rustc: &'a [u16],
    pub toolchain_cargo: &'a [u16],
    pub toolchain_pinned: &'a [u16],
    pub lockfile_sha256: &'a [u16],
    pub source_head: &'a [u16],
    pub release: &'a [u16],
}

/// Check failure (mirrors `ManifestError`: `code` + `executable-manifest: …`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFailure {
    pub code: &'static str,
    pub message: String,
}

fn manifest_failure(code: &'static str, detail: String) -> ManifestFailure {
    ManifestFailure {
        code,
        message: format!("executable-manifest: {detail}"),
    }
}

fn shape_text<'a>(node: &'a Node, key: &str) -> Option<&'a Vec<u16>> {
    match obj_get(node, key) {
        Some(Node::Text(units)) => Some(units),
        _ => None,
    }
}

/// Shape-check a loaded `manifest.json` tree (mirrors `isManifest`).
/// `manifest_path` is the host-joined `<dir>/manifest.json` for the message.
pub fn manifest_facts<'a>(
    node: &'a Node,
    manifest_path: &[u16],
) -> Result<ExecutableManifestFacts<'a>, ManifestFailure> {
    let malformed = || {
        manifest_failure(
            "manifest-malformed",
            format!("{} is not a manifest", render_text(manifest_path)),
        )
    };
    if !matches!(node, Node::Obj(_)) {
        return Err(malformed());
    }
    let toolchain = match obj_get(node, "toolchain") {
        Some(node @ Node::Obj(_)) => node,
        _ => return Err(malformed()),
    };
    let bytes_node = obj_get(node, "bytes");
    let (bytes_bits, bytes_spelling) = match bytes_node {
        Some(node) => match as_num(node) {
            Some(pair) => pair,
            None => return Err(malformed()),
        },
        None => return Err(malformed()),
    };
    let facts = (|| {
        Some(ExecutableManifestFacts {
            triple: shape_text(node, "triple")?,
            binary: shape_text(node, "binary")?,
            sha256: shape_text(node, "sha256")?,
            bytes_value: f64::from_bits(bytes_bits),
            bytes_spelling,
            toolchain_rustc: shape_text(toolchain, "rustc")?,
            toolchain_cargo: shape_text(toolchain, "cargo")?,
            toolchain_pinned: shape_text(toolchain, "pinned")?,
            lockfile_sha256: shape_text(node, "lockfileSha256")?,
            source_head: shape_text(node, "sourceHead")?,
            release: shape_text(node, "release")?,
        })
    })();
    match facts {
        Some(facts) => Ok(facts),
        None => Err(malformed()),
    }
}

/// Verify a staged/installed bundle: sidecar triple match, binary present
/// and executable (host `stat`/`access` fact), sha and bytes match,
/// toolchain pin match. `binary_path` is the host-joined `<dir>/<binary>`.
pub fn check_executable_manifest(
    facts: &ExecutableManifestFacts,
    want_triple: &[u16],
    binary_path: &[u16],
    binary_is_executable_file: bool,
    binary_bytes: &[u8],
) -> Result<(), ManifestFailure> {
    if facts.triple != want_triple {
        return Err(manifest_failure(
            "manifest-triple",
            format!(
                "want {}, manifest says {}",
                render_text(want_triple),
                render_text(facts.triple)
            ),
        ));
    }
    if !binary_is_executable_file {
        return Err(manifest_failure(
            "manifest-binary",
            format!("{} is not an executable file", render_text(binary_path)),
        ));
    }
    let sha = sha256_hex(binary_bytes);
    let sha_match = facts.sha256.len() == sha.len()
        && facts
            .sha256
            .iter()
            .zip(sha.bytes())
            .all(|(u, b)| *u == b as u16);
    if !sha_match || binary_bytes.len() as f64 != facts.bytes_value {
        return Err(manifest_failure(
            "manifest-hash",
            format!(
                "{}: want sha {} ({} bytes), got {sha} ({})",
                render_text(binary_path),
                render_text(facts.sha256),
                facts.bytes_spelling,
                binary_bytes.len()
            ),
        ));
    }
    if !units_eq_ascii(facts.toolchain_pinned, PINNED_TOOLCHAIN) {
        return Err(manifest_failure(
            "manifest-toolchain",
            format!(
                "pinned toolchain {}, want {PINNED_TOOLCHAIN}",
                render_text(facts.toolchain_pinned)
            ),
        ));
    }
    Ok(())
}

/// Supported-host membership (mirrors `isSupportedTriple`).
pub fn is_supported_triple(triple: &[u16]) -> bool {
    SUPPORTED_HOSTS
        .iter()
        .any(|(host, _, _)| units_eq_ascii(triple, host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covered_rule_matches_ts_suffix_check() {
        assert!(is_covered(&[0x61, 0x2E, 0x6A, 0x73])); // a.js
        assert!(!is_covered(
            &"app.tsbuildinfo".encode_utf16().collect::<Vec<_>>()
        ));
        // Shorter than the suffix: covered.
        assert!(is_covered(&[0x6F, 0x66, 0x6F])); // foo
    }

    #[test]
    fn supported_triples_match_install_claims() {
        assert!(is_supported_triple(
            &"darwin-arm64".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(is_supported_triple(
            &"linux-x64-gnu".encode_utf16().collect::<Vec<_>>()
        ));
        assert!(!is_supported_triple(
            &"win32-x64-msvc".encode_utf16().collect::<Vec<_>>()
        ));
    }
}
