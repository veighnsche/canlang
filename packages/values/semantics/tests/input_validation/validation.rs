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
    assert_eq!(response["code"], "length/oversized");
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

#[test]
fn native_profile_carries_candidate_constraints_at_registration() {
    let mut host = host();
    let handle = owner(&mut host);
    let carried = carried_schema();
    let registered = call(
        &mut host,
        "plan.register",
        json!({
            "owner": handle, "profile": "values/v1", "schema": carried, "provenance": provenance(),
        }),
    );
    assert_eq!(registered["ok"], true);
    let id = registered["value"]["id"].as_str().unwrap().to_string();
    assert_eq!(id, "plan:v1:values:native:artifact-1:g0:0");
    let summary = call(&mut host, "plan.get", json!({"owner": handle, "id": id}));
    assert_eq!(summary["value"]["aliases"], json!(["Nick"]));
}

#[test]
fn native_profile_carried_gates_still_fail_closed() {
    let mut host = host();
    let handle = owner(&mut host);
    // Each malformed duty fails closed without publishing a plan or
    // consuming the first plan identity.
    let mut bad: Vec<Value> = Vec::new();
    let mut push_field = |patch: Value| {
        let mut schema = carried_schema();
        let fields = schema["contracts"][0]["fields"].as_array_mut().unwrap();
        for field in fields.iter_mut() {
            if field["name"] == "name" {
                for (key, value) in patch.as_object().unwrap() {
                    field[key] = value.clone();
                }
            }
        }
        bad.push(schema);
    };
    push_field(json!({"format": "upper"}));
    push_field(json!({"distinctBy": "name"}));
    push_field(json!({"distinctBy": "id"}));
    push_field(json!({"excludedIds": [[110]]}));
    push_field(json!({"format": "name", "distinctBy": "id", "array": false}));
    {
        // Duplicate excluded ids.
        let mut schema = carried_schema();
        let fields = schema["contracts"][0]["fields"].as_array_mut().unwrap();
        for field in fields.iter_mut() {
            if field["name"] == "tags" {
                field["excludedIds"] = json!([[97], [97]]);
            }
        }
        bad.push(schema);
    }
    {
        // Non-NAME excluded id.
        let mut schema = carried_schema();
        let fields = schema["contracts"][0]["fields"].as_array_mut().unwrap();
        for field in fields.iter_mut() {
            if field["name"] == "tags" {
                field["excludedIds"] = json!([[48]]);
            }
        }
        bad.push(schema);
    }
    {
        // Alias with a non-text type.
        let mut schema = carried_schema();
        schema["aliases"] = json!([{"name": "Nick", "type": "int", "min": 1.0, "max": 6.0, "format": "name"}]);
        bad.push(schema);
    }
    {
        // Receiving bounds that cannot satisfy the alias.
        let mut schema = carried_schema();
        let fields = schema["contracts"][0]["fields"].as_array_mut().unwrap();
        for field in fields.iter_mut() {
            if field["name"] == "nick" {
                field["length_min"] = json!(7.0);
            }
        }
        bad.push(schema);
    }
    {
        // Duplicate declarations.
        let mut schema = carried_schema();
        schema["contracts"].as_array_mut().unwrap().push(json!({"name": "User", "fields": []}));
        bad.push(schema);
    }
    for constrained in bad {
        let response = call(
            &mut host,
            "plan.register",
            json!({
                "owner": handle, "profile": "values/v1", "schema": constrained, "provenance": provenance(),
            }),
        );
        assert_eq!(response["ok"], false);
        assert_eq!(response["stage"], "plan");
        assert_eq!(response["code"], "malformed-schema");
    }
    let accepted = call(
        &mut host,
        "plan.register",
        json!({
            "owner": handle, "profile": "values/v1", "schema": carried_schema(), "provenance": provenance(),
        }),
    );
    assert_eq!(
        accepted["value"]["id"],
        "plan:v1:values:native:artifact-1:g0:0"
    );
}

// ---------------------------------------------------------------------------
// Whole-profile execution helpers.
// ---------------------------------------------------------------------------

