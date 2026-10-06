//! Ordered compatibility calculations (P04.2): the exact
//! `deploy/compat.ts` + `deploy/installed.ts` rules over admitted
//! `Node` facts.
//!
//! Same reason order (contracts, language, capabilities, bindings,
//! secrets, schedules), same codes, same detail strings, no early
//! return: every applicable reason is reported, in order. No new
//! capability or version authority: `KNOWN_CAPABILITIES` mirrors the
//! TS registry byte-for-byte and this module never invents an id.
//!
//! Inputs arrive as `Node` trees (owner-produced facts, host-loaded).
//! Malformed shapes fail with the host loader's own vocabulary
//! (`target.*` / `descriptor.*` / `environment.*` messages), never
//! with invented codes. Well-formed text renders byte-exactly; lone
//! surrogates in rendered details become U+FFFD per Node stdout
//! encoding (see `input::render_text`).

use crate::artifact::escape_json_string;
use crate::input::{
    as_arr, as_bool, as_num, as_obj, as_text, js_string, nonempty_text, obj_get, render_text,
    units_eq, Node,
};

/// Capability ids this calculation knows. Mirrors `KNOWN_CAPABILITIES`
/// exactly (order matters: it feeds the unknown-id error join).
pub const KNOWN_CAPABILITIES: [&str; 8] = [
    "canlang.builtins",
    "values.decimal",
    "values.int64",
    "values.money",
    "values.temporal",
    "state",
    "d1-batch",
    "do-alarms",
];

/// One compatibility failure: machine code + human detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatReason {
    pub code: String,
    pub detail: String,
}

/// Compatibility verdict: compatible, or the ordered reasons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatVerdict {
    pub compatible: bool,
    pub reasons: Vec<CompatReason>,
}

/// Shape failure reading owner-produced facts. Messages reuse the
/// host loader vocabulary verbatim (never invented codes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatError {
    pub message: String,
}

impl std::fmt::Display for CompatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Installed runtime facts (mirrors `InstalledRuntime`).
#[derive(Debug, Clone)]
pub struct InstalledRuntime<'a> {
    pub contracts_version: f64,
    pub contracts_spelling: &'a str,
    pub runtime_version: &'a [u16],
    pub capabilities: Vec<&'a [u16]>,
    pub known_language_versions: Vec<&'a [u16]>,
    pub supports_schedules: bool,
}

/// Known-vs-installed split (mirrors `CapabilitySplit`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CapabilitySplit {
    pub installed: Vec<Vec<u16>>,
    pub missing: Vec<Vec<u16>>,
    pub unknown: Vec<Vec<u16>>,
}

/// Split candidate ids against the registry and the installed set.
/// Order-preserving within each bucket: candidate order first (each
/// occurrence), then installed-only ids (deduped) for `unknown`.
pub fn split_capabilities(candidate: &[Vec<u16>], installed: &[Vec<u16>]) -> CapabilitySplit {
    let mut split = CapabilitySplit::default();
    for id in candidate {
        if !KNOWN_CAPABILITIES.iter().any(|k| units_eq(id, k)) {
            split.unknown.push(id.clone());
        } else if installed.iter().any(|have| have == id) {
            split.installed.push(id.clone());
        } else {
            split.missing.push(id.clone());
        }
    }
    let mut seen: Vec<&Vec<u16>> = candidate.iter().collect();
    for id in installed {
        if !seen.contains(&id) {
            seen.push(id);
            if !KNOWN_CAPABILITIES.iter().any(|k| units_eq(id, k)) {
                split.unknown.push(id.clone());
            }
        }
    }
    split
}

fn text_vec(node: &Node) -> Option<Vec<&Vec<u16>>> {
    as_arr(node).and_then(|items| items.iter().map(as_text).collect::<Option<Vec<_>>>())
}

