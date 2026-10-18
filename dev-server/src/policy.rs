//! Test-only native policy execution with literal SDK callbacks on caller-held objects.
//! This protocol is private to semantic tests; no supplied callback can issue a policy verdict.
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead, Read, Write},
    sync::atomic::AtomicBool,
};
const LIMIT: u64 = 64 * 1024 * 1024;
fn read(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut bytes = Vec::new();
    reader
        .take(LIMIT + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT || bytes.last() != Some(&b'\n') {
        return Err("bounded policy frame unavailable".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid policy frame".into())
}
fn send(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("policy frame exceeds limit".into());
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}
pub fn run() -> u8 {
    crate::signals::install();
    let input = RefCell::new(io::stdin().lock());
    let output = RefCell::new(io::stdout().lock());
    let sequence = Cell::new(0u64);
    let result = (|| -> Result<Value, String> {
        let request = read(&mut *input.borrow_mut())?;
        let operation = request["operation"]
            .as_str()
            .ok_or("policy operation is absent")?;
        let generation = format!("policy-{}", crate::preview::random_id()?);
        let cancel = AtomicBool::new(false);
        let call = |command: &str,
                    parent: Option<&str>,
                    payload: Value,
                    _: &AtomicBool|
         -> Result<Value, String> {
            let id = sequence.get();
            sequence.set(id + 1);
            send(
                &mut *output.borrow_mut(),
                &json!({"kind":"call","id":id,"generation":parent,"command":command,"payload":payload}),
            )?;
            let reply = read(&mut *input.borrow_mut())?;
            if reply["id"] != id {
                return Err("policy SDK reply identity differs".into());
            }
            if reply["ok"] != true {
                return Err(format!("policy SDK call failed: {command}"));
            }
            Ok(reply["result"].clone())
        };
        let result =
            crate::preview::test_policy(operation, &request["input"], &generation, &call, &cancel);
        // Join and release every SDK allocation, including a constructor that failed after allocation.
        let cleanup = call(
            "test.release",
            Some(&generation),
            json!({}),
            &AtomicBool::new(false),
        );
        match cleanup {
            Err(error) => Err(error),
            Ok(_) => result,
        }
    })();
    let (code, result) = match result {
        Ok(result) => (0, json!({"kind":"done","ok":true,"result":result})),
        Err(detail) => (1, json!({"kind":"done","ok":false,"detail":detail})),
    };
    if send(&mut *output.borrow_mut(), &result).is_err() {
        return 1;
    }
    code
}
