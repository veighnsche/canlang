//! Authored document identities remain protocol keys. This adapter only
//! derives a native display path for explicitly authored `file://` URIs.
use std::path::PathBuf;

/// Supported native path projection; this does not read the filesystem.
/// Other spellings/schemes and unsupported authorities remain URI identities.
pub(super) fn native_file_path(uri: &str) -> Option<PathBuf> {
    if !uri
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        return None;
    }
    let parsed = url::Url::parse(uri).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    #[cfg(any(
        unix,
        windows,
        target_os = "redox",
        target_os = "wasi",
        target_os = "hermit"
    ))]
    {
        let path = parsed.to_file_path().ok()?;
        // SourceDb display paths are Strings. Preserve URI text on loss or
        // unusable NUL rather than inventing replacement-character filenames.
        let text = path.to_str()?;
        if text.contains('\0') {
            return None;
        }
        Some(path)
    }
    #[cfg(not(any(
        unix,
        windows,
        target_os = "redox",
        target_os = "wasi",
        target_os = "hermit"
    )))]
    {
        None
    }
}

pub(super) fn display_path(uri: &str) -> String {
    native_file_path(uri)
        .and_then(|path| path.into_os_string().into_string().ok())
        .unwrap_or_else(|| uri.to_owned())
}

