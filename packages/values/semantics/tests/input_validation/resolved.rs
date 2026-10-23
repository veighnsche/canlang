//! Resolved-leaf join vectors: deferred pointers, admitted exact
//! leaves (valid and ordered-invalid), operation targets, honest
//! passthrough of unresolvable deferrals, and fail-closed refusals.

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

fn units_of(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn fr_text(text: &str) -> Value {
    json!({"t": "text", "units": units_of(text)})
}

fn fr_entries(pairs: Vec<(&str, Value)>) -> Value {
    json!({"t": "entries", "entries": pairs.into_iter().map(|(key, value)| json!([units_of(key), value])).collect::<Vec<_>>()})
}

fn fr_array(items: Vec<Value>) -> Value {
    json!({"t": "array", "items": items})
}

fn seg_key(name: &str) -> Value {
    json!({"k": units_of(name)})
}

fn money_frame(minor: &str, currency: &str) -> Value {
    fr_entries(vec![("minor", fr_text(minor)), ("currency", fr_text(currency))])
}

fn money_input(minor: &str, currency: &str) -> Value {
    money_frame(minor, currency)
}

fn exact_field(name: &str, scalar: &str, required: bool) -> Value {
    json!({
        "name": name, "type_id": scalar,
        "base": {"t": "scalar", "name": scalar},
        "required": required,
    })
}

fn invoice_schema() -> Value {
    json!({
        "t": "normalized",
        "contracts": [
            {"name": "Invoice", "fields": [
                exact_field("amount", "money", true),
                exact_field("qty", "int", true),
                exact_field("rate", "decimal", true),
                exact_field("day", "date", true),
                {"name": "note", "type_id": "text", "base": {"t": "scalar", "name": "text"},
                 "required": true, "length_max": 5.0},
            ]},
        ],
        "enums": [],
        "operations": [],
    })
}

fn register(host: &mut ProfileHost, schema: Value) -> (u64, String) {
    let handle = owner(host);
    let id = call(
        host,
        "plan.register",
        json!({"owner": handle, "profile": "values/v1", "schema": schema, "provenance": provenance()}),
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

fn execute(host: &mut ProfileHost, request: u64, target: Value, resolved: Value) -> Value {
    let mut args = json!({"request": request, "profile": "values/v1", "target": target});
    if !resolved.is_null() {
        args["resolved"] = resolved;
    }
    call(host, "values.execute", args)["value"].clone()
}

fn fail_envelope(host: &mut ProfileHost, request: u64, target: Value, resolved: Value) -> Value {
    let mut args = json!({"request": request, "profile": "values/v1", "target": target});
    if !resolved.is_null() {
        args["resolved"] = resolved;
    }
    call(host, "values.execute", args)
}

fn dispose(host: &mut ProfileHost, request: u64) {
    let response = call(host, "request.dispose", json!({"request": request}));
    assert_eq!(response["ok"], true);
}

fn value_entry(name: &str, frame: Value) -> Value {
    json!({"path": [seg_key(name)], "frame": frame})
}

fn poison_entry(name: &str, code: &str, message: &str) -> Value {
    json!({"path": [seg_key(name)], "violations": [
        {"path": [], "code": code, "message": message,
         "expected": "canonical minor", "actual": "\"xx\""},
    ]})
}

fn valid_invoice_frame() -> Value {
    fr_entries(vec![
        ("amount", money_input("100", "USD")),
        ("qty", fr_text("5")),
        ("rate", fr_text("1.50")),
        ("day", fr_text("2024-02-29")),
        ("note", fr_text("ok")),
    ])
}

fn valid_invoice_resolved() -> Value {
    json!([
        value_entry("amount", money_frame("100", "USD")),
        value_entry("qty", fr_text("5")),
        value_entry("rate", fr_text("1.5")),
        value_entry("day", fr_text("2024-02-29")),
    ])
}

fn contract_target(name: &str, mode: &str) -> Value {
    json!({"kind": "contract", "name": name, "mode": mode})
}

#[test]
fn deferred_exact_gap_carries_leaf_and_path() {
    let mut host = host();
    let (owner, plan) = register(&mut host, invoice_schema());
    let request = begin(&mut host, owner, &plan, valid_invoice_frame());
    let outcome = execute(
        &mut host,
        request,
        contract_target("Invoice", "create"),
        Value::Null,
    );
    assert_eq!(outcome["outcome"], "deferred");
    assert_eq!(outcome["reason"], "exact-codec");
    assert_eq!(
        outcome["detail"],
        "target reaches a leaf owned by exact-codec at contracts.Invoice.fields.amount"
    );
    assert_eq!(outcome["leaf"], "money");
    assert_eq!(outcome["path"], json!([seg_key("amount")]));
    dispose(&mut host, request);
}

#[test]
fn admitted_exact_leaves_validate_end_to_end() {
    let mut host = host();
    let (owner, plan) = register(&mut host, invoice_schema());
    let request = begin(&mut host, owner, &plan, valid_invoice_frame());
    let outcome = execute(
        &mut host,
        request,
        contract_target("Invoice", "create"),
        valid_invoice_resolved(),
    );
    assert_eq!(outcome["outcome"], "valid", "outcome: {outcome}");
    let value = &outcome["value"];
    assert_eq!(value["t"], "entries");
    let fields: Vec<(String, &Value)> = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            let key_units: Vec<u16> = serde_json::from_value(pair[0].clone()).unwrap();
            (
                String::from_utf16_lossy(&key_units).to_string(),
                &pair[1],
            )
        })
        .collect();
    let get = |name: &str| fields.iter().find(|(key, _)| key == name).unwrap().1;
    // Canonical frames ride opaquely: the host-decoded "1.50" stores as "1.5".
    assert_eq!(
        get("amount"),
        &json!({"t": "exact", "kind": "money", "value": money_frame("100", "USD")})
    );
    assert_eq!(
        get("qty"),
        &json!({"t": "exact", "kind": "int", "value": fr_text("5")})
    );
    assert_eq!(
        get("rate"),
        &json!({"t": "exact", "kind": "decimal", "value": fr_text("1.5")})
    );
    assert_eq!(
        get("day"),
        &json!({"t": "exact", "kind": "date", "value": fr_text("2024-02-29")})
    );
    assert_eq!(get("note"), &json!({"t": "text", "units": units_of("ok")}));
    dispose(&mut host, request);
}

#[test]
fn replayed_violations_accumulate_in_field_order() {
    let mut host = host();
    let (owner, plan) = register(&mut host, invoice_schema());
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("amount", money_input("xx", "USD")),
            ("qty", fr_text("zz")),
            ("rate", fr_text("1.5")),
            ("day", fr_text("2024-02-29")),
            ("note", fr_text("waytoolong")),
        ]),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Invoice", "create"),
        json!([
            poison_entry("amount", "format", "money minor is malformed"),
            poison_entry("qty", "format", "int is malformed"),
            value_entry("rate", fr_text("1.5")),
            value_entry("day", fr_text("2024-02-29")),
        ]),
    );
    assert_eq!(outcome["outcome"], "invalid", "outcome: {outcome}");
    let violations = outcome["violations"].as_array().unwrap();
    // Host replays land at their leaf positions, ahead of the native
    // text bound on the later field.
    let codes: Vec<&str> = violations
        .iter()
        .map(|violation| violation["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, vec!["format", "format", "bound"]);
    let paths: Vec<Value> = violations
        .iter()
        .map(|violation| violation["path"].clone())
        .collect();
    assert_eq!(
        paths,
        vec![
            json!([seg_key("amount")]),
            json!([seg_key("qty")]),
            json!([seg_key("note")]),
        ]
    );
    assert_eq!(violations[0]["message"], "money minor is malformed");
    assert_eq!(violations[0]["expected"], "canonical minor");
    assert_eq!(violations[0]["actual"], "\"xx\"");
    dispose(&mut host, request);
}

#[test]
fn operation_target_admits_exact_inputs() {
    let mut host = host();
    let (owner, plan) = register(
        &mut host,
        json!({
            "t": "normalized",
            "contracts": [],
            "enums": [],
            "operations": [
                {"name": "Shop.Refund", "mutation": true, "inputs": [
                    exact_field("amount", "money", true),
                    {"name": "note", "type_id": "text",
                     "base": {"t": "scalar", "name": "text"}, "required": false},
                ]},
            ],
        }),
    );
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("amount", money_input("25", "EUR")),
            ("operation_id", fr_text("op-1")),
        ]),
    );
    let outcome = execute(
        &mut host,
        request,
        json!({"kind": "operation", "name": "Shop.Refund"}),
        json!([value_entry("amount", money_frame("25", "EUR"))]),
    );
    assert_eq!(outcome["outcome"], "valid", "outcome: {outcome}");
    dispose(&mut host, request);
}

