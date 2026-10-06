//! Deploy-plan differential (P06.1): every vector ran through the
//! real `buildDeployPlan`. Inputs are real `encodeAdmittedTreeJson`
//! outputs (decoded via the P03.2 path); expected plans compare as
//! values AND as ordered key walks (P06.2 renders from insertion
//! order). Refusal messages are byte-exact; the three V8-unstable
//! throws assert outcome-class only (TS threw) while native pins the
//! loader-voice message. Regenerate with `bun /tmp/p061-vectors.ts`
//! plus this emitter.
use can_preparation::input::{decode_tree, Node};
use can_preparation::plan::build_deploy_plan;

/// Test-only Node -> JSON value (P06.2 owns the exact renderer).
/// Numbers re-parse their canonical spellings, exactly as a JSON
/// round-trip of the TS plan would.
fn node_to_value(node: &Node) -> serde_json::Value {
    match node {
        Node::Null => serde_json::Value::Null,
        Node::Bool(v) => serde_json::Value::Bool(*v),
        Node::Num { spelling, .. } => {
            serde_json::from_str(spelling).unwrap_or(serde_json::Value::Null)
        }
        Node::Text(units) => serde_json::Value::String(String::from_utf16_lossy(units)),
        Node::Arr(items) => serde_json::Value::Array(items.iter().map(node_to_value).collect()),
        Node::Obj(entries) => {
            let mut map = serde_json::Map::new();
            for (key, value) in entries {
                map.insert(String::from_utf16_lossy(key), node_to_value(value));
            }
            serde_json::Value::Object(map)
        }
    }
}

/// Test-only ordered key walk: (path, keys) per object, (#len) per array.
fn walk(node: &Node, path: String, out: &mut Vec<(String, Vec<String>)>) {
    match node {
        Node::Obj(entries) => {
            let keys = entries
                .iter()
                .map(|(k, _)| String::from_utf16_lossy(k))
                .collect::<Vec<_>>();
            out.push((path.clone(), keys));
            for (key, value) in entries {
                let key = String::from_utf16_lossy(key);
                let child = if path == "$" {
                    format!("$.{key}")
                } else {
                    format!("{path}.{key}")
                };
                walk(value, child, out);
            }
        }
        Node::Arr(items) => {
            out.push((path.clone(), vec![format!("#{}", items.len())]));
            for (i, item) in items.iter().enumerate() {
                walk(item, format!("{path}[{i}]"), out);
            }
        }
        _ => {}
    }
}

struct Case {
    id: &'static str,
    descriptor: &'static str,
    environment: &'static str,
    options: &'static str,
    expected_plan: Option<&'static str>,
    expected_walk: Option<&'static str>,
    expected_err: Option<&'static str>,
    unstable_throw: bool,
}

fn run_case(case: &Case) {
    let descriptor = decode_tree(case.descriptor.as_bytes()).unwrap();
    let environment = decode_tree(case.environment.as_bytes()).unwrap();
    let options = decode_tree(case.options.as_bytes()).unwrap();
    match build_deploy_plan(&descriptor, &environment, &options) {
        Ok(plan) => {
            let want_json = case
                .expected_plan
                .unwrap_or_else(|| panic!("{}: native built, TS refused", case.id));
            let want: serde_json::Value = serde_json::from_str(want_json).unwrap();
            assert_eq!(node_to_value(&plan), want, "{}: plan value", case.id);
            let want_walk: Vec<(String, Vec<String>)> =
                serde_json::from_str(case.expected_walk.unwrap()).unwrap();
            let mut got_walk = Vec::new();
            walk(&plan, "$".to_string(), &mut got_walk);
            assert_eq!(got_walk, want_walk, "{}: key order", case.id);
        }
        Err(error) => {
            assert!(
                !case.unstable_throw || case.expected_err.is_some(),
                "{}: native refused, TS built",
                case.id
            );
            let want = case
                .expected_err
                .unwrap_or_else(|| panic!("{}: native refused, TS built", case.id));
            assert_eq!(error.message, want, "{}: refusal", case.id);
        }
    }
}

