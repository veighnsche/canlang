//! Closed, owner-defined business refusal observations and value-free projections.
//! Response prose, draft fields, identities, operation names and credentials never enter the queue.
use crate::capture::{self, Capture};
use hyper::HeaderMap;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::atomic::AtomicBool};

pub const MAX_OBSERVED_BYTES: usize = 8 * 1024;
#[derive(Clone, Debug)]
pub struct Catalog {
    messages: BTreeMap<String, String>,
    retryable: BTreeMap<String, bool>,
    form_header: String,
}
impl Catalog {
    /// The catalog's exact captured bytes are emitted from the defining Interfaces owner.
    pub fn from_capture(capture: &Capture, cancel: &AtomicBool) -> Result<Self, String> {
        let bytes = capture::verified_bytes(capture, "extra:construct-catalog", cancel)?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid captured error catalog")?;
        Self::from_value(&value)
    }
    pub fn from_value(value: &Value) -> Result<Self, String> {
        let messages = value["publicErrorMessages"]
            .as_object()
            .ok_or("public error messages are unavailable")?;
        let defaults = value["retryableByCode"]
            .as_object()
            .ok_or("business retry defaults are unavailable")?;
        if messages.is_empty() || messages.len() > 256 || messages.len() != defaults.len() {
            return Err("closed business error catalog is invalid".into());
        }
        let mut catalog = Self {
            messages: BTreeMap::new(),
            retryable: BTreeMap::new(),
            form_header: value["formRefusalHeader"]
                .as_str()
                .ok_or("form refusal header is unavailable")?
                .to_owned(),
        };
        if catalog.form_header.is_empty()
            || catalog.form_header.len() > 128
            || !catalog
                .form_header
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err("form refusal header is invalid".into());
        }
        for (code, message) in messages {
            if code.is_empty()
                || code.len() > 32
                || !code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            {
                return Err("closed business error code is invalid".into());
            }
            let message = message
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 512 && !v.chars().any(char::is_control))
                .ok_or("public business error message is invalid")?;
            let retryable = defaults
                .get(code)
                .and_then(Value::as_bool)
                .ok_or("business retry default is invalid")?;
            catalog.messages.insert(code.clone(), message.into());
            catalog.retryable.insert(code.clone(), retryable);
        }
        Ok(catalog)
    }
    fn error(&self, candidate: &Value, require_message: bool) -> Option<Observed> {
        let code = candidate["code"].as_str()?;
        if require_message && !candidate["message"].is_string() {
            return None;
        }
        Some(Observed {
            code: code.into(),
            message: self.messages.get(code)?.clone(),
            retryable: candidate["retryable"]
                .as_bool()
                .unwrap_or(*self.retryable.get(code)?),
            mcp: false,
        })
    }
}
#[derive(Clone, Debug)]
pub struct Observed {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub mcp: bool,
}
fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    // Fetch Headers joins duplicates with a comma; ambiguous metadata is never eligible.
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        None
    } else {
        Some(value)
    }
}
fn safe_rpc_id(id: &Value) -> bool {
    id.is_string()
        || id.as_f64().is_some_and(|v| {
            v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0
        })
}
fn same_rpc_id(left: &Value, right: &Value) -> bool {
    if left.is_number() && right.is_number() {
        left.as_f64() == right.as_f64()
    } else {
        left == right
    }
}
/// Parse only the existing owning transport envelopes. Returned text is exclusively catalog text.
pub fn observed(
    catalog: &Catalog,
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
    method: &str,
    path: &str,
    request_body: &[u8],
) -> Option<Observed> {
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if status >= 400
        && method == "POST"
        && path.starts_with("/api/operations/")
        && content_type.starts_with("text/html")
    {
        return form_refusal(catalog, headers);
    }
    if body.is_empty()
        || body.len() > MAX_OBSERVED_BYTES
        || !content_type.starts_with("application/json")
    {
        return None;
    }
    let root: Value = serde_json::from_slice(body).ok()?;
    root.as_object()?;
    if status >= 400 {
        let candidate = match root.get("error") {
            Some(error) if !error.is_null() => error,
            _ => &root,
        };
        return catalog.error(candidate, true);
    }
    mcp_refusal(catalog, status, method, path, &root, request_body)
}
fn form_refusal(catalog: &Catalog, headers: &HeaderMap) -> Option<Observed> {
    let raw = one_header(headers, &catalog.form_header)?;
    if raw.len() > 256 {
        return None;
    }
    let fields: Value = serde_json::from_str(raw).ok()?;
    let object = fields.as_object()?;
    if object.len() != 3
        || !["version", "code", "retryable"]
            .into_iter()
            .all(|key| object.contains_key(key))
        || fields["version"].as_f64() != Some(1.0)
        || !fields["retryable"].is_boolean()
    {
        return None;
    }
    catalog.error(&fields, false)
}
fn mcp_refusal(
    catalog: &Catalog,
    status: u16,
    method: &str,
    path: &str,
    root: &Value,
    request_body: &[u8],
) -> Option<Observed> {
    if status != 200
        || method != "POST"
        || path != "/mcp"
        || root["jsonrpc"] != "2.0"
        || root.get("error").is_some()
    {
        return None;
    }
    let call: Value = serde_json::from_slice(request_body).ok()?;
    call.as_object()?;
    if call["jsonrpc"] != "2.0"
        || call["method"] != "tools/call"
        || !safe_rpc_id(&call["id"])
        || !same_rpc_id(&root["id"], &call["id"])
    {
        return None;
    }
    let result = &root["result"];
    result.as_object()?;
    if result["isError"] != true {
        return None;
    }
    let mut error = catalog.error(&result["structuredContent"], true)?;
    error.mcp = true;
    Some(error)
}
fn ref_part<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 64
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or_else(|| format!("business refusal {key} identity is invalid"))
}
pub fn validate_context(context: &Value) -> Result<(), String> {
    for key in ["session", "revision", "servingBuild"] {
        ref_part(context, key)?;
    }
    let revision = context["sourceRevision"]
        .as_str()
        .and_then(|v| v.strip_prefix("sha256:"))
        .ok_or("business refusal source revision is invalid")?;
    if revision.len() != 64
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("business refusal source revision is invalid".into());
    }
    Ok(())
}
/// No actor/policy projection is available on this surface: operation and all business values stay withheld.
pub fn projection(
    context: &Value,
    request_id: &str,
    status: u16,
    error: &Observed,
) -> Result<Value, String> {
    validate_context(context)?;
    ref_part(&json!({"request":request_id}), "request")?;
    if if error.mcp {
        status != 200
    } else {
        !(400..=599).contains(&status)
    } {
        return Err("business refusal HTTP status differs from transport".into());
    }
    let reference = format!(
        "{}/{}/{request_id}/f0",
        context["session"].as_str().unwrap(),
        context["revision"].as_str().unwrap()
    );
    let mut owner = json!({"request_id":request_id,"status":status});
    let mut detail = json!({"ref":reference,"status":status,"retryable":error.retryable});
    if error.mcp {
        owner["transport"] = json!("mcp");
        detail["transport"] = json!("mcp");
    }
    let mut missing = vec![
        "source_mapping_unavailable",
        "trace_unavailable",
        "operation_identity_withheld",
    ];
    if error.code == "delivery_unknown" {
        missing.push("external_effect_uncertain");
    }
    Ok(
        json!({"occurrence":{"schema":"can.dev.failure.v1","ref":reference,"session":context["session"],"revision":context["revision"],
        "source_revision":context["sourceRevision"],"serving_build":context["servingBuild"],"origin":"http","phase":"unknown","code":error.code,
        "summary":error.message,"owner_ref":owner,"evidence":{"state":"partial","missing":missing},"detail_ref":format!("{reference}/detail")},"detail":detail}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(crate) fn catalog() -> Catalog {
        Catalog::from_value(&json!({"publicErrorMessages":{"forbidden":"Safe permission message.","busy":"Safe busy message.","delivery_unknown":"Safe uncertain message.","limit":"Safe limit message."},
            "retryableByCode":{"forbidden":false,"busy":true,"delivery_unknown":true,"limit":false},"formRefusalHeader":"can-form-refusal"})).unwrap()
    }
    fn headers(content_type: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", content_type.parse().unwrap());
        headers
    }
    #[test]
    fn observes_only_closed_json_codes_and_preserves_worker_retry_fact_without_values() {
        let catalog = catalog();
        let headers = headers("application/json; charset=utf-8");
        for (body, retryable) in [
            (
                json!({"error":{"code":"busy","message":"PRIVATE","retryable":false,"fields":[{"message":"SECRET"}],"operation_id":"PRIVATE_OPERATION"}}),
                false,
            ),
            (json!({"code":"delivery_unknown","message":"PRIVATE"}), true),
            (
                json!({"error":null,"code":"forbidden","message":"PRIVATE"}),
                false,
            ),
            (
                json!({"code":"busy","message":"PRIVATE","retryable":"true"}),
                true,
            ),
        ] {
            let error = observed(
                &catalog,
                503,
                &headers,
                body.to_string().as_bytes(),
                "GET",
                "/mcp",
                b"",
            )
            .unwrap();
            assert_eq!(error.retryable, retryable);
            assert!(!error.message.contains("PRIVATE"));
            assert!(!error.mcp);
        }
        for body in [
            json!({"code":"unknown","message":"PRIVATE"}),
            json!({"code":"busy"}),
            json!([]),
        ] {
            assert!(
                observed(
                    &catalog,
                    503,
                    &headers,
                    body.to_string().as_bytes(),
                    "GET",
                    "/mcp",
                    b""
                )
                .is_none()
            );
        }
        assert!(
            observed(
                &catalog,
                503,
                &headers,
                &vec![b' '; MAX_OBSERVED_BYTES + 1],
                "GET",
                "/mcp",
                b""
            )
            .is_none()
        );
    }
    #[test]
    fn html_metadata_is_exact_and_drafts_are_never_inspected() {
        let catalog = catalog();
        let mut headers = headers("text/html; charset=utf-8");
        headers.insert(
            "can-form-refusal",
            r#"{"version":1,"code":"limit","retryable":true}"#.parse().unwrap(),
        );
        let draft = vec![b'X'; MAX_OBSERVED_BYTES + 1];
        let error = observed(
            &catalog,
            429,
            &headers,
            &draft,
            "POST",
            "/api/operations/Office.create",
            b"PRIVATE",
        )
        .unwrap();
        assert_eq!(error.code, "limit");
        assert!(error.retryable);
        for raw in [
            r#"{"version":2,"code":"limit","retryable":true}"#,
            r#"{"version":1,"code":"limit","retryable":"true"}"#,
            r#"{"version":1,"code":"unknown","retryable":true}"#,
            r#"{"version":1,"code":"limit","retryable":true,"message":"PRIVATE"}"#,
        ] {
            headers.insert("can-form-refusal", raw.parse().unwrap());
            assert!(
                observed(
                    &catalog,
                    429,
                    &headers,
                    &draft,
                    "POST",
                    "/api/operations/Office.create",
                    b""
                )
                .is_none()
            );
        }
        headers.insert(
            "can-form-refusal",
            r#"{"version":1,"code":"limit","retryable":true}"#.parse().unwrap(),
        );
        for (status, method, path) in [
            (200, "POST", "/api/operations/Office.create"),
            (429, "GET", "/api/operations/Office.create"),
            (429, "POST", "/page"),
        ] {
            assert!(observed(&catalog, status, &headers, &draft, method, path, b"").is_none());
        }
    }
    #[test]
    fn mcp_requires_matching_tools_call_and_exact_business_error_surface() {
        let catalog = catalog();
        let headers = headers("application/json");
        let call = json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"PRIVATE_OPERATION","arguments":{"secret":"PRIVATE"}}});
        let response = json!({"jsonrpc":"2.0","id":7.0,"result":{"isError":true,"structuredContent":{"code":"busy","message":"PRIVATE","retryable":true},"content":[{"text":"PRIVATE"}]}});
        let observe = |response: &Value, call: &Value, path: &str| {
            observed(
                &catalog,
                200,
                &headers,
                response.to_string().as_bytes(),
                "POST",
                path,
                call.to_string().as_bytes(),
            )
        };
        let error = observe(&response, &call, "/mcp").unwrap();
        assert!(error.mcp);
        assert_eq!(error.message, "Safe busy message.");
        let mut changed = response.clone();
        changed["id"] = json!(8);
        assert!(observe(&changed, &call, "/mcp").is_none());
        changed = response.clone();
        changed["error"] = Value::Null;
        assert!(observe(&changed, &call, "/mcp").is_none());
        changed = response.clone();
        changed["result"]["isError"] = json!(false);
        assert!(observe(&changed, &call, "/mcp").is_none());
        assert!(observe(&response, &call, "/other").is_none());
        let mut changed_call = call.clone();
        changed_call["method"] = json!("tools/list");
        assert!(observe(&response, &changed_call, "/mcp").is_none());
        changed_call = call.clone();
        changed_call["id"] = json!(9_007_199_254_740_992u64);
        assert!(observe(&response, &changed_call, "/mcp").is_none());
    }
    #[test]
    fn public_projection_carries_only_safe_catalog_facts_and_owner_correlation() {
        let context = json!({"session":"session","revision":"r1","sourceRevision":format!("sha256:{}","a".repeat(64)),"servingBuild":"b1"});
        let error=observed(&catalog(),503,&headers("application/json"),br#"{"code":"delivery_unknown","message":"PRIVATE","operation_id":"PRIVATE_OPERATION"}"#,"GET","/private",b"").unwrap();
        let result = projection(&context, "request-1", 503, &error).unwrap();
        assert_eq!(result["occurrence"]["summary"], "Safe uncertain message.");
        assert_eq!(
            result["occurrence"]["owner_ref"],
            json!({"request_id":"request-1","status":503})
        );
        assert_eq!(
            result["detail"],
            json!({"ref":"session/r1/request-1/f0","status":503,"retryable":true})
        );
        assert!(
            result["occurrence"]["evidence"]["missing"]
                .as_array()
                .unwrap()
                .contains(&json!("external_effect_uncertain"))
        );
        assert!(!result.to_string().contains("PRIVATE"));
        assert!(projection(&context, "bad/request", 503, &error).is_err());
    }
}