/// Schema carrying the full current duties: trim/bounds/format on a
/// text field, an alias-nominal, an enum-nominal with a text default, a
/// distinctBy/excludedIds contract array, a union, a model ref and a
/// secret refusal. No exact/host leaves: the target executes natively.
fn carried_schema() -> Value {
    json!({
        "t": "normalized",
        "contracts": [
            {"name": "User", "fields": [
                {"name": "id", "type_id": "text", "base": {"t": "scalar", "name": "text"}, "required": true},
                {"name": "name", "type_id": "text", "base": {"t": "scalar", "name": "text"},
                 "required": true, "trim": true, "length_min": 1.0, "length_max": 8.0, "format": "name"},
                {"name": "nick", "type_id": "Nick", "base": {"t": "nominal", "path": "Nick"}, "required": false},
                {"name": "role", "type_id": "Role", "base": {"t": "nominal", "path": "Role"},
                 "required": false, "has_default": true,
                 "default": {"t": "text", "units": [117, 115, 101, 114]}},
                {"name": "tags", "type_id": "Tag", "base": {"t": "nominal", "path": "Tag"},
                 "array": true, "required": false, "distinctBy": "id", "excludedIds": [[109, 101]]},
                {"name": "pick", "type_id": "Tag|Role", "base": {"t": "union", "arms": ["Tag", "Role"]}, "required": false},
            ]},
            {"name": "Tag", "fields": [
                {"name": "id", "type_id": "text", "base": {"t": "scalar", "name": "text"}, "required": true},
            ]},
        ],
        "enums": [{"name": "Role", "cases": ["admin", "user"]}],
        "operations": [
            {"name": "rename", "mutation": true, "inputs": [
                {"name": "user", "type_id": "Account", "base": {"t": "nominal", "path": "Account"}, "required": true},
                {"name": "name", "type_id": "text", "base": {"t": "scalar", "name": "text"}, "required": true},
            ]},
            {"name": "search", "mutation": false, "inputs": [
                {"name": "name", "type_id": "text", "base": {"t": "scalar", "name": "text"}, "required": false},
            ]},
        ],
        "aliases": [{"name": "Nick", "type": "text", "min": 1.0, "max": 6.0, "format": "name"}],
    })
}

fn units_of(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn fr_text(text: &str) -> Value {
    json!({"t": "text", "units": units_of(text)})
}

fn fr_bool(flag: bool) -> Value {
    json!({"t": "bool", "v": flag})
}

fn fr_null() -> Value {
    json!({"t": "null"})
}

fn fr_array(items: Vec<Value>) -> Value {
    json!({"t": "array", "items": items})
}

fn fr_entries(pairs: Vec<(&str, Value)>) -> Value {
    json!({"t": "entries", "entries": pairs.into_iter().map(|(key, value)| json!([units_of(key), value])).collect::<Vec<_>>()})
}

fn register_carried(host: &mut ProfileHost) -> (u64, String) {
    let handle = owner(host);
    let id = call(
        host,
        "plan.register",
        json!({
            "owner": handle, "profile": "values/v1",
            "schema": carried_schema(), "provenance": provenance(),
        }),
    )["value"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    (handle, id)
}

fn begin(host: &mut ProfileHost, owner: u64, plan: &str, frame: Value) -> u64 {
    let response = call(
        host,
        "request.begin",
        json!({"owner": owner, "plan": plan, "frame": frame, "budgets": budgets()}),
    );
    assert_eq!(response["ok"], true, "begin failed: {response}");
    response["value"]["request"].as_u64().unwrap()
}

fn execute(host: &mut ProfileHost, request: u64, target: Value) -> Value {
    let response = call(
        host,
        "values.execute",
        json!({"request": request, "profile": "values/v1", "target": target}),
    );
    assert_eq!(response["ok"], true, "execute envelope failed: {response}");
    response["value"].clone()
}

fn dispose(host: &mut ProfileHost, request: u64) {
    let response = call(host, "request.dispose", json!({"request": request}));
    assert_eq!(response["ok"], true);
}

fn contract_target(name: &str, mode: &str) -> Value {
    json!({"kind": "contract", "name": name, "mode": mode})
}

#[test]
fn execute_create_valid_applies_trim_bounds_defaults_and_markers() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("id", fr_text("u1")),
            ("name", fr_text("  Al  ")),
            ("pick", fr_entries(vec![
                ("type", fr_text("Role")),
                ("value", fr_text("admin")),
            ])),
        ]),
    );
    let outcome = execute(&mut host, request, contract_target("User", "create"));
    assert_eq!(outcome["outcome"], "valid");
    let value = &outcome["value"];
    assert_eq!(value["t"], "entries");
    let fields: Vec<(String, &Value)> = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            let key_units: Vec<u16> = serde_json::from_value(pair[0].clone()).unwrap();
            (String::from_utf16_lossy(&key_units).to_string(), &pair[1])
        })
        .collect();
    let get = |name: &str| fields.iter().find(|(key, _)| key == name).unwrap().1;
    // Trimmed before bounds: "  Al  " stores as "Al".
    assert_eq!(get("name"), &json!({"t": "text", "units": units_of("Al")}));
    // Omitted default stays a registry reference (stable host identity).
    assert_eq!(get("role")["t"], "default-ref");
    // Omitted plain optional array stays the shared empty marker.
    assert_eq!(get("nick"), &json!({"t": "empty-array"}));
    assert_eq!(get("tags"), &json!({"t": "empty-array"}));
    // Union branch carries its resolved arm.
    assert_eq!(get("pick"), &json!({"t": "union", "arm": "Role", "value": {"t": "enum", "case": "admin"}}));
    dispose(&mut host, request);
}

