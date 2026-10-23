use can_dev_server::{
    gateway::{Backend, Gateway},
    refusals::Catalog,
};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::{net::TcpListener, sync::mpsc, thread, time::Duration};
use url::Url;
fn context(revision: &str, build: &str) -> Value {
    json!({"session":"session","revision":revision,"sourceRevision":format!("sha256:{}","a".repeat(64)),"servingBuild":build})
}
fn catalog() -> Catalog {
    Catalog::from_value(&json!({"publicErrorMessages":{"busy":"Safe busy message."},"retryableByCode":{"busy":true},"formRefusalHeader":"can-form-refusal"})).unwrap()
}
fn get(url: &str, cookie: Option<&str>) -> String {
    let url = Url::parse(url).unwrap();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let cookie = cookie.map_or(String::new(), |value| format!("Cookie: {value}\r\n"));
    write!(
        stream,
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept-Encoding: gzip, deflate\r\nConnection: close\r\n{}\r\n",
        &url[url::Position::BeforePath..],
        url.port().unwrap(),
        cookie
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}
#[test]
fn refusal_retains_the_selected_build_and_http_bytes_when_backend_changes_during_dispatch() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let backend = Backend {
        origin: format!("http://{}", listener.local_addr().unwrap()),
        header: "x-can-local-dispatch".into(),
        secret: "a".repeat(43),
        url_header: "x-can-local-url".into(),
    };
    let (entered, ready) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let body = r#"{"error":{"code":"busy","message":"PRIVATE_RESPONSE","fields":[{"message":"PRIVATE_FIELD"}]}}"#;
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut headers = Vec::new();
        let mut byte = [0u8; 1];
        while !headers.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
        }
        assert!(
            String::from_utf8(headers)
                .unwrap()
                .to_ascii_lowercase()
                .lines()
                .any(|line| line == "accept-encoding: identity")
        );
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        write!(stream,"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nX-Private: PRIVATE_HEADER\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
    });
    let mut gateway = Gateway::bind().unwrap();
    gateway
        .set_observed_backend(backend.clone(), context("r1", "b1"), catalog())
        .unwrap();
    let bootstrap = get(&gateway.mint_access().unwrap(), None);
    let cookie = bootstrap
        .lines()
        .find_map(|line| {
            line.strip_prefix("set-cookie: ")
                .or_else(|| line.strip_prefix("Set-Cookie: "))
        })
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(gateway.drain_refusals()["projections"], json!([]));
    let url = format!("{}/refusal", gateway.origin());
    let client = thread::spawn(move || get(&url, Some(&cookie)));
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    gateway
        .set_observed_backend(backend, context("r2", "b2"), catalog())
        .unwrap();
    release.send(()).unwrap();
    let response = client.join().unwrap();
    assert!(response.starts_with("HTTP/1.1 503"));
    assert!(response.ends_with(body));
    assert!(response.contains("PRIVATE_HEADER"));
    worker.join().unwrap();
    let observed = gateway.drain_refusals();
    assert_eq!(observed["projections"].as_array().unwrap().len(), 1);
    assert_eq!(observed["projections"][0]["occurrence"]["revision"], "r1");
    assert_eq!(
        observed["projections"][0]["occurrence"]["serving_build"],
        "b1"
    );
    assert_eq!(
        observed["projections"][0]["occurrence"]["summary"],
        "Safe busy message."
    );
    assert!(!observed.to_string().contains("PRIVATE"));
    assert_eq!(
        gateway.drain_refusals(),
        json!({"projections":[],"dropped":0,"unavailable":0})
    );
    gateway.shutdown().unwrap();
}
