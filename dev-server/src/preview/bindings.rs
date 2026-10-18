//! Admission of the compiler's static source-owned runtime inventory.
use super::Result;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
fn invalid<T>(why: &str) -> Result<T> {
    Err(format!("RUNTIME_BINDINGS_INVALID: {why}"))
}
fn properties(value: &Value) -> Result<BTreeMap<String, Value>> {
    if value["type"] != "ObjectExpression" {
        return invalid("compiled runtime metadata must be an object literal");
    }
    let mut result = BTreeMap::new();
    for p in value["properties"]
        .as_array()
        .ok_or("runtime metadata lacks properties")?
    {
        if p["type"] != "Property"
            || p["computed"] == true
            || p["method"] == true
            || p["kind"] != "init"
        {
            return invalid("metadata cannot contain computed keys, spreads or getters");
        }
        let key = match p["key"]["type"].as_str() {
            Some("Identifier") => p["key"]["name"].as_str(),
            Some("Literal") => p["key"]["value"].as_str(),
            _ => None,
        }
        .ok_or("invalid metadata key")?;
        if result.insert(key.into(), p["value"].clone()).is_some() {
            return invalid("duplicate metadata key");
        }
    }
    Ok(result)
}
fn literal(value: &Value) -> Result<Value> {
    match value["type"].as_str() {
        Some("Literal")
            if value["value"].is_null()
                || value["value"].is_string()
                || value["value"].is_boolean()
                || value["value"].is_number() =>
        {
            Ok(value["value"].clone())
        }
        Some("ArrayExpression") => Ok(Value::Array(
            value["elements"]
                .as_array()
                .ok_or("invalid array metadata")?
                .iter()
                .map(literal)
                .collect::<Result<_>>()?,
        )),
        Some("ObjectExpression") => Ok(Value::Object(
            properties(value)?
                .into_iter()
                .map(|(k, v)| literal(&v).map(|v| (k, v)))
                .collect::<Result<Map<String, Value>>>()?,
        )),
        _ => invalid("compiled runtime metadata must contain literal data"),
    }
}
fn strings(value: &Value) -> bool {
    value.as_array().is_some_and(|v| {
        let mut seen = BTreeSet::new();
        v.iter()
            .all(|v| v.as_str().is_some_and(|s| !s.is_empty() && seen.insert(s)))
    })
}
fn inventory(value: &Value) -> Result<Vec<Value>> {
    let entries = value
        .as_array()
        .ok_or("runtime binding inventory must be an array")?;
    let mut seen = BTreeSet::new();
    for b in entries {
        let owner = b["owner"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("binding owner missing")?;
        let name = b["name"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("binding name missing")?;
        let binding = b["binding"].as_str().ok_or("binding key missing")?;
        if binding
            != if b["kind"] == "r2" {
                "FILES".into()
            } else {
                format!("{owner}.{name}")
            }
            || !seen.insert(format!("{owner}:{binding}"))
        {
            return invalid("runtime binding canonical identity is invalid or duplicated");
        }
        let nonempty = |key: &str| b[key].as_str().is_some_and(|s| !s.is_empty());
        let valid = match b["kind"].as_str() {
            Some("r2") => b["implicit"] == true && name == "FILES",
            Some("durable-object") => nonempty("key"),
            Some("queue") => nonempty("type") && strings(&b["handlers"]),
            Some("kv") => b["ttlMilliseconds"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())),
            Some("service") => nonempty("from") && nonempty("capability"),
            Some("analytics-engine") => b["schema"].as_array().is_some_and(|fields| {
                let mut names = BTreeSet::new();
                fields.iter().all(|f| {
                    f["name"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && names.insert(s))
                        && f["type"].as_str().is_some_and(|s| !s.is_empty())
                })
            }),
            _ => false,
        };
        if !valid {
            return invalid("runtime binding declaration is invalid");
        }
    }
    Ok(entries.clone())
}
#[derive(Clone)]
pub struct Plan {
    pub app: Option<String>,
    pub bindings: Vec<Value>,
    pub queue_handlers: Vec<String>,
    pub no_model_storage_mode: Option<String>,
}
impl Plan {
    pub fn resources(&self) -> Vec<Value> {
        self.bindings.iter().map(|b|json!({"requirement":{"binding":b["binding"],"kind":b["kind"],"logicalName":b["binding"]},"resourceId":resource_id(b["binding"].as_str().unwrap())})).collect()
    }
}
pub fn plan(artifact: &Value, ast: Option<&Value>) -> Result<Plan> {
    let Some(ast) = ast else {
        return absent_inventory(artifact, "inventory requires compiled entry");
    };
    let mut definition = None;
    let mut exports = BTreeMap::new();
    read_entry_exports(ast, &mut definition, &mut exports)?;
    let Some(definition) = definition else {
        return absent_inventory(artifact, "compiled entry runtime binding inventory missing");
    };
    let Some(emitted) = definition.get("runtimeBindings") else {
        return absent_inventory(artifact, "compiled entry runtime binding inventory missing");
    };
    let full = inventory(artifact.get("runtimeBindings").unwrap_or(&json!([])))?;
    if full != inventory(&literal(emitted)?)? {
        return invalid("artifact inventory disagrees with original compiled entry");
    }
    let app = definition_app(&definition)?;
    let owners = definition_owners(&definition, &app)?;
    let bindings = select_bindings(full, &owners)?;
    let queue_handlers = checked_queue_handlers(artifact, &bindings, &exports, &definition)?;
    let no_model_storage_mode = model_free_storage_mode(artifact, &bindings, &owners, &definition)?;
    Ok(Plan {
        app: Some(app),
        bindings,
        queue_handlers,
        no_model_storage_mode,
    })
}
fn absent_inventory(artifact: &Value, why: &str) -> Result<Plan> {
    if artifact.get("runtimeBindings").is_none() {
        Ok(Plan {
            app: None,
            bindings: vec![],
            queue_handlers: vec![],
            no_model_storage_mode: None,
        })
    } else {
        invalid(why)
    }
}
fn read_entry_exports(
    ast: &Value,
    definition: &mut Option<BTreeMap<String, Value>>,
    exports: &mut BTreeMap<String, Value>,
) -> Result<()> {
    for statement in ast["body"]
        .as_array()
        .ok_or("compiled entry parse failed")?
    {
        if statement["type"] != "ExportNamedDeclaration"
            || statement["declaration"]["type"] != "VariableDeclaration"
        {
            continue;
        }
        let declaration = &statement["declaration"];
        for b in declaration["declarations"]
            .as_array()
            .ok_or("invalid export declaration")?
        {
            if b["id"]["type"] != "Identifier" {
                continue;
            }
            let Some(name) = b["id"]["name"].as_str() else {
                continue;
            };
            if !b["init"].is_null() {
                exports.insert(name.to_string(), b["init"].clone());
            }
            if name == "appDefinition" {
                if definition.is_some() || declaration["kind"] != "const" {
                    return invalid("entry must export one constant appDefinition");
                }
                *definition = Some(properties(&b["init"])?);
            }
        }
    }
    Ok(())
}
fn definition_app(definition: &BTreeMap<String, Value>) -> Result<String> {
    let app = literal(
        definition
            .get("id")
            .ok_or("compiled entry lacks app identity")?,
    )?
    .as_str()
    .filter(|s| !s.is_empty())
    .ok_or("compiled entry lacks app identity")?
    .to_string();
    Ok(app)
}
fn definition_owners(definition: &BTreeMap<String, Value>, app: &str) -> Result<Value> {
    let owners = literal(
        definition
            .get("runtimeBindingOwners")
            .ok_or("compiled owner closure missing")?,
    )?;
    if !strings(&owners)
        || !owners
            .as_array()
            .unwrap()
            .contains(&Value::String(app.to_owned()))
    {
        return invalid("compiled runtime owner closure invalid");
    }
    Ok(owners)
}
fn select_bindings(full: Vec<Value>, owners: &Value) -> Result<Vec<Value>> {
    let selected: Vec<_> = full
        .into_iter()
        .filter(|b| owners.as_array().unwrap().contains(&b["owner"]))
        .collect();
    let mut has_r2 = false;
    let bindings: Vec<_> = selected
        .into_iter()
        .filter(|b| {
            if b["kind"] == "r2" {
                if has_r2 {
                    false
                } else {
                    has_r2 = true;
                    true
                }
            } else {
                true
            }
        })
        .collect();
    let mut seen = BTreeSet::new();
    if bindings
        .iter()
        .any(|b| !seen.insert(b["binding"].as_str().unwrap()))
    {
        return invalid("runtime bindings alias environment key");
    }
    Ok(bindings)
}
fn checked_queue_handlers(
    artifact: &Value,
    bindings: &[Value],
    exports: &BTreeMap<String, Value>,
    definition: &BTreeMap<String, Value>,
) -> Result<Vec<String>> {
    let mut queue_handlers = vec![];
    for queue in bindings.iter().filter(|b| b["kind"] == "queue") {
        for handler in queue["handlers"].as_array().unwrap() {
            validate_queue_callable(artifact, handler, exports)?;
            validate_queue_invocation(queue, handler, definition)?;
            queue_handlers.push(handler.as_str().unwrap().into());
        }
    }
    Ok(queue_handlers)
}
fn validate_queue_callable(
    artifact: &Value,
    handler: &Value,
    exports: &BTreeMap<String, Value>,
) -> Result<()> {
    let references: Vec<_> = artifact["callables"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|c| c["id"] == *handler)
        .collect();
    if references.len() != 1 {
        return invalid("queue handler has no unique callable reference");
    }
    let c = references[0];
    if c["kind"] != "handler"
        || c["module"] != artifact["modules"][0]["path"]
        || c["member"] != json!([handler])
        || exports
            .get(c["export"].as_str().unwrap_or(""))
            .map(literal)
            .transpose()?
            .as_ref()
            != Some(handler)
    {
        return invalid("queue handler callable disagrees with entry");
    }
    Ok(())
}
fn validate_queue_invocation(
    queue: &Value,
    handler: &Value,
    definition: &BTreeMap<String, Value>,
) -> Result<()> {
    let operations = properties(
        definition
            .get("operations")
            .ok_or("queue invocation missing")?,
    )?;
    let events = properties(definition.get("events").ok_or("queue event missing")?)?;
    let metadata = properties(
        operations
            .get(handler.as_str().unwrap())
            .ok_or("queue operation missing")?,
    )?;
    let event = properties(
        events
            .get(queue["binding"].as_str().unwrap())
            .ok_or("queue event missing")?,
    )?;
    let inv = literal(
        metadata
            .get("invocation")
            .ok_or("handler invocation missing")?,
    )?;
    let input = properties(event.get("inputs").ok_or("event input missing")?)?;
    let field = properties(input.get("value").ok_or("event value missing")?)?;
    validate_handler_signature(queue, handler, &metadata, &inv, &field)?;
    Ok(())
}
fn validate_handler_signature(
    queue: &Value,
    handler: &Value,
    metadata: &BTreeMap<String, Value>,
    inv: &Value,
    field: &BTreeMap<String, Value>,
) -> Result<()> {
    let get = |key: &str| metadata.get(key).map(literal).transpose();
    if get("handler")?.as_ref() != Some(handler)
        || get("event")?.as_ref() != Some(&queue["binding"])
        || get("read")? != Some(json!(false))
        || inv["name"] != *handler
        || inv["kind"] != "scenario"
        || inv["inputs"]["fields"].as_array().map(Vec::len) != Some(1)
        || inv["inputs"]["fields"][0]["name"] != "value"
        || inv["inputs"]["fields"][0]["valueType"] != queue["type"]
        || inv["inputs"]["fields"][0]["required"] != true
        || literal(field.get("type").ok_or("event type missing")?)? != queue["type"]
    {
        return invalid("queue handler disagrees with source schema");
    }
    Ok(())
}
fn model_free_storage_mode(
    artifact: &Value,
    bindings: &[Value],
    owners: &Value,
    definition: &BTreeMap<String, Value>,
) -> Result<Option<String>> {
    let mut no_model_storage_mode = None;
    if artifact["models"].as_array().is_some_and(Vec::is_empty)
        && !bindings.is_empty()
        && artifact["operations"]
            .as_array()
            .is_some_and(|v| !v.is_empty())
    {
        let policy = properties(
            definition
                .get("policy")
                .ok_or("model-free policy missing")?,
        )?;
        let policies = properties(
            policy
                .get("operations")
                .ok_or("model-free operation policy missing")?,
        )?;
        let modes = owned_operation_modes(artifact, owners, &policies)?;
        if modes.len() > 1 {
            return Err(
                "MIXED_OWNER_PROFILE_UNSUPPORTED: mixed model-free State ownership unsupported"
                    .into(),
            );
        }
        if modes.contains("global") {
            return Err("MODEL_FREE_OWNER_PROFILE_UNSUPPORTED: model-free public/authenticated resources require global State owner selection".into());
        }
        no_model_storage_mode = Some(
            if modes.contains("team") {
                "team"
            } else {
                "global"
            }
            .into(),
        );
    }
    Ok(no_model_storage_mode)
}
fn owned_operation_modes(
    artifact: &Value,
    owners: &Value,
    policies: &BTreeMap<String, Value>,
) -> Result<BTreeSet<&'static str>> {
    let mut modes = BTreeSet::new();
    for op in artifact["operations"].as_array().unwrap() {
        let name = op["name"].as_str().ok_or("operation name missing")?;
        if !owners
            .as_array()
            .unwrap()
            .iter()
            .any(|o| name.starts_with(&format!("{}.", o.as_str().unwrap())))
        {
            continue;
        }
        let metadata = properties(
            policies
                .get(name)
                .ok_or("original operation policy missing")?,
        )?;
        let selectors = metadata
            .get("by")
            .map(literal)
            .transpose()?
            .unwrap_or(json!([]));
        if !selectors.as_array().is_some_and(|v| {
            !v.is_empty() && v.iter().all(|s| s.as_str().is_some_and(|s| !s.is_empty()))
        }) || ["gated", "when"].iter().any(|key| {
            metadata.get(*key).map(literal).transpose().ok().flatten() == Some(json!(true))
        }) {
            return Err("MODEL_FREE_OWNER_PROFILE_UNSUPPORTED: model-free preview requires explicit ordinary caller selectors".into());
        }
        for selector in selectors.as_array().unwrap() {
            modes.insert(if selector == "public" || selector == "authenticated" {
                "global"
            } else {
                "team"
            });
        }
    }
    Ok(modes)
}

pub fn resource_id(binding: &str) -> String {
    format!(
        "can-local-{}",
        &crate::capture::hash(binding.as_bytes())[..24]
    )
}
