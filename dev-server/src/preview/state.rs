//! Private retained development state, compatible with the original Node manifests.
use super::{Result, random_id};
use crate::capture::{Capture, hash};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(
            "preview storage must be an owner-only directory without a symbolic link".into(),
        );
    }
    // New directories follow the process umask; restrict only directories we own.
    if meta.mode() & 0o077 != 0 {
        return Err(
            "preview storage must be an owner-only directory without a symbolic link".into(),
        );
    }
    Ok(())
}
pub fn create_private_directory(path: &Path) -> Result<()> {
    if !path.exists() {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(path).map_err(|e| e.to_string())?;
    }
    private_directory(path)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u8,
    identity: String,
    schema: String,
    database_id: String,
    owner_database_ids: Vec<String>,
    seed: Option<Value>,
}
pub struct Retained {
    pub persistence: String,
    pub database_id: String,
    pub owner_database_ids: Vec<String>,
    pub seed: Option<Value>,
    path: PathBuf,
    manifest: Manifest,
}
impl Retained {
    pub fn open(root: &Path, capture: &Capture, artifact_json: &str, mode: &str) -> Result<Self> {
        let base =
            crate::capture::absolute(std::env::current_dir().map_err(|e| e.to_string())?, root);
        create_private_directory(&base)?;
        #[derive(Serialize)]
        struct Identity<'a> {
            root: &'a str,
            source: &'a str,
        }
        let identity = serde_json::to_string(&Identity {
            root: &capture.root,
            source: &capture.app_path,
        })
        .map_err(|e| e.to_string())?;
        let directory = base.join(hash(identity.as_bytes()));
        create_private_directory(&directory)?;
        let persistence = directory.join("d1");
        create_private_directory(&persistence)?;
        #[derive(Deserialize)]
        struct Artifact<'a> {
            #[serde(borrow)]
            models: Option<&'a RawValue>,
        }
        let artifact: Artifact = serde_json::from_str(artifact_json).map_err(|e| e.to_string())?;
        let models = artifact.models.map(RawValue::get).unwrap_or("[]");
        // artifact_json is Node-compatible compact JSON, so model member order is retained.
        let schema = hash(
            format!(
                "{{\"storageMode\":{},\"models\":{models}}}",
                serde_json::to_string(mode).unwrap()
            )
            .as_bytes(),
        );
        let path = directory.join("preview.json");
        let manifest = match read_private(&path) {
            Ok(bytes) => checked_manifest(&bytes, &identity, &schema)?,
            Err(error) if !path.try_exists().map_err(|e| e.to_string())? => {
                let value = Manifest {
                    version: 1,
                    identity,
                    schema,
                    database_id: format!("can-preview-{}", random_id()?),
                    owner_database_ids: vec![
                        format!("can-preview-owner-{}", random_id()?),
                        format!("can-preview-owner-{}", random_id()?),
                    ],
                    seed: None,
                };
                let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
                write_new(&path, &bytes).map_err(|e| format!("{error}: {e}"))?;
                value
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            persistence: persistence.to_string_lossy().into(),
            database_id: manifest.database_id.clone(),
            owner_database_ids: manifest.owner_database_ids.clone(),
            seed: manifest.seed.clone(),
            path,
            manifest,
        })
    }
    pub fn save_seed(&mut self, seed: Value) -> Result<()> {
        self.manifest.seed = Some(seed.clone());
        let staged = self
            .path
            .with_file_name(format!("preview-{}.json", random_id()?));
        let result = (|| {
            write_new(
                &staged,
                &serde_json::to_vec(&self.manifest).map_err(|e| e.to_string())?,
            )?;
            fs::rename(&staged, &self.path).map_err(|e| e.to_string())?;
            File::open(self.path.parent().unwrap())
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(staged);
        }
        result?;
        self.seed = Some(seed);
        Ok(())
    }
}
fn checked_manifest(bytes: &[u8], identity: &str, schema: &str) -> Result<Manifest> {
    let value: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| "preview metadata is invalid; retained state was preserved")?;
    if value.version != 1
        || value.identity != identity
        || !database_id(&value.database_id, "can-preview-")
        || value.owner_database_ids.len() != 2
        || value.owner_database_ids[0] == value.owner_database_ids[1]
        || value
            .owner_database_ids
            .iter()
            .any(|v| !database_id(v, "can-preview-owner-"))
        || value.seed.as_ref().is_some_and(|v| {
            !v["actors"].is_array() || !v["owners"].is_array() || !v["probe"].is_object()
        })
    {
        return Err("preview metadata is invalid; retained state was preserved".into());
    }
    if value.schema != schema {
        return Err("retained preview models changed; migrations are unsupported, use a separate preview state root or explicitly reset this source's development data".into());
    }
    Ok(value)
}
fn database_id(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|v| {
        v.len() == 36
            && v.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
    })
}
fn read_private(path: &Path) -> Result<Vec<u8>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o077 != 0
        || before.len() > 64 * 1024
    {
        return Err("preview metadata must be a bounded owner-only regular file".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    let current = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024
        || before.dev() != current.dev()
        || before.ino() != current.ino()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
    {
        return Err("preview metadata changed during read".into());
    }
    Ok(bytes)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

// JSON.stringify preserves source object insertion order. serde_json::Value sorts
// maps, so use RawValue recursion to compact without reordering objects.
pub fn compact_json(source: &str) -> Result<String> {
    struct Compact;
    impl<'de> serde::de::Visitor<'de> for Compact {
        type Value = String;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<String, M::Error> {
            let mut fields: Vec<(String, String)> = Vec::new();
            while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                let value = compact_json(value.get()).map_err(serde::de::Error::custom)?;
                if let Some((_, existing)) = fields.iter_mut().find(|(name, _)| name == &key) {
                    *existing = value;
                } else {
                    fields.push((key, value));
                }
            }
            // ECMAScript enumerates array-index keys first, then other keys in
            // insertion order. Preserve that behavior in old schema identities.
            let index = |key: &str| {
                key.parse::<u32>()
                    .ok()
                    .filter(|n| *n != u32::MAX && n.to_string() == key)
            };
            fields.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            });
            Ok(format!(
                "{{{}}}",
                fields
                    .into_iter()
                    .map(|(key, value)| format!("{}:{value}", serde_json::to_string(&key).unwrap()))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        }
        fn visit_seq<S: serde::de::SeqAccess<'de>>(
            self,
            mut seq: S,
        ) -> std::result::Result<String, S::Error> {
            let mut values = Vec::new();
            while let Some(value) = seq.next_element::<Box<RawValue>>()? {
                values.push(compact_json(value.get()).map_err(serde::de::Error::custom)?);
            }
            Ok(format!("[{}]", values.join(",")))
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<String, E> {
            serde_json::to_string(v).map_err(E::custom)
        }
        fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<String, E> {
            Ok(v.to_string())
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<String, E> {
            Ok(js_number(v as f64))
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<String, E> {
            Ok(js_number(v as f64))
        }
        fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<String, E> {
            Ok(js_number(v))
        }
        fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<String, E> {
            Ok("null".into())
        }
    }
    let mut deserializer = serde_json::Deserializer::from_str(source);
    let result = serde::de::Deserializer::deserialize_any(&mut deserializer, Compact)
        .map_err(|e| e.to_string())?;
    deserializer.end().map_err(|e| e.to_string())?;
    Ok(result)
}
// Normalize the shortest binary64 representation to ECMAScript's decimal
// exponent thresholds. Compiler JSON uses finite binary64 numbers.
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let raw = serde_json::to_string(&value).expect("finite JSON number");
    let negative = raw.starts_with('-');
    let unsigned = raw.trim_start_matches('-');
    let (mantissa, exponent) = unsigned
        .split_once(['e', 'E'])
        .map(|(m, e)| (m, e.parse::<i32>().unwrap()))
        .unwrap_or((unsigned, 0));
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let mut digits = mantissa.replace('.', "");
    while digits.ends_with('0') && digits.len() > 1 {
        digits.pop();
    }
    let decimal = point + exponent;
    let prefix = if negative { "-" } else { "" };
    if decimal > 0 && decimal <= 21 {
        let decimal = decimal as usize;
        if decimal >= digits.len() {
            format!("{prefix}{digits}{}", "0".repeat(decimal - digits.len()))
        } else {
            format!("{prefix}{}.{}", &digits[..decimal], &digits[decimal..])
        }
    } else if decimal <= 0 && decimal > -6 {
        format!("{prefix}0.{}{digits}", "0".repeat((-decimal) as usize))
    } else {
        let power = decimal - 1;
        let fraction = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!(
            "{prefix}{}{fraction}e{}{power}",
            &digits[..1],
            if power >= 0 { "+" } else { "" }
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_number_and_index_enumeration() {
        assert_eq!(
            compact_json(r#"{"b":1.0,"3":9007199254740993,"1":1e-6,"c":1e20,"d":1e21,"z":-0.0}"#)
                .unwrap(),
            r#"{"1":0.000001,"3":9007199254740992,"b":1,"c":100000000000000000000,"d":1e+21,"z":0}"#
        );
    }
    #[test]
    fn retained_identity_is_reused_and_schema_changes_refused() {
        let (project, request) = crate::capture::tests::fixture();
        let capture = crate::capture::capture(
            &request,
            &crate::capture::tests::empty_inventory,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        let state_root = project.path().join("retained");
        let artifact = r#"{"models":[{"name":"Note","fields":[{"name":"title","type":"String"}],"scope":"app"}]}"#;
        let mut first = Retained::open(&state_root, &capture, artifact, "global").unwrap();
        assert!(first.seed.is_none());
        let database_id = first.database_id.clone();
        let owners = first.owner_database_ids.clone();
        let seed = serde_json::json!({"actors":[{"label":"Ava","email":"ava@preview.can.test","password":"local-development-only","teams":["Cedar"]}],
            "probe":{"email":"ava@preview.can.test","password":"local-development-only","teamId":"cedar"},
            "owners":[{"owner":"cedar","binding":"STATE_CEDAR_DB"},{"owner":"oak","binding":"STATE_OAK_DB"}]});
        first.save_seed(seed.clone()).unwrap();
        let second = Retained::open(&state_root, &capture, artifact, "global").unwrap();
        assert_eq!(second.database_id, database_id);
        assert_eq!(second.owner_database_ids, owners);
        assert_eq!(second.seed, Some(seed.clone()));
        let mut other_capture = capture.clone();
        other_capture.app_path = format!("{}/Other.can", capture.root);
        let other = Retained::open(&state_root, &other_capture, artifact, "global").unwrap();
        assert_ne!(other.persistence, first.persistence);
        assert_ne!(other.database_id, database_id);
        assert!(other.seed.is_none());
        assert!(
            Retained::open(&state_root, &capture, artifact, "team")
                .err()
                .unwrap()
                .contains("models changed")
        );
        assert!(
            Retained::open(
                &state_root,
                &capture,
                r#"{"models":[{"name":"Other","scope":"app"}]}"#,
                "global"
            )
            .err()
            .unwrap()
            .contains("models changed")
        );
    }
    #[test]
    fn exposed_state_and_metadata_links_are_refused_without_overwrite() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let (project, request) = crate::capture::tests::fixture();
        let capture = crate::capture::capture(
            &request,
            &crate::capture::tests::empty_inventory,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        let root = project.path().join("retained");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            Retained::open(&root, &capture, r#"{"models":[]}"#, "team")
                .err()
                .unwrap()
                .contains("owner-only")
        );
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let state = Retained::open(&root, &capture, r#"{"models":[]}"#, "team").unwrap();
        let before = fs::read(&state.path).unwrap();
        fs::set_permissions(&state.path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            Retained::open(&root, &capture, r#"{"models":[]}"#, "team")
                .err()
                .unwrap()
                .contains("owner-only")
        );
        assert_eq!(fs::read(&state.path).unwrap(), before);
        fs::remove_file(&state.path).unwrap();
        let outside = root.join("outside.json");
        symlink(&outside, &state.path).unwrap();
        assert!(Retained::open(&root, &capture, r#"{"models":[]}"#, "team").is_err());
        assert!(
            fs::symlink_metadata(&state.path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(!outside.exists());
    }
    #[test]
    fn node_manifest_key_order() {
        let source = r#"{ "storageMode":"team", "models":[{"name":"Note","fields":[{"name":"title","type":"String"}],"scope":"app"}] }"#;
        assert_eq!(
            compact_json(source).unwrap(),
            r#"{"storageMode":"team","models":[{"name":"Note","fields":[{"name":"title","type":"String"}],"scope":"app"}]}"#
        );
    }
}
