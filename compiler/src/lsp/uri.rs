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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonfile_and_unsupported_forms_keep_authored_identity() {
        for uri in [
            "untitled:a%20b.can",
            "vscode-remote://ssh-remote+host/a%20b.can",
            "custom:///A%2Fb/%C3%A9",
            "relative%20name.can",
            "",
            "file:/a.can",
            "file:relative.can",
            "file:///bad%FF.can",
            "file:///a%00b.can",
        ] {
            assert_eq!(display_path(uri), uri);
            assert!(native_file_path(uri).is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_file_authority_and_exact_unicode_projection() {
        for (uri, path) in [
            ("file:///a%20b.can", "/a b.can"),
            ("file:///caf%C3%A9%F0%9F%98%80.can", "/café😀.can"),
            ("file:///café😀.can", "/café😀.can"),
            ("file://localhost/a.can", "/a.can"),
            ("FILE:///a.can", "/a.can"),
            ("file:///a.can?q=one#frag", "/a.can"),
            ("file:///a/../b.can", "/b.can"),
            ("file:///100%.can", "/100%.can"),
            ("file:///x%2G.can", "/x%2G.can"),
            ("file:///a%2Fb.can", "/a/b.can"),
            ("file:///a%5Cb.can", "/a\\b.can"),
            ("file:///C:/Users/a.can", "/C:/Users/a.can"),
        ] {
            assert_eq!(display_path(uri), path);
            assert_eq!(native_file_path(uri), Some(PathBuf::from(path)));
        }
        let remote = "file://remote/share/a.can";
        assert_eq!(display_path(remote), remote);
        assert!(native_file_path(remote).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_and_unc_projection() {
        assert_eq!(
            native_file_path("file:///C:/Users/a.can"),
            Some(PathBuf::from(r"C:\Users\a.can"))
        );
        assert_eq!(
            native_file_path("file://remote/share/a.can"),
            Some(PathBuf::from(r"\\remote\share\a.can"))
        );
    }
}
