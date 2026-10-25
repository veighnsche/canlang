//! Source-owned deployment inventory and staged sink lowering through the CLI.
use std::path::Path;
use std::process::Command;

fn compile(dir: &Path, source: &str) -> (bool, serde_json::Value) {
    let source_path = dir.join("resources.can");
    std::fs::write(&source_path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/values/dist/catalog.json"))
        .arg(source_path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let result = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    (output.status.success(), result)
}

#[test]
fn declared_resources_emit_owned_inventory_and_sends_stay_on_the_outbox_abi() {
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app Resources
context
 binding Rooms DurableObject key=Resources.Room
 queue Jobs type=Work
 cache KV ttl=5m
 analytics Events {kind:text,value:decimal}
use std {EmailV1 as Mail} from=deployment.email
Given
 contract Work {title:text}
 Room at=Rooms {name:text,attachment:file?}
 Booking in Room {title:text}
When
 scenario publish(value:Work,enabled:bool) by=members
  do
   send Jobs.publish {value} when=enabled as queued
   send Events.write {kind="published",value=1.5} as tracked
 scenario process on=Jobs
  do
   let title=event.title
   require title!=""
Then
"#;
    let (success, artifact) = compile(scratch.path(), source);
    assert!(success, "{artifact}");
    assert!(artifact["requires"].as_array().unwrap().iter().any(
        |requirement| requirement["capability"] == "cloudflare.runtime-bindings"
            && requirement["min_version"] == 1
    ));
    let inventory = artifact["runtimeBindings"].as_array().unwrap();
    assert_eq!(inventory.len(), 6, "{inventory:?}");
    assert!(
        inventory.iter().any(
            |binding| binding["kind"] == "durable-object" && binding["key"] == "Resources.Room"
        )
    );
    assert!(inventory.iter().any(|binding| binding["kind"] == "queue"
        && binding["type"] == "Resources.Work"
        && binding["handlers"] == serde_json::json!(["Resources.process"])));
    assert!(
        inventory
            .iter()
            .any(|binding| binding["kind"] == "kv" && binding["ttlMilliseconds"] == "300000")
    );
    assert!(
        inventory
            .iter()
            .any(|binding| binding["kind"] == "analytics-engine"
                && binding["schema"][1]["type"] == "decimal")
    );
    assert!(
        inventory
            .iter()
            .any(|binding| binding["kind"] == "r2" && binding["binding"] == "FILES")
    );
    assert!(
        inventory
            .iter()
            .any(|binding| binding["kind"] == "service" && binding["capability"] == "std.EmailV1")
    );
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(
        js.contains("\"Resources.Jobs\":{inputs:{value:{type:\"Resources.Work\"}},inputFields:[")
    );
    let serialized = js.split_once("runtimeBindings:").unwrap().1;
    let emitted_inventory = serde_json::Deserializer::from_str(serialized)
        .into_iter::<serde_json::Value>()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(emitted_inventory, artifact["runtimeBindings"]);
    let queue = js.find("await send(c,\"Resources.Jobs.publish\"").unwrap();
    let analytics = js.find("await send(c,\"Resources.Events.write\"").unwrap();
    assert!(queue < analytics, "lexical effects must retain their order");
    assert!(js.contains("binding:\"Resources.Jobs\""));
    assert!(
        js.contains("when:{rule:"),
        "dispatch guards use the existing retained rule ABI: {js}"
    );
    assert!(js.contains("event:\"Resources.Jobs\""));
    assert!(js.contains("\"valueType\":\"Resources.Work\""));
    assert!(!js.contains("writeDataPoint("));
    assert!(!js.contains(".getByName("));
}

#[test]
fn sink_inputs_and_durable_placement_fail_closed() {
    let scratch = tempfile::tempdir().unwrap();
    for (context, model, send) in [
        (
            "queue Jobs type=text",
            "",
            "send Jobs.publish {value=1} as sent",
        ),
        (
            "queue Jobs type=text",
            "",
            "send Jobs.erase {value=\"x\"} as sent",
        ),
        (
            "analytics Events {kind:text}",
            "",
            "send Events.write {unknown=\"x\"} as sent",
        ),
        (
            "binding Rooms DurableObject key=Invalid.Room",
            "Room {name:text}",
            "let x=1",
        ),
        (
            "binding Rooms DurableObject key=Invalid.Room",
            "Room at=Missing {name:text}",
            "let x=1",
        ),
        (
            "binding Rooms DurableObject key=Invalid.Room\n binding Others DurableObject key=Invalid.Room",
            "Room at=Rooms {name:text}",
            "let x=1",
        ),
    ] {
        let source = format!(
            "app Invalid\ncontext\n {context}\nGiven\n {model}\nWhen\n scenario run() by=members\n  do\n   {send}\nThen\n"
        );
        let (success, result) = compile(scratch.path(), &source);
        assert!(!success, "incorrect source admitted: {source}: {result}");
        assert!(
            result.to_string().contains("E3001") || result.to_string().contains("E3010"),
            "{result}"
        );
    }
}

#[test]
fn scalar_queue_payloads_are_typed_and_unselected_apps_retain_their_owners() {
    let scratch = tempfile::tempdir().unwrap();
    let source = "app First\ncontext\n queue Words type=text\nGiven\nWhen\n scenario process on=Words\n  do require event!=\"\"\nThen\napp Second\ncontext\n analytics Elsewhere {kind:text}\nGiven\n Attachment {content:file}\nWhen\nThen\n";
    let (success, artifact) = compile(scratch.path(), source);
    assert!(success, "{artifact}");
    let inventory = artifact["runtimeBindings"].as_array().unwrap();
    assert!(
        inventory
            .iter()
            .any(|binding| binding["owner"] == "First" && binding["kind"] == "queue")
    );
    assert!(
        inventory
            .iter()
            .any(|binding| binding["owner"] == "Second" && binding["kind"] == "analytics-engine")
    );
    assert!(
        inventory
            .iter()
            .filter(|binding| binding["kind"] == "r2")
            .all(|binding| binding["owner"] == "Second")
    );
}

#[test]
fn owner_closure_follows_composition_and_unbound_imports_but_not_service_schemas() {
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app Product uses=[Nested]
app Nested uses=[Feature]
app Unselected
context
 queue Hidden type=text
Given
When
Then
app Feature
context
 queue Jobs type=text
use std {EmailV1 as Adapter} from=deployment.remote
use Shared {Payload}
Given
When
Then
package Shared
 Given
  export contract Payload {attachment:file}
 When
 Then
package Remote
 Given
  export capability Adapter version=1
   send(value:text) -> text
  Document {attachment:file}
 When
 Then
"#;
    let (success, artifact) = compile(scratch.path(), source);
    assert!(success, "{artifact}");
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    let owners = js.split_once("runtimeBindingOwners:").unwrap().1;
    let owners = serde_json::Deserializer::from_str(owners)
        .into_iter::<serde_json::Value>()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(
        owners,
        serde_json::json!(["Product", "Nested", "Feature", "Shared"])
    );
    let inventory = artifact["runtimeBindings"].as_array().unwrap();
    let product_files = inventory
        .iter()
        .find(|binding| binding["owner"] == "Product" && binding["kind"] == "r2");
    assert!(
        product_files.is_some(),
        "runtime dependency file use implies selected store"
    );
    assert!(
        inventory
            .iter()
            .any(|binding| binding["owner"] == "Feature" && binding["kind"] == "service"),
        "full declaration inventory retains its source ownership"
    );
    let selected: Vec<_> = inventory
        .iter()
        .filter(|binding| owners.as_array().unwrap().contains(&binding["owner"]))
        .collect();
    assert!(selected.iter().all(|binding| binding["name"] != "Hidden"));
    let no_runtime_files = source.replace("Payload {attachment:file}", "Payload {attachment:text}");
    let (success, artifact) = compile(scratch.path(), &no_runtime_files);
    assert!(success, "{artifact}");
    assert!(
        artifact["runtimeBindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["kind"] != "r2"),
        "bound provider schemas and unselected package files do not provision storage"
    );
}

#[test]
fn scenarios_infer_root_authority_through_mutations_reads_and_local_calls() {
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app Rooted
context
 binding Rooms DurableObject key=Rooted.Room
Given
 Room at=Rooms {name:text}
 Booking in Room {title:text}
 policy Room read=members
 policy Booking read=members
 derive roomCount():int = count(Room)
When
 crud Room by=members fields=name
 scenario make(name:text) -> Room by=members
  do
   create Room {name} as room
   return room
 scenario wrapped(name:text) -> Room by=members
  do
   call make {name} as made
   return made
 scenario rename(room:Room,name:text) by=members
  do set room {name}
 scenario book(room:Room,title:text) by=members
  do create Booking {parent=room,title} as booking
 scenario touch(room:Room) by=members
  do require room.name!=""
 scenario countRooms() by=members
  do require roomCount()>=0
Then
"#;
    let (success, artifact) = compile(scratch.path(), source);
    assert!(success, "{artifact}");
    let expected = serde_json::json!({"binding":"Rooted.Rooms","model":"Rooted.Room"});
    let operations = artifact["operations"].as_array().unwrap();
    for operation in [
        "make",
        "wrapped",
        "rename",
        "book",
        "touch",
        "countRooms",
        "Room.create",
    ] {
        let operation = operations
            .iter()
            .find(|entry| entry["name"] == format!("Rooted.{operation}"))
            .unwrap();
        let mut expected = expected.clone();
        if matches!(
            operation["name"].as_str(),
            Some("Rooted.make" | "Rooted.wrapped" | "Rooted.Room.create")
        ) {
            expected["createsRoot"] = serde_json::json!(true);
        }
        assert_eq!(operation["rootAuthority"], expected, "{operation}");
    }
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(js.contains("rootAuthority:{\"binding\":\"Rooted.Rooms\",\"model\":\"Rooted.Room\"}"));
}

#[test]
fn root_authority_rejects_mutable_d1_and_other_root_dependencies() {
    let scratch = tempfile::tempdir().unwrap();
    let prefix = "app Mixed\ncontext\n binding Rooms DurableObject key=Mixed.Room\n binding Others DurableObject key=Mixed.Other\nGiven\n Room at=Rooms {name:text}\n Other at=Others {name:text}\n Config {name:text}\n policy Room read=members\n policy Other read=members\n policy Config read=members\n derive configs():int=count(Config)\nWhen\n";
    for scenario in [
        " scenario mixed(config:Config) by=members\n  do\n   require config.name!=\"\"\n   create Room {name=\"x\"} as made\n",
        " scenario mixed() by=members\n  do\n   require configs()>=0\n   create Room {name=\"x\"} as made\n",
        " scenario mixed() by=members\n  do\n   create Other {name=\"x\"} as other\n   create Room {name=\"x\"} as room\n",
        " scenario helper() by=members\n  do require configs()>=0\n scenario mixed() by=members\n  do\n   call helper {}\n   create Room {name=\"x\"} as room\n",
    ] {
        let source = format!("{prefix}{scenario}Then\n");
        let (success, diagnostics) = compile(scratch.path(), &source);
        assert!(
            !success,
            "cross-owner source admitted: {source}: {diagnostics}"
        );
        assert!(diagnostics.to_string().contains("E4051"), "{diagnostics}");
    }
    let callback = prefix.replace(
        "When\n",
        " invariant Room: count(Config)>=0\nWhen\n crud Room by=members fields=name\n",
    );
    let (success, diagnostics) = compile(scratch.path(), &format!("{callback}Then\n"));
    assert!(
        !success && diagnostics.to_string().contains("E4051"),
        "{diagnostics}"
    );
}

#[test]
fn root_queue_contract_fields_are_values_not_storage_models() {
    let scratch = tempfile::tempdir().unwrap();
    let source = "app RootQueue\ncontext\n binding Schedule DurableObject key=RootQueue.Calendar\n queue Jobs type=BookingJob\nGiven\n Calendar at=Schedule {name:text,processed:int=0}\n Booking in Calendar {title:text}\n contract BookingJob {calendar:Calendar,title:text}\n policy Calendar read=members\n policy Booking read=members\nWhen\n crud Calendar by=members fields=name\n crud Booking by=members fields=title\n scenario submit(calendar:Calendar,title:text,accept:bool) by=members\n  do\n   send Jobs.publish {value=BookingJob {calendar,title}} as queued\n   require accept\n scenario consume on=Jobs\n  do\n   require actor==null\n   create Booking {parent=event.calendar,title=event.title} as booking\n   set event.calendar {processed=event.calendar.processed+1}\nThen\n";
    let (success, artifact) = compile(scratch.path(), source);
    assert!(success, "{artifact}");
    assert_eq!(
        artifact["runtimeBindings"][1]["type"],
        "RootQueue.BookingJob"
    );
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(js.contains(
        "rootAuthority:{\"binding\":\"RootQueue.Schedule\",\"model\":\"RootQueue.Calendar\"}"
    ));
}

#[test]
fn queue_event_mutation_targets_infer_and_validate_root_authority() {
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app EventRoot
context
 binding Rooms DurableObject key=EventRoot.Room
 binding Others DurableObject key=EventRoot.Other
 queue Jobs type=Payload
Given
 Room at=Rooms {name:text}
 Other at=Others {name:text}
 contract Payload {room:Room,other:Other}
 policy Room read=members
 policy Other read=members
When
 scenario consume on=Jobs
  do set event.room {name="updated"}
Then
"#;
    let (success, artifact) = compile(scratch.path(), source);
    assert!(success, "{artifact}");
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(
        js.contains("rootAuthority:{\"binding\":\"EventRoot.Rooms\",\"model\":\"EventRoot.Room\"}")
    );

    let mixed = source.replace(
        "  do set event.room {name=\"updated\"}",
        "  do\n   set event.room {name=\"updated\"}\n   set event.other {name=\"updated\"}",
    );
    let (success, diagnostics) = compile(scratch.path(), &mixed);
    assert!(
        !success && diagnostics.to_string().contains("E4051"),
        "{diagnostics}"
    );
}