#[test]
fn wire_codec_deferral_passes_through_without_pointer() {
    let mut host = host();
    let (owner, plan) = register(
        &mut host,
        json!({
            "t": "normalized",
            "contracts": [
                {"name": "Team", "fields": [
                    {"name": "owner", "type_id": "user",
                     "base": {"t": "user"}, "required": true},
                ]},
            ],
            "enums": [],
            "operations": [],
        }),
    );
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![("owner", fr_text("u1"))]),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Team", "create"),
        Value::Null,
    );
    assert_eq!(outcome["outcome"], "deferred");
    assert_eq!(outcome["reason"], "wire-codec");
    assert!(outcome.get("leaf").is_none(), "outcome: {outcome}");
    assert!(outcome.get("path").is_none(), "outcome: {outcome}");
    dispose(&mut host, request);
}

#[test]
fn union_arm_exact_gap_carries_no_pointer() {
    let mut host = host();
    let (owner, plan) = register(
        &mut host,
        json!({
            "t": "normalized",
            "contracts": [
                {"name": "Pick", "fields": [
                    {"name": "choice", "type_id": "int|text",
                     "base": {"t": "union", "arms": ["int", "text"]}, "required": true},
                ]},
            ],
            "enums": [],
            "operations": [],
        }),
    );
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![(
            "choice",
            fr_entries(vec![
                ("type", fr_text("int")),
                ("value", fr_text("5")),
            ]),
        )]),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Pick", "create"),
        Value::Null,
    );
    assert_eq!(outcome["outcome"], "deferred");
    assert_eq!(outcome["reason"], "exact-codec");
    assert!(outcome.get("leaf").is_none(), "outcome: {outcome}");
    assert!(outcome.get("path").is_none(), "outcome: {outcome}");
    dispose(&mut host, request);
}