#[test]
fn execute_accumulates_violations_in_order() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("zzz", fr_bool(true)),
            ("name", fr_text("waytoolongname")),
        ]),
    );
    let outcome = execute(&mut host, request, contract_target("User", "create"));
    assert_eq!(outcome["outcome"], "invalid");
    let violations = outcome["violations"].as_array().unwrap();
    // Unknown field first (entry order), then missing required in shape
    // order, then the bound failure in declaration order.
    let codes: Vec<&str> = violations
        .iter()
        .map(|violation| violation["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, vec!["unknown-field", "required", "bound"]);
    assert_eq!(violations[0]["message"], "contract User has no field \"zzz\"");
    assert_eq!(violations[1]["message"], "missing required field");
    assert_eq!(
        violations[2]["message"],
        "length 14 is above the maximum of 8"
    );
    dispose(&mut host, request);
}

#[test]
fn execute_keyed_array_duties_pass_and_fail() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    let tags = |ids: Vec<&str>| {
        fr_array(
            ids.into_iter()
                .map(|id| fr_entries(vec![("id", fr_text(id))]))
                .collect(),
        )
    };
    // Distinct ids outside excludedIds validate.
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("id", fr_text("u1")),
            ("name", fr_text("Al")),
            ("tags", tags(vec!["a", "b"])),
        ]),
    );
    let outcome = execute(&mut host, request, contract_target("User", "create"));
    assert_eq!(outcome["outcome"], "valid");
    dispose(&mut host, request);
    // A repeated id and an authored (excluded) id both violate in order.
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("id", fr_text("u1")),
            ("name", fr_text("Al")),
            ("tags", tags(vec!["a", "a", "me"])),
        ]),
    );
    let outcome = execute(&mut host, request, contract_target("User", "create"));
    assert_eq!(outcome["outcome"], "invalid");
    let messages: Vec<&str> = outcome["violations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|violation| violation["message"].as_str().unwrap())
        .collect();
    assert_eq!(
        messages,
        vec!["array repeats an id", "array id collides with an authored id"]
    );
    dispose(&mut host, request);
}

#[test]
fn execute_alias_and_union_branches() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    // Alias-nominal present value enforces declared alias bounds; the
    // union contract branch validates as a complete value.
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("id", fr_text("u1")),
            ("name", fr_text("Al")),
            ("nick", fr_text("Bob")),
            ("pick", fr_entries(vec![
                ("type", fr_text("Tag")),
                ("value", fr_entries(vec![("id", fr_text("t1"))])),
            ])),
        ]),
    );
    let outcome = execute(&mut host, request, contract_target("User", "create"));
    assert_eq!(outcome["outcome"], "valid");
    dispose(&mut host, request);
    // Over-long alias text and an undeclared arm violate in order.
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("id", fr_text("u1")),
            ("name", fr_text("Al")),
            ("nick", fr_text("toolongnick")),
            ("pick", fr_entries(vec![
                ("type", fr_text("Nope")),
                ("value", fr_entries(vec![])),
            ])),
        ]),
    );
    let outcome = execute(&mut host, request, contract_target("User", "create"));
    assert_eq!(outcome["outcome"], "invalid");
    let violations = outcome["violations"].as_array().unwrap();
    assert_eq!(violations[0]["code"], "bound");
    assert_eq!(
        violations[0]["message"],
        "length 11 is above the maximum of 6"
    );
    assert_eq!(violations[1]["code"], "type");
    assert_eq!(
        violations[1]["message"],
        "union discriminator names no declared arm"
    );
    dispose(&mut host, request);
}

