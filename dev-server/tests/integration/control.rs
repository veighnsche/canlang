//! Actual control boundary integration; assertions run through the public owning API.
use super::fixtures::{lookup, selection};
use can_dev_server::claim::Claim;
use can_dev_server::control::*;
use serde_json::{Value, json};
use std::os::unix::net::UnixStream;
use std::{
    io::{Read, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
#[test]
fn private_control_roundtrip_and_live_duplicate_refusal() {
    let (_root, _runtime, selection) = selection();
    let mut server = Server::start(
        selection.clone(),
        Arc::new(|command| Ok(json!({"received":command.command,"payload":command.payload}))),
    )
    .unwrap();
    let client = Client::discover(&lookup(&selection)).unwrap();
    let result = client
        .request(
            Command {
                command: "status".into(),
                payload: json!({"n":1}),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(result, json!({"received":"status","payload":{"n":1}}));
    assert_eq!(
        Claim::acquire(&selection).err().unwrap().code,
        "SESSION_EXISTS"
    );
    let mut wrong = lookup(&selection);
    wrong.session_id = Some("wrong".into());
    assert_eq!(
        Client::discover(&wrong).unwrap_err().code,
        "SESSION_MISMATCH"
    );
    server.stop().unwrap();
    assert!(!Path::new(&server.identity.socket_path).exists());
}

#[test]
fn client_cancellation_detaches_while_owner_operation_finishes() {
    let (_root, _runtime, selection) = selection();
    let completed = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(AtomicBool::new(false));
    let finish = Arc::new(AtomicBool::new(false));
    let done = completed.clone();
    let gate = entered.clone();
    let release = finish.clone();
    let mut server = Server::start(
        selection.clone(),
        Arc::new(move |_| {
            gate.store(true, Ordering::Release);
            while !release.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(2));
            }
            done.store(true, Ordering::Release);
            Ok(Value::Null)
        }),
    )
    .unwrap();
    let client = Client::discover(&lookup(&selection)).unwrap();
    let cancel = AtomicBool::new(false);
    thread::scope(|scope| {
        let request = scope.spawn(|| {
            client.request(
                Command {
                    command: "check".into(),
                    payload: Value::Null,
                },
                &cancel,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !entered.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(entered.load(Ordering::Acquire));
        cancel.store(true, Ordering::Release);
        assert_eq!(request.join().unwrap().unwrap_err().code, "REQUEST_ABORTED");
        assert!(!completed.load(Ordering::Acquire));
        finish.store(true, Ordering::Release);
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while !completed.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    assert!(completed.load(Ordering::Acquire));
    assert!(server.require_ownership().is_ok());
    server.stop().unwrap();
}

#[test]
fn detached_request_cancels_only_its_handler_and_keeps_owner_available() {
    let (_root, _runtime, selection) = selection();
    let (entered, ready) = mpsc::channel();
    let (finished, joined) = mpsc::channel();
    let mut server = Server::start_cancellable(
        selection.clone(),
        Arc::new(move |command, cancel| {
            if command.command == "example.run" {
                entered.send(()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                while !cancel.load(Ordering::Acquire) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(2));
                }
                finished.send(cancel.load(Ordering::Acquire)).unwrap();
            }
            Ok(json!("available"))
        }),
    )
    .unwrap();
    let client = Client::discover(&lookup(&selection)).unwrap();
    let cancel = AtomicBool::new(false);
    thread::scope(|scope| {
        let request = scope.spawn(|| {
            client.request(
                Command {
                    command: "example.run".into(),
                    payload: Value::Null,
                },
                &cancel,
            )
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        cancel.store(true, Ordering::Release);
        assert_eq!(request.join().unwrap().unwrap_err().code, "REQUEST_ABORTED");
    });
    assert!(joined.recv_timeout(Duration::from_secs(2)).unwrap());
    assert_eq!(
        client
            .request(
                Command {
                    command: "status".into(),
                    payload: Value::Null
                },
                &AtomicBool::new(false)
            )
            .unwrap(),
        "available"
    );
    server.stop().unwrap();
}

#[test]
fn stop_drains_the_complete_final_response_before_retiring_claim() {
    let (_root, _runtime, selection) = selection();
    let (entered_tx, entered_rx) = mpsc::channel();
    let release = Arc::new(AtomicBool::new(false));
    let gate = release.clone();
    let final_response = json!({"schema":"can.dev.stop-confirmed.v1","resourcesReleased":true,"padding":"x".repeat(80*1024)});
    let expected = final_response.clone();
    let mut server = Server::start(
        selection.clone(),
        Arc::new(move |_| {
            entered_tx.send(()).unwrap();
            while !gate.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(2));
            }
            Ok(final_response.clone())
        }),
    )
    .unwrap();
    let client = Client::discover(&lookup(&selection)).unwrap();
    let request = thread::spawn(move || {
        client.request(
            Command {
                command: "stop.confirm".into(),
                payload: Value::Null,
            },
            &AtomicBool::new(false),
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(!server.retire_when_drained().unwrap());
    assert!(Path::new(&server.identity.socket_path).exists());
    release.store(true, Ordering::Release);
    server.stop().unwrap();
    assert_eq!(request.join().unwrap().unwrap(), expected);
    assert!(!Path::new(&server.identity.socket_path).exists());
}

#[test]
fn oversized_frames_are_bounded_and_owner_stays_available() {
    let (_root, _runtime, selection) = selection();
    let mut server = Server::start(
        selection.clone(),
        Arc::new(|command| {
            if command.command == "large" {
                Ok(Value::String("x".repeat(128 * 1024)))
            } else {
                Ok(json!("ready"))
            }
        }),
    )
    .unwrap();
    let client = Client::discover(&lookup(&selection)).unwrap();
    assert_eq!(
        client
            .request(
                Command {
                    command: "large".into(),
                    payload: Value::Null
                },
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "RESPONSE_TOO_LARGE"
    );
    assert_eq!(
        client
            .request(
                Command {
                    command: "status".into(),
                    payload: json!("x".repeat(256 * 1024))
                },
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "REQUEST_TOO_LARGE"
    );
    assert_eq!(
        client
            .request(
                Command {
                    command: "status".into(),
                    payload: Value::Null
                },
                &AtomicBool::new(false)
            )
            .unwrap(),
        "ready"
    );
    server.stop().unwrap();
}

#[test]
fn forged_hello_never_dispatches_and_owner_remains_available() {
    let (_root, _runtime, selection) = selection();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let called = calls.clone();
    let mut server = Server::start(
        selection.clone(),
        Arc::new(move |_| {
            called.fetch_add(1, Ordering::AcqRel);
            Ok(json!({"alive":true}))
        }),
    )
    .unwrap();
    let mut stream = UnixStream::connect(&server.identity.socket_path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut hello = serde_json::to_value(&server.identity).unwrap();
    hello["type"] = json!("hello");
    hello["nonce"] = json!("a".repeat(32));
    hello["sessionId"] = json!("forged");
    writeln!(stream, "{hello}").unwrap();
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    assert_eq!(calls.load(Ordering::Acquire), 0);
    let client = Client::discover(&lookup(&selection)).unwrap();
    assert_eq!(
        client
            .request(
                Command {
                    command: "status".into(),
                    payload: Value::Null
                },
                &AtomicBool::new(false)
            )
            .unwrap()["alive"],
        true
    );
    server.stop().unwrap();
}