#[test]
fn duplicate_paths_fail_closed() {
    let mut host = host();
    let (owner, plan) = register(&mut host, invoice_schema());
    let request = begin(&mut host, owner, &plan, valid_invoice_frame());
    let response = fail_envelope(
        &mut host,
        request,
        contract_target("Invoice", "create"),
        json!([value_entry("qty", fr_text("5")), value_entry("qty", fr_text("5"))]),
    );
    assert_eq!(response["ok"], false);
    assert_eq!(response["stage"], "transport");
    assert_eq!(response["code"], "args/malformed");
    dispose(&mut host, request);
}

#[test]
fn shape_and_scope_mismatches_fail_closed() {
    let mut host = host();
    let (owner, plan) = register(&mut host, invoice_schema());
    // Array frame for a scalar int leaf.
    let first = begin(&mut host, owner, &plan, valid_invoice_frame());
    let response = fail_envelope(
        &mut host,
        first,
        contract_target("Invoice", "create"),
        json!([value_entry("qty", fr_array(vec![fr_text("5")]))]),
    );
    assert_eq!((response["ok"].clone(), response["code"].clone()), (json!(false), json!("args/malformed")));
    dispose(&mut host, first);
    // Text leaf path (native text, never coverable).
    let second = begin(&mut host, owner, &plan, valid_invoice_frame());
    let response = fail_envelope(
        &mut host,
        second,
        contract_target("Invoice", "create"),
        json!([value_entry("note", fr_text("ok"))]),
    );
    assert_eq!((response["ok"].clone(), response["code"].clone()), (json!(false), json!("args/malformed")));
    dispose(&mut host, second);
    // Frame plus violations on one entry.
    let third = begin(&mut host, owner, &plan, valid_invoice_frame());
    let mut both = value_entry("qty", fr_text("5"));
    both["violations"] = poison_entry("qty", "format", "int is malformed")["violations"].clone();
    let response = fail_envelope(
        &mut host,
        third,
        contract_target("Invoice", "create"),
        json!([both]),
    );
    assert_eq!((response["ok"].clone(), response["code"].clone()), (json!(false), json!("args/malformed")));
    dispose(&mut host, third);
    // Value entry for an absent field.
    let fourth = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("amount", money_input("100", "USD")),
            ("qty", fr_text("5")),
            ("rate", fr_text("1.5")),
            ("note", fr_text("ok")),
        ]),
    );
    let response = fail_envelope(
        &mut host,
        fourth,
        contract_target("Invoice", "create"),
        json!([value_entry("day", fr_text("2024-02-29"))]),
    );
    assert_eq!((response["ok"].clone(), response["code"].clone()), (json!(false), json!("args/malformed")));
    dispose(&mut host, fourth);
}

