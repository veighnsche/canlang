use can_dev_server::gateway::{Backend, Gateway, GatewayOptions};
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    io,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::{JoinHandle, JoinSet},
    time::{sleep, timeout},
};
use url::Url;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
struct HttpResult {
    status: u16,
    headers: hyper::HeaderMap,
    body: Bytes,
}
async fn request(
    url: &str,
    method: &str,
    headers: &[(&str, &str)],
    body: &'static str,
) -> io::Result<HttpResult> {
    let url = Url::parse(url).unwrap();
    let stream = TcpStream::connect(("127.0.0.1", url.port().unwrap())).await?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(io::Error::other)?;
    let mut request = Request::builder()
        .method(method)
        .uri(&url[url::Position::BeforePath..])
        .header(
            "host",
            &url[url::Position::BeforeHost..url::Position::AfterPort],
        );
    for (key, value) in headers {
        request = request.header(*key, *value);
    }
    let work = async {
        let response = sender
            .send_request(
                request
                    .body(Full::new(Bytes::from_static(body.as_bytes())))
                    .unwrap(),
            )
            .await
            .map_err(io::Error::other)?;
        let (parts, body) = response.into_parts();
        let body = body.collect().await.map_err(io::Error::other)?.to_bytes();
        Ok(HttpResult {
            status: parts.status.as_u16(),
            headers: parts.headers,
            body,
        })
    };
    tokio::pin!(work);
    tokio::select! { biased; result = &mut work => result, _ = connection => work.await }
}
struct Fixture {
    backend: Backend,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}