#[test]
fn vector_full_kinds() {
    run_case(&Case {
        id: "full-kinds",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[100,98]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[68,66]}]]},{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[98,117,99,107,101,116]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[114,50]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[66,75,84]}]]},{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[111,98,106]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,117,114,97,98,108,101,45,111,98,106,101,99,116]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[67,108,115]}]]},{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[113]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[113,117,101,117,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[81]}]]},{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[115,118,99]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[115,101,114,118,105,99,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[83,86,67]}]]},{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[97,101]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[97,110,97,108,121,116,105,99,115,45,101,110,103,105,110,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[68,83]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[104,97,110,100,108,101,114],{\"t\":\"text\",\"units\":[104,49]}],[[101,118,101,114,121,77,105,108,108,105,115,101,99,111,110,100,115],{\"t\":\"text\",\"units\":[54,48,48,48,48]}]]},{\"t\":\"obj\",\"entries\":[[[104,97,110,100,108,101,114],{\"t\":\"text\",\"units\":[104,50]}],[[101,118,101,114,121,77,105,108,108,105,115,101,99,111,110,100,115],{\"t\":\"text\",\"units\":[54,48]}]]}]}],[[115,101,99,114,101,116,115],{\"t\":\"arr\",\"items\":[]}],[[114,101,113,117,105,114,101,100,67,97,112,97,98,105,108,105,116,105,101,115],{\"t\":\"arr\",\"items\":[]}],[[105,100,101,110,116,105,116,121],{\"t\":\"obj\",\"entries\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[100,98]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[68,66]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,100,98]}]]},{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[98,117,99,107,101,116]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[114,50]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[66,75,84]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,98,117,99,107,101,116]}]]},{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[111,98,106]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,117,114,97,98,108,101,45,111,98,106,101,99,116]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[67,108,115]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,111,98,106]}]]},{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[113]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[113,117,101,117,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[81]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,113]}]]},{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[115,118,99]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[115,101,114,118,105,99,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[83,86,67]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,115,118,99]}]]},{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[97,101]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[97,110,97,108,121,116,105,99,115,45,101,110,103,105,110,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[68,83]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,97,101]}]]}]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[[[122,101,98,114,97],{\"t\":\"text\",\"units\":[122]}],[[97,112,112,108,101],{\"t\":\"text\",\"units\":[97]}],[[109,97,110,103,111],{\"t\":\"text\",\"units\":[109]}]]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}],[[98,117,110,100,108,101],{\"t\":\"obj\",\"entries\":[[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,97,112,112,46,100,101,112,108,111,121,47,119,111,114,107,101,114,47,109,97,105,110,46,106,115]}],[[109,111,100,117,108,101,67,111,117,110,116],{\"t\":\"num\",\"bits\":\"401c000000000000\",\"spelling\":\"7\"}],[[115,104,97,50,53,54],{\"t\":\"text\",\"units\":[99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99]}]]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./app.deploy/worker/main.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{\"zebra\":\"z\",\"apple\":\"a\",\"mango\":\"m\"},\"d1_databases\":[{\"binding\":\"db\",\"database_name\":\"DB\",\"database_id\":\"id-db\"}],\"r2_buckets\":[{\"binding\":\"bucket\",\"bucket_name\":\"BKT\"}],\"durable_objects\":{\"bindings\":[{\"name\":\"obj\",\"class_name\":\"Cls\"}]},\"queues\":{\"producers\":[{\"binding\":\"q\",\"queue\":\"Q\"}]},\"services\":[{\"binding\":\"svc\",\"service\":\"SVC\"}],\"analytics_engine_datasets\":[{\"binding\":\"ae\",\"dataset\":\"DS\"}]},\"schedules\":[{\"handler\":\"h1\",\"everyMilliseconds\":\"60000\"},{\"handler\":\"h2\",\"everyMilliseconds\":\"60\"}],\"bundle\":{\"main\":\"./app.deploy/worker/main.js\",\"moduleCount\":7,\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"}}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[\"zebra\",\"apple\",\"mango\"]],[\"$.wrangler.d1_databases\",[\"#1\"]],[\"$.wrangler.d1_databases[0]\",[\"binding\",\"database_name\",\"database_id\"]],[\"$.wrangler.r2_buckets\",[\"#1\"]],[\"$.wrangler.r2_buckets[0]\",[\"binding\",\"bucket_name\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#1\"]],[\"$.wrangler.durable_objects.bindings[0]\",[\"name\",\"class_name\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#1\"]],[\"$.wrangler.queues.producers[0]\",[\"binding\",\"queue\"]],[\"$.wrangler.services\",[\"#1\"]],[\"$.wrangler.services[0]\",[\"binding\",\"service\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#1\"]],[\"$.wrangler.analytics_engine_datasets[0]\",[\"binding\",\"dataset\"]],[\"$.schedules\",[\"#2\"]],[\"$.schedules[0]\",[\"handler\",\"everyMilliseconds\"]],[\"$.schedules[1]\",[\"handler\",\"everyMilliseconds\"]],[\"$.bundle\",[\"main\",\"moduleCount\",\"sha256\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_legacy_main() {
    run_case(&Case {
        id: "legacy-main",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{},\"d1_databases\":[],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[]],[\"$.wrangler.d1_databases\",[\"#0\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_bundle_no_main() {
    run_case(&Case {
        id: "bundle-no-main",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}],[[98,117,110,100,108,101],{\"t\":\"obj\",\"entries\":[[[109,111,100,117,108,101,67,111,117,110,116],{\"t\":\"num\",\"bits\":\"4008000000000000\",\"spelling\":\"3\"}]]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{},\"d1_databases\":[],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":{\"moduleCount\":3}}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[]],[\"$.wrangler.d1_databases\",[\"#0\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]],[\"$.bundle\",[\"moduleCount\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_empty() {
    run_case(&Case {
        id: "empty",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{},\"d1_databases\":[],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[]],[\"$.wrangler.d1_databases\",[\"#0\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_unresolved() {
    run_case(&Case {
        id: "unresolved",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[103,104,111,115,116]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[71]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("deploy plan needs a selected resource for binding ghost"),
        unstable_throw: false,
    });
}

#[test]
fn vector_mismatched_kind() {
    run_case(&Case {
        id: "mismatched-kind",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[100,98]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[68,66]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[100,98]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[114,50]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[68,66]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,100,98]}]]}]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("binding db resolves to a different requirement"),
        unstable_throw: false,
    });
}

#[test]
fn vector_unknown_kind() {
    run_case(&Case {
        id: "unknown-kind",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[120]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[104,121,112,101,114,100,114,105,118,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[72]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[120]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[104,121,112,101,114,100,114,105,118,101]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[72]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,120]}]]}]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("deploy plan has no mapping for resource kind hyperdrive"),
        unstable_throw: false,
    });
}