#[test]
fn native_decides_markers_for_absent_and_null() {
    let mut host = host();
    let (owner, plan) = register(
        &mut host,
        json!({
            "t": "normalized",
            "contracts": [
                {"name": "Maybe", "fields": [
                    exact_field("nick", "int", false),
                    {"name": "tip", "type_id": "money", "base": {"t": "scalar", "name": "money"},
                     "required": false, "nullable": true},
                ]},
            ],
            "enums": [],
            "operations": [],
        }),
    );
    // Omitted optional int: the marker covers the plan gap, omission
    // keeps the existing implicit-empty semantics.
    let first = begin(&mut host, owner, &plan, fr_entries(vec![]));
    let outcome = execute(
        &mut host,
        first,
        contract_target("Maybe", "create"),
        json!([
            {"path": [seg_key("nick")]},
            {"path": [seg_key("tip")]},
        ]),
    );
    assert_eq!(outcome["outcome"], "valid", "outcome: {outcome}");
    dispose(&mut host, first);
    // Explicit null on a nullable exact leaf validates natively.
    let second = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("nick", fr_text("7")),
            ("tip", json!({"t": "null"})),
        ]),
    );
    let outcome = execute(
        &mut host,
        second,
        contract_target("Maybe", "create"),
        json!([
            value_entry("nick", fr_text("7")),
            {"path": [seg_key("tip")]},
        ]),
    );
    assert_eq!(outcome["outcome"], "valid", "outcome: {outcome}");
    dispose(&mut host, second);
}

#[test]
fn array_of_exact_consumes_opaquely() {
    let mut host = host();
    let (owner, plan) = register(
        &mut host,
        json!({
            "t": "normalized",
            "contracts": [
                {"name": "Batch", "fields": [
                    {"name": "tags", "type_id": "int[]",
                     "base": {"t": "scalar", "name": "int"},
                     "required": true, "array": true},
                ]},
            ],
            "enums": [],
            "operations": [],
        }),
    );
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![("tags", fr_array(vec![fr_text("1"), fr_text("2")]))]),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Batch", "create"),
        json!([value_entry(
            "tags",
            fr_array(vec![fr_text("1"), fr_text("2")])
        )]),
    );
    assert_eq!(outcome["outcome"], "valid", "outcome: {outcome}");
    let value = &outcome["value"];
    assert_eq!(
        value["entries"][0][1],
        json!({"t": "exact", "kind": "int",
               "value": fr_array(vec![fr_text("1"), fr_text("2")])})
    );
    dispose(&mut host, request);
}

fn bounded_schema() -> Value {
    json!({
        "t": "normalized",
        "contracts": [
            {"name": "Bounds", "fields": [
                {"name": "x", "type_id": "int",
                 "base": {"t": "scalar", "name": "int"},
                 "required": true,
                 "value_min": {"t": "bigint", "digits": "10"}},
                {"name": "tags", "type_id": "int[]",
                 "base": {"t": "scalar", "name": "int"},
                 "required": true, "array": true, "length_max": 1.0},
            ]},
        ],
        "enums": [],
        "operations": [],
    })
}

fn bounded_frame(x: Value, tags: Value) -> Value {
    fr_entries(vec![("x", x), ("tags", tags)])
}

fn bounded_resolved(x: Value, tags: Value) -> Value {
    json!([value_entry("x", x), value_entry("tags", tags)])
}

#[test]
fn deferred_pointer_carries_declared_array_shape() {
    // The host shape check needs the declared array shape up front:
    // scalar and array leaves advertise it on the pointer.
    let mut host = host();
    let (owner, plan) = register(&mut host, bounded_schema());
    let request = begin(&mut host, owner, &plan, bounded_frame(fr_text("1"), fr_array(vec![fr_text("1")])));
    let outcome = execute(&mut host, request, contract_target("Bounds", "create"), Value::Null);
    assert_eq!(outcome["outcome"], "deferred");
    assert_eq!(outcome["leaf"], "int");
    assert_eq!(outcome["array"], false);
    dispose(&mut host, request);
    let array_schema = json!({
        "t": "normalized",
        "contracts": [
            {"name": "OnlyTags", "fields": [
                {"name": "tags", "type_id": "int[]",
                 "base": {"t": "scalar", "name": "int"},
                 "required": true, "array": true, "length_max": 1.0},
            ]},
        ],
        "enums": [],
        "operations": [],
    });
    let (owner, plan) = register(&mut host, array_schema);
    let request = begin(&mut host, owner, &plan, fr_entries(vec![("tags", fr_text("1"))]));
    let outcome = execute(&mut host, request, contract_target("OnlyTags", "create"), Value::Null);
    assert_eq!(outcome["outcome"], "deferred");
    assert_eq!(outcome["leaf"], "int");
    assert_eq!(outcome["array"], true);
    dispose(&mut host, request);
}

