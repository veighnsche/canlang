//! Native build-scoped browser access. Workerd receives only private transport
//! authority; ordinary application Identity, Origin and CSRF still apply.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Request, Response, StatusCode,
    body::{Bytes, Incoming},
    header::{COOKIE, HeaderMap, HeaderName, HeaderValue, SET_COOKIE},
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    convert::Infallible,
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::{net::TcpStream, sync::watch, task::JoinSet, time::timeout};
use url::Url;

const COOKIE_NAME: &str = "can_dev_preview";
const BOOTSTRAP_PATH: &str = "/_can_dev/preview/bootstrap";
type HttpResponse = Response<Full<Bytes>>;
type Refusal = (StatusCode, &'static str);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Backend {
    pub origin: String,
    pub header: String,
    pub secret: String,
    pub url_header: String,
}
impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Backend")
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}
impl Backend {
    fn validate(&self) -> io::Result<()> {
        let url = Url::parse(&self.origin).map_err(invalid)?;
        let valid = url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some_and(|port| port != 0)
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none();
        if !valid || self.header != "x-can-local-dispatch" || self.url_header != "x-can-local-url" {
            return Err(invalid("invalid private loopback backend"));
        }
        if !(32..=128).contains(&self.secret.len())
            || !self
                .secret
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(invalid("invalid private backend credential"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct GatewayOptions {
    pub bootstrap_ttl: Duration,
    pub cookie_ttl: Duration,
    pub header_timeout: Duration,
    pub request_timeout: Duration,
    pub max_body_bytes: usize,
    pub max_response_bytes: usize,
}
impl Default for GatewayOptions {
    fn default() -> Self {
        Self {
            bootstrap_ttl: Duration::from_secs(30),
            cookie_ttl: Duration::from_secs(900),
            header_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(30),
            max_body_bytes: 1024 * 1024,
            max_response_bytes: 16 * 1024 * 1024,
        }
    }
}
struct Credential {
    hash: [u8; 32],
    expires: Instant,
}
#[derive(Default)]
struct Access {
    pending: Option<Credential>,
    cookies: VecDeque<Credential>,
}
struct Shared {
    origin: String,
    authority: String,
    access: Mutex<Access>,
    backend: Mutex<Option<Backend>>,
    accepting: AtomicBool,
    options: GatewayOptions,
}
pub struct Gateway {
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
    thread: Option<JoinHandle<io::Result<()>>>,
    shutdown_error: Option<String>,
}
fn invalid(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}
fn failed(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}
fn hash(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
fn token() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(failed)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
impl Gateway {
    pub fn bind() -> io::Result<Self> {
        Self::bind_with_options(GatewayOptions::default())
    }
    pub fn bind_with_options(options: GatewayOptions) -> io::Result<Self> {
        validate_options(&options)?;
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let authority = listener.local_addr()?.to_string();
        let shared = Arc::new(Shared {
            origin: format!("http://{authority}"),
            authority,
            access: Mutex::new(Access::default()),
            backend: Mutex::new(None),
            accepting: AtomicBool::new(true),
            options,
        });
        let (shutdown, receiver) = watch::channel(false);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let state = shared.clone();
        let thread = thread::Builder::new()
            .name("can-preview-gateway".into())
            .spawn(move || run_listener(listener, state, receiver, ready_tx))?;
        if let Err(error) = await_listener(ready_rx) {
            let _ = shutdown.send(true);
            let _ = thread.join();
            return Err(error);
        }
        Ok(Self {
            shared,
            shutdown,
            thread: Some(thread),
            shutdown_error: None,
        })
    }
    pub fn origin(&self) -> &str {
        &self.shared.origin
    }
    pub fn set_backend(&self, backend: Backend) -> io::Result<()> {
        backend.validate()?;
        if !self.shared.accepting.load(Ordering::Acquire) {
            return Err(failed("preview admission is closed"));
        }
        *self.shared.backend.lock().map_err(failed)? = Some(backend);
        Ok(())
    }
    pub fn mint_access(&self) -> io::Result<String> {
        if !self.shared.accepting.load(Ordering::Acquire) {
            return Err(failed("preview admission is closed"));
        }
        let token = token()?;
        let mut access = self.shared.access.lock().map_err(failed)?;
        access.pending = Some(Credential {
            hash: hash(&token),
            expires: Instant::now() + self.shared.options.bootstrap_ttl,
        });
        Ok(format!("{}{BOOTSTRAP_PATH}?token={token}", self.origin()))
    }
    pub fn close_admission(&self) {
        self.shared.accepting.store(false, Ordering::Release);
        if let Ok(mut access) = self.shared.access.lock() {
            access.pending = None;
            access.cookies.clear();
        }
    }
    pub fn shutdown(&mut self) -> io::Result<()> {
        self.close_admission();
        let _ = self.shutdown.send(true);
        if let Some(thread) = self.thread.take() {
            let result = thread
                .join()
                .map_err(|_| failed("preview gateway thread panicked"))
                .and_then(|result| result);
            if let Err(error) = result {
                self.shutdown_error = Some(error.to_string());
            }
        }
        match &self.shutdown_error {
            Some(error) => Err(failed(error)),
            None => Ok(()),
        }
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
fn validate_options(options: &GatewayOptions) -> io::Result<()> {
    let times = [
        options.bootstrap_ttl,
        options.cookie_ttl,
        options.header_timeout,
        options.request_timeout,
    ];
    if times.iter().any(Duration::is_zero)
        || options.max_body_bytes == 0
        || options.max_response_bytes == 0
    {
        return Err(invalid("preview limits must be positive"));
    }
    Ok(())
}
fn await_listener(receiver: mpsc::Receiver<io::Result<()>>) -> io::Result<()> {
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(failed)?
}
fn run_listener(
    listener: TcpListener,
    shared: Arc<Shared>,
    receiver: watch::Receiver<bool>,
    ready: mpsc::SyncSender<io::Result<()>>,
) -> io::Result<()> {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready.send(Err(failed(&error)));
            return Err(error);
        }
    };
    runtime.block_on(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                let _ = ready.send(Err(failed(&error)));
                return Err(error);
            }
        };
        let _ = ready.send(Ok(()));
        serve(listener, shared, receiver).await
    })
}
async fn serve(
    listener: tokio::net::TcpListener,
    shared: Arc<Shared>,
    mut shutdown: watch::Receiver<bool>,
) -> io::Result<()> {
    let mut tasks = JoinSet::new();
    let mut failure = None;
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Err(error)) = result { failure = Some(failed(error)); break; }
            }
            result = listener.accept() => {
                let (stream, _) = match result { Ok(value) => value, Err(error) => { failure = Some(error); break; } };
                if tasks.len() < 64 { tasks.spawn(serve_connection(stream, shared.clone(), shutdown.clone())); }
            }
        }
    }
    drop(listener);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