/// Build the installed facts from the target declaration (mirrors
/// `installedFromTree` → `probeInstalledRuntime`): env must be a
/// record, unknown capability ids throw loud.
pub fn installed_from_tree<'a>(
    env: &'a Node,
    declaration: &'a Node,
) -> Result<InstalledRuntime<'a>, CompatError> {
    if as_obj(env).is_none() {
        return Err(CompatError {
            message: "probeInstalledRuntime needs the target env as a record".to_string(),
        });
    }
    let contracts_version = obj_get(declaration, "contractsVersion")
        .and_then(as_num)
        .ok_or_else(|| CompatError {
            message: "target.contractsVersion must be a number (the deployment's supported contracts version)".to_string(),
        })?;
    let runtime_version = obj_get(declaration, "runtimeVersion")
        .and_then(nonempty_text)
        .ok_or_else(|| CompatError {
            message: "target.runtimeVersion must be a non-empty string".to_string(),
        })?;
    let known_language_versions = obj_get(declaration, "knownLanguageVersions")
        .and_then(text_vec)
        .ok_or_else(|| CompatError {
            message: "target.knownLanguageVersions must be an array of strings".to_string(),
        })?;
    let capabilities = obj_get(declaration, "capabilities")
        .and_then(text_vec)
        .ok_or_else(|| CompatError {
            message: "target.capabilities must be an array of strings".to_string(),
        })?;
    let supports_schedules = obj_get(declaration, "supportsSchedules")
        .and_then(as_bool)
        .ok_or_else(|| CompatError {
            message: "target.supportsSchedules must be a boolean".to_string(),
        })?;
    let owned: Vec<Vec<u16>> = capabilities.iter().map(|u| (*u).clone()).collect();
    let split = split_capabilities(&owned, &owned);
    if !split.unknown.is_empty() {
        let ids = split
            .unknown
            .iter()
            .map(|id| escape_json_string(id))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(CompatError {
            message: format!(
                "probeInstalledRuntime: unknown capability id(s) {ids} (known: {})",
                KNOWN_CAPABILITIES.join(", ")
            ),
        });
    }
    Ok(InstalledRuntime {
        contracts_version: f64::from_bits(contracts_version.0),
        contracts_spelling: contracts_version.1,
        runtime_version: runtime_version.as_slice(),
        capabilities: capabilities.iter().map(|u| u.as_slice()).collect(),
        known_language_versions: known_language_versions
            .iter()
            .map(|u| u.as_slice())
            .collect(),
        supports_schedules,
    })
}

fn descriptor_text<'a>(
    descriptor: &'a Node,
    section: &str,
    field: &str,
    what: &str,
) -> Result<&'a [u16], CompatError> {
    let parent = obj_get(descriptor, section).ok_or_else(|| CompatError {
        message: format!("descriptor.{section} must be an object"),
    })?;
    obj_get(parent, field)
        .and_then(as_text)
        .map(|u| u.as_slice())
        .ok_or_else(|| CompatError {
            message: format!("descriptor.{what} must be a string"),
        })
}