#[test]
fn int_value_min_rejects_below_minimum_through_resolved_carrier() {
    // VALIDATION-012 B: `value_min` 10 refuses canonical `1` with the
    // original bound voice, while the resolved `Exact` carrier stays.
    let mut host = host();
    let (owner, plan) = register(&mut host, bounded_schema());
    let request = begin(
        &mut host,
        owner,
        &plan,
        bounded_frame(fr_text("1"), fr_array(vec![fr_text("1")])),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Bounds", "create"),
        bounded_resolved(fr_text("1"), fr_array(vec![fr_text("1")])),
    );
    assert_eq!(outcome["outcome"], "invalid", "outcome: {outcome}");
    let violations = outcome["violations"].as_array().unwrap();
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0]["path"], json!([seg_key("x")]));
    assert_eq!(violations[0]["code"], "bound");
    assert_eq!(violations[0]["message"], "value is below the minimum");
    assert_eq!(violations[0]["expected"], json!(">= \"10\""));
    assert_eq!(violations[0]["actual"], json!("\"1\""));
    dispose(&mut host, request);
    // At the minimum the same join validates with its carrier intact.
    let request = begin(
        &mut host,
        owner,
        &plan,
        bounded_frame(fr_text("10"), fr_array(vec![fr_text("1")])),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Bounds", "create"),
        bounded_resolved(fr_text("10"), fr_array(vec![fr_text("1")])),
    );
    assert_eq!(outcome["outcome"], "valid", "outcome: {outcome}");
    assert_eq!(
        outcome["value"]["entries"][0][1],
        json!({"t": "exact", "kind": "int", "value": fr_text("10")})
    );
    dispose(&mut host, request);
}

#[test]
fn int_array_length_max_rejects_overlong_through_resolved_carrier() {
    // VALIDATION-012 B: `length_max` 1 refuses two admitted elements
    // with the original length voice.
    let mut host = host();
    let (owner, plan) = register(&mut host, bounded_schema());
    let request = begin(
        &mut host,
        owner,
        &plan,
        bounded_frame(fr_text("10"), fr_array(vec![fr_text("1"), fr_text("2")])),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Bounds", "create"),
        bounded_resolved(fr_text("10"), fr_array(vec![fr_text("1"), fr_text("2")])),
    );
    assert_eq!(outcome["outcome"], "invalid", "outcome: {outcome}");
    let violations = outcome["violations"].as_array().unwrap();
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0]["path"], json!([seg_key("tags")]));
    assert_eq!(violations[0]["code"], "bound");
    assert_eq!(
        violations[0]["message"],
        json!("length 2 is above the maximum of 1")
    );
    dispose(&mut host, request);
}

#[test]
fn scalar_array_skew_on_canonical_frames_records_type_not_malformed() {
    // VALIDATION-012 B: a frame-carrying entry whose wire shape misses
    // the declared shape records the leaf type verdict (invalid) at
    // execution instead of failing admission as malformed.
    let mut host = host();
    let (owner, plan) = register(&mut host, bounded_schema());
    // Array wire for the scalar `x`, with a canonical frame attached.
    let request = begin(
        &mut host,
        owner,
        &plan,
        bounded_frame(fr_array(vec![fr_text("1")]), fr_array(vec![fr_text("1")])),
    );
    // Direct admission of a skewed frame stays fail-closed (see
    // `shape_and_scope_mismatches_fail_closed`): the execution path
    // opens through the host shape join, which replays the genuine
    // leaf verdict as violations. Drive that replay here.
    let outcome = execute(
        &mut host,
        request,
        contract_target("Bounds", "create"),
        json!([
            {"path": [seg_key("x")], "violations": [
                {"path": [], "code": "type",
                 "message": "int has the wrong wire type",
                 "expected": "canonical int64 decimal string",
                 "actual": "array of length 1"},
            ]},
            value_entry("tags", fr_array(vec![fr_text("1")])),
        ]),
    );
    assert_eq!(outcome["outcome"], "invalid", "outcome: {outcome}");
    let violations = outcome["violations"].as_array().unwrap();
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0]["path"], json!([seg_key("x")]));
    assert_eq!(violations[0]["code"], "type");
    dispose(&mut host, request);
    // Scalar wire for the array `tags` replays the array shape verdict.
    let request = begin(
        &mut host,
        owner,
        &plan,
        bounded_frame(fr_text("10"), fr_text("1")),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("Bounds", "create"),
        json!([
            value_entry("x", fr_text("10")),
            {"path": [seg_key("tags")], "violations": [
                {"path": [], "code": "type",
                 "message": "expected an array",
                 "expected": "int[]",
                 "actual": "\"1\""},
            ]},
        ]),
    );
    assert_eq!(outcome["outcome"], "invalid", "outcome: {outcome}");
    let violations = outcome["violations"].as_array().unwrap();
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0]["path"], json!([seg_key("tags")]));
    assert_eq!(violations[0]["code"], "type");
    dispose(&mut host, request);
}