#[test]
fn vector_numeric_kind() {
    run_case(&Case {
        id: "numeric-kind",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[120]}],[[107,105,110,100],{\"t\":\"num\",\"bits\":\"4045000000000000\",\"spelling\":\"42\"}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[72]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[120]}],[[107,105,110,100],{\"t\":\"num\",\"bits\":\"4045000000000000\",\"spelling\":\"42\"}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[72]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,120]}]]}]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("deploy plan has no mapping for resource kind 42"),
        unstable_throw: false,
    });
}

#[test]
fn vector_unicode_binding() {
    run_case(&Case {
        id: "unicode-binding",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[100,111,110,110,233,101,115,45,55296,56320]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[71]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("deploy plan needs a selected resource for binding données-𐀀"),
        unstable_throw: false,
    });
}

#[test]
fn vector_numeric_binding() {
    run_case(&Case {
        id: "numeric-binding",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"num\",\"bits\":\"401c000000000000\",\"spelling\":\"7\"}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[71]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"num\",\"bits\":\"401c000000000000\",\"spelling\":\"7\"}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[71]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"num\",\"bits\":\"40c81c8000000000\",\"spelling\":\"12345\"}]]}]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{},\"d1_databases\":[{\"binding\":7,\"database_name\":\"G\",\"database_id\":12345}],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[]],[\"$.wrangler.d1_databases\",[\"#1\"]],[\"$.wrangler.d1_databases[0]\",[\"binding\",\"database_name\",\"database_id\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_mixed_binding() {
    run_case(&Case {
        id: "mixed-binding",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"num\",\"bits\":\"401c000000000000\",\"spelling\":\"7\"}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[71]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[55]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[71]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100]}]]}]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("deploy plan needs a selected resource for binding 7"),
        unstable_throw: false,
    });
}

#[test]
fn vector_vars_array() {
    run_case(&Case {
        id: "vars-array",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"arr\",\"items\":[{\"t\":\"text\",\"units\":[97]},{\"t\":\"text\",\"units\":[98]}]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{\"0\":\"a\",\"1\":\"b\"},\"d1_databases\":[],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[\"0\",\"1\"]],[\"$.wrangler.d1_databases\",[\"#0\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_vars_string() {
    run_case(&Case {
        id: "vars-string",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"text\",\"units\":[97,98]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{\"0\":\"a\",\"1\":\"b\"},\"d1_databases\":[],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[\"0\",\"1\"]],[\"$.wrangler.d1_databases\",[\"#0\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_vars_null() {
    run_case(&Case {
        id: "vars-null",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"null\"}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{},\"d1_databases\":[],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[]],[\"$.wrangler.d1_databases\",[\"#0\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_schedule_passthrough() {
    run_case(&Case {
        id: "schedule-passthrough",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[104,97,110,100,108,101,114],{\"t\":\"text\",\"units\":[104]}],[[101,118,101,114,121,77,105,108,108,105,115,101,99,111,110,100,115],{\"t\":\"text\",\"units\":[49]}],[[101,120,116,114,97],{\"t\":\"obj\",\"entries\":[[[100,101,101,112],{\"t\":\"arr\",\"items\":[{\"t\":\"num\",\"bits\":\"3ff0000000000000\",\"spelling\":\"1\"},{\"t\":\"text\",\"units\":[120]},{\"t\":\"null\"},{\"t\":\"bool\",\"v\":true}]}]]}]]}]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{},\"d1_databases\":[],\"r2_buckets\":[],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[{\"handler\":\"h\",\"everyMilliseconds\":\"1\",\"extra\":{\"deep\":[1,\"x\",null,true]}}],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[]],[\"$.wrangler.d1_databases\",[\"#0\"]],[\"$.wrangler.r2_buckets\",[\"#0\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#1\"]],[\"$.schedules[0]\",[\"handler\",\"everyMilliseconds\",\"extra\"]],[\"$.schedules[0].extra\",[\"deep\"]],[\"$.schedules[0].extra.deep\",[\"#4\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_kind_order() {
    run_case(&Case {
        id: "kind-order",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[97]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[65]}]]},{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[98]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[114,50]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[66]}]]},{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[99]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[67]}]]}]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[97]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[65]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,97]}]]},{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[98]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[114,50]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[66]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,98]}]]},{\"t\":\"obj\",\"entries\":[[[114,101,113,117,105,114,101,109,101,110,116],{\"t\":\"obj\",\"entries\":[[[98,105,110,100,105,110,103],{\"t\":\"text\",\"units\":[99]}],[[107,105,110,100],{\"t\":\"text\",\"units\":[100,49]}],[[108,111,103,105,99,97,108,78,97,109,101],{\"t\":\"text\",\"units\":[67]}]]}],[[114,101,115,111,117,114,99,101,73,100],{\"t\":\"text\",\"units\":[105,100,45,99]}]]}]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: Some("{\"wrangler\":{\"name\":\"w1\",\"main\":\"./dist/worker/entry.js\",\"compatibility_date\":\"2026-07-15\",\"vars\":{},\"d1_databases\":[{\"binding\":\"a\",\"database_name\":\"A\",\"database_id\":\"id-a\"},{\"binding\":\"c\",\"database_name\":\"C\",\"database_id\":\"id-c\"}],\"r2_buckets\":[{\"binding\":\"b\",\"bucket_name\":\"B\"}],\"durable_objects\":{\"bindings\":[]},\"queues\":{\"producers\":[]},\"services\":[],\"analytics_engine_datasets\":[]},\"schedules\":[],\"bundle\":null}"),
        expected_walk: Some("[[\"$\",[\"wrangler\",\"schedules\",\"bundle\"]],[\"$.wrangler\",[\"name\",\"main\",\"compatibility_date\",\"vars\",\"d1_databases\",\"r2_buckets\",\"durable_objects\",\"queues\",\"services\",\"analytics_engine_datasets\"]],[\"$.wrangler.vars\",[]],[\"$.wrangler.d1_databases\",[\"#2\"]],[\"$.wrangler.d1_databases[0]\",[\"binding\",\"database_name\",\"database_id\"]],[\"$.wrangler.d1_databases[1]\",[\"binding\",\"database_name\",\"database_id\"]],[\"$.wrangler.r2_buckets\",[\"#1\"]],[\"$.wrangler.r2_buckets[0]\",[\"binding\",\"bucket_name\"]],[\"$.wrangler.durable_objects\",[\"bindings\"]],[\"$.wrangler.durable_objects.bindings\",[\"#0\"]],[\"$.wrangler.queues\",[\"producers\"]],[\"$.wrangler.queues.producers\",[\"#0\"]],[\"$.wrangler.services\",[\"#0\"]],[\"$.wrangler.analytics_engine_datasets\",[\"#0\"]],[\"$.schedules\",[\"#0\"]]]"),
        expected_err: None,
        unstable_throw: false,
    });
}