impl Fixture {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend {
            origin: format!("http://{}", listener.local_addr().unwrap()),
            header: "x-can-local-dispatch".into(),
            secret: "a".repeat(43),
            url_header: "x-can-local-url".into(),
        };
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    result = listener.accept() => {
                        let (stream, _) = result.unwrap();
                        tasks.spawn(async move {
                            let _ = hyper::server::conn::http1::Builder::new().keep_alive(false)
                                .serve_connection(TokioIo::new(stream), service_fn(backend_response)).await;
                        });
                    }
                }
            }
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        });
        Self {
            backend,
            stop,
            task,
        }
    }
    async fn close(self) {
        let _ = self.stop.send(());
        self.task.await.unwrap();
    }
}
async fn backend_response(request: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = request.uri().path().to_owned();
    if path == "/slow" {
        sleep(Duration::from_secs(60)).await;
    }
    let headers = request.headers().clone();
    let body = request.into_body().collect().await.unwrap().to_bytes();
    let value = json!({ "cookie": headers.get("cookie").and_then(|value| value.to_str().ok()),
        "csrf": headers.get("x-csrf-token").and_then(|value| value.to_str().ok()),
        "origin": headers.get("origin").and_then(|value| value.to_str().ok()),
        "private_url": headers.get("x-can-local-url").and_then(|value| value.to_str().ok()),
        "secret_ok": headers.get("x-can-local-dispatch").is_some_and(|value| value == "a".repeat(43).as_str()),
        "hop": headers.contains_key("x-private-hop"), "body": String::from_utf8_lossy(&body) });
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    if path == "/large" {
        *response.body_mut() = Full::new(Bytes::from(vec![0; 4096]));
    }
    if path == "/conflict" {
        response
            .headers_mut()
            .append("set-cookie", "can_dev_preview=app; Path=/".parse().unwrap());
    }
    if path == "/cookies" {
        response
            .headers_mut()
            .append("set-cookie", "can_session=app; HttpOnly".parse().unwrap());
        response.headers_mut().append(
            "set-cookie",
            "other=value; SameSite=Strict".parse().unwrap(),
        );
    }
    Ok(response)
}
async fn access(gateway: &Gateway) -> String {
    let response = request(&gateway.mint_access().unwrap(), "GET", &[], "")
        .await
        .unwrap();
    assert_eq!(response.status, 303);
    let cookie = response
        .headers
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cookie.contains("HttpOnly; SameSite=Strict; Path=/"));
    assert_eq!(response.headers.get("location").unwrap(), "/");
    assert_eq!(
        response.headers.get("referrer-policy").unwrap(),
        "no-referrer"
    );
    cookie.split(';').next().unwrap().to_owned()
}
#[test]
fn protected_access_origin_private_forwarding_limits_and_cookie_isolation() {
    runtime().block_on(async {
        let fixture = Fixture::start().await;
        let options = GatewayOptions {
            max_body_bytes: 32,
            max_response_bytes: 2048,
            request_timeout: Duration::from_millis(300),
            ..Default::default()
        };
        let mut gateway = Gateway::bind_with_options(options).unwrap();
        gateway.set_backend(fixture.backend.clone()).unwrap();
        let origin = gateway.origin().to_owned();
        assert_eq!(request(&origin, "GET", &[], "").await.unwrap().status, 401);
        let minted = gateway.mint_access().unwrap();
        let opened = request(&minted, "GET", &[], "").await.unwrap();
        assert_eq!(opened.status, 303);
        let cookie = opened
            .headers
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        assert_eq!(request(&minted, "GET", &[], "").await.unwrap().status, 403);
        let cookie_with_identity = format!("{cookie}; can_session=identity");
        let headers = [
            ("cookie", cookie_with_identity.as_str()),
            ("origin", origin.as_str()),
            ("x-csrf-token", "csrf-value"),
            ("x-can-local-dispatch", "browser-forged"),
            ("x-can-local-url", "http://evil.invalid"),
            ("connection", "x-private-hop"),
            ("x-private-hop", "private"),
        ];
        let response = request(&format!("{origin}/echo"), "POST", &headers, "actual-body")
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        let value: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(value["cookie"], "can_session=identity");
        assert_eq!(value["csrf"], "csrf-value");
        assert_eq!(value["body"], "actual-body");
        assert_eq!(value["origin"], origin);
        assert_eq!(value["private_url"], format!("{origin}/echo"));
        assert_eq!(value["secret_ok"], true);
        assert_eq!(value["hop"], false);
        assert_eq!(
            request(&origin, "POST", &[("cookie", &cookie)], "")
                .await
                .unwrap()
                .status,
            403
        );
        assert_eq!(
            request(
                &origin,
                "POST",
                &[("cookie", &cookie), ("origin", "http://evil.invalid")],
                ""
            )
            .await
            .unwrap()
            .status,
            403
        );
        assert_eq!(
            request(
                &origin,
                "POST",
                &[
                    ("cookie", &cookie),
                    ("origin", &origin),
                    ("origin", &origin)
                ],
                ""
            )
            .await
            .unwrap()
            .status,
            403
        );
        assert_eq!(
            request(&origin, "GET", &[("host", "evil.invalid")], "")
                .await
                .unwrap()
                .status,
            400
        );
        assert_eq!(
            request(
                &format!("{origin}//evil.invalid/"),
                "GET",
                &[("cookie", &cookie)],
                ""
            )
            .await
            .unwrap()
            .status,
            400
        );
        let duplicate = format!("{cookie}; {cookie}");
        assert_eq!(
            request(&origin, "GET", &[("cookie", &duplicate)], "")
                .await
                .unwrap()
                .status,
            401
        );
        assert_eq!(
            request(
                &format!("{origin}/conflict"),
                "GET",
                &[("cookie", &cookie)],
                ""
            )
            .await
            .unwrap()
            .status,
            502
        );
        assert_eq!(
            request(
                &format!("{origin}/large"),
                "GET",
                &[("cookie", &cookie)],
                ""
            )
            .await
            .unwrap()
            .status,
            502
        );
        assert_eq!(
            request(
                &origin,
                "POST",
                &headers,
                "123456789012345678901234567890123"
            )
            .await
            .unwrap()
            .status,
            413
        );
        let response = request(
            &format!("{origin}/cookies"),
            "GET",
            &[("cookie", &cookie)],
            "",
        )
        .await
        .unwrap();
        assert_eq!(response.headers.get_all("set-cookie").iter().count(), 2);
        assert_eq!(
            request(&format!("{origin}/slow"), "GET", &[("cookie", &cookie)], "")
                .await
                .unwrap()
                .status,
            504
        );
        gateway.close_admission();
        assert!(gateway.mint_access().is_err());
        assert!(gateway.set_backend(fixture.backend.clone()).is_err());
        assert_eq!(
            request(&origin, "GET", &[("cookie", &cookie)], "")
                .await
                .unwrap()
                .status,
            503
        );
        gateway.shutdown().unwrap();
        gateway.shutdown().unwrap();
        assert!(request(&origin, "GET", &[], "").await.is_err());
        fixture.close().await;
    });
}
#[test]
fn bootstrap_and_cookie_expiry_and_bounded_access_history() {
    runtime().block_on(async {
        let fixture = Fixture::start().await;
        let mut gateway = Gateway::bind_with_options(GatewayOptions {
            bootstrap_ttl: Duration::from_millis(40),
            cookie_ttl: Duration::from_millis(150),
            ..Default::default()
        })
        .unwrap();
        gateway.set_backend(fixture.backend.clone()).unwrap();
        let expired = gateway.mint_access().unwrap();
        sleep(Duration::from_millis(60)).await;
        assert_eq!(request(&expired, "GET", &[], "").await.unwrap().status, 403);
        let cookie = access(&gateway).await;
        sleep(Duration::from_millis(180)).await;
        assert_eq!(
            request(gateway.origin(), "GET", &[("cookie", &cookie)], "")
                .await
                .unwrap()
                .status,
            401
        );
        let mut cookies = Vec::new();
        for _ in 0..9 {
            cookies.push(access(&gateway).await);
        }
        assert_eq!(
            request(gateway.origin(), "GET", &[("cookie", &cookies[0])], "")
                .await
                .unwrap()
                .status,
            401
        );
        assert_eq!(
            request(gateway.origin(), "GET", &[("cookie", &cookies[8])], "")
                .await
                .unwrap()
                .status,
            200
        );
        gateway.shutdown().unwrap();
        fixture.close().await;
    });
}
#[test]
fn shutdown_aborts_slow_headers_and_admitted_partial_body_and_joins_listener() {
    runtime().block_on(async {
        let mut gateway = Gateway::bind().unwrap();
        gateway.set_backend(Backend { origin: "http://127.0.0.1:9".into(), header: "x-can-local-dispatch".into(),
            secret: "a".repeat(43), url_header: "x-can-local-url".into() }).unwrap();
        let cookie = access(&gateway).await;
        let url = Url::parse(gateway.origin()).unwrap(); let address = ("127.0.0.1", url.port().unwrap());
        let mut headers = TcpStream::connect(address).await.unwrap(); headers.write_all(b"GET / HTTP/1.1\r\nHost:").await.unwrap();
        let mut body = TcpStream::connect(address).await.unwrap();
        let prefix = format!("POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {}\r\nCookie: {cookie}\r\nContent-Length: 50\r\n\r\na", url.port().unwrap(), gateway.origin());
        body.write_all(prefix.as_bytes()).await.unwrap(); sleep(Duration::from_millis(20)).await;
        let start = Instant::now(); gateway.shutdown().unwrap(); assert!(start.elapsed() < Duration::from_secs(1));
        for stream in [&mut headers, &mut body] {
            let mut buffer = [0; 1024];
            let closed = timeout(Duration::from_secs(1), stream.read(&mut buffer)).await.unwrap();
            assert!(closed.is_err() || closed.unwrap() == 0);
        }
        assert!(TcpStream::connect(address).await.is_err());
    });
}
#[test]
fn refuses_non_loopback_or_invalid_backend_credentials() {
    let mut gateway = Gateway::bind().unwrap();
    let mut backend = Backend {
        origin: "http://example.com:1234".into(),
        header: "x-can-local-dispatch".into(),
        secret: "a".repeat(43),
        url_header: "x-can-local-url".into(),
    };
    assert!(gateway.set_backend(backend.clone()).is_err());
    backend.origin = "http://127.0.0.1:1234/path".into();
    assert!(gateway.set_backend(backend.clone()).is_err());
    backend.origin = "http://127.0.0.1:1234".into();
    backend.secret = "short".into();
    assert!(gateway.set_backend(backend).is_err());
    gateway.shutdown().unwrap();
}