// Bound metadata is the copied native CanValue, while resolved frames are the
// owning codec's wire representation. These two transports must not be confused.
fn bound_object(entries: Vec<(&str, Value)>) -> Value {
    json!({"t":"object","entries":entries.into_iter().map(|(name,value)|json!([name,value])).collect::<Vec<_>>()})
}
fn bound_bigint(digits: &str) -> Value {
    json!({"t":"bigint","digits":digits})
}
fn bound_number(value: f64) -> Value {
    json!({"t":"bits","bits":format!("{:016x}",value.to_bits())})
}
fn bound_decimal(coef: &str, scale: f64) -> Value {
    bound_object(vec![
        ("kind", fr_text("decimal")),
        ("coef", bound_bigint(coef)),
        ("scale", bound_number(scale)),
    ])
}
fn bound_money(minor: &str, currency: &str) -> Value {
    bound_object(vec![
        ("kind", fr_text("money")),
        ("minor", bound_bigint(minor)),
        ("currency", fr_text(currency)),
    ])
}
fn bound_date(year: f64, month: f64, day: f64) -> Value {
    bound_object(vec![
        ("kind", fr_text("date")),
        ("year", bound_number(year)),
        ("month", bound_number(month)),
        ("day", bound_number(day)),
    ])
}
fn bound_datetime(ms: &str) -> Value {
    bound_object(vec![
        ("kind", fr_text("datetime")),
        ("ms", bound_bigint(ms)),
    ])
}
fn exact_bounds_schema(fields: Vec<Value>) -> Value {
    json!({"t":"normalized","contracts":[{"name":"ExactBounds","fields":fields}],"enums":[],"operations":[]})
}
fn bounded_exact_field(name: &str, kind: &str, min: Value, max: Value) -> Value {
    let mut field = exact_field(name, kind, true);
    field["value_min"] = min;
    field["value_max"] = max;
    field
}
fn release_bounds_plan(host: &mut ProfileHost, owner: u64, plan: &str) {
    assert_eq!(
        call(host, "plan.release", json!({"owner":owner,"id":plan}))["ok"],
        true
    );
    assert_eq!(
        call(host, "owner.retire", json!({"owner":owner}))["ok"],
        true
    );
}
fn bound_violation(name: &str, side: &str, bound: &str, actual: &str) -> Value {
    json!({"path":[seg_key(name)],"code":"bound",
        "message":if side=="min" {"value is below the minimum"} else {"value is above the maximum"},
        "expected":format!("{} {bound}",if side=="min" {">="} else {"<="}),"actual":actual})
}

