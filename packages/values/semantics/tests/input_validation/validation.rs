//! V03.5 scaffold entry vectors: version/op/args gates, digest
//! fidelity, fixed-width overflow, and plan lifecycle envelopes.

use serde_json::{json, Value};
use values_semantics::profiles::{ProfileHost, STRUCTURAL_ABI};

fn host() -> ProfileHost {
    ProfileHost::default()
}

fn call(host: &mut ProfileHost, op: &str, args: Value) -> Value {
    host.handle_line(&json!({"v": STRUCTURAL_ABI, "op": op, "args": args}).to_string())
}

fn budgets() -> Value {
    json!({"nodes": 1000, "depth": 50, "text": 1000, "entries": 100})
}

fn schema() -> Value {
    json!({
        "t": "normalized",
        "contracts": [
            {"name": "User", "fields": [
                {"name": "id", "type_id": "int", "base": {"t": "scalar", "name": "int"}, "required": true},
            ]},
        ],
        "enums": [],
        "operations": [],
    })
}

fn provenance() -> Value {
    json!({"factory": "normalizeSchema", "owner_rev": "artifact-1"})
}

fn owner(host: &mut ProfileHost) -> u64 {
    let response = call(
        host,
        "owner.create",
        json!({"abi": "v1", "profile": "values", "backend": "native", "owner_rev": "artifact-1", "bound": 8}),
    );
    response["value"]["owner"].as_u64().unwrap()
}

#[test]
fn version_op_and_args_gates_run_first() {
    let mut host = host();
    let malformed = host.handle_line(r#"{"op":"input.digest","args":{}}"#);
    assert_eq!(malformed["code"], "version/malformed");
    let unsupported = host.handle_line(r#"{"v":9,"op":"input.digest","args":{}}"#);
    assert_eq!(unsupported["code"], "version/unsupported");
    assert_eq!(unsupported["stage"], "transport");
    let unknown = call(&mut host, "nope.nope", json!({}));
    assert_eq!(unknown["code"], "op/unknown");
    let bad_args = host.handle_line(r#"{"v":1,"op":"input.digest","args":[]}"#);
    assert_eq!(bad_args["code"], "args/malformed");
    let unparseable = host.handle_line("not json");
    assert_eq!(unparseable["code"], "args/malformed");
}

#[test]
fn digest_preserves_bits_units_and_keys() {
    let mut host = host();
    let neg_zero = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "f64", "bits": "8000000000000000"}, "budgets": budgets()}),
    );
    assert_eq!(neg_zero["value"]["root"]["bits"], "8000000000000000");
    let lone = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "text", "units": [55296]}, "budgets": budgets()}),
    );
    assert_eq!(lone["value"]["root"]["units"], json!([55296]));
    let dupes = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "entries", "entries": [
            [[98], {"t": "f64", "bits": "3ff0000000000000"}],
            [[97], {"t": "bool", "v": true}],
            [[98], {"t": "null"}],
        ]}, "budgets": budgets()}),
    );
    assert_eq!(dupes["value"]["root"]["keys"], json!([[98], [97], [98]]));
    let missing = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "entries", "entries": [[[109], {"t": "missing"}]]}, "budgets": budgets()}),
    );
    assert_eq!(missing["value"]["nodes"], 2);
}

#[test]
fn fixed_width_overflow_rejects_before_coercion() {
    let mut host = host();
    let wide_unit = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "text", "units": [65536]}, "budgets": budgets()}),
    );
    assert_eq!(wide_unit["code"], "fixed-width/overflow");
    assert_eq!(wide_unit["ok"], false);
    let long_bits = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "f64", "bits": "00000000000000000"}, "budgets": budgets()}),
    );
    assert_eq!(long_bits["code"], "fixed-width/overflow");
    let bad_hex = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "f64", "bits": "not-hex!"}, "budgets": budgets()}),
    );
    assert_eq!(bad_hex["code"], "args/malformed");
    let wide_budget = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "bool", "v": true}, "budgets": {"nodes": 4294967296u64, "depth": 1, "text": 1, "entries": 1}}),
    );
    assert_eq!(wide_budget["code"], "fixed-width/overflow");
}

#[test]
fn length_gates_reject_at_the_transport_stage() {
    let mut host = host();
    let tight = json!({"nodes": 1, "depth": 50, "text": 1000, "entries": 100});
    let response = call(
        &mut host,
        "input.digest",
        json!({"frame": {"t": "array", "items": [{"t": "bool", "v": true}]}, "budgets": tight}),
    );
    assert_eq!(response["stage"], "transport");
    assert_eq!(response["code"], "length/nodes");
    assert_eq!(response["check"], "nodes");
}

#[test]
fn owner_handles_stay_server_side() {
    let mut host = host();
    let handle = owner(&mut host);
    assert_eq!(handle, 0);
    let forged = call(
        &mut host,
        "plan.register",
        json!({"owner": 99, "profile": "v", "schema": schema()}),
    );
    assert_eq!(forged["stage"], "plan");
    assert_eq!(forged["code"], "foreign-owner");
    let unshaped = call(&mut host, "owner.create", json!({"abi": "v1"}));
    assert_eq!(unshaped["code"], "args/malformed");
}

#[test]
fn plan_lifecycle_round_trips_through_the_envelope() {
    let mut host = host();
    let handle = owner(&mut host);
    let id = call(
        &mut host,
        "plan.register",
        json!({"owner": handle, "profile": "values/v1", "schema": schema(), "provenance": provenance()}),
    )["value"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(id, "plan:v1:values:native:artifact-1:g0:0");
    let summary = call(&mut host, "plan.get", json!({"owner": handle, "id": id}));
    assert_eq!(summary["value"]["contracts"], json!(["User"]));
    assert_eq!(summary["value"]["generation"], 0);
    let retired = call(&mut host, "owner.retire", json!({"owner": handle}));
    assert_eq!(retired["value"]["generation"], 1);
    let stale = call(&mut host, "plan.get", json!({"owner": handle, "id": id}));
    assert_eq!(stale["code"], "inactive-generation");
    let released = call(
        &mut host,
        "plan.release",
        json!({"owner": handle, "id": id}),
    );
    assert_eq!(released["ok"], true);
}

#[test]
fn plan_gates_surface_as_plan_stage_errors() {
    let mut host = host();
    let handle = owner(&mut host);
    let legacy = call(
        &mut host,
        "plan.register",
        json!({"owner": handle, "profile": "v", "schema": {"t": "legacy", "text": "s"}, "provenance": provenance()}),
    );
    assert_eq!(legacy["stage"], "plan");
    assert_eq!(legacy["code"], "legacy-wrapper");
    let missing = call(
        &mut host,
        "plan.register",
        json!({"owner": handle, "profile": "v", "schema": schema()}),
    );
    assert_eq!(missing["code"], "missing-provenance");
    let unknown = call(
        &mut host,
        "plan.get",
        json!({"owner": handle, "id": "plan:nope"}),
    );
    assert_eq!(unknown["code"], "unknown-plan");
}
