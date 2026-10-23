//! Protected browser behavior checks for the private native test host.
use crate::{
    capture::{self, Capture},
    gateway::Gateway,
    preview,
};
use serde_json::{Value, json};
use std::{
    sync::atomic::AtomicBool,
    time::{SystemTime, UNIX_EPOCH},
};
pub type Call<'a> = preview::Call<'a>;
type Result<T> = std::result::Result<T, String>;
const APP: &str = "HelpOffice";
const MODEL: &str = "HelpOffice.Supply";
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn a(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn require(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(format!("HelpOffice browser test: {message}"))
    }
}
fn equal(actual: &Value, expected: &Value, message: &str) -> Result<()> {
    require(actual == expected, message)
}
fn parse(v: &Value) -> Result<Value> {
    serde_json::from_str(v.as_str().ok_or("browser test stored JSON must be text")?)
        .map_err(|_| "browser test stored JSON is invalid".into())
}
fn encode(v: &Value) -> Result<String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}
fn id() -> Result<String> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let mut bytes = [0u8; 10];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let random = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let t = format!("{time:012x}");
    Ok(format!(
        "{}-{}-7{}-8{}-{}",
        &t[..8],
        &t[8..12],
        &random[..3],
        &random[4..7],
        &random[8..20]
    ))
}
fn refusal_error<'a>(body: &'a Value, operation_id: &str, engine: bool) -> Result<&'a Value> {
    if !engine {
        require(
            body.get("retry").is_none(),
            "pre-engine refusal issued a retry",
        )?;
        return Ok(body);
    }
    let retry = &body["retry"];
    require(
        body.as_object().is_some_and(|v| v.len() == 2)
            && body["error"].is_object()
            && body["error"]["operation_id"] == operation_id
            && retry.as_object().is_some_and(|v| v.len() == 1)
            && retry["operation_id"]
                .as_str()
                .is_some_and(|v| !v.is_empty() && v != operation_id),
        "durable refusal must retain its submitted identity and issue one fresh retry identity",
    )?;
    Ok(&body["error"])
}
fn artifact_checks(artifact: &Value) -> Result<Value> {
    artifact_field_checks(artifact)?;
    for kind in ["create", "update", "delete", "read"] {
        require(
            a(&artifact["operations"])
                .iter()
                .any(|v| v["name"] == format!("{MODEL}.{kind}") && v["kind"] == kind),
            "owning CRUD descriptor missing",
        )?;
    }
    let total = a(&artifact["operations"])
        .iter()
        .find(|v| v["name"] == "HelpOffice.total")
        .ok_or("browser test total missing")?;
    require(
        total["kind"] == "read" && total["result"]["type"] == "int",
        "owning count descriptor changed",
    )?;
    let rename = a(&artifact["operations"])
        .iter()
        .find(|v| v["name"] == "HelpOffice.rename")
        .ok_or("browser test rename missing")?;
    require(
        rename["kind"] == "scenario" && rename["result"]["type"] == "void",
        "rename scenario descriptor changed",
    )?;
    let plan = &rename["result"]["disclosure"];
    require(plan.is_object(), "rename disclosure plan missing")?;
    let callable = a(&artifact["callables"])
        .iter()
        .find(|v| v["id"] == "HelpOffice.rename" && v["kind"] == "operation")
        .ok_or("browser test rename callable missing")?;
    require(
        callable["inputStyle"] == "parameters"
            && callable["module"] == plan["source"]["module"]
            && a(&artifact["modules"])
                .iter()
                .any(|v| v["path"] == callable["module"]),
        "rename callable owner mismatch",
    )?;
    require(
        a(&plan["returns"]).iter().any(|r| {
            a(&r["intrinsics"]).iter().any(|v| {
                v["kind"] == "admitted-input" && v["parameter"] == "name" && v["type"] == "text"
            })
        }),
        "admitted name dependency missing",
    )?;
    Ok(plan.clone())
}

