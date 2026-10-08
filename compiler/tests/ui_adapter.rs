//! Production CLI -> unchanged generated modules -> public UI factories.
//! This finite static markup test does not substitute an authorized query
//! runner or claim the separate canonical bound-preference save lifecycle.

#[test]
fn unsupported_preference_tabs_and_order_refuse_at_the_authored_profile() {
    use std::path::PathBuf;
    use std::process::Command;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let prefix = "app BoundUi\nGiven\n preferences { view:enum(all,finished)=all label={text=\"View\",values={all=\"All\",finished=\"Finished\"}} }\n Todo { title:text }\n policy Todo read=public\nWhen\nThen\n page / title=\"Page\"\n";
    for (body, profile, authored) in [
        (
            "  tabs preferences.view\n",
            "bound tabs",
            "preferences.view",
        ),
        (
            "  list Todo order=title empty=\"No tasks\"\n   text row.title\n",
            "collection order",
            "title",
        ),
        (
            "  list Todo order={by=preferences.view,default=[-created],cases={finished=[title]}} empty=\"No tasks\"\n   text row.title\n",
            "collection order",
            "{by=preferences.view,default=[-created],cases={finished=[title]}}",
        ),
    ] {
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
    let scratch = Scratch(
        std::env::temp_dir().join(format!(
            "can-ui-adapter-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )),
    );
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
When
Then
 page / title="Home"
  card "Card <&>"
   text "Card body"
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
for(const sentinel of ['Card body','First panel','Second panel','Third panel','Visible panel']) {
 assert.equal(html.split(sentinel).length-1,1,`${sentinel} renders once`);
}
assert.ok(!html.includes('Hidden panel'),'panel gate omits the entire item');
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
console.log('actual static UI adapter: card title, caption transport, ordered children, gates, default active and distinct sites passed');
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