#[test]
fn execute_update_omits_absent_fields() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![("name", fr_text("Bo"))]),
    );
    let outcome = execute(&mut host, request, contract_target("User", "update"));
    assert_eq!(outcome["outcome"], "valid");
    let entries = outcome["value"]["entries"].as_array().unwrap();
    let omitted = entries
        .iter()
        .find(|pair| {
            let key_units: Vec<u16> = serde_json::from_value(pair[0].clone()).unwrap();
            String::from_utf16_lossy(&key_units) == "id"
        })
        .unwrap();
    assert_eq!(omitted[1], json!({"t": "update-omitted"}));
    dispose(&mut host, request);
}

#[test]
fn execute_mutation_operation_checks_id_and_ref_versions() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    // Missing operation_id.
    let missing = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("user", fr_entries(vec![("id", fr_text("a")), ("version", fr_text("3"))])),
            ("name", fr_text("Bo")),
        ]),
    );
    let outcome = execute(
        &mut host,
        missing,
        json!({"kind": "operation", "name": "rename"}),
    );
    assert_eq!(outcome["outcome"], "invalid");
    assert_eq!(outcome["violations"][0]["code"], "required");
    assert_eq!(
        outcome["violations"][0]["message"],
        "mutation rename requires operation_id"
    );
    dispose(&mut host, missing);
    // Ref without the mutation-required version.
    let unversioned = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("operation_id", fr_text("op-1")),
            ("user", fr_entries(vec![("id", fr_text("a"))])),
            ("name", fr_text("Bo")),
        ]),
    );
    let outcome = execute(
        &mut host,
        unversioned,
        json!({"kind": "operation", "name": "rename"}),
    );
    assert_eq!(outcome["outcome"], "invalid");
    assert_eq!(outcome["violations"][0]["code"], "required");
    assert_eq!(
        outcome["violations"][0]["message"],
        "mutation input ref to Account requires an expected version"
    );
    dispose(&mut host, unversioned);
    // Complete mutation input validates with its ref shape.
    let complete = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("operation_id", fr_text("op-1")),
            ("user", fr_entries(vec![("id", fr_text("a")), ("version", fr_text("3"))])),
            ("name", fr_text("Bo")),
        ]),
    );
    let outcome = execute(
        &mut host,
        complete,
        json!({"kind": "operation", "name": "rename"}),
    );
    assert_eq!(outcome["outcome"], "valid");
    dispose(&mut host, complete);
}

#[test]
fn execute_query_operation_keeps_operation_id_unknown() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("operation_id", fr_text("op-9")),
            ("name", fr_text("Bo")),
        ]),
    );
    let outcome = execute(
        &mut host,
        request,
        json!({"kind": "operation", "name": "search"}),
    );
    assert_eq!(outcome["outcome"], "invalid");
    assert_eq!(outcome["violations"][0]["code"], "unknown-argument");
    dispose(&mut host, request);
}

