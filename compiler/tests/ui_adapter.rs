//! Production CLI -> unchanged generated modules -> public UI factories.
//! Static markup uses actual factories. A separate controlled async form/query
//! probe verifies producer ordering only, returning unavailable forms; it makes
//! no authorization, protected-binding or preference-save lifecycle claim.

#[test]
fn preference_dispatched_order_publishes_case_ternary() {
    use std::path::PathBuf;
    use std::process::Command;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let prefix = "app BoundUi\nGiven\n Todo { title:text, rank:int }\n policy Todo read=public\nWhen\nThen\n preferences { view:enum(all,finished)=all label={text=\"View\",values={all=\"All\",finished=\"Finished\"}} }\n page / title=\"Page\"\n";
    let body = "  list Todo order={by=preferences.view,default=[-created],cases={finished=[rank]}} empty=\"No tasks\"\n   text row.title\n";
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
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let compiled: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        compiled.get("modules").is_some(),
        "dispatched order published no modules"
    );
    let js = compiled["modules"][0]["js"].as_str().unwrap();
    assert!(
        js.contains("(preferences.view===\"finished\")?[\"rank\"]:[\"-created\"]"),
        "dispatch ternary: {js}"
    );
    assert!(
        js.contains("const preferences="),
        "preferences preamble: {js}"
    );
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
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let compiled: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let js = compiled["modules"][0]["js"].as_str().unwrap();
    assert!(
        js.contains(
            "preferenceFields:[{name:\"view\",options:[\"all\",\"finished\"],defaultValue:\"all\",caption:"
        ),
        "{js}"
    );
    assert!(js.contains("postTo:c.pollUrl ?? c.path"), "{js}");
    assert!(
        js.contains("version:c.preferenceVersions.BoundUi.view"),
        "{js}"
    );
    assert!(js.contains("current:preferences.view"), "{js}");
}

