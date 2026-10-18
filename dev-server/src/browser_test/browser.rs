//! Protected browser journeys using fixed Playwright SDK primitives.
use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

fn captured_identity(fixture: &Capture) -> Result<Option<Value>> {
    let input = |name: &str| fixture.inputs.iter().find(|v| v.name == name);
    let Some(producer) = input("extra:browser:producer") else {
        return Ok(None);
    };
    let Some(driver) = input("extra:browser:driver-entry") else {
        return Ok(None);
    };
    let Some(executable) = input("extra:browser:executable") else {
        return Ok(None);
    };
    if [producer, driver, executable]
        .iter()
        .any(|v| v.state == "missing")
    {
        return Ok(None);
    }
    for captured in [producer, driver, executable] {
        require(
            captured.state == "present" && captured.sha256.is_some(),
            "browser producer input is unreadable",
        )?;
        let path = captured
            .canonical_path
            .as_deref()
            .ok_or("browser producer path is absent")?;
        require(
            fs::canonicalize(path).map_err(|e| e.to_string())? == Path::new(path),
            "browser producer path changed",
        )?;
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        require(
            metadata.is_file(),
            "browser producer input must be a regular file",
        )?;
    }
    let executable_path = executable.canonical_path.as_deref().unwrap();
    require(
        fs::metadata(executable_path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o111
            != 0,
        "captured browser is not executable",
    )?;
    Ok(Some(
        json!({"driverEntryPath":driver.canonical_path,"executablePath":executable.canonical_path}),
    ))
}
#[derive(Clone)]
struct Session {
    context: String,
    page: String,
}
#[derive(Clone)]
struct Locator {
    selector: String,
    chain: Vec<Value>,
}
impl Locator {
    fn new(selector: &str) -> Self {
        Self {
            selector: selector.into(),
            chain: Vec::new(),
        }
    }
    fn child(&self, selector: &str) -> Self {
        let mut n = self.clone();
        n.chain.push(json!({"selector":selector}));
        n
    }
    fn first(&self) -> Self {
        let mut n = self.clone();
        n.chain.push(json!({"first":true}));
        n
    }
    fn nth(&self, index: usize) -> Self {
        let mut n = self.clone();
        n.chain.push(json!({"nth":index}));
        n
    }
    fn filter(&self, name: &str) -> Self {
        let mut n = self.clone();
        n.chain.push(json!({"hasText":name}));
        n
    }
    fn call(&self, h: &Harness<'_>, page: &str, method: &str, value: Value) -> Result<Value> {
        h.api("browser.locator",json!({"page":page,"selector":self.selector,"chain":self.chain,"method":method,"value":value}))
    }
    fn count(&self, h: &Harness<'_>, page: &str) -> Result<usize> {
        self.call(h, page, "count", Value::Null)?
            .as_u64()
            .map(|v| v as usize)
            .ok_or("browser count not integer".into())
    }
    fn text(&self, h: &Harness<'_>, page: &str, method: &str) -> Result<String> {
        self.call(h, page, method, Value::Null)?
            .as_str()
            .map(str::to_owned)
            .ok_or("browser result not text".into())
    }
}
fn rows() -> Locator {
    Locator::new("li.list-row")
}
fn row(name: &str) -> Locator {
    rows().filter(name)
}
fn value(name: &str, quantity: Option<&str>, available: bool) -> Value {
    json!({"name":name,"quantity":quantity,"available":available})
}
fn strip(v: &str) -> String {
    v.replace(['\u{2068}', '\u{2069}'], "")
}
fn normalize(v: &str) -> String {
    strip(v).split_whitespace().collect::<Vec<_>>().join(" ")
}
fn overview(h: &Harness<'_>, session: &Session, visible: &[Value], all: &[Value]) -> Result<()> {
    equal(
        &h.api("browser.title", json!({"page":session.page}))?,
        &json!("Office supplies — HelpOffice"),
        "browser page title and app brand changed",
    )?;
    let page = session.page.as_str();
    equal(
        &Locator::new("main#can-main > section.card > .card-body > h2.card-title").call(
            h,
            page,
            "allTextContents",
            Value::Null,
        )?,
        &json!(["Add a supply", "Team supplies"]),
        "authored card headings changed",
    )?;
    require(
        rows().count(h, page)? == visible.len(),
        "visible browser row count changed",
    )?;
    let inputs =
        rows().child("form[action*=\"Supply.update\"] input[name=\"inputs[changes][name]\"]");
    let mut names = Vec::new();
    for i in 0..inputs.count(h, page)? {
        names.push(inputs.nth(i).text(h, page, "inputValue")?);
    }
    let mut expected: Vec<_> = visible.iter().map(|v| s(&v["name"]).to_owned()).collect();
    expected.sort();
    equal(
        &json!(names),
        &json!(expected),
        "authored name ordering changed",
    )?;
    for item in visible {
        overview_item(h, page, item)?;
    }
    equal(
        &json!(strip(&Locator::new(".stat-value").text(h, page, "innerText")?).trim()),
        &json!(all.len().to_string()),
        "authored stat must count all rows",
    )?;
    equal(
        &json!(
            Locator::new(".stat-desc")
                .text(h, page, "innerText")?
                .trim()
        ),
        &json!("Visible supplies"),
        "authored stat description changed",
    )?;
    overview_table(h, page, all)
}
fn goto(h: &Harness<'_>, page: &str, url: &str) -> Result<Value> {
    h.api(
        "browser.goto",
        json!({"page":page,"url":url,"waitUntil":"domcontentloaded"}),
    )
}
fn reload(h: &Harness<'_>, session: &Session) -> Result<()> {
    require(
        goto(h, &session.page, h.origin)?["status"] == 200,
        "member browser page did not serve",
    )?;
    Locator::new("form[action*=\"Supply.create\"]")
        .first()
        .call(h, &session.page, "waitFor", json!({"state":"visible"}))?;
    Ok(())
}
fn readonly(h: &Harness<'_>, action: impl FnOnce() -> Result<()>) -> Result<()> {
    let before = h.snapshot()?;
    action()?;
    equal(
        &h.snapshot()?,
        &before,
        "browser read-only phase wrote resources",
    )
}
fn submit(h: &Harness<'_>, session: &Session, form: &Locator, operation: &str) -> Result<()> {
    let reply=h.api("browser.submit",json!({"page":session.page,"selector":form.selector,"chain":form.chain,"operation":format!("HelpOffice.Supply.{operation}")}))?;
    require(
        reply["status"] == 200,
        "generated browser operation did not commit",
    )?;
    reload(h, session)
}
fn no_names(h: &Harness<'_>, page: &str, initial: &[Value]) -> Result<()> {
    let body = Locator::new("body").text(h, page, "innerText")?;
    require(
        initial.iter().all(|v| !body.contains(s(&v["name"]))),
        "foreign/anonymous browser disclosed initial names",
    )
}
fn refused(
    h: &Harness<'_>,
    session: &Session,
    url: &str,
    recovery: &str,
    initial: &[Value],
) -> Result<()> {
    browser_recovery(h, session, url, recovery)?;
    refused_content(h, &session.page, initial)
}
fn refused_content(h: &Harness<'_>, page: &str, initial: &[Value]) -> Result<()> {
    require(Locator::new("form[action*=\"Supply.create\"], form[action*=\"Supply.update\"], form[action*=\"Supply.delete\"]").count(h,page)?==0,"refused page disclosed mutation forms")?;
    require(
        rows().count(h, page)? == 0 && Locator::new("table.table").count(h, page)? == 0,
        "refused page disclosed read projections",
    )?;
    no_names(h, page, initial)
}
fn browser_recovery(h: &Harness<'_>, session: &Session, url: &str, recovery: &str) -> Result<()> {
    let navigation = goto(h, &session.page, url)?;
    require(
        navigation["status"] == 200
            && navigation["url"] == format!("{}{recovery}", h.origin)
            && navigation["json"].is_null(),
        "refused browser page must reach owning authentication recovery",
    )?;
    forbidden_resource(h, session)
}
fn forbidden_resource(h: &Harness<'_>, session: &Session) -> Result<()> {
    let reply = browser_request(h, &session.context, "GET", "/", Value::Null, None)?;
    require(
        reply["status"] == 403 && reply["json"]["code"] == "forbidden",
        "page without active membership must expose owning forbidden envelope",
    )?;
    Ok(())
}
fn anonymous_recovery_write(
    before: &Value,
    after: &Value,
    cookie: &str,
    origin: &str,
    started: u64,
    finished: u64,
) -> Result<()> {
    presession_write(before, after, cookie)?;
    let previous = super::rows(before, "Identity", "can_auth_rate_limits")?;
    let current = super::rows(after, "Identity", "can_auth_rate_limits")?;
    let changed: Vec<_> = current.iter().filter(|v| !previous.contains(v)).collect();
    require(
        changed.len() == 1,
        "anonymous recovery must update one auth descriptor window",
    )?;
    let counter = changed[0];
    require(
        counter.as_object().is_some_and(|v| v.len() == 6)
            && counter["scope"] == origin
            && s(&counter["key"])
                .strip_prefix("/auth/login/descriptor:")
                .is_some_and(|v| !v.is_empty())
            && counter["limit_count"] == 10
            && counter["window_ms"] == 60_000
            && counter["hits"]
                .as_u64()
                .is_some_and(|v| (1..=10).contains(&v)),
        "anonymous recovery changed an unrelated auth counter",
    )?;
    let same_window = |v: &&Value| {
        ["scope", "key", "limit_count", "window_ms"]
            .iter()
            .all(|key| v[*key] == counter[*key])
    };
    auth_window_transition(&previous, counter, started, finished)?;
    let removed: Vec<_> = previous
        .iter()
        .filter(|v| !same_window(v) && !current.contains(v))
        .collect();
    require(
        removed.len() <= 64
            && removed.iter().all(|v| {
                v["scope"] == origin
                    && v["expires"]
                        .as_u64()
                        .is_some_and(|expiry| expiry <= finished)
            }),
        "anonymous recovery removed a live or unrelated auth window",
    )?;
    stable_except(
        before,
        after,
        "Identity",
        &["identity_presession_tokens", "can_auth_rate_limits"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_recovery_allows_only_one_cookie_bound_presession_write() {
        let counter = json!({"scope":"http://preview","key":"/auth/login/descriptor:unknown","limit_count":10,"window_ms":60_000,"hits":1,"expires":61_000});
        let before = json!({"Identity":{"identity_presession_tokens":[],"identity_sessions":[],"can_auth_rate_limits":[encode(&counter).unwrap()]},"owner":{"records":[]}});
        let mut after = before.clone();
        let mut next_counter = counter.clone();
        next_counter["hits"] = json!(2);
        after["Identity"]["can_auth_rate_limits"] = json!([encode(&next_counter).unwrap()]);
        after["Identity"]["identity_presession_tokens"] = json!([encode(&json!({
            "token_id":"token","token_sha256":capture::hash(b"cookie"),
            "created_at":"2026-10-18T10:00:00.000Z","expires_at":"2026-10-18T10:10:00.000Z"
        }))
        .unwrap()]);
        let check = |after: &Value, cookie| {
            anonymous_recovery_write(&before, after, cookie, "http://preview", 1_000, 2_000)
        };
        check(&after, "cookie").unwrap();
        assert!(check(&after, "other-cookie").is_err());
        let mut leaked = after.clone();
        leaked["owner"]["records"] = json!(["domain write"]);
        assert!(check(&leaked, "cookie").is_err());
        leaked = after.clone();
        leaked["Identity"]["identity_sessions"] = json!(["session write"]);
        assert!(check(&leaked, "cookie").is_err());
        leaked = after.clone();
        next_counter["key"] = json!("/auth/login:unknown");
        leaked["Identity"]["can_auth_rate_limits"] = json!([encode(&next_counter).unwrap()]);
        assert!(check(&leaked, "cookie").is_err());
        after["Identity"]["identity_presession_tokens"] = json!([]);
        assert!(check(&after, "cookie").is_err());
    }
}
fn browser_request(
    h: &Harness<'_>,
    context: &str,
    method: &str,
    path: &str,
    data: Value,
    csrf: Option<&str>,
) -> Result<Value> {
    let mut headers = json!({"origin":h.origin,"accept":"application/json"});
    if let Some(csrf) = csrf {
        headers["x-csrf-token"] = json!(csrf);
    }
    h.api("browser.request",json!({"context":context,"method":method,"url":format!("{}{path}",h.origin),"headers":headers,"data":data,"timeout":10000}))
}
fn new_session(h: &Harness<'_>, browser: &str, contexts: &mut Vec<String>) -> Result<Session> {
    let context = format!("context-{}", preview::random_id()?);
    contexts.push(context.clone());
    h.api(
        "browser.newContext",
        json!({"browser":browser,"handle":context,"timeout":10000,"navigationTimeout":15000}),
    )?;
    let page = format!("page-{}", preview::random_id()?);
    h.api("browser.newPage", json!({"context":context,"handle":page}))?;
    Ok(Session { context, page })
}

fn mutation(
    h: &Harness<'_>,
    actor: &Actor,
    kind: &str,
    expected: &Value,
    action: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let before = h.snapshot()?;
    action()?;
    let after = h.snapshot()?;
    let owner = s(&actor.owner);
    let (receipt, outcome) = mutation_receipt(&before, &after, actor, kind)?;
    let old_records = super::rows(&before, owner, "records")?;
    let new_records = super::rows(&after, owner, "records")?;
    let changed: Vec<_> = new_records
        .iter()
        .filter(|v| !old_records.contains(v))
        .collect();
    require(
        changed.len() == 1,
        "browser operation must change exactly one record",
    )?;
    let current = changed[0];
    require(current["model"] == MODEL, "browser changed a foreign model")?;
    let original = old_records.iter().find(|v| v["id"] == current["id"]);
    let reference = original.map(|v| json!({"id":v["id"],"version":v["version"].to_string()}));
    let data = json!({"name":expected["name"],"quantity":expected["quantity"],"available":expected["available"],"stock":"0","locked":false});
    let submitted = mutation_inputs(kind, expected, reference);
    equal(
        &receipt["input_hash"],
        &h.hash_inputs(&submitted)?,
        "browser generated form source inputs changed",
    )?;
    equal(
        &parse(&current["data"])?,
        &data,
        "browser physical data changed",
    )?;
    mutation_record(
        actor,
        kind,
        &receipt,
        &old_records,
        &new_records,
        current,
        original,
    )?;
    mutation_history(&before, &after, actor, &receipt, current, original, &data)?;
    equal(
        &outcome["recordVersions"],
        &json!([{"model":MODEL,"id":current["id"],"version":current["version"]}]),
        "browser record version receipt changed",
    )?;
    let replay = h.invoke(
        Some(actor),
        &format!("{MODEL}.{kind}"),
        submitted,
        Some(s(&receipt["operation_id"])),
    )?;
    require(
        replay.status == 200 && replay.body["status"] == "replayed",
        "browser envelope did not replay",
    )?;
    equal(&h.snapshot()?, &after, "browser replay wrote resources")
}
fn preference(
    h: &Harness<'_>,
    actor: &Actor,
    owner: &str,
    value: &str,
    action: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let before = h.snapshot()?;
    action()?;
    let after = h.snapshot()?;
    let old = super::rows(&before, "Identity", "page_preferences")?;
    let new = super::rows(&after, "Identity", "page_preferences")?;
    let matches = |v: &&Value| {
        v["app_id"] == APP
            && v["actor_user_id"] == actor.principal
            && v["team_id"] == actor.owner
            && v["owner"] == owner
            && v["field"] == "view"
    };
    let previous: Vec<_> = old.iter().filter(matches).collect();
    let selected: Vec<_> = new.iter().filter(matches).collect();
    require(
        selected.len() == 1,
        "browser preference physical selection missing",
    )?;
    equal(
        selected[0],
        &json!({"app_id":APP,"actor_user_id":actor.principal,"team_id":actor.owner,"owner":owner,"field":"view","value":value,"version":previous.first().and_then(|v|v["version"].as_u64()).unwrap_or(0)+1}),
        "browser preference scope/version/value changed",
    )?;
    equal(
        &json!(new.iter().filter(|v| !matches(v)).collect::<Vec<_>>()),
        &json!(old.iter().filter(|v| !matches(v)).collect::<Vec<_>>()),
        "browser changed unrelated preferences",
    )?;
    stable_except(&before, &after, "Identity", &["page_preferences"])
}

pub(super) fn run(
    h: &Harness<'_>,
    artifact: &Value,
    fixture: &Capture,
    expected: &[Actor; 4],
    nullable: &Value,
) -> Result<()> {
    let Some(identity) = captured_identity(fixture)? else {
        return Ok(());
    };
    let pages: Vec<_> = a(&artifact["pages"])
        .iter()
        .filter(|v| v["path"] == "/")
        .collect();
    require(
        pages.len() == 1 && pages[0]["owner"] == APP,
        "browser needs actual owning compiled root page",
    )?;
    let browser = format!("browser-{}", preview::random_id()?);
    let mut contexts = Vec::new();
    let lease = h.api(
        "browser.launch",
        json!({"root":fixture.root,"handle":browser,"identity":identity}),
    )?;
    equal(
        &lease["identity"],
        &identity,
        "launched browser identity changed",
    )?;
    let result = browser_journey(h, &browser, &mut contexts, expected, nullable);
    let cleanup = AtomicBool::new(false);
    let mut close_error = None;
    for context in contexts {
        if let Err(e) = (h.call)(
            "browser.close",
            Some(h.generation),
            json!({"handle":context}),
            &cleanup,
        ) {
            close_error = Some(e);
        }
    }
    let closed = (h.call)(
        "browser.close",
        Some(h.generation),
        json!({"handle":browser}),
        &cleanup,
    );
    if let Some(error) = close_error {
        return Err(error);
    }
    let closed = closed?;
    require(closed["connected"] == false, "test browser must disconnect")?;
    result?;
    capture::check_cancel(h.cancel)?;
    Ok(())
}

fn overview_item(h: &Harness<'_>, page: &str, item: &Value) -> Result<()> {
    let actual = row(s(&item["name"]));
    require(
        actual.count(h, page)? == 1,
        "authored row must appear exactly once",
    )?;
    let text = actual.child("p").first().text(h, page, "innerText")?;
    equal(
        &json!(normalize(&text)),
        &json!(normalize(&format!(
            "{} {} {}",
            s(&item["name"]),
            s(&item["quantity"]),
            item["available"]
        ))),
        "authored row name/quantity/availability changed",
    )?;
    let form = actual.child("form[action*=\"Supply.update\"]").first();
    equal(
        &form.child("input[name=\"inputs[changes][name]\"]").call(
            h,
            page,
            "inputValue",
            Value::Null,
        )?,
        &item["name"],
        "edit name differs from physical row",
    )?;
    equal(
        &form
            .child("input[name=\"inputs[changes][quantity]\"]")
            .call(h, page, "inputValue", Value::Null)?,
        &json!(s(&item["quantity"])),
        "edit nullable quantity differs from physical row",
    )?;
    equal(
        &form
            .child("input[name=\"inputs[changes][available]\"]")
            .call(h, page, "isChecked", Value::Null)?,
        &item["available"],
        "edit availability differs from physical row",
    )?;
    Ok(())
}

fn overview_table(h: &Harness<'_>, page: &str, all: &[Value]) -> Result<()> {
    if all.is_empty() {
        for text in ["No supplies", "No stock"] {
            require(
                Locator::new(&format!("text=\"{text}\"")).count(h, page)? > 0,
                "authored list/table empty state missing",
            )?;
        }
    } else {
        let table = Locator::new("table.table");
        require(table.count(h, page)? == 1, "authored table missing")?;
        equal(
            &table
                .child("thead th")
                .call(h, page, "allTextContents", Value::Null)?,
            &json!(["name", "stock", "available"]),
            "authored table columns changed",
        )?;
        require(
            table.child("tbody tr").count(h, page)? == all.len(),
            "table was filtered by list preference",
        )?;
        for item in all {
            let row = table.child("tbody tr").filter(s(&item["name"]));
            require(row.count(h, page)? == 1, "table physical row missing")?;
            let cells = row
                .child("td")
                .call(h, page, "allTextContents", Value::Null)?;
            equal(
                &json!(a(&cells).iter().map(|v| strip(s(v))).collect::<Vec<_>>()),
                &json!([
                    s(&item["name"]),
                    "0",
                    if item["available"] == true {
                        "true"
                    } else {
                        "false"
                    }
                ]),
                "table physical values changed",
            )?;
        }
    }
    Ok(())
}

fn presession_write(before: &Value, after: &Value, cookie: &str) -> Result<()> {
    let old = super::rows(before, "Identity", "identity_presession_tokens")?;
    let new = super::rows(after, "Identity", "identity_presession_tokens")?;
    let added: Vec<_> = new.iter().filter(|v| !old.contains(v)).collect();
    require(
        new.len() == old.len() + 1 && old.iter().all(|v| new.contains(v)) && added.len() == 1,
        "anonymous recovery must add exactly one presession token",
    )?;
    let row = added[0];
    require(
        row.as_object().is_some_and(|v| v.len() == 4)
            && !cookie.is_empty()
            && !s(&row["token_id"]).is_empty()
            && row["token_sha256"] == capture::hash(cookie.as_bytes())
            && !s(&row["created_at"]).is_empty()
            && s(&row["expires_at"]) > s(&row["created_at"]),
        "anonymous recovery presession must match its actual browser cookie",
    )?;
    Ok(())
}

fn auth_window_transition(
    previous: &[Value],
    counter: &Value,
    started: u64,
    finished: u64,
) -> Result<()> {
    let same_window = |v: &&Value| {
        ["scope", "key", "limit_count", "window_ms"]
            .iter()
            .all(|key| v[*key] == counter[*key])
    };
    let old_counter = previous.iter().find(same_window);
    let fresh = counter["hits"] == 1
        && counter["expires"].as_u64().is_some_and(|v| {
            started.checked_add(60_000).is_some_and(|min| v >= min)
                && finished.checked_add(60_000).is_some_and(|max| v <= max)
        });
    require(
        match old_counter {
            Some(old) => old["expires"].as_u64().is_some_and(|expires| {
                expires > started
                    && counter["expires"] == old["expires"]
                    && old["hits"].as_u64().and_then(|v| v.checked_add(1))
                        == counter["hits"].as_u64()
                    || expires <= finished && fresh
            }),
            None => fresh,
        },
        "anonymous recovery auth window did not record exactly one attempt",
    )?;
    Ok(())
}

fn mutation_receipt(
    before: &Value,
    after: &Value,
    actor: &Actor,
    kind: &str,
) -> Result<(Value, Value)> {
    let owner = s(&actor.owner);
    let old = super::rows(&before, owner, "receipts")?;
    let new = super::rows(&after, owner, "receipts")?;
    let added: Vec<_> = new.iter().filter(|v| !old.contains(v)).collect();
    require(
        added.len() == 1,
        "browser operation must add exactly one receipt",
    )?;
    let receipt = added[0];
    let outcome = parse(&receipt["outcome"])?;
    require(
        receipt["operation"] == format!("{MODEL}.{kind}")
            && receipt["principal"] == actor.principal
            && receipt["app"] == APP
            && receipt["owner"] == actor.owner
            && outcome["status"] == "committed",
        "browser receipt authority/status changed",
    )?;
    bookkeeping(
        &before,
        &after,
        actor,
        receipt,
        s(&receipt["operation_id"]),
        true,
    )?;
    Ok((receipt.clone(), outcome))
}

fn mutation_record(
    actor: &Actor,
    kind: &str,
    receipt: &Value,
    old_records: &[Value],
    new_records: &[Value],
    current: &Value,
    original: Option<&Value>,
) -> Result<()> {
    require(
        current["updated_by"] == actor.principal && current["updated"] == receipt["created_at"],
        "browser update attribution changed",
    )?;
    equal(
        &current["archived_at"],
        &if kind == "delete" {
            receipt["created_at"].clone()
        } else {
            Value::Null
        },
        "browser archive attribution changed",
    )?;
    if kind == "create" {
        require(
            original.is_none()
                && current["version"] == 1
                && new_records.len() == old_records.len() + 1,
            "browser create row cardinality/version changed",
        )?;
    } else {
        let old = original.ok_or("browser mutation original absent")?;
        require(
            old["archived_at"].is_null() && new_records.len() == old_records.len(),
            "browser update/archive cardinality changed",
        )?;
        let mut expected_stored = old.clone();
        expected_stored["version"] = json!(
            old["version"]
                .as_u64()
                .ok_or("browser original version invalid")?
                + 1
        );
        expected_stored["data"] = current["data"].clone();
        expected_stored["updated"] = receipt["created_at"].clone();
        expected_stored["updated_by"] = actor.principal.clone();
        if kind == "delete" {
            expected_stored["archived_at"] = receipt["created_at"].clone();
        }
        equal(
            current,
            &expected_stored,
            "browser mutation changed unrelated record metadata",
        )?;
    }
    equal(
        &json!(
            new_records
                .iter()
                .filter(|v| v["id"] != current["id"])
                .collect::<Vec<_>>()
        ),
        &json!(
            old_records
                .iter()
                .filter(|v| v["id"] != current["id"])
                .collect::<Vec<_>>()
        ),
        "browser changed unrelated records",
    )?;
    Ok(())
}

fn mutation_history(
    before: &Value,
    after: &Value,
    actor: &Actor,
    receipt: &Value,
    current: &Value,
    original: Option<&Value>,
    data: &Value,
) -> Result<()> {
    let owner = s(&actor.owner);
    let old_history = super::rows(&before, owner, "history")?;
    let history = super::rows(&after, owner, "history")?;
    let entries: Vec<_> = history
        .iter()
        .filter(|v| v["operation_id"] == receipt["operation_id"])
        .collect();
    require(
        entries.len() == 1 && history.len() == old_history.len() + 1,
        "browser history cardinality changed",
    )?;
    let entry = entries[0];
    require(
        entry["model"] == MODEL
            && entry["record_id"] == current["id"]
            && entry["operation"] == receipt["operation"]
            && entry["version"] == current["version"]
            && entry["actor"] == actor.principal,
        "browser history authority changed",
    )?;
    equal(
        &if entry["before"].is_null() {
            Value::Null
        } else {
            parse(&entry["before"])?
        },
        &original
            .map(|v| parse(&v["data"]))
            .transpose()?
            .unwrap_or(Value::Null),
        "browser history before changed",
    )?;
    equal(
        &parse(&entry["after"])?,
        &data,
        "browser history after changed",
    )?;
    equal(
        &json!(
            history
                .iter()
                .filter(|v| v["operation_id"] != receipt["operation_id"])
                .collect::<Vec<_>>()
        ),
        &json!(old_history),
        "browser changed unrelated history",
    )?;
    Ok(())
}

fn mutation_inputs(kind: &str, expected: &Value, reference: Option<Value>) -> Value {
    if kind == "create" {
        let mut v = json!({"name":expected["name"]});
        if !expected["quantity"].is_null() {
            v["quantity"] = expected["quantity"].clone();
        }
        v
    } else if kind == "delete" {
        json!({"record":reference})
    } else {
        json!({"record":reference,"name":expected["name"],"quantity":expected["quantity"],"available":expected["available"]})
    }
}

fn authenticated_sessions(
    h: &Harness<'_>,
    browser: &str,
    contexts: &mut Vec<String>,
    expected: &[Actor; 4],
) -> Result<(Vec<Session>, Vec<Actor>)> {
    let mut sessions = Vec::new();
    let mut actors = Vec::new();
    for (index, label) in ["Ava", "Ben", "Cal", "Dee"].iter().enumerate() {
        let session = new_session(h, browser, contexts)?;
        let actor = login_session(h, &session, label, &expected[index])?;
        sessions.push(session);
        actors.push(actor);
    }
    Ok((sessions, actors))
}

fn login_session(h: &Harness<'_>, session: &Session, label: &str, actor: &Actor) -> Result<Actor> {
    let access = h.gateway.mint_access().map_err(|e| e.to_string())?;
    browser_recovery(h, &session, &access, "/auth/login")?;
    let seed = a(&h.prepared.actors)
        .iter()
        .find(|v| v["label"] == label)
        .ok_or("browser seed absent")?;
    let presession = Locator::new("form[action=\"/auth/login\"] input[name=\"_presession\"]")
        .text(h, &session.page, "inputValue")?;
    require(
        !presession.is_empty(),
        "owning browser login form lacks presession token",
    )?;
    let logged = browser_request(
        h,
        &session.context,
        "POST",
        "/auth/login",
        json!({"email":seed["email"],"password":seed["password"],"_presession":presession}),
        None,
    )?;
    require(logged["status"] == 200, "browser login refused")?;
    let cookies = h.api("browser.cookies", json!({"context":session.context}))?;
    let cookie = a(&cookies)
        .iter()
        .find(|v| v["name"] == "can_session")
        .ok_or("browser session cookie absent")?;
    let cookie = format!("can_session={}", s(&cookie["value"]));
    let csrf = h.api("identity.csrf", json!({"cookie":cookie}))?;
    select_actor_team(h, session, actor, &csrf)?;
    let identity=h.api("identity.resolve",json!({"handle":h.prepared.recipe["runtime"]["handle"],"workerName":h.prepared.recipe["runtime"]["workerName"],"binding":"DB","cookie":cookie}))?;
    equal(
        &identity["actor"]["user_id"],
        &actor.principal,
        "browser session principal mismatch",
    )?;
    equal(
        &identity["team"]["team_id"],
        &actor.owner,
        "browser session owner mismatch",
    )?;
    equal(
        &identity["membership"]["status"],
        &if actor.owner.is_null() {
            Value::Null
        } else {
            json!("active")
        },
        "browser membership not active",
    )?;
    Ok(Actor {
        cookie,
        csrf: s(&csrf["csrf"]).into(),
        ..actor.clone()
    })
}

fn epoch_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "browser authentication clock exceeds supported range".into())
}

fn anonymous_admission(
    h: &Harness<'_>,
    browser: &str,
    contexts: &mut Vec<String>,
    initial: &[Value],
) -> Result<()> {
    let anonymous_started = epoch_ms()?;
    let before_anonymous = h.snapshot()?;
    let anonymous = new_session(h, browser, contexts)?;
    browser_recovery(
        h,
        &anonymous,
        &h.gateway.mint_access().map_err(|e| e.to_string())?,
        "/auth/login",
    )?;
    let cookies = h.api("browser.cookies", json!({"context":anonymous.context}))?;
    let presession = a(&cookies)
        .iter()
        .find(|v| v["name"] == "can_presession")
        .ok_or("anonymous login recovery lacks presession cookie")?;
    anonymous_recovery_write(
        &before_anonymous,
        &h.snapshot()?,
        s(&presession["value"]),
        h.origin,
        anonymous_started,
        epoch_ms()?,
    )?;
    readonly(h, || {
        forbidden_resource(h, &anonymous)?;
        refused_content(h, &anonymous.page, initial)?;
        require(
            !a(&cookies).iter().any(|v| v["name"] == "can_session"),
            "anonymous refusal synthesized Identity session",
        )
    })?;
    Ok(())
}

fn browser_admission(
    h: &Harness<'_>,
    browser: &str,
    contexts: &mut Vec<String>,
    expected: &[Actor; 4],
    sessions: &[Session],
) -> Result<Vec<Value>> {
    require(
        !expected[0].owner.is_null()
            && expected[0].owner == expected[1].owner
            && !expected[2].owner.is_null()
            && expected[2].owner != expected[0].owner
            && expected[3].owner.is_null(),
        "browser identity security matrix changed",
    )?;
    let initial=h.sql(h.binding(&expected[0])?,"SELECT data FROM records WHERE model=? AND archived_at IS NULL",json!([MODEL]))?.iter().map(|v|{let data=parse(&v["data"])?;Ok(json!({"name":data["name"],"quantity":data["quantity"],"available":data["available"]==true}))}).collect::<Result<Vec<_>>>()?;
    let ava = &sessions[0];
    let ben = &sessions[1];
    readonly(h, || {
        reload(h, &sessions[2])?;
        overview(h, &sessions[2], &[], &[])?;
        no_names(h, &sessions[2].page, &initial)?;
        refused(h, &sessions[3], h.origin, "/auth/select-team", &initial)
    })?;
    anonymous_admission(h, browser, contexts, &initial)?;
    readonly(h, || {
        reload(h, ava)?;
        reload(h, ben)?;
        overview(h, ava, &initial, &initial)
    })?;
    Ok(initial)
}

fn remove_supply(h: &Harness<'_>, actor: &Actor, session: &Session, item: &Value) -> Result<()> {
    mutation(h, actor, "delete", item, || {
        let form = row(s(&item["name"])).child("form[action*=\"Supply.delete\"]");
        require(
            form.count(h, &session.page)? == 1,
            "authored delete form missing",
        )?;
        submit(h, session, &form, "delete")
    })
}

fn create_supply(h: &Harness<'_>, actor: &Actor, session: &Session, item: &Value) -> Result<()> {
    mutation(h, actor, "create", item, || {
        let form = Locator::new("form[action*=\"Supply.create\"]").first();
        require(
            form.count(h, &session.page)? == 1,
            "inline create form missing",
        )?;
        form.child("input[name=\"inputs[name]\"]").call(
            h,
            &session.page,
            "fill",
            item["name"].clone(),
        )?;
        form.child("input[name=\"inputs[quantity]\"]").call(
            h,
            &session.page,
            "fill",
            json!(s(&item["quantity"])),
        )?;
        submit(h, session, &form, "create")
    })
}

fn edit_supply(
    h: &Harness<'_>,
    actor: &Actor,
    session: &Session,
    before: &Value,
    after: &Value,
) -> Result<()> {
    mutation(h, actor, "update", after, || {
        let actual = row(s(&before["name"]));
        let form = actual.child("form[action*=\"Supply.update\"]").first();
        require(
            form.count(h, &session.page)? == 1,
            "authored row edit form missing",
        )?;
        actual
            .child("label.drawer-button")
            .call(h, &session.page, "click", Value::Null)?;
        form.child("input[name=\"inputs[changes][name]\"]").call(
            h,
            &session.page,
            "fill",
            after["name"].clone(),
        )?;
        form.child("input[name=\"inputs[changes][quantity]\"]")
            .call(h, &session.page, "fill", json!(s(&after["quantity"])))?;
        form.child("input[name=\"inputs[changes][available]\"]")
            .call(h, &session.page, "setChecked", after["available"].clone())?;
        submit(h, session, &form, "update")
    })
}

fn select_view(
    h: &Harness<'_>,
    actor: &Actor,
    session: &Session,
    tabs: &Locator,
    view: &str,
) -> Result<()> {
    preference(h, actor, APP, view, || {
        tabs.child(&format!("input[value=\"{view}\"]")).call(
            h,
            &session.page,
            "check",
            Value::Null,
        )?;
        let response = h.api(
            "browser.submit",
            json!({"page":session.page,"selector":tabs.selector,"chain":tabs.chain,"path":"/"}),
        )?;
        require(
            response["status"] == 303,
            "browser preference did not redirect after persistence",
        )?;
        reload(h, session)?;
        require(
            tabs.child(&format!("input[value=\"{view}\"]")).call(
                h,
                &session.page,
                "isChecked",
                Value::Null,
            )? == true,
            "preference did not survive reload",
        )
    })
}

fn browser_journey(
    h: &Harness<'_>,
    browser: &str,
    contexts: &mut Vec<String>,
    expected: &[Actor; 4],
    nullable: &Value,
) -> Result<()> {
    let (sessions, actors) = authenticated_sessions(h, browser, contexts, expected)?;
    let initial = browser_admission(h, browser, contexts, expected, &sessions)?;
    let ava = &sessions[0];
    let ben = &sessions[1];
    // Authentication and read-only admission precede business probes, so
    // cancellation after the four verified sessions cannot write owner work.
    h.refusal(
        Some(&actors[2]),
        "update",
        json!({"record":{"id":nullable["id"],"version":"2"},"name":"Foreign browser"}),
        "not_found",
        false,
    )?;
    h.refusal(
        Some(&actors[3]),
        "create",
        json!({"name":"Forbidden browser"}),
        "forbidden",
        false,
    )?;
    for item in &initial {
        remove_supply(h, &actors[0], ava, item)?;
    }
    readonly(h, || {
        reload(h, ben)?;
        overview(h, ava, &[], &[])?;
        overview(h, ben, &[], &[])
    })?;
    let suffix = &preview::random_id()?[..8];
    let paper = value(&format!("Browser paper {suffix}"), None, true);
    let pens = value(&format!("Browser pens {suffix}"), Some("2"), true);
    for item in [&paper, &pens] {
        create_supply(h, &actors[0], ava, item)?;
    }
    readonly(h, || {
        reload(h, ben)?;
        overview(
            h,
            ava,
            &[paper.clone(), pens.clone()],
            &[paper.clone(), pens.clone()],
        )?;
        overview(
            h,
            ben,
            &[paper.clone(), pens.clone()],
            &[paper.clone(), pens.clone()],
        )
    })?;
    let changed = value(&format!("Browser changed paper {suffix}"), Some("8"), false);
    edit_supply(h, &actors[1], ben, &paper, &changed)?;
    readonly(h, || {
        reload(h, ava)?;
        overview(
            h,
            ava,
            &[changed.clone(), pens.clone()],
            &[changed.clone(), pens.clone()],
        )?;
        overview(
            h,
            ben,
            &[changed.clone(), pens.clone()],
            &[changed.clone(), pens.clone()],
        )
    })?;
    preference_journey(h, &actors[0], ava, &changed, &pens)?;
    let mut restored = changed.clone();
    restored["available"] = json!(true);
    edit_supply(h, &actors[1], ben, &changed, &restored)?;
    readonly(h, || {
        reload(h, ava)?;
        overview(
            h,
            ava,
            &[restored.clone(), pens.clone()],
            &[restored.clone(), pens.clone()],
        )
    })?;
    remove_supply(h, &actors[0], ava, &restored)?;
    remove_supply(h, &actors[0], ava, &pens)?;
    readonly(h, || {
        reload(h, ben)?;
        overview(h, ava, &[], &[])?;
        overview(h, ben, &[], &[])
    })?;
    Ok(())
}

fn select_actor_team(
    h: &Harness<'_>,
    session: &Session,
    actor: &Actor,
    csrf: &Value,
) -> Result<()> {
    let teams = browser_request(h, &session.context, "GET", "/auth/teams", Value::Null, None)?;
    require(
        teams["status"] == 200
            && !s(&actor.principal).is_empty()
            && a(&teams["json"]["teams"]).len() == if actor.owner.is_null() { 0 } else { 1 },
        "browser team membership changed",
    )?;
    if !actor.owner.is_null() {
        equal(
            &teams["json"]["teams"][0]["team_id"],
            &actor.owner,
            "browser discovered wrong owner",
        )?;
        require(
            browser_request(
                h,
                &session.context,
                "POST",
                "/auth/select-team",
                json!({"team":actor.owner,"_csrf":csrf["csrf"]}),
                Some(s(&csrf["csrf"])),
            )?["status"]
                == 200,
            "browser team selection refused",
        )?;
    }
    Ok(())
}

fn preference_journey(
    h: &Harness<'_>,
    actor: &Actor,
    session: &Session,
    changed: &Value,
    pens: &Value,
) -> Result<()> {
    let tabs = Locator::new("form:has(input[type=\"radio\"][name=\"view\"])");
    select_view(h, actor, session, &tabs, "available")?;
    readonly(h, || {
        reload(h, session)?;
        require(
            tabs.child("input[value=\"available\"]").call(
                h,
                &session.page,
                "isChecked",
                Value::Null,
            )? == true,
            "preference lost on reload",
        )?;
        overview(
            h,
            session,
            std::slice::from_ref(pens),
            &[changed.clone(), pens.clone()],
        )
    })?;
    select_view(h, actor, session, &tabs, "all")?;
    readonly(h, || {
        reload(h, session)?;
        overview(
            h,
            session,
            &[changed.clone(), pens.clone()],
            &[changed.clone(), pens.clone()],
        )
    })?;
    Ok(())
}