#[test]
fn execute_secret_leaves_refuse_every_value() {
    let mut host = host();
    let handle = owner(&mut host);
    let id = call(
        &mut host,
        "plan.register",
        json!({
            "owner": handle, "profile": "values/v1",
            "schema": json!({
                "t": "normalized",
                "contracts": [{"name": "Vault", "fields": [
                    {"name": "key", "type_id": "secret", "base": {"t": "secret"}, "required": true},
                ]}],
                "enums": [], "operations": [],
            }),
            "provenance": provenance(),
        }),
    )["value"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let request = begin(
        &mut host,
        handle,
        &id,
        fr_entries(vec![("key", fr_text("s3cr3t"))]),
    );
    let outcome = execute(&mut host, request, contract_target("Vault", "create"));
    assert_eq!(outcome["outcome"], "invalid");
    assert_eq!(outcome["violations"][0]["code"], "type");
    assert_eq!(
        outcome["violations"][0]["message"],
        "secret values have no wire form"
    );
    dispose(&mut host, request);
}

#[test]
fn execute_exact_leaves_defer_with_their_owner() {
    let mut host = host();
    let handle = owner(&mut host);
    let id = call(
        &mut host,
        "plan.register",
        json!({
            "owner": handle, "profile": "values/v1",
            "schema": json!({
                "t": "normalized",
                "contracts": [{"name": "Counted", "fields": [
                    {"name": "n", "type_id": "int", "base": {"t": "scalar", "name": "int"}, "required": true},
                ]}],
                "enums": [], "operations": [],
            }),
            "provenance": provenance(),
        }),
    )["value"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let request = begin(
        &mut host,
        handle,
        &id,
        fr_entries(vec![("n", json!({"t": "f64", "bits": "3ff0000000000000"}))]),
    );
    let outcome = execute(&mut host, request, contract_target("Counted", "create"));
    // No false native claim: the host keeps the legacy path via
    // preselected compatibility routing for this declared deferral.
    assert_eq!(outcome["outcome"], "deferred");
    assert_eq!(outcome["reason"], "exact-codec");
    dispose(&mut host, request);
}

#[test]
fn execute_request_lifecycle_fails_closed() {
    let mut host = host();
    let (owner, plan) = register_carried(&mut host);
    // Forged handles fail at the adapter before Rust executes.
    let forged = call(
        &mut host,
        "values.execute",
        json!({"request": 999, "profile": "values/v1", "target": contract_target("User", "create")}),
    );
    assert_eq!(forged["ok"], false);
    assert_eq!(forged["stage"], "transport");
    assert_eq!(forged["code"], "request/unknown");
    // Disposed requests stay disposed.
    let request = begin(&mut host, owner, &plan, fr_entries(vec![("id", fr_text("u1"))]));
    dispose(&mut host, request);
    let stale = call(
        &mut host,
        "values.execute",
        json!({"request": request, "profile": "values/v1", "target": contract_target("User", "create")}),
    );
    assert_eq!(stale["code"], "request/unknown");
    // Retirement between begin and execute fails the fresh lookup.
    let live = begin(&mut host, owner, &plan, fr_entries(vec![("id", fr_text("u1"))]));
    call(&mut host, "owner.retire", json!({"owner": owner}));
    let retired = call(
        &mut host,
        "values.execute",
        json!({"request": live, "profile": "values/v1", "target": contract_target("User", "create")}),
    );
    assert_eq!(retired["stage"], "plan");
    assert_eq!(retired["code"], "inactive-generation");
    // Unknown targets and profile skew fail at the plan stage.
    let fresh = {
        let response = call(
            &mut host,
            "request.begin",
            json!({"owner": owner, "plan": plan, "frame": fr_entries(vec![("id", fr_text("u1"))]), "budgets": budgets()}),
        );
        // The plan id above is retired, so begin itself must fail closed.
        assert_eq!(response["ok"], false);
        assert_eq!(response["code"], "inactive-generation");
        // Re-register under the new generation for target/profile checks.
        let id = call(
            &mut host,
            "plan.register",
            json!({
                "owner": owner, "profile": "values/v1",
                "schema": carried_schema(), "provenance": provenance(),
            }),
        )["value"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        begin(&mut host, owner, &id, fr_entries(vec![("id", fr_text("u1"))]))
    };
    let unknown = call(
        &mut host,
        "values.execute",
        json!({"request": fresh, "profile": "values/v1", "target": contract_target("Nope", "create")}),
    );
    assert_eq!(unknown["stage"], "plan");
    assert_eq!(unknown["code"], "unknown-target");
    let skewed = call(
        &mut host,
        "values.execute",
        json!({"request": fresh, "profile": "http-input/v1", "target": contract_target("User", "create")}),
    );
    assert_eq!(skewed["stage"], "plan");
    assert_eq!(skewed["code"], "invalid-profile");
    dispose(&mut host, fresh);
    dispose(&mut host, live);
}