// The original Loyalty declaration supplies the cases/captions. This finite
// producer consumer does not qualify its other models or preference persistence.
#[cfg(unix)]
#[test]
fn unguarded_bound_panels_reach_installed_ui_with_owned_labels_and_selection() {
    use std::{path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let original = include_str!("../../draft/apps/CanLoyalty/CanLoyalty.can");
    let heading = original
        .lines()
        .find(|line| line.trim_start().starts_with("message heading_rewards ="))
        .unwrap()
        .trim();
    let preference = original
        .lines()
        .find(|line| line.trim_start().starts_with("preferences { view:"))
        .unwrap()
        .trim()
        .split(", location:")
        .next()
        .unwrap();
    assert!(original.contains("     tabs preferences.view\n      tab rewards\n"));
    assert!(original.contains("      tab history\n       timeline account.Earning\n"));
    let source = format!(
        r#"app BoundLoyalty
Given
 {heading}
 Entry {{title:text}}
 policy Entry read=public
When
Then
 {preference} }}
 page /loyalty title="My rewards"
  tabs preferences.view
   tab rewards
    text "Reward panel"
   tab history
    text "History panel"
 page /reverse title="Reversed panels"
  tabs ((preferences.view))
   tab history
    text "History first"
   tab rewards
    text "Rewards second"
 page /rows title="Row panels"
  list Entry
   tabs preferences.view
    tab rewards
     text row.title
    tab history
     text row.title
"#
    );
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("bound-panels.can");
    std::fs::write(&input, &source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&compiled.stdout).unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    for module in artifact["modules"].as_array().unwrap() {
        let path = scratch.path().join(module["path"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, module["js"].as_str().unwrap()).unwrap();
    }
    let runner = scratch.path().join("bound-panels.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {appDefinition}=await import(pathToFileURL(process.argv[2]));
const context={appDefaultLocale:'en',preferredLocales:['nl'],csrfToken:'csrf-bound',
 path:'/loyalty',pollUrl:'/loyalty?fragment=body',preferenceVersions:{BoundLoyalty:{view:'7'}}};
const page=appDefinition.pages.find(page=>page.path==='/loyalty');
const {caption,optionLabels,...field}=page.preferenceFields[0];
assert.deepEqual(field,{name:'view',options:['rewards','history'],defaultValue:'rewards'});
const {resolveCaption}=await import('@canlang/ui');
assert.equal(resolveCaption(caption,context),'Beloningsweergave');
assert.equal(resolveCaption(optionLabels.history,context),'Geschiedenis');
for(const current of ['rewards','history']) {
 const bound=await page.admit({...context,preferences:{BoundLoyalty:{view:current}}});
 assert.equal(bound.preferences.BoundLoyalty.view,current);
 const html=await page.render(context,bound);
 const radios=[...html.matchAll(/<input type="radio"[^>]*>/g)].map(match=>match[0]);
 assert.deepEqual(radios.map(radio=>/ value="([^"]+)"/.exec(radio)[1]),['rewards','history']);
 assert.deepEqual(radios.filter(radio=>radio.includes(' checked')).map(radio=>/ value="([^"]+)"/.exec(radio)[1]),[current]);
 assert.ok(radios[0].includes('aria-label="Beloningen"'));
 assert.ok(radios[1].includes('aria-label="Geschiedenis"'));
 assert.match(html,/<form action="\/loyalty\?fragment=body" method="post"/);
 assert.ok(html.includes('name="_csrf" value="csrf-bound"'));
 assert.ok(html.includes('name="_version" value="7"'));
 assert.equal(html.split('Reward panel').length-1,1);
 assert.equal(html.split('History panel').length-1,1);
 assert.ok(html.indexOf('Reward panel')<html.indexOf('History panel'));
}
const defaultBindings=await page.admit(context);
assert.equal(defaultBindings.preferences.BoundLoyalty.view,'rewards');
const reverse=appDefinition.pages.find(page=>page.path==='/reverse');
const reversed=await reverse.render(context,await reverse.admit(context));
const reverseRadios=[...reversed.matchAll(/<input type="radio"[^>]*>/g)].map(match=>match[0]);
assert.deepEqual(reverseRadios.map(radio=>/ value="([^"]+)"/.exec(radio)[1]),['history','rewards']);
assert.ok(reverseRadios[1].includes(' checked'),'saved/default case survives authored reordering');
const rows=appDefinition.pages.find(page=>page.path==='/rows');
let queries=0;
const rowContext={...context,invocation:{probe:'scope-only'},async query(invocation,model) {
 queries++; assert.equal(invocation,this.invocation); assert.equal(model,'BoundLoyalty.Entry');
 return {columns:[],rows:[{id:'first',fields:{title:'First row'}},{id:'second',fields:{title:'Second row'}}]};
}};
const rowHtml=await rows.render(rowContext,await rows.admit(rowContext));
assert.equal(queries,1);
for(const title of ['First row','Second row']) assert.equal(rowHtml.split(title).length-1,2);
const ids=[...rowHtml.matchAll(/ id="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length,'same preference in repeated rows keeps distinct tab/panel ids');
const invalid=await page.admit({...context,preferences:{BoundLoyalty:{view:'foreign'}}});
await assert.rejects(page.render(context,invalid),/not a listed option/);
assert.equal(invalid.preferences.BoundLoyalty.view,'foreign','renderer never rewrites accepted preference input');
console.log('owning Loyalty labels/cases, selection/version/route and row scope reach installed UI');
"#).unwrap();
    let executed = Command::new("node")
        .arg(&runner)
        .arg(
            scratch
                .path()
                .join(artifact["modules"][0]["path"].as_str().unwrap()),
        )
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}

#[test]
fn gated_bound_panels_keep_the_specific_unsupported_profile() {
    use std::{path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    for gate in ["true", "false", "authenticated"] {
        let source = format!(
            "app BoundGate\nGiven\nWhen\nThen\n preferences {{view:enum(rewards,history)=rewards}}\n page / title=\"Page\"\n  tabs preferences.view\n   tab rewards\n    text \"Rewards\"\n   tab history\n    require {gate}\n    text \"History\"\n"
        );
        let input = scratch.path().join("gated.can");
        std::fs::write(&input, source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(output.status.code(), Some(10), "{gate}: {artifact}");
        assert!(
            artifact["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E6008"
                    && diagnostic["message"]
                        .as_str()
                        .unwrap()
                        .contains("direct tab gate")),
            "{gate}: {artifact}"
        );
        assert!(artifact.get("modules").is_none(), "{gate}: {artifact}");
    }
}

#[test]
fn original_loyalty_bound_panels_keep_their_checked_cases_labels_and_bodies_in_ir() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::codegen::ir::{self, IrExpr, IrUi};
    use canlang_compiler::source::{SourceDb, Span};
    use std::path::Path;
    fn tabs(nodes: &[IrUi]) -> Option<&IrUi> {
        nodes.iter().find_map(|node| {
            if node.factory == "tabs" && node.props.iter().any(|(key, _)| key == "binding") {
                Some(node)
            } else {
                tabs(&node.children)
            }
        })
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let original = include_str!("../../draft/apps/CanLoyalty/CanLoyalty.can");
    let mut db = SourceDb::new();
    let id = db.add(
        "draft/apps/CanLoyalty/CanLoyalty.can".into(),
        original.into(),
    );
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, _) = check_program(&db, &[id], catalog.as_ref());
    // Unresolved original imports and other unsupported workflows still prevent
    // shipping. Raw IR inspects only this original source producer, not an app.
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    let page = program
        .modules
        .iter()
        .find(|module| module.name == "loyalty")
        .unwrap()
        .pages
        .iter()
        .find(|page| page.path == "/loyalty")
        .unwrap();
    let tabs = tabs(&page.render).unwrap_or_else(|| panic!("{diagnostics:?}"));
    assert_eq!(tabs.children.len(), 2);
    for (panel, case, label) in [
        (&tabs.children[0], "rewards", "Rewards"),
        (&tabs.children[1], "history", "History"),
    ] {
        assert_eq!(panel.factory, "tabItem");
        assert!(panel.gate.is_none());
        assert!(panel.props.iter().any(|(key, value)| key == "value"
            && matches!(&value.expr, IrExpr::Text(value) if value == case)));
        assert!(panel.props.iter().any(|(key, value)| key == "caption"
            && matches!(&value.expr, IrExpr::Message(value) if value.source == label)));
        assert!(
            original[panel.span.start as usize..panel.span.end as usize]
                .trim_start()
                .starts_with(&format!("tab {case}"))
        );
        assert!(panel.children.iter().all(|child| child.span.file == id
            && child.span.start >= panel.span.start
            && child.span.end <= panel.span.end));
    }
    assert_eq!(
        tabs.children[0]
            .children
            .iter()
            .map(|child| child.factory.as_str())
            .collect::<Vec<_>>(),
        vec!["list", "table"]
    );
    // The history tab's bound timeline lowers through the shared collection
    // pipeline (CAN18-v1 B20): one item template over the admitted Earning
    // sequence with its page marker. No timeline diagnostic remains.
    let timeline = tabs.children[1]
        .children
        .iter()
        .find(|child| child.factory == "timeline")
        .unwrap_or_else(|| panic!("history tab keeps its bound timeline: {diagnostics:?}"));
    assert!(
        timeline.props.iter().any(|(key, value)| key == "model"
            && matches!(&value.expr, IrExpr::Text(model) if model.ends_with("Earning"))),
        "{timeline:?}"
    );
    assert!(
        timeline
            .props
            .iter()
            .any(|(key, value)| key == "page" && matches!(value.expr, IrExpr::Bool(true))),
        "{timeline:?}"
    );
    assert!(timeline.row_scope.is_some(), "{timeline:?}");
    assert!(
        !diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("timeline")),
        "{diagnostics:?}"
    );
    assert!(
        !page.admit.is_empty(),
        "original enclosing authenticated page remains protected"
    );
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
    assert!(js.contains("preferenceFields:[{name:\"selection\",options:[\"draft\",\"submitted\",\"approved\"],defaultValue:\"submitted\""), "{js}");
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
        " page / title=\"Page\"\n  list Expense empty=\"Empty\"\n   tabs ((row.status))\n",
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
fn chained_preference_tabs_use_nearest_labels_and_receiving_identity() {
    use std::{path::PathBuf, process::Command};
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = tempfile::tempdir().unwrap();
    for (status, selection) in [
        ("preferences.status", "preferences.selection"),
        ("((preferences.status))", "(preferences.selection)"),
    ] {
        let source = format!(
            "app ChainedTabs\nGiven\n Expense {{status:enum(draft,submitted,approved)=draft label={{text=\"Status\",values={{draft=\"Draft\",submitted=\"Submitted\",approved=\"Approved\"}}}}}}\n Bridge {{status:Expense.status=approved label={{text=\"Bridge status\",values={{draft=\"Bridge draft\",approved=\"Bridge approved\"}}}}}}\n policy Expense read=public\n policy Bridge read=public\nWhen\nThen\n preferences {{status:Bridge.status=submitted label={{values={{approved=\"Accepted status\"}}}},selection:Bridge.status=draft label={{values={{approved=\"Accepted selection\"}}}}}}\n page / title=\"Page\"\n  tabs {status}\n  tabs {selection}\n"
        );
        let path = scratch.path().join("chained.can");
        std::fs::write(&path, source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(output.status.success(), "{artifact}");
        let js = artifact["modules"][0]["js"].as_str().unwrap();
        assert!(js.contains("preferenceFields:[{name:\"status\",options:[\"draft\",\"submitted\",\"approved\"],defaultValue:\"submitted\""), "{js}");
        assert!(js.contains("{name:\"selection\",options:[\"draft\",\"submitted\",\"approved\"],defaultValue:\"draft\""), "{js}");
        for field in ["status", "selection"] {
            assert!(js.contains(&format!("current:preferences.{field}")), "{js}");
            assert!(
                js.contains(&format!("version:c.preferenceVersions.ChainedTabs.{field}")),
                "{js}"
            );
        }
        let render = js
            .split("export async function ")
            .nth(1)
            .unwrap()
            .split("export const appDefinition")
            .next()
            .unwrap();
        for caption in [
            "Bridge status",
            "Bridge draft",
            "Submitted",
            "Accepted status",
            "Accepted selection",
        ] {
            assert!(render.contains(&format!("\"{caption}\"")), "{render}");
        }
        for ancestor in ["Status", "Draft", "Approved", "Bridge approved"] {
            assert!(!render.contains(&format!("\"{ancestor}\"")), "{render}");
        }
        assert_eq!(
            render.matches("caption:").count(),
            1,
            "renamed field must not inherit a legend: {render}"
        );
        assert!(render.contains("postTo:c.pollUrl ?? c.path"), "{render}");
    }
}

#[test]
fn grouped_preference_tabs_keep_inline_and_borrowed_checked_identities() {
    use std::{path::PathBuf, process::Command};
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = tempfile::tempdir().unwrap();
    for annotation in ["enum(draft,submitted)", "Expense.status"] {
        for target in [
            "preferences.view",
            "(preferences.view)",
            "((preferences.view))",
        ] {
            let source = format!(
                "app GroupedTabs\nGiven\n Expense {{status:enum(draft,submitted)=draft}}\n policy Expense read=public\nWhen\nThen\n preferences {{view:{annotation}=submitted}}\n page / title=\"Page\"\n  tabs {target}\n"
            );
            let path = scratch.path().join("grouped.can");
            std::fs::write(&path, source).unwrap();
            let output = Command::new(env!("CARGO_BIN_EXE_can"))
                .args(["compile", "--format=json", "--catalog"])
                .arg(root.join("packages/values/dist/catalog.json"))
                .arg(path)
                .env_remove("CAN_CATALOG")
                .output()
                .unwrap();
            let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(
                output.status.success(),
                "{annotation}: {target}: {artifact}"
            );
            let js = artifact["modules"][0]["js"].as_str().unwrap();
            assert!(js.contains("preferenceFields:[{name:\"view\",options:[\"draft\",\"submitted\"],defaultValue:\"submitted\""), "{js}");
            assert!(js.contains("current:preferences.view"), "{js}");
            assert!(
                js.contains("version:c.preferenceVersions.GroupedTabs.view"),
                "{js}"
            );
        }
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
fn fixed_search_is_owned_by_the_table() {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let source = concat!(
        "app CollectionContract\n",
        "Given\n",
        " Todo { title:text, done:bool=false }\n",
        " policy Todo read=public\n",
        "When\nThen\n",
        " page / title=\"Tasks\"\n",
        "  table Todo columns=title,done search=title empty=\"No tasks\"\n",
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
    assert!(
        js.contains("search:[\"title\"]"),
        "missing table search: {js}"
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
 preferences { expanded:bool=true }
 page / title="Home"
  card "Card <&>" layout=columns
   text "Card body"
  card caption()
   text "Dynamic card body"
  card
   text "Bare card body"
  card layout=columns
   text "Bare columns body"
  card
   require false
   text actor
  hero
   text "Bare hero body"
  hero caption()
   text "Captioned hero body"
  hero
   require false
   text "Hidden hero body"
  details "Collapse <&>" open=true
   text "Collapse body"
  collapse "Appointment coordination"@{nl="Afspraakafstemming"} id=coordination open=preferences.expanded
   text "Original disclosure body"
  collapse caption() open=true
   text "Dynamic disclosure body"
  collapse "Hidden disclosure"
   require false
   text actor
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
 page /disclosures title="Scoped disclosures"
  list Probe
   collapse row.note open=row.show
    require row.show
    text row.note
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
const context={appDefaultLocale:'en',preferredLocales:['nl']};
Object.defineProperty(context,'actor',{get(){throw new Error('gated disclosure evaluated its child');}});
const html=await page.render(context,bindings);
assert.ok(html.includes('Card &lt;&amp;&gt;'),'literal card title reaches real escaping sink');
assert.ok(html.includes('sm:grid-cols-2'),'card layout reaches the owning factory');
assert.ok(html.includes('Collapse &lt;&amp;&gt;'),'details maps to the real collapse caption sink');
assert.ok(/<details[^>]* open/.test(html),'collapse open option reaches the owning factory');
assert.ok(html.includes('<summary class="collapse-title">Afspraakafstemming</summary>'),
 'original collapse caption reaches the real localized disclosure sink');
assert.ok(html.includes('id="coordination"'),'authored disclosure ID reaches its existing sink');
assert.ok(/<details[^>]*\bopen[^>]*\bid="coordination"/.test(html),
 'checked owning boolean preference reaches the disclosure open property');
assert.ok(html.includes('<summary class="collapse-title">Dynamic</summary>'));
assert.ok(!html.includes('Hidden disclosure'),'false disclosure gate omits caption and children');
assert.ok(html.includes('Heading &lt;&amp;&gt;'),'title uses the actual text prop');
assert.ok(html.includes('Metric value'),'stat uses the singular value prop');
assert.ok(html.includes('Empty card'),'empty Card receives its owning children array');
for(const sentinel of ['Card body','Dynamic card body','Bare card body','Bare columns body','Bare hero body','Captioned hero body','Collapse body','Original disclosure body','Dynamic disclosure body','Modal content','Modal trigger','Modal actions','Drawer trigger','Drawer content','Drawer actions','Dynamic fieldset body','First panel','Second panel','Third panel','Visible panel']) {
 assert.equal(html.split(sentinel).length-1,1,`${sentinel} renders once`);
}
assert.ok(!html.includes('Hidden panel'),'panel gate omits the entire item');
assert.ok(!html.includes('Hidden modal'),'modal gate omits its caption and slots');
assert.ok(!html.includes('Hidden hero body'),'hero gate encloses its body');
assert.ok(!html.includes('<h2 class="card-title"></h2>'),'bare cards omit heading markup');
assert.ok(html.includes('class="hero"')&&html.includes('class="hero-content"'),'compact hero reaches the installed group factory');
assert.ok(html.includes('<h1 class="text-3xl font-bold">Dynamic</h1>'),'checked header caption reaches its existing hero sink');
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
 appDefaultLocale:'en',preferredLocales:[],invocation,memberships:[],canonical:{builtinRoles:['public']},
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
const disclosurePage=generated.appDefinition.pages[2];
const scopedHtml=await disclosurePage.render(formContext,await disclosurePage.admit({}));
assert.ok(!scopedHtml.includes('Gated row submit'),'false row gate omits its disclosure');
assert.equal(scopedHtml.split('Row submit').length-1,2,'own row value reaches its caption and child exactly once');
assert.equal(scopedHtml.split('<details ').length-1,1,'only the admitted row renders');
assert.ok(/<details[^>]* open/.test(scopedHtml),'open reads the same admitted row scope');
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
fn disclosure_open_requires_nonnullable_bool_during_analysis() {
    use canlang_compiler::analysis::{resolve, types};
    use canlang_compiler::source::SourceDb;
    use canlang_compiler::syntax;

    for component in ["details", "collapse"] {
        for (operand, expected) in [
            ("true", None),
            ("false", None),
            ("row.expanded", None),
            ("preferences.expanded", None),
            ("1", Some("E3007")),
            ("\"yes\"", Some("E3007")),
            ("row.optional", Some("E3007")),
            ("absent", Some("E2001")),
        ] {
            let source = format!(
                "app Ui\nGiven\n Probe {{title:text,expanded:bool,optional:bool?}}\nWhen\nThen\n preferences {{expanded:bool=false}}\n page / title=\"Page\"\n  list Probe\n   {component} \"Caption\" open={operand}\n    text row.title\n"
            );
            let mut db = SourceDb::new();
            let id = db.add("disclosure.can".into(), source.clone());
            let (tree, mut diagnostics) = syntax::parse(&db, id);
            assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
            let trees = vec![(id, tree)];
            let resolved = resolve::resolve_program(&db, &trees, None, &mut diagnostics);
            let typed = types::check_types(&db, &trees, None, &resolved, &mut diagnostics);
            resolve::emit_unresolved(&db, &resolved, &typed, &mut diagnostics);
            assert_eq!(
                diagnostics.iter().map(|d| d.code).collect::<Vec<_>>(),
                expected.into_iter().collect::<Vec<_>>(),
                "{source}\n{diagnostics:?}"
            );
            if expected.is_some() {
                let start = source.find("open=").unwrap() + "open=".len();
                assert_eq!(diagnostics[0].primary.start as usize, start, "{source}");
                assert_eq!(
                    diagnostics[0].primary.end as usize,
                    start + operand.len(),
                    "{source}"
                );
            }
        }
    }
}

#[test]
fn unsupported_ui_payloads_refuse_instead_of_losing_authored_meaning() {
    use std::path::PathBuf;
    use std::process::Command;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for (body, profile) in [
        (
            "  card unknown=true\n   text \"Body\"\n",
            "unsupported attribute",
        ),
        (
            "  details \"Caption\" display=drawer\n   text \"Body\"\n",
            "details",
        ),
        ("  details \"Caption\" open=1\n   text \"Body\"\n", "open="),
        (
            "  tabs \"Unused\"@{nl=\"Ongebruikt\"}\n   tab \"One\"\n    text \"Body\"\n",
            "bound tab panels",
        ),
        // Page-level `stat 1,2` is admitted by the outcome-6/B17 factory
        // slice (DESIGN s9 multi-value stat: int literals lower header by
        // header through the single-value stat profile and render via the
        // real stat factory; twin refusal coverage for unrenderable money
        // headers lives in factory_profiles), so it no longer belongs in
        // this refusal list.
        // Bare `metrics 1` is admitted by the outcome-6 payload slice
        // (DESIGN s9 `metrics expr,...`: one typed scalar through the
        // shared stat contract; a constant needs no row grant), so it no
        // longer belongs in this refusal list. Twin boundary coverage lives
        // in ui_original_bindings (empty/suite metrics still refuse E6008).
        // Page-level `copy "Value"` is admitted by the same slice (DESIGN s9
        // `copy expr`: one text value, label defaulting to the value at the
        // factory); twin non-text/multi-header refusal coverage lives in
        // ui_original_bindings.
        ("  tooltip \"Notice\"\n", "tooltip"),
        (
            "  chat_bubble\n   slot content\n    text \"First\"\n   slot content\n    text \"Second\"\n",
            "chat_bubble",
        ),
        ("  alert \"Notice\" tone=neutral\n", "alert"),
        ("  badge \"Value\" unknown=true\n", "badge"),
        ("  details \"Caption\"\n   require false\n", "details"),
        ("  collapse\n   text \"Body\"\n", "collapse"),
        ("  collapse \"Caption\" open=1\n   text \"Body\"\n", "open="),
        ("  collapse \"Caption\"\n   require false\n", "collapse"),
        (
            "  collapse \"Caption\"\n   slot content\n    text \"Body\"\n",
            "collapse",
        ),
        (
            "  details \"Caption\"\n   slot content\n    text \"Body\"\n",
            "details",
        ),
        (
            "  collapse \"Caption\" open=absent\n   text \"Body\"\n",
            "absent",
        ),
        ("  fieldset \"Caption\"\n   require false\n", "fieldset"),
        ("  join\n   require false\n", "join"),
        ("  hero\n   require false\n", "hero"),
        ("  hero unknown=true\n   text \"Body\"\n", "hero"),
        ("  hero\n   slot content\n    text \"Body\"\n", "hero"),
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
        let expected_code = if profile == "unsupported attribute" {
            "E1203"
        } else if profile == "bound tab panels" {
            "E3001"
        } else if profile == "open=" {
            "E3007"
        } else if profile == "absent" {
            "E2001"
        } else {
            "E6008"
        };
        assert!(
            diagnostic["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|error| {
                    error["code"] == expected_code
                        && error["message"].as_str().unwrap().contains(profile)
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

#[test]
fn nullable_file_destinations_reach_presenter_once_in_authored_order() {
    use std::process::Command;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    for component in ["button", "link"] {
        let scratch = tempfile::tempdir().unwrap();
        let source = scratch.path().join("file-target.can");
        let specimen = r#"app FileTargets
Given
 Item {caption:text, pdf:file?, direct:file, show:bool, destination:url}
 policy Item read=members
When
Then
 page / title="Files"
  list Item
   button caption=row.caption target=row.pdf
    require row.show
   primary "Direct PDF" target=row.direct
    require row.show
   text "After files"
 page /urls title="URLs"
  list Item
   link target=row.destination caption=row.destination
  link target="/safe" caption="Go"@{nl="Ga"}
"#;
        let specimen = if component == "link" {
            specimen
                .replace("button caption=row.caption", "link caption=row.caption")
                .replace(
                    "primary \"Direct PDF\" target=row.direct",
                    "link caption=\"Direct PDF\" target=row.direct",
                )
        } else {
            specimen.to_string()
        };
        std::fs::write(&source, specimen).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&source)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let artifact = scratch.path().join("artifact.json");
        std::fs::write(&artifact, output.stdout).unwrap();
        let runner = scratch.path().join("consume.mjs");
        std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,artifactPath,scratch,component]=process.argv.slice(2);
const load=path=>import(pathToFileURL(resolve(root,path)));
const {loadArtifactFile}=await load('packages/cloudflare/dist/runtime/artifact.js');
const {assembleModules}=await load('packages/cloudflare/dist/runtime/modules.js');
const fixture={trace:[],show:true,target:null,withheld:false,failure:false};
globalThis.fileTargetFixture=fixture;
const native={show:true};
for(const name of ['show','caption','pdf','direct','destination']) Object.defineProperty(native,name,{enumerable:true,configurable:true,get(){
 fixture.trace.push(name);
 if(name==='show')return fixture.show;
 if(name==='destination')return 'https://example.test/referral';
 if(!fixture.show)throw new Error('hidden target evaluated');
 return name==='caption'?'Open <PDF>':name==='pdf'?fixture.target:{kind:'file',id:'direct'};
}});
fixture.native=native;
const uiPath=resolve(scratch,'ui.mjs');
writeFileSync(uiPath,`export * from ${JSON.stringify(pathToFileURL(resolve(root,'packages/ui/dist/src/index.js')).href)};
export async function list(props){const f=globalThis.fileTargetFixture;return (await Promise.all(await props.renderRow({id:'item',version:'1',fields:{}},props.context,f.native))).join('');}`);
const loaded=loadArtifactFile(artifactPath);
const asm=await assembleModules(loaded,{workDir:resolve(scratch,'modules'),stdlibUrl:pathToFileURL(resolve(root,'packages/cloudflare/dist/runtime/stdlib.js')).href,uiUrl:pathToFileURL(uiPath).href});
const ref=loaded.artifact.pages[0],module=await import(asm.moduleUrls[ref.module]);
const page=module[ref.export];
const context={path:'/',preferredLocales:[],appDefaultLocale:'en',memberships:[],canonical:{builtinRoles:[]},async presentFile(file){
 fixture.trace.push(`present:${file.id}:start`);await Promise.resolve();
 if(fixture.failure)throw new Error('presenter-failed');
 fixture.trace.push(`present:${file.id}:end`);
 return fixture.withheld?null:{href:`/files/read/${file.id}`};
}};
let html=await page.render(context,{});
assert.ok(html.includes('aria-disabled="true">Open &lt;PDF&gt;'));
assert.ok(html.includes(component==='button'?'disabled aria-disabled':'role="link" aria-disabled'));
assert.ok(html.includes('href="/files/read/direct"'));
assert.deepEqual(fixture.trace,['show','caption','pdf','show','direct','present:direct:start','present:direct:end']);
fixture.trace=[];fixture.target={kind:'file',id:'optional'};
html=await page.render(context,{});
assert.ok(html.indexOf('/files/read/optional')<html.indexOf('/files/read/direct'));
assert.ok(html.indexOf('/files/read/direct')<html.indexOf('After files'));
assert.deepEqual(fixture.trace,['show','caption','pdf','present:optional:start','present:optional:end','show','direct','present:direct:start','present:direct:end']);
fixture.trace=[];fixture.withheld=true;
html=await page.render(context,{});assert.equal((html.match(/aria-disabled/g)||[]).length,2);assert.ok(!html.includes('href='));
fixture.trace=[];fixture.show=false;
html=await page.render(context,{});assert.deepEqual(fixture.trace,['show','show']);assert.ok(!html.includes('Open &lt;PDF&gt;'));
fixture.trace=[];fixture.show=true;fixture.failure=true;
await assert.rejects(page.render(context,{}),/presenter-failed/);
assert.deepEqual(fixture.trace,['show','caption','pdf','present:optional:start'],'first presenter failure prevents following sibling evaluation');
const urlRef=loaded.artifact.pages[1],urlModule=await import(asm.moduleUrls[urlRef.module]);
const urlHtml=await urlModule[urlRef.export].render({...context,preferredLocales:['nl']},{});
assert.ok(urlHtml.includes('href="https://example.test/referral">https://example.test/referral</a>'),urlHtml);
assert.ok(urlHtml.includes('href="/safe">Ga</a>'));
delete globalThis.fileTargetFixture;
"#).unwrap();
        let result = Command::new("node")
            .arg(runner)
            .arg(root)
            .arg(artifact)
            .arg(scratch.path())
            .arg(component)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        // The extension is exact File?, not arbitrary nullable destinations or collections.
        // A nullable URL stays refused for buttons, but is the accepted
        // link profile (outcome 2 renders its absent state instead).
        let mut refused: Vec<&str> = vec!["file[]"];
        if component == "button" {
            refused.push("url?");
        }
        for ty in refused {
            let bad = format!(
                "app InvalidFileTarget\nGiven\n Item {{target:{ty}}}\nWhen\nThen\n page / title=\"Files\"\n  list Item\n   {component} caption=\"Open\" target=row.target\n"
            );
            std::fs::write(&source, bad).unwrap();
            let output = Command::new(env!("CARGO_BIN_EXE_can"))
                .args(["check", "--format=json", "--catalog"])
                .arg(root.join("packages/values/dist/catalog.json"))
                .arg(&source)
                .output()
                .unwrap();
            assert!(!output.status.success(), "{ty} unexpectedly accepted");
            let diagnostics: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(
                diagnostics["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|d| d["code"] == "E3001"),
                "{diagnostics}"
            );
        }
    }
}

#[test]
fn nullable_url_link_destinations_render_present_and_absent_states() {
    use std::process::Command;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("url-target.can");
    let specimen = r#"app UrlTargets
Given
 Item { href:url?, shown:bool }
 policy Item read=members
 derive pick(href:url?):url? = href
When
Then
 page / title="Links"
  list Item
   link target=row.href caption="Direct"
    require row.shown
   link target=pick(row.href) caption="Helped"
   link target=row.href
"#;
    std::fs::write(&source, specimen).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let compiled: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let js = compiled["modules"][0]["js"].as_str().unwrap();
    // One static absent-URL marker per nullable-URL link; the marker
    // carries no evaluation, so authored order is untouched.
    assert_eq!(
        js.matches("absentUrl:true").count(),
        3,
        "each nullable-url link emits its absent-state marker: {js}"
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, output.stdout).unwrap();
    let runner = scratch.path().join("consume.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,artifactPath,scratch]=process.argv.slice(2);
const load=path=>import(pathToFileURL(resolve(root,path)));
const {loadArtifactFile}=await load('packages/cloudflare/dist/runtime/artifact.js');
const {assembleModules}=await load('packages/cloudflare/dist/runtime/modules.js');
const fixture={trace:[],shown:true,href:'https://example.test/source',denied:false};
globalThis.urlTargetFixture=fixture;
const native={shown:true,href:'https://example.test/source'};
for(const name of ['shown','href']) Object.defineProperty(native,name,{enumerable:true,configurable:true,get(){
 fixture.trace.push(name);
 if(fixture.denied&&name==='href')throw new Error('forbidden');
 if(name==='shown')return fixture.shown;
 return fixture.href;
}});
fixture.native=native;
const uiPath=resolve(scratch,'ui.mjs');
writeFileSync(uiPath,`export * from ${JSON.stringify(pathToFileURL(resolve(root,'packages/ui/dist/src/index.js')).href)};
export async function list(props){const f=globalThis.urlTargetFixture;return (await Promise.all(await props.renderRow({id:'item',version:'1',fields:{}},props.context,f.native))).join('');}`);
const loaded=loadArtifactFile(artifactPath);
const asm=await assembleModules(loaded,{workDir:resolve(scratch,'modules'),stdlibUrl:pathToFileURL(resolve(root,'packages/cloudflare/dist/runtime/stdlib.js')).href,uiUrl:pathToFileURL(uiPath).href});
const ref=loaded.artifact.pages[0],module=await import(asm.moduleUrls[ref.module]);
const page=module[ref.export];
const context={path:'/',preferredLocales:[],appDefaultLocale:'en',memberships:[],canonical:{builtinRoles:[]}};
// Present direct, helper-produced and bare destinations render hrefs in authored order.
let html=await page.render(context,{});
assert.ok(html.includes('href="https://example.test/source">Direct</a>'),html);
assert.ok(html.includes('href="https://example.test/source">Helped</a>'),html);
assert.ok(html.includes('href="https://example.test/source">https://example.test/source</a>'),html);
assert.deepEqual(fixture.trace,['shown','href','href','href']);
// Absent destinations share one noninteractive state with no href: authored
// captions where given, the shared unavailable label otherwise.
fixture.trace=[];fixture.href=null;
html=await page.render(context,{});
assert.ok(html.includes('role="link" aria-disabled="true">Direct<'),html);
assert.ok(html.includes('aria-disabled="true">Helped<'),html);
assert.ok(html.includes('aria-disabled="true">Unavailable<'),html);
assert.ok(!html.includes('href='),html);
const nlHtml=await page.render({...context,preferredLocales:['nl']},{});
assert.ok(nlHtml.includes('aria-disabled="true">Niet beschikbaar<'),nlHtml);
// An authored guard omits its control before child evaluation.
fixture.trace=[];fixture.shown=false;
html=await page.render(context,{});
assert.ok(!html.includes('Direct'),html);
assert.ok(html.includes('aria-disabled="true">Helped<'),html);
assert.deepEqual(fixture.trace,['shown','href','href']);
// A denied field stays a failure: it never becomes an absent destination,
// and the first failure prevents later sibling evaluation.
fixture.trace=[];fixture.shown=true;fixture.denied=true;
await assert.rejects(page.render(context,{}),/forbidden/);
assert.deepEqual(fixture.trace,['shown','href']);
delete globalThis.urlTargetFixture;
"#).unwrap();
    let result = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(artifact)
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
