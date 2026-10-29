//! Bounded private workerd transport used by readiness and isolated examples.
use crate::{capture::check_cancel, gateway::Backend};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, body::Bytes, header::HeaderMap};
use hyper_util::rt::TokioIo;
use std::{net::Ipv4Addr, sync::atomic::AtomicBool, time::Duration};
use tokio::{net::TcpStream, time::timeout};
use url::Url;

pub struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}
impl Response {
    pub fn json(&self) -> Result<serde_json::Value, String> {
        serde_json::from_slice(&self.body).map_err(|_| "preview response is not JSON".into())
    }
    pub fn content_type(&self, prefix: &str) -> bool {
        self.headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with(prefix))
    }
    pub fn cookie(&self, name: &str) -> Result<String, String> {
        let prefix = format!("{name}=");
        let cookies: Vec<_> = self
            .headers
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter(|v| v.starts_with(&prefix))
            .collect();
        if cookies.len() != 1 {
            return Err("Identity returned no unique session cookie".into());
        }
        let cookie = cookies[0].split(';').next().unwrap_or("");
        if cookie.len() == prefix.len() {
            return Err("Identity returned an empty session cookie".into());
        }
        Ok(cookie.into())
    }
}
fn checked_backend(backend: &Backend) -> Result<Url, String> {
    let target = Url::parse(&backend.origin).map_err(|e| e.to_string())?;
    if target.scheme() != "http"
        || target.host_str() != Some("127.0.0.1")
        || target.port().is_none()
        || target.path() != "/"
        || target.query().is_some()
        || target.fragment().is_some()
        || !target.username().is_empty()
        || target.password().is_some()
        || backend.header != "x-can-local-dispatch"
        || backend.url_header != "x-can-local-url"
    {
        return Err("invalid private preview backend".into());
    }
    Ok(target)
}
pub fn request(
    backend: &Backend,
    origin: &str,
    path: &str,
    method: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
    cancel: &AtomicBool,
) -> Result<Response, String> {
    check_cancel(cancel)?;
    let target = checked_backend(backend)?;
    let base = Url::parse(origin).map_err(|e| e.to_string())?;
    let url = base.join(path).map_err(|e| e.to_string())?;
    if url.origin() != base.origin() || !path.starts_with('/') {
        return Err("preview probe route escapes selected origin".into());
    }
    let mut builder = Request::builder()
        .method(method)
        .uri(&url[url::Position::BeforePath..])
        .header(
            "host",
            &target[url::Position::BeforeHost..url::Position::AfterPort],
        );
    for (key, value) in headers {
        builder = builder.header(*key, *value);
    }
    let request = builder
        .header(&backend.header, &backend.secret)
        .header(&backend.url_header, url.as_str())
        .body(Full::new(Bytes::from(body)))
        .map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    // Readiness, not a performance gate: a page GET over miniflare
    // sqlite-wasm costs tens of seconds on real apps under load
    // (repeated phase-A/B domain scans plus per-row policy reads);
    // production D1 has a different profile. Page-read round-trip
    // count is follow-up work; the probe must not flake meanwhile.
    let result = runtime.block_on(async {
        timeout(Duration::from_secs(90), async {
            let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, target.port().unwrap()))
                .await
                .map_err(|e| e.to_string())?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream))
                    .await
                    .map_err(|e| e.to_string())?;
            let work = async {
                let response = sender
                    .send_request(request)
                    .await
                    .map_err(|e| e.to_string())?;
                let (parts, body) = response.into_parts();
                let body = Limited::new(body, 32 * 1024 * 1024)
                    .collect()
                    .await
                    .map_err(|_| "preview response exceeds bound".to_string())?
                    .to_bytes()
                    .to_vec();
                Ok(Response {
                    status: parts.status.as_u16(),
                    headers: parts.headers,
                    body,
                })
            };
            tokio::pin!(work);
            tokio::select! { biased; result=&mut work=>result, _=connection=>work.await }
        })
        .await
        .map_err(|_| "preview probe timed out".to_string())?
    });
    check_cancel(cancel)?;
    result
}