/// Ordered compatibility verdict (mirrors `checkCompatibility`):
/// contracts, language, capabilities, bindings, secrets, schedules —
/// every applicable reason, no early return.
pub fn check_compatibility(
    descriptor: &Node,
    environment: &Node,
    installed: &InstalledRuntime<'_>,
) -> Result<CompatVerdict, CompatError> {
    let mut reasons: Vec<CompatReason> = Vec::new();

    let identity = obj_get(descriptor, "identity").ok_or_else(|| CompatError {
        message: "descriptor.identity must be an object".to_string(),
    })?;
    let want_contracts = obj_get(identity, "contractsVersion")
        .and_then(as_num)
        .ok_or_else(|| CompatError {
            message: "descriptor.identity.contractsVersion must be a number".to_string(),
        })?;
    if f64::from_bits(want_contracts.0) != installed.contracts_version {
        reasons.push(CompatReason {
            code: "contracts-mismatch".to_string(),
            detail: format!(
                "artifact wants contracts v{}, installed v{}",
                want_contracts.1, installed.contracts_spelling
            ),
        });
    }

    let language = descriptor_text(
        descriptor,
        "identity",
        "languageVersion",
        "identity.languageVersion",
    )?;
    if !installed.known_language_versions.contains(&language) {
        reasons.push(CompatReason {
            code: "unknown-language-version".to_string(),
            detail: format!("language {} is not installed", render_text(language)),
        });
    }

    let required = obj_get(descriptor, "requiredCapabilities")
        .and_then(as_arr)
        .ok_or_else(|| CompatError {
            message: "descriptor.requiredCapabilities must be an array".to_string(),
        })?;
    // Entries are unchecked by the host loader: any value is reachable.
    // Mirror TS `includes` (SameValueZero: only exact Text hits) and
    // `String(entry)` detail rendering for the rest.
    for capability in required {
        let hit = as_text(capability)
            .map(|id| installed.capabilities.contains(&id.as_slice()))
            .unwrap_or(false);
        if !hit {
            reasons.push(CompatReason {
                code: "missing-capability".to_string(),
                detail: js_string(capability),
            });
        }
    }

    let bindings = obj_get(descriptor, "resourceBindings")
        .and_then(as_arr)
        .ok_or_else(|| CompatError {
            message: "descriptor.resourceBindings must be an array".to_string(),
        })?;
    let resources = obj_get(environment, "resources")
        .and_then(as_arr)
        .ok_or_else(|| CompatError {
            message: "environment.resources must be an array".to_string(),
        })?;
    for requirement in bindings {
        let binding = obj_get(requirement, "binding")
            .and_then(nonempty_text)
            .ok_or_else(|| CompatError {
                message: "descriptor.resourceBindings[].binding must be a non-empty string"
                    .to_string(),
            })?;
        let kind = obj_get(requirement, "kind")
            .and_then(nonempty_text)
            .ok_or_else(|| CompatError {
                message: "descriptor.resourceBindings[].kind must be a non-empty string"
                    .to_string(),
            })?;
        let logical = obj_get(requirement, "logicalName")
            .and_then(nonempty_text)
            .ok_or_else(|| CompatError {
                message: "descriptor.resourceBindings[].logicalName must be a non-empty string"
                    .to_string(),
            })?;
        let resolved = resources.iter().find(|candidate| {
            obj_get(candidate, "requirement")
                .and_then(|req| obj_get(req, "binding"))
                .and_then(as_text)
                .map(|b| b.as_slice() == binding.as_slice())
                .unwrap_or(false)
        });
        match resolved {
            None => reasons.push(CompatReason {
                code: "missing-binding".to_string(),
                detail: format!("no resource selected for binding {}", render_text(binding)),
            }),
            Some(candidate) => {
                let req = obj_get(candidate, "requirement").expect("matched above");
                let same_kind = obj_get(req, "kind")
                    .and_then(as_text)
                    .map(|k| k.as_slice() == kind.as_slice())
                    .unwrap_or(false);
                let same_logical = obj_get(req, "logicalName")
                    .and_then(as_text)
                    .map(|l| l.as_slice() == logical.as_slice())
                    .unwrap_or(false);
                if !(same_kind && same_logical) {
                    reasons.push(CompatReason {
                        code: "missing-binding".to_string(),
                        detail: format!(
                            "binding {} resolves to a different requirement",
                            render_text(binding)
                        ),
                    });
                }
            }
        }
    }

    let secrets = obj_get(descriptor, "secrets")
        .and_then(as_arr)
        .ok_or_else(|| CompatError {
            message: "descriptor.secrets must be an array".to_string(),
        })?;
    let present = obj_get(environment, "secretsPresent")
        .and_then(as_arr)
        .ok_or_else(|| CompatError {
            message: "environment.secretsPresent must be an array".to_string(),
        })?;
    for secret in secrets {
        let binding = obj_get(secret, "binding")
            .and_then(nonempty_text)
            .ok_or_else(|| CompatError {
                message: "descriptor.secrets[].binding must be a non-empty string".to_string(),
            })?;
        let optional = obj_get(secret, "optional")
            .and_then(as_bool)
            .ok_or_else(|| CompatError {
                message: "descriptor.secrets[].optional must be a boolean".to_string(),
            })?;
        if !optional {
            let found = present.iter().any(|entry| {
                as_text(entry)
                    .map(|t| t.as_slice() == binding.as_slice())
                    .unwrap_or(false)
            });
            if !found {
                reasons.push(CompatReason {
                    code: "missing-secret".to_string(),
                    detail: render_text(binding),
                });
            }
        }
    }

    let schedules = obj_get(descriptor, "schedules")
        .and_then(as_arr)
        .ok_or_else(|| CompatError {
            message: "descriptor.schedules must be an array".to_string(),
        })?;
    if !schedules.is_empty() && !installed.supports_schedules {
        reasons.push(CompatReason {
            code: "unsupported-schedule".to_string(),
            detail: format!(
                "{} schedule(s) but the target has no schedule backend",
                schedules.len()
            ),
        });
    }

    Ok(CompatVerdict {
        compatible: reasons.is_empty(),
        reasons,
    })
}

/// Compiler-vs-runtime release comparison (mirrors
/// `checkCompilerVersionMatch`). Returns `None` on match, else the
/// exact detail string.
pub fn check_compiler_version_match(
    descriptor: &Node,
    installed: &InstalledRuntime<'_>,
) -> Result<Option<String>, CompatError> {
    let want = descriptor_text(
        descriptor,
        "identity",
        "compilerVersion",
        "identity.compilerVersion",
    )?;
    if want == installed.runtime_version {
        return Ok(None);
    }
    Ok(Some(format!(
        "artifact compiled by {} but the target runs runtime {}",
        escape_json_string(want),
        escape_json_string(installed.runtime_version)
    )))
}