#[test]
fn all_exact_scalar_bounds_are_inclusive_and_preserve_codec_diagnostics() {
    // Expected strings are the public TS checkBounds/encodeValue voices, not
    // observations calculated by the production native bound implementation.
    let cases = vec![
        (
            "int",
            bound_bigint("-10"),
            bound_bigint("10"),
            vec![
                (fr_text("-10"), None),
                (fr_text("10"), None),
                (fr_text("-11"), Some(("min", "\"-10\"", "\"-11\""))),
                (fr_text("11"), Some(("max", "\"10\"", "\"11\""))),
            ],
        ),
        (
            "duration",
            bound_bigint("-10"),
            bound_bigint("10"),
            vec![
                (fr_text("-10"), None),
                (fr_text("10"), None),
                (fr_text("-11"), Some(("min", "\"-10\"", "\"-11\""))),
                (fr_text("11"), Some(("max", "\"10\"", "\"11\""))),
            ],
        ),
        (
            "decimal",
            bound_decimal("150", 2.0),
            bound_decimal("250", 2.0),
            vec![
                (fr_text("1.5"), None),
                (fr_text("2.5"), None),
                (fr_text("1.49"), Some(("min", "\"1.5\"", "\"1.49\""))),
                (fr_text("2.51"), Some(("max", "\"2.5\"", "\"2.51\""))),
            ],
        ),
        (
            "decimal",
            bound_decimal("12345678901234567890123456789012345678", 1.0),
            bound_decimal("12345678901234567890123456789012345678", 1.0),
            vec![
                (fr_text("1234567890123456789012345678901234567.8"), None),
                (
                    fr_text("1234567890123456789012345678901234567.7"),
                    Some((
                        "min",
                        "\"1234567890123456789012345678901234567.8\"",
                        "\"1234567890123456789012345678901234567.7\"",
                    )),
                ),
                (
                    fr_text("1234567890123456789012345678901234567.9"),
                    Some((
                        "max",
                        "\"1234567890123456789012345678901234567.8\"",
                        "\"1234567890123456789012345678901234567.9\"",
                    )),
                ),
            ],
        ),
        (
            "money",
            bound_money("10", "USD"),
            bound_money("20", "USD"),
            vec![
                (money_frame("10", "USD"), None),
                (money_frame("20", "USD"), None),
                (
                    money_frame("9", "USD"),
                    Some((
                        "min",
                        "{\"minor\":\"10\",\"currency\":\"USD\"}",
                        "{\"minor\":\"9\",\"currency\":\"USD\"}",
                    )),
                ),
                (
                    money_frame("21", "USD"),
                    Some((
                        "max",
                        "{\"minor\":\"20\",\"currency\":\"USD\"}",
                        "{\"minor\":\"21\",\"currency\":\"USD\"}",
                    )),
                ),
            ],
        ),
        (
            "date",
            bound_date(2024.0, 2.0, 29.0),
            bound_date(2024.0, 3.0, 1.0),
            vec![
                (fr_text("2024-02-29"), None),
                (fr_text("2024-03-01"), None),
                (
                    fr_text("2024-02-28"),
                    Some(("min", "\"2024-02-29\"", "\"2024-02-28\"")),
                ),
                (
                    fr_text("2024-03-02"),
                    Some(("max", "\"2024-03-01\"", "\"2024-03-02\"")),
                ),
            ],
        ),
        (
            "datetime",
            bound_datetime("1709164800000"),
            bound_datetime("1709164801000"),
            vec![
                (fr_text("2024-02-29T00:00:00.000Z"), None),
                (fr_text("2024-02-29T00:00:01.000Z"), None),
                (
                    fr_text("2024-02-28T23:59:59.999Z"),
                    Some((
                        "min",
                        "\"2024-02-29T00:00:00.000Z\"",
                        "\"2024-02-28T23:59:59.999Z\"",
                    )),
                ),
                (
                    fr_text("2024-02-29T00:00:01.001Z"),
                    Some((
                        "max",
                        "\"2024-02-29T00:00:01.000Z\"",
                        "\"2024-02-29T00:00:01.001Z\"",
                    )),
                ),
            ],
        ),
    ];
    for (kind, min, max, rows) in cases {
        let mut host = host();
        let (owner, plan) = register(
            &mut host,
            exact_bounds_schema(vec![bounded_exact_field("x", kind, min, max)]),
        );
        for (frame, expected) in rows {
            let request = begin(
                &mut host,
                owner,
                &plan,
                fr_entries(vec![("x", frame.clone())]),
            );
            let outcome = execute(
                &mut host,
                request,
                contract_target("ExactBounds", "create"),
                json!([value_entry("x", frame.clone())]),
            );
            if let Some((side, bound, actual)) = expected {
                assert_eq!(outcome["outcome"], "invalid", "{kind}: {outcome}");
                assert_eq!(
                    outcome["violations"],
                    json!([bound_violation("x", side, bound, actual)]),
                    "{kind}: {outcome}"
                );
            } else {
                assert_eq!(outcome["outcome"], "valid", "{kind}: {outcome}");
                assert_eq!(
                    outcome["value"]["entries"][0][1],
                    json!({"t":"exact","kind":kind,"value":frame})
                );
            }
            dispose(&mut host, request);
        }
        release_bounds_plan(&mut host, owner, &plan);
    }
}

