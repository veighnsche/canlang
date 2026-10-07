extern crate url;
pub fn uri_to_path(uri: &str) -> String {
    let path = uri.strip_prefix("file://").unwrap_or(uri);
    let bytes = path.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(a), Some(b)) = (bytes.get(i + 1), bytes.get(i + 2))
            && let (Some(h), Some(l)) = (hex_val(*a), hex_val(*b))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn main() {
let s = "file:///a%20b.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///caf%C3%A9.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///café.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///bad%FF.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///100%.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///x%2G.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///a%2Fb.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///a%5Cb.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///a%00b.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file://localhost/a.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file://remote/share/a.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///C:/Users/a.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///C%3A/Users/a.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "FILE:///a.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:/a.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///a.can?q=one#frag"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "untitled:a%20b.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "vscode-remote://ssh-remote+host/a%20b.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "relative%20name.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:relative.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
let s = "file:///a/../b.can"; println!("{:?} => old={:?}; url={:?}", s,uri_to_path(s),url::Url::parse(s).map(|u|(u.as_str().to_string(),u.host_str().map(str::to_string),u.path().to_string(),u.to_file_path().map(|p| format!("{:?}",p)))));
}
