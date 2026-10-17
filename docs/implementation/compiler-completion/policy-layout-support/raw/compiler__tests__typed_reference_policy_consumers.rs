//! Pass5 production consumers: fresh compiler output enters the actual docs
//! renderer and policy UI. Missing Node/built packages skip loudly; malformed
//! output or unavailable exports fail instead of substituting a test renderer.
#![cfg(unix)]

use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::docs::extract_reference;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = r#"app Shop source="en"
Given
 role editor label="Audit <&>"
 # Source gadget. @{nl="Nederlandse gadget.",fr=null}
 Gadget { title:text="a\n" desc="Source title."@{nl="",fr=null}, alias:text desc="", stock:int=42 }
 # Source widget.
 Widget { title:text }
 policy Gadget read=members where=row.stock>0
 policy Widget read=members
 invariant Gadget: row.stock>=0
When
 scenario rename(item:Gadget) by=editor
  require item.title!="<blocked&>"
  do set item {title="sold"}
Then
"#;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn available(name: &str, required: &[&str]) -> Option<PathBuf> {
    let root = root();
    for relative in required {
        if !root.join(relative).is_file() {
            eprintln!("SKIP {name}: missing built package {relative}");
            return None;
        }
    }
    match Command::new("node").arg("--version").output() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("SKIP {name}: Node unavailable");
            None
        }
        Err(error) => panic!("Node probe failed: {error}"),
        Ok(output) => {
            assert!(output.status.success(), "Node probe failed: {output:?}");
            Some(root)
        }
    }
}

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn cli(root: &Path, source: &Path, command: &str) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_can"));
    cmd.arg(command)
        .arg("--catalog")
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(source)
        .current_dir(root);
    cmd
}

