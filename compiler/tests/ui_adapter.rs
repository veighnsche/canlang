//! Production CLI -> unchanged generated modules -> public UI factories.
//! Static markup uses actual factories. A separate controlled async form/query
//! probe verifies producer ordering only, returning unavailable forms; it makes
//! no authorization, protected-binding or preference-save lifecycle claim.

#[test]
fn unsupported_dynamic_order_refuses_at_the_authored_profile() {
    use std::path::PathBuf;
    use std::process::Command;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let prefix = "app BoundUi\nGiven\n Todo { title:text }\n policy Todo read=public\nWhen\nThen\n preferences { view:enum(all,finished)=all label={text=\"View\",values={all=\"All\",finished=\"Finished\"}} }\n page / title=\"Page\"\n";
    {
        let (body, profile, authored) = (
            "  list Todo order={by=preferences.view,default=[-created],cases={finished=[title]}} empty=\"No tasks\"\n   text row.title\n",
            "collection order",
            "{by=preferences.view,default=[-created],cases={finished=[title]}}",
        );
        let scratch = tempfile::tempdir().unwrap();
        let source = prefix.to_string() + body;
        let path = scratch.path().join("profile.can");
        std::fs::write(&path, &source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert!(!output.status.success(), "{profile} unexpectedly published");
        let diagnostic: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let errors = diagnostic["diagnostics"].as_array().unwrap();
        let gap = errors.iter().find(|error| {
            error["code"] == "E6008" && error["message"].as_str().unwrap().contains(profile)
        });
        assert!(
            gap.is_some(),
            "{profile}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let span = &gap.unwrap()["primary"];
        assert_eq!(
            source
                [span["start"].as_u64().unwrap() as usize..span["end"].as_u64().unwrap() as usize]
                .trim(),
            authored
        );
        assert!(
            diagnostic.get("modules").is_none(),
            "blocked profile published modules"
        );
    }
}

#[test]
fn bound_tabs_emit_source_options_and_request_owned_save_route() {
    use std::path::PathBuf;
    use std::process::Command;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let source = "app BoundUi\nGiven\n Todo { title:text }\n policy Todo read=public\nWhen\nThen\n preferences { view:enum(all,finished)=all label={text=\"View\",values={all=\"All\",finished=\"Finished\"}} }\n page / title=\"Page\"\n  tabs preferences.view\n";
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("profile.can");
    std::fs::write(&path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    let compiled: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let js = compiled["modules"][0]["js"].as_str().unwrap();
    assert!(js.contains("preferenceFields:[{name:\"view\",options:[\"all\",\"finished\"],defaultValue:\"all\"}]"), "{js}");
    assert!(js.contains("postTo:c.pollUrl ?? c.path"), "{js}");
    assert!(js.contains("version:c.preferenceVersions.BoundUi.view"), "{js}");
    assert!(js.contains("current:preferences.view"), "{js}");
}

#[test]
fn nominal_preference_tabs_keep_the_receiving_field_and_refuse_foreign_bindings() {
    use std::{path::PathBuf, process::Command};
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = tempfile::tempdir().unwrap();
    let prefix = "app NominalTabs\nGiven\n Expense { status:enum(draft,submitted,approved)=draft label={text=\"Status\",values={draft=\"Draft\",submitted=\"Submitted\",approved=\"Approved\"}} }\n policy Expense read=public\nWhen\nThen\n";
    let run = |body: &str| {
        let path = scratch.path().join("nominal.can");
        std::fs::write(&path, prefix.to_string() + body).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        (output, artifact)
    };
    let (output, artifact) = run(
        " preferences { selection:Expense.status=submitted label={text=\"Review\",values={approved=\"Accepted\"}} }\n page / title=\"Page\"\n  tabs preferences.selection\n",
    );
    assert!(output.status.success(), "{artifact}");
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(js.contains("preferenceFields:[{name:\"selection\",options:[\"draft\",\"submitted\",\"approved\"],defaultValue:\"submitted\"}]"), "{js}");
    assert!(
        js.contains("version:c.preferenceVersions.NominalTabs.selection"),
        "{js}"
    );
    assert!(js.contains("current:preferences.selection"), "{js}");
    for label in ["Draft", "Submitted", "Accepted", "Review"] {
        assert!(js.contains(label), "missing {label}: {js}");
    }
    for body in [
        " preferences { selection:Expense.status? }\n page / title=\"Page\"\n  tabs preferences.selection\n",
        " preferences { selection:Expense.status=foreign }\n page / title=\"Page\"\n  tabs preferences.selection\n",
        " page / title=\"Page\"\n  list Expense empty=\"Empty\"\n   tabs row.status\n",
    ] {
        let (output, artifact) = run(body);
        assert!(
            !output.status.success(),
            "unsupported binding published: {body}"
        );
        assert!(artifact.get("modules").is_none(), "{artifact}");
        assert!(
            artifact["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"]
                    .as_str()
                    .is_some_and(|code| code.starts_with('E'))),
            "{artifact}"
        );
    }
}

#[test]
fn fixed_order_search_and_count_are_owned_by_the_list() {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let source = concat!(
        "app CollectionContract\n",
        "Given\n",
        " Todo { title:text }\n",
        " policy Todo read=public\n",
        "When\nThen\n",
        " page / title=\"Tasks\"\n",
        "  list Todo order=title search=title empty=\"No tasks\"\n",
        "   count label=\"Tasks in this view\"\n",
        "   text row.title\n",
    );
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("collection.can");
    std::fs::write(&path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    for owned_prop in ["order:[\"title\"]", "search:[\"title\"]", "count:{label:"] {
        assert!(js.contains(owned_prop), "missing {owned_prop}: {js}");
    }
    assert_eq!(js.matches("count:{label:").count(), 1, "{js}");
    assert!(
        js.find("count:{label:").unwrap() < js.find("renderRow:").unwrap(),
        "count must belong to the list, before its row closure: {js}"
    );
}

#[test]
fn literal_card_and_transient_tabs_reach_actual_factory() {
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for path in [
        "packages/values/dist/catalog.json",
        "packages/ui/dist/src/index.js",
    ] {
        assert!(
            root.join(path).exists(),
            "UI runtime prerequisite missing: {path}"
        );
    }
    assert!(
        Command::new("node").arg("--version").output().is_ok(),
        "Node runtime prerequisite missing"
    );
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let scratch = Scratch(std::env::temp_dir().join(format!(
            "can-ui-adapter-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    std::fs::create_dir_all(&scratch.0).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("node_modules"), scratch.0.join("node_modules")).unwrap();
    #[cfg(not(unix))]
    std::os::windows::fs::symlink_dir(root.join("node_modules"), scratch.0.join("node_modules"))
        .unwrap();
    let source = scratch.0.join("ui.can");
    std::fs::write(
        &source,
        r#"app Ui
Given
 derive caption():text = "Dynamic"
 Probe { show:bool, note:text }
 policy Probe read=public
When
 scenario renderFormProbe(note:text) by=public
  do
   let chosen = "ready"
Then
 page / title="Home"
  card "Card <&>" layout=columns
   text "Card body"
  card caption()
   text "Dynamic card body"
  details "Collapse <&>" open=true
   text "Collapse body"
  title "Heading <&>"
  stat "Metric value"
  card "Empty card"
   require true
  modal "Modal caption" id=dialog
   slot content
    text "Modal content"
   slot trigger
    text "Modal trigger"
   slot actions
    text "Modal actions"
  drawer "Drawer caption" id=drawer_panel
   slot trigger
    text "Drawer trigger"
   slot content
    text "Drawer content"
   slot actions
    text "Drawer actions"
  modal "Hidden modal" id=hidden_dialog
   require false
   slot content
    text "Hidden modal body"
  fieldset caption()
   text "Dynamic fieldset body"
  divider caption()
  text "Translated text"@{nl="Vertaalde tekst"}
  badge "Translated badge"@{nl="Vertaalde badge"}
  stat "Translated stat"@{nl="Vertaalde statistiek"}
  alert "Translated alert"@{nl="Vertaalde melding"}
  tabs
   tab "Repeat"@{nl="Zelfde"}
    text "First panel"
   tab "Repeat"@{nl="Zelfde"}
    text "Second panel"
  tabs
   tab caption()
    text "Third panel"
  tabs
   tab "Hidden"
    require false
    text "Hidden panel"
   tab "Visible"
    text "Visible panel"
 page /async title="Async producer"
  form renderFormProbe fields=note submit="Page submit"
   text actor
  form renderFormProbe fields=note submit="Gated page submit"
   require false
   text actor
  list Probe empty="No probes"
   form renderFormProbe fields=note submit=row.note
    require row.show
    text actor
"#,
    )
    .unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "CLI failed: {}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.0.join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let runner = scratch.0.join("consume.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {dirname,resolve} from 'node:path';
const artifact=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.equal(artifact.modules.length,1);
const module=artifact.modules[0];
assert.ok(!module.js.includes('tab as '),'no nonexistent tab factory import');
assert.ok(module.js.includes('items:['),'actual tabs factory payload');
const path=resolve(dirname(process.argv[2]),module.path);
writeFileSync(path,module.js);
const generated=await import(pathToFileURL(path));
const page=generated.appDefinition.pages[0];
assert.equal(page.title.source,'Home');
const bindings=await page.admit({});
const html=await page.render({appDefaultLocale:'en',preferredLocales:['nl']},bindings);
assert.ok(html.includes('Card &lt;&amp;&gt;'),'literal card title reaches real escaping sink');
assert.ok(html.includes('sm:grid-cols-2'),'card layout reaches the owning factory');
assert.ok(html.includes('Collapse &lt;&amp;&gt;'),'details maps to the real collapse caption sink');
assert.ok(/<details[^>]* open/.test(html),'collapse open option reaches the owning factory');
assert.ok(html.includes('Heading &lt;&amp;&gt;'),'title uses the actual text prop');
assert.ok(html.includes('Metric value'),'stat uses the singular value prop');
assert.ok(html.includes('Empty card'),'empty Card receives its owning children array');
for(const sentinel of ['Card body','Dynamic card body','Collapse body','Modal content','Modal trigger','Modal actions','Drawer trigger','Drawer content','Drawer actions','Dynamic fieldset body','First panel','Second panel','Third panel','Visible panel']) {
 assert.equal(html.split(sentinel).length-1,1,`${sentinel} renders once`);
}
assert.ok(!html.includes('Hidden panel'),'panel gate omits the entire item');
assert.ok(!html.includes('Hidden modal'),'modal gate omits its caption and slots');
for(const caption of ['Vertaalde tekst','Vertaalde badge','Vertaalde statistiek','Vertaalde melding']) {
 assert.ok(html.includes(caption),`${caption} retains its owning message descriptor`);
}
assert.ok(!module.js.includes('slot as '),'named slots dissolve into the owning modal/drawer props');
assert.ok(html.indexOf('First panel')<html.indexOf('Second panel'),'authored panel order');
const radios=[...html.matchAll(/<input type="radio"[^>]*>/g)].map(match=>match[0]);
assert.equal(radios.length,4);
assert.equal(radios.filter(radio=>radio.includes('aria-label="Zelfde"')).length,2,'translated duplicate captions retain distinct values');
const groups=new Map();
for(const radio of radios) {
 const name=/ name="([^"]+)"/.exec(radio)[1];
 const value=/ value="([^"]+)"/.exec(radio)[1];
 if(!groups.has(name)) groups.set(name,[]);
 groups.get(name).push({value,checked:radio.includes(' checked')});
}
assert.equal(groups.size,3,'sibling tabsets have distinct parent identities');
assert.deepEqual([...groups.values()].map(items=>items.map(item=>item.value)),[['0','1'],['0'],['1']]);
assert.deepEqual([...groups.values()].map(items=>items.filter(item=>item.checked).length),[1,1,1],'first surviving panel is default active');
const ids=[...html.matchAll(/ id="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length,'parent/tab/panel IDs never collide');
// Controlled unavailable forms exercise only emitted await/gate/order behavior.
const asyncPage=generated.appDefinition.pages[1];
const trace=[];
let childReads=0;
const invocation={probe:'producer-only'};
const formContext={
 appDefaultLocale:'en',preferredLocales:[],invocation,
 async prepareForm(request) {
  const label=typeof request.submit==='string'?request.submit:request.submit.source;
  trace.push(['prepare:start',request.operation,label]);
  await Promise.resolve();
  trace.push(['prepare:end',request.operation,label]);
  return {status:'unavailable',message:`Unavailable ${label}`};
 },
 async query(seenInvocation,model) {
  assert.equal(seenInvocation,invocation);
  trace.push(['query',model]);
  return {columns:[],rows:[
   {id:'hidden',fields:{show:false,note:'Gated row submit'}},
   {id:'visible',fields:{show:true,note:'Row submit'}},
  ]};
 },
};
Object.defineProperty(formContext,'actor',{get(){childReads++;throw new Error('unavailable/gated form evaluated its child');}});
const asyncHtml=await asyncPage.render(formContext,await asyncPage.admit({}));
assert.deepEqual(trace,[
 ['prepare:start','Ui.renderFormProbe','Page submit'],
 ['prepare:end','Ui.renderFormProbe','Page submit'],
 ['query','Ui.Probe'],
 ['prepare:start','Ui.renderFormProbe','Row submit'],
 ['prepare:end','Ui.renderFormProbe','Row submit'],
],'each admitted form awaits one preparation before child rendering, in source/row order');
assert.equal(childReads,0,'unavailable and false gates never evaluate authored children');
assert.equal(asyncHtml.split('Unavailable Page submit').length-1,1);
assert.equal(asyncHtml.split('Unavailable Row submit').length-1,1);
assert.ok(!asyncHtml.includes('Gated page submit')&&!asyncHtml.includes('Gated row submit'));
assert.ok(!asyncHtml.includes('<form'),'unavailable forms expose no controls or submit');
console.log('actual UI adapter and controlled async unavailable-form producer passed');
"#).unwrap();
    let consumed = Command::new("node")
        .arg(&runner)
        .arg(&artifact)
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        consumed.status.success(),
        "actual consumer failed: {}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
}

#[test]
fn unsupported_ui_payloads_refuse_instead_of_losing_authored_meaning() {
    use std::path::PathBuf;
    use std::process::Command;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for (body, profile) in [
        ("  card\n   text \"Body\"\n", "card"),
        (
            "  details \"Caption\" display=drawer\n   text \"Body\"\n",
            "details",
        ),
        (
            "  details \"Caption\" open=1\n   text \"Body\"\n",
            "collapse",
        ),
        (
            "  tabs \"Unused\"@{nl=\"Ongebruikt\"}\n   tab \"One\"\n    text \"Body\"\n",
            "tabs",
        ),
        ("  stat 1,2\n", "stat"),
        ("  metrics 1\n", "metrics"),
        ("  copy \"Value\"\n", "copy"),
        ("  tooltip \"Notice\"\n", "tooltip"),
        (
            "  chat_bubble\n   slot content\n    text \"First\"\n   slot content\n    text \"Second\"\n",
            "chat_bubble",
        ),
        ("  alert \"Notice\" tone=neutral\n", "alert"),
        ("  badge \"Value\" unknown=true\n", "badge"),
        ("  details \"Caption\"\n   require false\n", "details"),
        ("  fieldset \"Caption\"\n   require false\n", "fieldset"),
        ("  join\n   require false\n", "join"),
        (
            "  divider \"First\"@{nl=\"Eerste\"},\"Second\"@{nl=\"Tweede\"}\n",
            "divider",
        ),
    ] {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("profile.can");
        let source =
            format!("app UnsupportedUi\nGiven\nWhen\nThen\n page / title=\"Page\"\n{body}");
        std::fs::write(&path, &source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert!(!output.status.success(), "{profile} unexpectedly published");
        let diagnostic: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            diagnostic["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|error| {
                    error["code"] == "E6008" && error["message"].as_str().unwrap().contains(profile)
                }),
            "{profile}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            diagnostic.get("modules").is_none(),
            "{profile} published modules"
        );
    }
}