#[test]
fn vector_bindings_not_array() {
    run_case(&Case {
        id: "bindings-not-array",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"num\",\"bits\":\"4045000000000000\",\"spelling\":\"42\"}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("descriptor.resourceBindings must be an array"),
        unstable_throw: true,
    });
}

#[test]
fn vector_schedules_not_array() {
    run_case(&Case {
        id: "schedules-not-array",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"text\",\"units\":[110,111,112,101]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("descriptor.schedules must be an array"),
        unstable_throw: true,
    });
}

#[test]
fn vector_descriptor_null() {
    run_case(&Case {
        id: "descriptor-null",
        descriptor: "{\"t\":\"null\"}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[119,111,114,107,101,114,78,97,109,101],{\"t\":\"text\",\"units\":[119,49]}],[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("descriptor must be a JSON object"),
        unstable_throw: true,
    });
}

#[test]
fn vector_options_missing_key() {
    run_case(&Case {
        id: "options-missing-key",
        descriptor: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,66,105,110,100,105,110,103,115],{\"t\":\"arr\",\"items\":[]}],[[115,99,104,101,100,117,108,101,115],{\"t\":\"arr\",\"items\":[]}]]}",
        environment: "{\"t\":\"obj\",\"entries\":[[[114,101,115,111,117,114,99,101,115],{\"t\":\"arr\",\"items\":[]}],[[118,97,114,115],{\"t\":\"obj\",\"entries\":[]}]]}",
        options: "{\"t\":\"obj\",\"entries\":[[[109,97,105,110],{\"t\":\"text\",\"units\":[46,47,120]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{\"t\":\"text\",\"units\":[50,48,50,54,45,48,55,45,49,53]}]]}",
        expected_plan: None,
        expected_walk: None,
        expected_err: Some("deploy plan options must include \"workerName\""),
        unstable_throw: false,
    });
}