fn success(output: std::process::Output) -> String {
    assert!(
        output.status.success(),
        "consumer failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn fresh_docs_cli_and_extracted_typed_json_enter_public_markdown_renderer() {
    let Some(root) = available(
        "typed_reference_consumer",
        &[
            "packages/values/dist/catalog.json",
            "packages/cloudflare/dist/cli/platform.js",
            "packages/interfaces/dist/src/index.js",
        ],
    ) else {
        return;
    };
    let dir = scratch();
    let source = dir.path().join("shop.can");
    std::fs::write(&source, SOURCE).unwrap();
    let platform = root.join("packages/cloudflare/dist/cli/platform.js");
    assert!(
        std::fs::read_to_string(&platform)
            .unwrap()
            .starts_with("#!/usr/bin/env node\n")
    );
    let nl = success(
        cli(&root, &source, "docs")
            .arg("--locale=nl")
            .env("CAN_PLATFORM_BIN", &platform)
            .output()
            .unwrap(),
    );
    assert!(nl.contains("Nederlandse gadget."), "{nl}");
    assert!(nl.contains("Source widget."), "{nl}");
    assert!(!nl.contains("Source gadget."), "{nl}");
    assert!(
        !nl.contains("Source title."),
        "authored empty translation must win: {nl}"
    );
    assert!(
        // Code spans preserve literal backslashes without Markdown escape doubling.
        nl.contains(r#"| `title` | `text` | no | no | `"a\n"` | — |  |"#),
        "{nl}"
    );
    assert!(
        nl.contains("| `alias` | `text` | no | yes | — | — |  |"),
        "{nl}"
    );
    assert!(
        nl.contains("| `stock` | `int` | no | no | `42` | — | Geen beschrijving. |"),
        "{nl}"
    );
    let fr = success(
        cli(&root, &source, "docs")
            .arg("--locale=fr")
            .env("CAN_PLATFORM_BIN", &platform)
            .output()
            .unwrap(),
    );
    assert!(
        fr.contains("Source gadget."),
        "null variant must fall back: {fr}"
    );
    assert!(fr.contains("Source title."), "{fr}");

    // Independently use the public extractor, then production typed output,
    // then the public renderer export. This also observes null vs omission.
    let mut db = SourceDb::new();
    let id = db.add(source.to_string_lossy().into_owned(), SOURCE.into());
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let model = extract_reference(&db, &[id], &program);
    let json_path = dir.path().join("reference.json");
    std::fs::write(&json_path, model.to_json_string()).unwrap();
    let (program_without_catalog, diagnostics) = check_program(&db, &[id], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let no_catalog_path = dir.path().join("reference-without-catalog.json");
    std::fs::write(
        &no_catalog_path,
        extract_reference(&db, &[id], &program_without_catalog).to_json_string(),
    )
    .unwrap();
    let runner = dir.path().join("reference.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {renderReferenceMarkdown} = await import(pathToFileURL(process.argv[2]));
const model = JSON.parse(readFileSync(process.argv[3], 'utf8'));
assert.equal(model.availability.status, 'unknown');
assert.equal(typeof model.catalogVersion, 'string');
const gadget = model.owners.flatMap(o => o.declarations).find(d => d.name === 'Gadget');
const title = gadget.fields.find(f => f.name === 'title');
assert.equal(title.default, '"a\\n"');
assert.deepEqual(title.description.variants, [{tag:'nl',text:''},{tag:'fr',text:null}]);
const alias = gadget.fields.find(f => f.name === 'alias');
assert.equal(alias.description.source, '');
assert.equal(Object.hasOwn(alias, 'default'), false);
const stock = gadget.fields.find(f => f.name === 'stock');
assert.equal(Object.hasOwn(stock, 'description'), false);
assert.equal(stock.default, '42');
assert.equal(renderReferenceMarkdown(model, {locale:'nl'}), readFileSync(process.argv[4], 'utf8'));
const source = renderReferenceMarkdown(model, {locale:'fr'});
assert.ok(source.includes('Source gadget.'));
assert.ok(source.includes('Source title.'));
const withoutCatalog = JSON.parse(readFileSync(process.argv[5], 'utf8'));
assert.equal(Object.hasOwn(withoutCatalog, 'catalogVersion'), true);
assert.equal(withoutCatalog.catalogVersion, null);
assert.ok(renderReferenceMarkdown(withoutCatalog).includes('- Catalog version: none'));
console.log('PASS typed reference: fresh docs CLI and extracted JSON through public Markdown renderer');
"#).unwrap();
    let markdown_path = dir.path().join("cli.md");
    std::fs::write(&markdown_path, nl).unwrap();
    let output = success(
        Command::new("node")
            .arg(&runner)
            .arg(root.join("packages/interfaces/dist/src/index.js"))
            .arg(json_path)
            .arg(markdown_path)
            .arg(no_catalog_path)
            .output()
            .unwrap(),
    );
    eprint!("{output}");
}

#[test]
fn fresh_policy_cli_enters_actual_policy_sections_and_html_page() {
    let Some(root) = available(
        "typed_policy_consumer",
        &[
            "packages/values/dist/catalog.json",
            "packages/ui/dist/src/policyPage.js",
        ],
    ) else {
        return;
    };
    let dir = scratch();
    let source = dir.path().join("shop.can");
    std::fs::write(&source, SOURCE).unwrap();
    let dump = success(
        cli(&root, &source, "policy")
            .arg("--format=json")
            .output()
            .unwrap(),
    );
    assert!(dump.ends_with("}\n\n"));
    assert!(!dump.ends_with("}\n\n\n"));
    let dump_path = dir.path().join("policy.json");
    std::fs::write(&dump_path, dump).unwrap();
    let runner = dir.path().join("policy.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {policyDumpSections, policyPage} = await import(pathToFileURL(process.argv[2]));
const dump = JSON.parse(readFileSync(process.argv[3], 'utf8'));
assert.equal(dump.version, 1);
const sections = policyDumpSections(dump);
const section = name => sections.find(s => s.heading === name);
assert.deepEqual(section('Shop.Gadget').policies, [
 {text:'policy Gadget read=members where=row.stock>0',decision:'read=members',rationale:'row.stock>0',actor:null,time:null},
 {text:'invariant Gadget: row.stock>=0',decision:null,rationale:'row.stock>=0',actor:null,time:null},
]);
assert.deepEqual(section('Shop.rename').policies, [
 {text:'scenario rename(item:Gadget) by=editor',decision:'editor',rationale:'item.title!="<blocked&>"',actor:null,time:null},
]);
assert.deepEqual(section('Shop.editor').policies, [
 {text:'"Audit <&>"',decision:'Shop.editor',rationale:null,actor:null,time:null},
]);
assert.equal(Object.hasOwn(dump.models.find(m => m.canonical === 'Shop.Widget').policies[0], 'where'), false);
const context = {preferredLocales:[],appDefaultLocale:'en',theme:{mode:'system',accent:'blue',density:'comfortable'},path:'/policy',isPartial:false,csrfToken:'csrf',principal:null,invocation:null,query:async()=>({rows:[],columns:[]})};
const html = await policyPage({context,dump});
assert.ok(html.includes('Shop.Gadget'));
assert.ok(html.includes('read=members'));
assert.ok(html.includes('row.stock&gt;0'));
assert.ok(html.includes('stock&gt;=0'));
assert.ok(html.includes('&lt;blocked&amp;&gt;'));
assert.ok(html.includes('Audit &lt;&amp;&gt;'));
assert.equal(html.includes('<blocked&>'), false);
assert.equal(html.includes('Audit <&>'), false);
console.log('PASS typed policy: fresh CLI through actual policyDumpSections and policyPage escaping');
"#).unwrap();
    let output = success(
        Command::new("node")
            .arg(&runner)
            .arg(root.join("packages/ui/dist/src/policyPage.js"))
            .arg(dump_path)
            .output()
            .unwrap(),
    );
    eprint!("{output}");
}