#[test]
fn currency_mismatch_and_later_bounds_keep_field_and_min_max_order() {
    let mut host = host();
    let (owner, plan) = register(
        &mut host,
        exact_bounds_schema(vec![
            bounded_exact_field(
                "amount",
                "money",
                bound_money("10", "USD"),
                bound_money("20", "USD"),
            ),
            bounded_exact_field(
                "rate",
                "decimal",
                bound_decimal("150", 2.0),
                bound_decimal("250", 2.0),
            ),
        ]),
    );
    let frame = fr_entries(vec![
        ("amount", money_frame("15", "EUR")),
        ("rate", fr_text("3")),
    ]);
    let request = begin(&mut host, owner, &plan, frame);
    let outcome = execute(
        &mut host,
        request,
        contract_target("ExactBounds", "create"),
        json!([
            value_entry("amount", money_frame("15", "EUR")),
            value_entry("rate", fr_text("3"))
        ]),
    );
    assert_eq!(outcome["outcome"], "invalid", "{outcome}");
    let mismatch = json!({"path":[seg_key("amount")],"code":"bound","message":"money bound needs a matching currency",
        "expected":"currency USD","actual":"{\"minor\":\"15\",\"currency\":\"EUR\"}"});
    assert_eq!(
        outcome["violations"],
        json!([
            mismatch.clone(),
            mismatch,
            bound_violation("rate", "max", "\"2.5\"", "\"3\"")
        ])
    );
    dispose(&mut host, request);
    // A supplied host decode refusal replays in place; no bound checks on that
    // failed leaf, and the later successfully decoded field still checks max.
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("amount", money_frame("xx", "USD")),
            ("rate", fr_text("3")),
        ]),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("ExactBounds", "create"),
        json!([
            poison_entry("amount", "format", "money minor is malformed"),
            value_entry("rate", fr_text("3"))
        ]),
    );
    assert_eq!(
        outcome["violations"],
        json!([
        {"path":[seg_key("amount")],"code":"format","message":"money minor is malformed","expected":"canonical minor","actual":"\"xx\""},
        bound_violation("rate","max","\"2.5\"","\"3\"")])
    );
    dispose(&mut host, request);
    release_bounds_plan(&mut host, owner, &plan);
}

#[test]
fn exact_bounds_do_not_replace_nullable_omission_update_or_array_length_duties() {
    let mut host = host();
    let mut optional = bounded_exact_field(
        "maybe",
        "decimal",
        bound_decimal("10", 0.0),
        bound_decimal("20", 0.0),
    );
    optional["required"] = json!(false);
    optional["nullable"] = json!(true);
    optional["type_id"] = json!("decimal?");
    let mut array = exact_field("batch", "decimal", false);
    array["array"] = json!(true);
    array["type_id"] = json!("decimal[]");
    array["length_max"] = json!(1.0);
    let (owner, plan) = register(&mut host, exact_bounds_schema(vec![optional, array]));
    for mode in ["create", "update"] {
        let request = begin(&mut host, owner, &plan, fr_entries(vec![]));
        let outcome = execute(
            &mut host,
            request,
            contract_target("ExactBounds", mode),
            json!([
            {"path":[seg_key("maybe")]},{"path":[seg_key("batch")]}]),
        );
        assert_eq!(outcome["outcome"], "valid", "{mode}: {outcome}");
        dispose(&mut host, request);
    }
    let request = begin(
        &mut host,
        owner,
        &plan,
        fr_entries(vec![
            ("maybe", json!({"t":"null"})),
            ("batch", fr_array(vec![fr_text("100"), fr_text("200")])),
        ]),
    );
    let outcome = execute(
        &mut host,
        request,
        contract_target("ExactBounds", "create"),
        json!([
        {"path":[seg_key("maybe")]},value_entry("batch",fr_array(vec![fr_text("100"),fr_text("200")]))]),
    );
    assert_eq!(outcome["outcome"], "invalid", "{outcome}");
    assert_eq!(
        outcome["violations"],
        json!([{"path":[seg_key("batch")],"code":"bound","message":"length 2 is above the maximum of 1","expected":"length <= 1","actual":"length 2"}])
    );
    dispose(&mut host, request);
    release_bounds_plan(&mut host, owner, &plan);
}

#[test]
fn malformed_exact_bounds_or_resolved_scalars_refuse_explicitly() {
    for (kind, min, frame) in [
        ("decimal", fr_text("not a native Decimal"), fr_text("2")),
        ("date", bound_date(2024.0, 2.0, 30.0), fr_text("2024-03-01")),
        ("money", bound_bigint("1"), money_frame("2", "USD")),
        (
            "decimal",
            bound_decimal("1", 0.0),
            fr_text("not a canonical decimal"),
        ),
    ] {
        let mut host = host();
        let mut field = exact_field("x", kind, true);
        field["value_min"] = min;
        let (owner, plan) = register(&mut host, exact_bounds_schema(vec![field]));
        let request = begin(
            &mut host,
            owner,
            &plan,
            fr_entries(vec![("x", frame.clone())]),
        );
        let outcome = execute(
            &mut host,
            request,
            contract_target("ExactBounds", "create"),
            json!([value_entry("x", frame)]),
        );
        assert_eq!(outcome["outcome"], "deferred", "{kind}: {outcome}");
        assert!(
            outcome.get("leaf").is_none() && outcome.get("path").is_none(),
            "no repeated codec-resolution loop: {outcome}"
        );
        assert!(outcome["detail"]
            .as_str()
            .is_some_and(|detail| !detail.is_empty()));
        dispose(&mut host, request);
        release_bounds_plan(&mut host, owner, &plan);
    }
}