/// Lone surrogates in vars values clone through at the units
/// level (JSON cannot round-trip them, so this stays native-only).
#[test]
fn surrogate_vars_clone_losslessly() {
    use can_preparation::input::Node;
    let units = vec![0x0041, 0xD800, 0x0042];
    let environment = Node::Obj(vec![
        (
            vec![0x0076, 0x0061, 0x0072, 0x0073],
            Node::Obj(vec![(vec![0x006B], Node::Text(units.clone()))]),
        ),
        (
            vec![
                0x0072, 0x0065, 0x0073, 0x006F, 0x0075, 0x0072, 0x0063, 0x0065, 0x0073,
            ],
            Node::Arr(vec![]),
        ),
    ]);
    let descriptor = Node::Obj(vec![
        (
            vec![
                0x0072, 0x0065, 0x0073, 0x006F, 0x0075, 0x0072, 0x0063, 0x0065, 0x0042, 0x0069,
                0x006E, 0x0064, 0x0069, 0x006E, 0x0067, 0x0073,
            ],
            Node::Arr(vec![]),
        ),
        (
            vec![
                0x0073, 0x0063, 0x0068, 0x0065, 0x0064, 0x0075, 0x006C, 0x0065, 0x0073,
            ],
            Node::Arr(vec![]),
        ),
    ]);
    let options = Node::Obj(vec![
        (
            vec![
                0x0077, 0x006F, 0x0072, 0x006B, 0x0065, 0x0072, 0x004E, 0x0061, 0x006D, 0x0065,
            ],
            Node::Text(vec![0x0077]),
        ),
        (
            vec![0x006D, 0x0061, 0x0069, 0x006E],
            Node::Text(vec![0x006D]),
        ),
        (
            vec![
                0x0063, 0x006F, 0x006D, 0x0070, 0x0061, 0x0074, 0x0069, 0x0062, 0x0069, 0x006C,
                0x0069, 0x0074, 0x0079, 0x0044, 0x0061, 0x0074, 0x0065,
            ],
            Node::Text(vec![0x0063]),
        ),
    ]);
    let plan = build_deploy_plan(&descriptor, &environment, &options).unwrap();
    if let Node::Obj(entries) = &plan {
        let wrangler = entries
            .iter()
            .find(|(k, _)| {
                k == &vec![
                    0x0077, 0x0072, 0x0061, 0x006E, 0x0067, 0x006C, 0x0065, 0x0072,
                ]
            })
            .unwrap()
            .1
            .clone();
        if let Node::Obj(wentries) = &wrangler {
            let vars = wentries
                .iter()
                .find(|(k, _)| k == &vec![0x0076, 0x0061, 0x0072, 0x0073])
                .unwrap()
                .1
                .clone();
            if let Node::Obj(ventries) = &vars {
                assert_eq!(ventries[0].1, Node::Text(units));
                return;
            }
        }
    }
    panic!("vars value did not survive");
}
