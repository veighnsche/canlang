//! Bounded control projections. Lifecycle and retention decisions stay in owner.
use crate::{
    capture::Capture,
    claim::{ControlError, Result},
    compiler::CompileResult,
};
use serde_json::{Value, json};
use std::collections::VecDeque;

pub const MAX_DIAGNOSTICS: usize = 256;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub fn integer(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= MAX_SAFE_INTEGER)
}
pub fn error(code: &str, message: &str) -> ControlError {
    ControlError::new(code, message)
}
pub fn short(text: &str, max: usize) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}
pub fn revision(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| valid_revision(s))
        .ok_or_else(|| error("INVALID_REQUEST", "captured revision is required"))
}
pub fn valid_revision(s: &str) -> bool {
    s.strip_prefix('r').is_some_and(|n| {
        !n.starts_with('0') && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
    })
}
pub fn page(payload: &Value, default: u64) -> Result<(i64, usize)> {
    let after = payload.get("after").map(Value::as_i64).unwrap_or(Some(-1));
    let limit = payload
        .get("limit")
        .map(Value::as_u64)
        .unwrap_or(Some(default));
    match (after, limit) {
        (Some(a), Some(n)) if a >= -1 && a <= MAX_SAFE_INTEGER as i64 && (1..=25).contains(&n) => {
            Ok((a, n as usize))
        }
        _ => Err(error("INVALID_REQUEST", "cursor or limit is invalid")),
    }
}
pub fn source(c: &Capture) -> Value {
    json!({"path":c.compiler_operand,"sha256":c.source_sha256})
}
pub fn at(c: &Capture, d: &Value) -> Value {
    json!({"path":c.compiler_operand,"start":d["primary"]["start"],"end":d["primary"]["end"]})
}
pub fn envelope(result: &CompileResult) -> Option<&Value> {
    match result {
        CompileResult::Diagnostics { envelope } => Some(envelope),
        _ => None,
    }
}
pub fn counts(result: &CompileResult) -> (usize, u64, usize) {
    let Some(e) = envelope(result) else {
        return (0, 0, 0);
    };
    let reported = e["diagnostics"].as_array().map_or(0, Vec::len);
    (
        reported,
        e["omitted"].as_u64().unwrap_or(0),
        reported.saturating_sub(MAX_DIAGNOSTICS),
    )
}
pub fn diagnostics(result: &CompileResult) -> &[Value] {
    envelope(result)
        .and_then(|e| e["diagnostics"].as_array())
        .map(|v| &v[..v.len().min(MAX_DIAGNOSTICS)])
        .unwrap_or(&[])
}
fn valid_span(span: &Value, bytes: u64) -> bool {
    span["file"] == 0
        && span["start"]
            .as_u64()
            .zip(span["end"].as_u64())
            .is_some_and(|(a, b)| a <= b && b <= bytes)
}
fn diagnostic(c: &Capture, value: &Value) -> Option<Value> {
    let code = value["code"].as_str()?;
    let message = value["message"].as_str()?;
    if !matches!(value["severity"].as_str()?, "error" | "warning" | "info")
        || !valid_span(&value["primary"], c.source_bytes)
    {
        return None;
    }
    let mut related = vec![];
    for item in value["related"].as_array()?.iter().take(8) {
        if !valid_span(item, c.source_bytes) {
            return None;
        }
        related.push(json!({"file":0,"start":item["start"],"end":item["end"],"message":short(item["message"].as_str()?,600)}));
    }
    let tags = value["tags"].as_array()?;
    if tags.iter().any(|v| !v.is_string()) {
        return None;
    }
    let mut result = json!({"code":short(code,40),"severity":value["severity"],"message":short(message,600),"primary":value["primary"],"related":related,
        "tags":tags.iter().take(12).map(|v|short(v.as_str().unwrap(),40)).collect::<Vec<_>>()});
    if let Some(candidates) = value.get("construct_candidates") {
        result["construct_candidates"] = candidates.clone()
    }
    Some(result)
}
pub fn normalize(c: &Capture, result: CompileResult) -> CompileResult {
    let CompileResult::Diagnostics { mut envelope } = result else {
        return result;
    };
    if envelope["omitted"].as_u64().is_none() || !envelope["complete"].is_boolean() {
        return CompileResult::ToolFailure {
            reason: "compiler diagnostic envelope has invalid fields".into(),
        };
    }
    let raw = envelope["diagnostics"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for (index, value) in raw.iter().take(MAX_DIAGNOSTICS).enumerate() {
        let Some(d) = diagnostic(c, value) else {
            return CompileResult::ToolFailure {
                reason: "compiler diagnostic envelope has invalid fields".into(),
            };
        };
        envelope["diagnostics"][index] = d;
    }
    CompileResult::Diagnostics { envelope }
}
pub fn focus(session: &str, rev: &str, c: &Capture, result: &CompileResult) -> Value {
    diagnostics(result).first().map(|d|json!({"ref":format!("{session}/{rev}/d0"),"code":d["code"],"severity":d["severity"],"message":short(d["message"].as_str().unwrap_or(""),180),"at":at(c,d)})).unwrap_or(Value::Null)
}
pub fn excerpt(c: &Capture, d: &Value) -> Value {
    if d["primary"]["file"] != 0 {
        return Value::Null;
    }
    let bytes = c.source_text.as_bytes();
    let start = (d["primary"]["start"].as_u64().unwrap_or(0) as usize)
        .saturating_sub(160)
        .min(bytes.len());
    let end = (d["primary"]["end"].as_u64().unwrap_or(0) as usize)
        .saturating_add(160)
        .min(bytes.len())
        .min(start + 800)
        .max(start);
    json!({"text":String::from_utf8_lossy(&bytes[start..end]),"start":start,"end":end})
}
pub fn compiler_failure(
    session: &str,
    rev: &str,
    c: &Capture,
    result: &CompileResult,
    index: usize,
) -> Result<Value> {
    let d = diagnostics(result)
        .get(index)
        .ok_or_else(|| error("FAILURE_UNAVAILABLE", "captured failure is unavailable"))?;
    let e = envelope(result).unwrap();
    let (_, omitted, service_omitted) = counts(result);
    let reference = format!("{session}/{rev}/d{index}");
    let code = short(d["code"].as_str().unwrap_or(""), 32);
    let mut missing = vec!["causal_trace_unavailable"];
    if e["complete"] != true {
        missing.insert(0, "compiler_analysis_incomplete")
    }
    if omitted + service_omitted as u64 > 0 {
        missing.insert(0, "diagnostics_omitted")
    }
    Ok(
        json!({"occurrence":{"schema":"can.dev.failure.v1","ref":reference,"session":session,"revision":rev,"source_revision":c.source_revision,
        "origin":"compiler","phase":"analysis","code":code,"summary":format!("Compiler reported {code}."),"owner_ref":{"diagnostic_index":index},
        "at":{"kind":"exact_span","path":c.compiler_operand,"sha256":c.source_sha256,"start":d["primary"]["start"],"end":d["primary"]["end"]},
        "evidence":{"state":"partial","missing":missing},"detail_ref":format!("{reference}/detail")},
        "detail":{"ref":reference,"severity":d["severity"],"diagnostic_code":d["code"],"analysis_complete":e["complete"],"omitted":omitted+service_omitted as u64,
        "message":d["message"],"related":d["related"].as_array().unwrap().iter().take(4).collect::<Vec<_>>()}}),
    )
}

#[derive(Clone)]
pub struct Failure {
    pub projection: Value,
    pub cursor: i64,
    pub rerun: Option<Value>,
    pub recipe: Option<String>,
    pub expires: u64,
}
#[derive(Default)]
pub struct Failures {
    items: VecDeque<Failure>,
    cursor: i64,
}
impl Failures {
    pub fn insert(
        &mut self,
        projection: Value,
        rerun: Option<Value>,
        recipe: Option<String>,
        now: u64,
    ) {
        self.items.push_back(Failure {
            projection,
            cursor: self.cursor,
            rerun,
            recipe,
            expires: now + 60 * 60_000,
        });
        self.cursor += 1;
        while self.items.len() > 64 {
            self.items.pop_front();
        }
    }
    pub fn get(&self, reference: &str) -> Option<&Failure> {
        self.items
            .iter()
            .find(|f| f.projection["occurrence"]["ref"] == reference)
    }
    pub fn latest(&self, build: &Value) -> Value {
        self.items
            .iter()
            .rev()
            .find(|f| !build.is_null() && f.projection["occurrence"]["serving_build"] == *build)
            .map(|f| f.projection["occurrence"].clone())
            .unwrap_or(Value::Null)
    }
    pub fn list(&self, session: &str, revision: &str, payload: &Value) -> Result<Value> {
        let (after, limit) = page(payload, 1)?;
        let retained: Vec<_> = self
            .items
            .iter()
            .filter(|f| f.projection["occurrence"]["revision"] == revision)
            .collect();
        let available: Vec<_> = retained.iter().filter(|f| f.cursor > after).collect();
        let page: Vec<_> = available
            .iter()
            .take(limit)
            .map(|f| f.projection["occurrence"].clone())
            .collect();
        let next = if available.len() > page.len() {
            available.get(page.len() - 1).map(|f| f.cursor)
        } else {
            None
        };
        Ok(
            json!({"schema":"can.dev.failures.v1","session":session,"revision":revision,"origins":["example","http"],"total_retained":retained.len(),"failures":page,"next_after":next}),
        )
    }
    pub fn prune(&mut self, now: u64) {
        self.items.retain(|f| f.expires > now)
    }
}

pub fn rerun_refusal(code: &str, original: Option<&Value>) -> Value {
    let mut v = json!({"schema":"can.dev.example-rerun.v1","ok":false,"kind":"rerun_refused","code":code,"detail":"The retained example rerun could not complete.","replay":{"available":false,"reason":"no_restore_capsule"},"evidence":{"missing":["actor_projection_unavailable","runtime_detail_unreleased","trace_unavailable"]}});
    if let Some(original) = original {
        v["original"] = original.clone()
    };
    v
}
pub fn attempt(result: &Value, run: &str, row: &Value) -> Value {
    json!({"run_id":run,"observed_at":result["report"]["finishedAt"],"outcome":row["outcome"],"row_index":row["rowIndex"],"idempotency":if result["idempotency"]["kind"]=="saved_outcome"{"saved_outcome"}else{"not_reported"}})
}
pub fn one_row<'a>(
    result: &'a Value,
    selector: &Value,
    digest: &str,
    source: &str,
) -> Option<&'a Value> {
    let report = &result["report"];
    if report["artifact"]["digest"] != digest
        || report["artifact"]["sourceRevision"] != source
        || result["executed"] != 1
        || report["summary"]["total"] != 1
    {
        return None;
    }
    let cases = report["cases"].as_array()?;
    if cases.len() != 1
        || cases[0]["kind"] != "table"
        || cases[0]["operation"] != selector["operation"]
    {
        return None;
    }
    let rows = cases[0]["rows"].as_array()?;
    if rows.len() != 1 || rows[0]["rowIndex"] != selector["rowIndex"] {
        return None;
    }
    for (outcome, key) in [
        ("passed", "passed"),
        ("failed", "failed"),
        ("setup-failed", "setupFailed"),
        ("unsupported", "unsupported"),
    ] {
        if report["summary"][key] != json!(u64::from(rows[0]["outcome"] == outcome)) {
            return None;
        }
    }
    Some(&rows[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursors_and_revision_are_strict() {
        for v in [
            json!({"limit":0}),
            json!({"after":1.2}),
            json!({"after":-2}),
            json!({"limit":null}),
        ] {
            assert!(page(&v, 10).is_err())
        }
        assert_eq!(page(&json!({"after":99}), 10).unwrap(), (99, 10));
        for r in ["r0", "r01", "r1x", ""] {
            assert!(!valid_revision(r))
        }
        assert!(valid_revision("r12"));
    }
    #[test]
    fn retained_runtime_failures_are_bounded_and_filter_serving_build() {
        let mut store = Failures::default();
        for n in 0..70 {
            store.insert(json!({"occurrence":{"ref":format!("s/r1/q{n}/f0"),"revision":"r1","serving_build":"g1"}}),None,None,0)
        }
        let page = store.list("s", "r1", &json!({"limit":25})).unwrap();
        assert_eq!(page["total_retained"], 64);
        assert_eq!(page["next_after"], 30);
        assert!(store.get("s/r1/q0/f0").is_none());
        assert!(store.latest(&json!("g2")).is_null());
        store.prune(60 * 60_000);
        assert!(store.latest(&json!("g1")).is_null());
    }
    #[test]
    fn rerun_requires_one_exact_row_and_matching_counts() {
        let mut result = json!({"executed":1,"report":{"artifact":{"digest":"digest","sourceRevision":"source"},"summary":{"total":1,"passed":0,"failed":1,"setupFailed":0,"unsupported":0},"cases":[{"kind":"table","operation":"op","rows":[{"rowIndex":2,"outcome":"failed"}]}]}});
        let selector = json!({"operation":"op","rowIndex":2});
        assert!(one_row(&result, &selector, "digest", "source").is_some());
        result["report"]["summary"]["passed"] = json!(1);
        assert!(one_row(&result, &selector, "digest", "source").is_none());
    }
    #[test]
    fn compiler_projection_preserves_omissions_and_withholds_trace() {
        let (_directory, request) = crate::capture::tests::fixture();
        let capture = crate::capture::capture(
            &request,
            &crate::capture::tests::empty_inventory,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        let d = json!({"code":"E123","severity":"error","message":"bad\n token","primary":{"file":0,"start":0,"end":3},"related":[],"tags":[]});
        let result = normalize(
            &capture,
            CompileResult::Diagnostics {
                envelope: json!({"complete":false,"omitted":2,"diagnostics":vec![d;258]}),
            },
        );
        assert_eq!(counts(&result), (258, 2, 2));
        assert_eq!(diagnostics(&result).len(), 256);
        let p = compiler_failure("session", "r2", &capture, &result, 255).unwrap();
        assert_eq!(p["occurrence"]["ref"], "session/r2/d255");
        assert_eq!(p["detail"]["omitted"], 4);
        assert_eq!(p["detail"]["message"], "bad token");
        assert!(
            p["occurrence"]["evidence"]["missing"]
                .as_array()
                .unwrap()
                .contains(&json!("causal_trace_unavailable"))
        );
        assert!(compiler_failure("session", "r2", &capture, &result, 256).is_err());
        assert!(p["detail"].get("trace").is_none());
    }
    #[test]
    fn malformed_diagnostic_fields_are_tool_failure() {
        let (_directory, request) = crate::capture::tests::fixture();
        let capture = crate::capture::capture(
            &request,
            &crate::capture::tests::empty_inventory,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        let result = normalize(
            &capture,
            CompileResult::Diagnostics {
                envelope: json!({"complete":true,"omitted":0,"diagnostics":[{"code":"E1","severity":"error","message":"bad","primary":{"file":0,"start":0,"end":999999},"related":[],"tags":[]}]}),
            },
        );
        assert!(matches!(result, CompileResult::ToolFailure { .. }));
    }
}
