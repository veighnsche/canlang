//! Original compact footer -> generated module -> installed server UI.
use std::path::Path;
use std::process::Command;

fn compile(source: &str, scratch: &Path) -> serde_json::Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let input = scratch.join("footer.can");
    std::fs::write(&input, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn original_compact_footer_reaches_installed_ui_with_localized_ordered_escaped_children() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let original = include_str!("../../draft/apps/CanCRM/CanCRM.can");
    let lines: Vec<_> = original.lines().collect();
    let start = lines
        .iter()
        .position(|line| line.trim_start().starts_with("footer \"Tours, quotes"))
        .unwrap();
    let original_footer = format!(
        "  {}\n   {}\n",
        lines[start].trim(),
        lines[start + 1].trim()
    );
    let source = format!(
        "app FooterProfile\nGiven\nWhen\nThen\n page / title=\"Footer\"\n{original_footer}   text \"<first>&\"\n   text \"second\"\n page /denied title=\"Denied\"\n  footer \"Hidden\"\n   require false\n   text \"Unobserved\"\n"
    );
    let scratch = tempfile::tempdir().unwrap();
    let artifact = compile(&source, scratch.path());
    assert!(
        artifact
            .get("diagnostics")
            .and_then(|value| value.as_array())
            .is_none_or(|values| values.is_empty()),
        "{artifact}"
    );
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
    let entry = scratch
        .path()
        .join(artifact["modules"][0]["path"].as_str().unwrap());
    let runner = scratch.path().join("footer.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {appDefinition}=await import(pathToFileURL(process.argv[2]));
const page=appDefinition.pages.find(page=>page.path==='/');
for(const [locale,caption,body] of [['en','Tours, quotes and accounts use their owning operations','CSV import previews invalid and duplicate rows'],['nl','Rondleidingen, offertes en accounts gebruiken hun eigen bewerkingen','CSV-import toont ongeldige en dubbele rijen']]) {
 const c={appDefaultLocale:'en',preferredLocales:[locale],path:'/',pollUrl:'/?fragment=body',csrfToken:'footer'};
 const html=await page.render(c,await page.admit(c));
 assert.ok(html.includes('<footer class="footer"'));
 assert.ok(html.includes(caption));assert.ok(html.includes(body));
 assert.ok(html.includes('&lt;first&gt;&amp;'));assert.ok(!html.includes('<first>'));
 assert.ok(html.indexOf(body)<html.indexOf('&lt;first&gt;&amp;'));assert.ok(html.indexOf('&lt;first&gt;&amp;')<html.indexOf('second'));
}
const denied=appDefinition.pages.find(page=>page.path==='/denied');
const c={appDefaultLocale:'en',preferredLocales:[],path:'/denied',pollUrl:'/denied',csrfToken:'footer'};
const html=await denied.render(c,await denied.admit(c));
assert.ok(!html.includes('Hidden'));assert.ok(!html.includes('Unobserved'));
"#).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(entry)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn compact_footer_refuses_unconsumed_slots_options_empty_body_and_multiple_captions() {
    for body in [
        "  footer \"Empty\"\n",
        "  footer \"One\",\"Two\"\n   text \"Body\"\n",
        "  footer \"Unknown\" size=lg\n   text \"Body\"\n",
        "  footer \"Slotted\"\n   slot content\n    text \"Body\"\n",
        "  footer \"Mixed\"\n   text \"Compact\"\n   slot content\n    text \"Slot\"\n",
    ] {
        let scratch = tempfile::tempdir().unwrap();
        let result = compile(
            &format!("app FooterRefusal\nGiven\nWhen\nThen\n page / title=\"Page\"\n{body}"),
            scratch.path(),
        );
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["severity"] == "error"),
            "{body}: {result}"
        );
        assert!(
            result.get("modules").is_none(),
            "{body}: published refused footer"
        );
    }
}

#[test]
fn compact_footer_retains_collection_row_binding_and_lazy_gate() {
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::codegen::{ir, js};
    use canlang_compiler::source::SourceDb;
    let source = "app FooterRows\nGiven\n Entry {name:text,visible:bool}\n policy Entry read=public\nWhen\nThen\n page / title=\"Rows\"\n  list Entry\n   footer \"Row footer\"\n    require row.visible\n    text row.name\n";
    let mut db = SourceDb::new();
    let file = db.add("footer-rows.can".into(), source.into());
    let (checked, diagnostics) = check_program(&db, &[file], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = ir::build(&checked, &db, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let list = &program.modules[0].pages[0].render[0];
    let footer = &list.children[0];
    assert_eq!(footer.factory, "footer");
    assert!(footer.gate.is_some());
    assert_eq!(footer.children[0].factory, "text");
    let mut emitter = js::Emitter::new(&program);
    let emitted = emitter.lower_ui(list);
    let (diagnostics, _, _, _) = emitter.finish();
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        emitted.contains(".visible ? $can$u$666f6f746572("),
        "{emitted}"
    );
    assert!(emitted.contains(".name"), "{emitted}");
}