async fn serve_connection(
    stream: TcpStream,
    shared: Arc<Shared>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(shared.options.header_timeout)
        .max_headers(100)
        .max_buf_size(64 * 1024)
        .keep_alive(false);
    let service = service_fn(move |request| handle(request, shared.clone()));
    let connection = builder.serve_connection(TokioIo::new(stream), service);
    tokio::select! { _ = shutdown.changed() => {}, _ = connection => {} }
}
async fn handle(
    request: Request<Incoming>,
    shared: Arc<Shared>,
) -> Result<HttpResponse, Infallible> {
    let result = timeout(shared.options.request_timeout, route(request, &shared)).await;
    let response = match result {
        Ok(Ok(response)) => response,
        Ok(Err((status, code))) => refusal(status, code),
        Err(_) => refusal(StatusCode::GATEWAY_TIMEOUT, "preview_dispatch_timeout"),
    };
    Ok(response)
}
async fn route(request: Request<Incoming>, shared: &Shared) -> Result<HttpResponse, Refusal> {
    if !shared.accepting.load(Ordering::Acquire) {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "preview_stopping"));
    }
    let url = request_url(&request, shared)?;
    if url.path() == BOOTSTRAP_PATH {
        return bootstrap(&request, &url, shared);
    }
    admit(&request, shared)?;
    // Pin the selected backend before awaiting any browser-controlled body bytes.
    let backend = shared
        .backend
        .lock()
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable"))?
        .clone()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable"))?;
    proxy(request, url, backend, shared).await
}
fn request_url(request: &Request<Incoming>, shared: &Shared) -> Result<Url, Refusal> {
    let path = request
        .uri()
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("");
    if request.uri().scheme().is_some()
        || request.uri().authority().is_some()
        || !path.starts_with('/')
        || path.starts_with("//")
    {
        return Err((StatusCode::BAD_REQUEST, "invalid_preview_path"));
    }
    let hosts = request.headers().get_all("host");
    if hosts.iter().count() != 1
        || hosts.iter().next().and_then(|value| value.to_str().ok())
            != Some(shared.authority.as_str())
    {
        return Err((StatusCode::BAD_REQUEST, "invalid_preview_host"));
    }
    let url = Url::parse(&format!("{}{path}", shared.origin))
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_preview_path"))?;
    if url.origin().ascii_serialization() != shared.origin {
        return Err((StatusCode::BAD_REQUEST, "invalid_preview_path"));
    }
    Ok(url)
}
fn bootstrap(
    request: &Request<Incoming>,
    url: &Url,
    shared: &Shared,
) -> Result<HttpResponse, Refusal> {
    let pairs: Vec<_> = url.query_pairs().collect();
    if request.method() != "GET" || pairs.len() != 1 || pairs[0].0 != "token" {
        return Err((StatusCode::FORBIDDEN, "invalid_preview_bootstrap"));
    }
    let mut access = shared
        .access
        .lock()
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable"))?;
    let valid = access.pending.as_ref().is_some_and(|credential| {
        credential.expires > Instant::now() && credential.hash == hash(&pairs[0].1)
    });
    if !valid {
        return Err((StatusCode::FORBIDDEN, "invalid_preview_bootstrap"));
    }
    access.pending = None;
    let cookie = token().map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable"))?;
    access
        .cookies
        .retain(|credential| credential.expires > Instant::now());
    if access.cookies.len() >= 8 {
        access.cookies.pop_front();
    }
    access.cookies.push_back(Credential {
        hash: hash(&cookie),
        expires: Instant::now() + shared.options.cookie_ttl,
    });
    let mut response = empty(StatusCode::SEE_OTHER);
    response
        .headers_mut()
        .insert("location", HeaderValue::from_static("/"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    let cookie = format!(
        "{COOKIE_NAME}={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        shared.options.cookie_ttl.as_secs().max(1)
    );
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "preview_unavailable"))?,
    );
    Ok(response)
}
fn admit(request: &Request<Incoming>, shared: &Shared) -> Result<(), Refusal> {
    let cookie = preview_cookie(request.headers())
        .ok_or((StatusCode::UNAUTHORIZED, "preview_access_required"))?;
    let mut access = shared
        .access
        .lock()
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable"))?;
    access
        .cookies
        .retain(|credential| credential.expires > Instant::now());
    if !access
        .cookies
        .iter()
        .any(|credential| credential.hash == hash(&cookie))
    {
        return Err((StatusCode::UNAUTHORIZED, "preview_access_required"));
    }
    let origins = request.headers().get_all("origin");
    let valid_origin = origins.iter().count() == 1
        && origins.iter().next().and_then(|value| value.to_str().ok())
            == Some(shared.origin.as_str());
    if request.method() != "GET" && request.method() != "HEAD" && !valid_origin {
        return Err((StatusCode::FORBIDDEN, "preview_origin_mismatch"));
    }
    Ok(())
}
fn preview_cookie(headers: &HeaderMap) -> Option<String> {
    let mut found = None;
    for header in headers.get_all(COOKIE) {
        for cookie in header.to_str().ok()?.split(';') {
            let Some((name, value)) = cookie.trim().split_once('=') else {
                continue;
            };
            if name == COOKIE_NAME {
                if found.is_some() {
                    return None;
                }
                found = Some(value.to_owned());
            }
        }
    }
    found
}
fn app_cookies(headers: &HeaderMap) -> Result<Option<HeaderValue>, Refusal> {
    let mut values = Vec::new();
    for header in headers.get_all(COOKIE) {
        let value = header
            .to_str()
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_preview_cookie"))?;
        values.extend(
            value
                .split(';')
                .map(str::trim)
                .filter(|part| !part.is_empty() && part.split('=').next() != Some(COOKIE_NAME))
                .map(str::to_owned),
        );
    }
    if values.is_empty() {
        return Ok(None);
    }
    HeaderValue::from_str(&values.join("; "))
        .map(Some)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_preview_cookie"))
}
fn hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "content-length"
            | "expect"
            | "host"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "x-can-dev-generation"
            | "x-can-local-dispatch"
            | "x-can-local-url"
    )
}
fn strip_hops(headers: &mut HeaderMap) {
    let nominated: Vec<HeaderName> = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|value| HeaderName::from_bytes(value.trim().as_bytes()).ok())
        .collect();
    for name in nominated {
        headers.remove(name);
    }
    let names: Vec<HeaderName> = headers
        .keys()
        .filter(|name| hop_header(name.as_str()))
        .cloned()
        .collect();
    for name in names {
        headers.remove(name);
    }
}
fn private_headers(headers: &mut HeaderMap, backend: &Backend, url: &Url) -> Result<(), Refusal> {
    let cookies = app_cookies(headers)?;
    strip_hops(headers);
    headers.remove(COOKIE);
    if let Some(cookies) = cookies {
        headers.insert(COOKIE, cookies);
    }
    headers.insert(
        HeaderName::from_bytes(backend.header.as_bytes())
            .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_backend_invalid"))?,
        HeaderValue::from_str(&backend.secret)
            .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_backend_invalid"))?,
    );
    headers.insert(
        HeaderName::from_bytes(backend.url_header.as_bytes())
            .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_backend_invalid"))?,
        HeaderValue::from_str(url.as_str())
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_preview_path"))?,
    );
    Ok(())
}
async fn proxy(
    request: Request<Incoming>,
    url: Url,
    backend: Backend,
    shared: &Shared,
) -> Result<HttpResponse, Refusal> {
    let (mut parts, body) = request.into_parts();
    private_headers(&mut parts.headers, &backend, &url)?;
    let bytes = Limited::new(body, shared.options.max_body_bytes)
        .collect()
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "preview_body_too_large"))?
        .to_bytes();
    let target = Url::parse(&backend.origin)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_backend_invalid"))?;
    parts.uri = url[url::Position::BeforePath..]
        .parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_preview_path"))?;
    parts.headers.insert(
        "host",
        HeaderValue::from_str(&target[url::Position::BeforeHost..url::Position::AfterPort])
            .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_backend_invalid"))?,
    );
    let request = Request::from_parts(parts, Full::new(bytes));
    let stream = TcpStream::connect((
        Ipv4Addr::LOCALHOST,
        target
            .port()
            .ok_or((StatusCode::BAD_GATEWAY, "preview_backend_invalid"))?,
    ))
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_dispatch_failed"))?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_dispatch_failed"))?;
    let work = async {
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_dispatch_failed"))?;
        relay(response, shared.options.max_response_bytes).await
    };
    tokio::pin!(work);
    tokio::select! { biased; result = &mut work => result, _ = connection => work.await }
}
async fn relay(response: Response<Incoming>, max_bytes: usize) -> Result<HttpResponse, Refusal> {
    let (mut parts, body) = response.into_parts();
    let conflict = parts.headers.get_all(SET_COOKIE).iter().any(|value| {
        value
            .to_str()
            .ok()
            .and_then(|value| value.split('=').next())
            .is_some_and(|name| name.trim() == COOKIE_NAME)
    });
    if conflict {
        return Err((StatusCode::BAD_GATEWAY, "preview_cookie_conflict"));
    }
    let bytes = Limited::new(body, max_bytes)
        .collect()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "preview_response_too_large"))?
        .to_bytes();
    strip_hops(&mut parts.headers);
    Ok(Response::from_parts(parts, Full::new(bytes)))
}
fn empty(status: StatusCode) -> HttpResponse {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
fn refusal(status: StatusCode, code: &'static str) -> HttpResponse {
    let mut response = empty(status);
    *response.body_mut() = Full::new(Bytes::from(format!("{{\"code\":\"{code}\"}}")));
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}