#[derive(Clone)]
struct Actor {
    cookie: String,
    csrf: String,
    owner: Value,
    principal: Value,
}
struct Invocation {
    status: u16,
    body: Value,
    id: String,
    inputs: Value,
    operation: String,
}
struct Harness<'a> {
    prepared: &'a preview::Prepared,
    gateway: &'a Gateway,
    origin: &'a str,
    generation: &'a str,
    call: &'a Call<'a>,
    cancel: &'a AtomicBool,
    owners: Vec<(String, String)>,
}
impl Harness<'_> {
    fn api(&self, method: &str, payload: Value) -> Result<Value> {
        (self.call)(method, Some(self.generation), payload, self.cancel)
    }
    fn sql(&self, binding: &str, sql: &str, params: Value) -> Result<Vec<Value>> {
        let value=self.api("d1.query",json!({"handle":self.prepared.recipe["runtime"]["handle"],"workerName":self.prepared.recipe["runtime"]["workerName"],"binding":binding,"sql":sql,"params":params,"mode":"all"}))?;
        value["results"]
            .as_array()
            .cloned()
            .or_else(|| value.as_array().cloned())
            .ok_or("browser test D1 result is not rows".into())
    }
    fn first(&self, binding: &str, sql: &str, params: Value) -> Result<Value> {
        Ok(self
            .sql(binding, sql, params)?
            .into_iter()
            .next()
            .unwrap_or(Value::Null))
    }
    fn snapshot(&self) -> Result<Value> {
        let mut snapshot = json!({});
        for (owner, binding) in
            std::iter::once(("Identity".to_owned(), "DB".to_owned())).chain(self.owners.clone())
        {
            let names=self.sql(&binding,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",json!([]))?;
            let mut tables = json!({});
            for row in names {
                let name = s(&row["name"]);
                if name.starts_with("_cf_") {
                    continue;
                }
                require(
                    !name.is_empty()
                        && name.bytes().enumerate().all(|(i, b)| {
                            b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit())
                        }),
                    "invalid browser test table name",
                )?;
                let rows = self.sql(&binding, &format!("SELECT * FROM \"{name}\""), json!([]))?;
                let mut rows: Vec<_> = rows.iter().map(encode).collect::<Result<_>>()?;
                rows.sort();
                tables[name] = json!(rows);
            }
            snapshot[owner] = tables;
        }
        Ok(snapshot)
    }
    fn request(
        &self,
        actor: Option<&Actor>,
        path: &str,
        body: Option<Value>,
        token: Option<&str>,
        cookie: Option<&str>,
    ) -> Result<preview::http::Response> {
        let cookies = [actor.map(|a| a.cookie.as_str()), cookie]
            .into_iter()
            .flatten()
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        let mut headers = vec![("origin", self.origin), ("cookie", cookies.as_str())];
        if body.is_some() {
            headers.push(("content-type", "application/json"));
        }
        if let Some(actor) = actor {
            headers.push(("x-csrf-token", actor.csrf.as_str()));
        }
        let bearer = token
            .filter(|v| !v.is_empty())
            .map(|v| format!("Bearer {v}"));
        if let Some(token) = &bearer {
            headers.push(("authorization", token));
        }
        if path == "/mcp" {
            headers.push(("accept", "application/json, text/event-stream"));
        }
        preview::http::request(
            &self.prepared.backend,
            self.origin,
            path,
            if body.is_some() { "POST" } else { "GET" },
            &headers,
            body.map(|v| serde_json::to_vec(&v).map_err(|e| e.to_string()))
                .transpose()?
                .unwrap_or_default(),
            self.cancel,
        )
    }
    fn login(&self, label: &str) -> Result<Actor> {
        let seed = a(&self.prepared.actors)
            .iter()
            .find(|v| v["label"] == label)
            .ok_or("browser test actor seed missing")?;
        let pre = self.request(None, "/auth/login", None, None, None)?;
        require(pre.status == 200, "login descriptor refused")?;
        let cookie = pre.cookie("can_presession")?;
        let descriptor = pre.json()?;
        let login=self.request(None,"/auth/login",Some(json!({"email":seed["email"],"password":seed["password"],"_presession":descriptor["preSessionToken"]})),None,Some(&cookie))?;
        require(login.status == 200, "actor login refused")?;
        let cookie = login.cookie("can_session")?;
        let csrf = self.api("identity.csrf", json!({"cookie":cookie}))?;
        let user = self.first(
            "DB",
            "SELECT user_id FROM identity_users WHERE email_lc=?",
            json!([s(&seed["email"]).to_lowercase()]),
        )?;
        require(!s(&user["user_id"]).is_empty(), "seeded principal missing")?;
        let mut actor = Actor {
            cookie,
            csrf: s(&csrf["csrf"]).into(),
            owner: Value::Null,
            principal: user["user_id"].clone(),
        };
        let listing = self.request(Some(&actor), "/auth/teams", None, None, None)?;
        require(listing.status == 200, "actor teams unavailable")?;
        let listing = listing.json()?;
        actor.owner = a(&listing["teams"])
            .first()
            .map(|v| v["team_id"].clone())
            .unwrap_or(Value::Null);
        if !actor.owner.is_null() {
            require(
                self.request(
                    Some(&actor),
                    "/auth/select-team",
                    Some(json!({"team":actor.owner,"_csrf":actor.csrf})),
                    None,
                    None,
                )?
                .status
                    == 200,
                "actor team selection refused",
            )?;
        }
        Ok(actor)
    }
    fn invoke(
        &self,
        actor: Option<&Actor>,
        operation: &str,
        inputs: Value,
        identity: Option<&str>,
    ) -> Result<Invocation> {
        let identity = identity.map(str::to_owned).map(Ok).unwrap_or_else(id)?;
        let reply = self.request(
            actor,
            &format!("/api/operations/{operation}"),
            Some(json!({"operation_id":identity,"inputs":inputs})),
            None,
            None,
        )?;
        Ok(Invocation {
            status: reply.status,
            body: reply.json()?,
            id: identity,
            inputs,
            operation: operation.into(),
        })
    }
    fn binding(&self, actor: &Actor) -> Result<&str> {
        self.owners
            .iter()
            .find(|(owner, _)| actor.owner == *owner)
            .map(|(_, b)| b.as_str())
            .ok_or("browser test owner DB absent".into())
    }
    fn hash_inputs(&self, inputs: &Value) -> Result<Value> {
        Ok(self.api("state.hashInputs", json!({"inputs":inputs}))?["hash"].clone())
    }
    fn refusal(
        &self,
        actor: Option<&Actor>,
        kind: &str,
        inputs: Value,
        code: &str,
        engine: bool,
    ) -> Result<()> {
        let before = self.snapshot()?;
        let reply = self.invoke(actor, &format!("{MODEL}.{kind}"), inputs, None)?;
        let after = self.snapshot()?;
        let error = refusal_error(&reply.body, &reply.id, engine)?;
        require(
            reply.status >= 400 && error["code"] == code,
            &format!(
                "{} refusal expected {code} (engine={engine}, authenticated={}, member={}); got HTTP {} code {}",
                reply.operation,
                actor.is_some(),
                actor.is_some_and(|v| !v.owner.is_null()),
                reply.status,
                error["code"],
            ),
        )?;
        if !engine {
            return equal(&after, &before, "pre-engine refusal wrote resources");
        }
        let actor = actor.ok_or("engine refusal has no actor")?;
        let receipt = self.first(
            self.binding(actor)?,
            "SELECT * FROM receipts WHERE operation_id=?",
            json!([reply.id]),
        )?;
        self.receipt(&receipt, actor, &reply.operation, &reply.inputs)?;
        equal(
            &parse(&receipt["resolved_defaults"])?,
            &json!({}),
            "refused defaults changed",
        )?;
        let rejected = parse(&receipt["outcome"])?;
        require(
            rejected["status"] == "rejected" && rejected["code"] == code,
            "canonical rejected receipt changed",
        )?;
        bookkeeping(&before, &after, actor, &receipt, &reply.id, false)?;
        Ok(())
    }
    fn receipt(
        &self,
        receipt: &Value,
        actor: &Actor,
        operation: &str,
        inputs: &Value,
    ) -> Result<()> {
        require(
            receipt["app"] == APP
                && receipt["owner"] == actor.owner
                && receipt["principal"] == actor.principal
                && receipt["operation"] == operation,
            "receipt ownership changed",
        )?;
        equal(
            &receipt["input_hash"],
            &self.hash_inputs(inputs)?,
            "receipt input hash changed",
        )
    }
}
fn rows(snapshot: &Value, owner: &str, table: &str) -> Result<Vec<Value>> {
    a(&snapshot[owner][table]).iter().map(parse).collect()
}
fn stable_except(before: &Value, after: &Value, owner: &str, tables: &[&str]) -> Result<()> {
    let b = before.as_object().ok_or("snapshot is not object")?;
    let c = after.as_object().ok_or("snapshot is not object")?;
    require(b.keys().eq(c.keys()), "snapshot owner set changed")?;
    for (key, table) in b {
        let old = table.as_object().ok_or("snapshot tables missing")?;
        let new = c[key].as_object().ok_or("snapshot owner disappeared")?;
        require(old.keys().eq(new.keys()), "snapshot table set changed")?;
        for (name, values) in old {
            if key != owner || !tables.contains(&name.as_str()) {
                equal(
                    &new[name],
                    values,
                    &format!("unrelated resource changed: {key}/{name}"),
                )?;
            }
        }
    }
    Ok(())
}
fn bookkeeping(
    before: &Value,
    after: &Value,
    actor: &Actor,
    receipt: &Value,
    operation_id: &str,
    domain: bool,
) -> Result<()> {
    let owner = s(&actor.owner);
    let old = rows(before, owner, "receipts")?;
    let new = rows(after, owner, "receipts")?;
    require(new.len() == old.len() + 1, "receipt cardinality changed")?;
    equal(
        &json!(
            new.iter()
                .filter(|v| v["operation_id"] != operation_id)
                .collect::<Vec<_>>()
        ),
        &json!(old),
        "unrelated receipts changed",
    )?;
    require(
        receipt["operation_id"] == operation_id,
        "receipt operation ID mismatch",
    )?;
    let fence = rows(before, owner, "fence")?
        .into_iter()
        .next()
        .ok_or("fence absent")?;
    let next = rows(after, owner, "fence")?
        .into_iter()
        .next()
        .ok_or("next fence absent")?;
    let mut expected = fence.clone();
    expected["revision"] = json!(fence["revision"].as_u64().ok_or("invalid fence revision")? + 1);
    equal(&next, &expected, "fence changed beyond revision")?;
    equal(
        &receipt["committed_revision"],
        &next["revision"],
        "committed revision mismatch",
    )?;
    let log = rows(before, owner, "fence_log")?;
    let next_log = rows(after, owner, "fence_log")?;
    require(
        next_log.len() == log.len() + 1,
        "fence log cardinality changed",
    )?;
    equal(
        &json!(
            next_log
                .iter()
                .filter(|v| v["revision"] != next["revision"])
                .collect::<Vec<_>>()
        ),
        &json!(log),
        "unrelated fence log changed",
    )?;
    equal(
        next_log
            .iter()
            .find(|v| v["revision"] == next["revision"])
            .ok_or("fence log entry missing")?,
        &json!({"revision":next["revision"],"operation":receipt["operation"],"at":receipt["created_at"]}),
        "fence log operation changed",
    )?;
    stable_except(
        before,
        after,
        owner,
        if domain {
            &["records", "receipts", "history", "fence", "fence_log"]
        } else {
            &["receipts", "fence", "fence_log"]
        },
    )
}
fn artifact_field_checks(artifact: &Value) -> Result<()> {
    let supply = a(&artifact["models"])
        .iter()
        .find(|v| v["name"] == MODEL)
        .ok_or("browser test Supply model missing")?;
    require(
        a(&supply["fields"]).len() == 5,
        "Supply must have five fields",
    )?;
    let field = |name: &str| {
        a(&supply["fields"])
            .iter()
            .find(|v| v["name"] == name)
            .ok_or("browser test field missing")
    };
    let name = field("name")?;
    let quantity = field("quantity")?;
    let available = field("available")?;
    require(
        name["field"]["kind"] == "string"
            && name["trim"] == true
            && quantity["field"]["kind"] == "integer"
            && quantity["nullable"] == true
            && available["field"]["kind"] == "boolean",
        "fixture field declarations changed",
    )?;
    equal(
        &available["default"],
        &json!({"kind":"literal","value":true}),
        "available default changed",
    )?;
    Ok(())
}

mod browser;

pub(crate) fn test_browser(
    prepared: &preview::Prepared,
    artifact: &Value,
    capture: &Capture,
    gateway: &Gateway,
    generation: &str,
    call: &Call<'_>,
    cancel: &AtomicBool,
) -> Result<Value> {
    artifact_checks(artifact)?;
    let owners = a(&prepared.recipe["runtime"]["owners"])
        .iter()
        .map(|owner| {
            (
                s(&owner["owner"]).to_owned(),
                s(&owner["binding"]).to_owned(),
            )
        })
        .collect();
    let h = Harness {
        prepared,
        gateway,
        origin: gateway.origin(),
        generation,
        call,
        cancel,
        owners,
    };
    let expected = [
        h.login("Ava")?,
        h.login("Ben")?,
        h.login("Cal")?,
        h.login("Dee")?,
    ];
    browser::run(&h, artifact, capture, &expected, &json!({"id":id()?}))?;
    Ok(json!({"passed":true}))
}
