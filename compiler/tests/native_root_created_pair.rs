//! Original adjacent Team-root constructors with an independent existing-row result.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItemKind, IrProgram, IrStmt};
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

const SOURCE: &str = r#"app RootPairs
Given
 Customer {active:bool}
 Contact in Customer {name:text}
 Location {currency:currency}
 Deal {customer:Customer,contact:Contact,location:Location,title:text trim min=1,value:money,notes:text,owner:user=actor,seats:int=1}
 contract Lead {customer:Customer,contact:Contact,location:Location,title:Deal.title,value:money,notes:text}
 Intake {source:text unique,input:Lead,deal:Deal}
 invariant Deal: row.contact.parent==row.customer and row.value.minor>=0 and row.value.currency==row.location.currency
 lock Intake fields=source,input,deal
 policy Customer read=members
 policy Contact read=members
 policy Location read=members
 policy Deal read=members
 policy Intake read=members
When
 scenario promote(source:text,input:Lead,accept:bool) -> Deal by=members
  require starts_with(source,"discover:") and source!="discover:" and input.customer.active
  do
   let existing=first(Intake as candidate where candidate.source==source)
   if existing!=null
    require existing.input==input and accept
    return existing.deal
   create Deal {customer=input.customer,contact=input.contact,location=input.location,title=input.title,value=input.value,notes=input.notes} as deal
   create Intake {source,input,deal} as intake
   return deal
Then
"#;
const ENTRY: &str = "$can$m$526f6f745061697273.mjs";

fn checked(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let file = db.add("root-created-pair.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

#[test]
fn original_and_renamed_root_pairs_keep_existing_reference_and_fresh_create_results() {
    for source in [
        SOURCE.to_string(),
        SOURCE
            .replace("RootPairs", "Renamed")
            .replace("Deal", "Opportunity")
            .replace("deal", "opportunity")
            .replace("Intake", "Evidence")
            .replace("Lead", "Review")
            .replace("existing", "selected"),
        SOURCE.replace(
            "   return deal\nThen",
            "   require accept\n   return deal\nThen",
        ),
        SOURCE.replace("   let existing=first(Intake as candidate where candidate.source==source)\n   if existing!=null\n    require existing.input==input and accept\n    return existing.deal\n", ""),
    ] {
        let (db, program, ir, catalog) = checked(&source);
        let owner = ir.items.iter().find(|item| item.name == "promote").unwrap();
        let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
            panic!("{:?}", ir.scenario_disclosures[&owner.id]);
        };
        assert_eq!(proof.effects.len(), 2);
        // Disclosure paths retain separate short-circuit alternatives. The
        // original source return sites remain distinct from path count.
        let sites: std::collections::HashSet<_> =
            proof.returns.iter().map(|returned| returned.node).collect();
        let has_early = source.contains("let existing=") || source.contains("let selected=");
        assert_eq!(sites.len(), 1 + usize::from(has_early));
        if !has_early {
            assert!(proof.source_facts.as_ref().unwrap().queries.as_ref().unwrap().is_empty());
        }
        let authored = &db.get(owner.span.file).unwrap().text;
        let expected = if source.contains("Renamed") {
            ["return selected.opportunity", "return opportunity"]
        } else {
            ["return existing.deal", "return deal"]
        };
        for expected in expected.into_iter().skip(usize::from(!has_early)) {
            assert!(sites.iter().any(|site| authored[site.start as usize..site.end as usize].contains(expected)));
        }
        let mut result = DiagnosticResult::new("root-created-pair", "1.0", 1);
        result.add_sources(&db);
        let (artifact, diagnostics) = emit(
            &program,
            &EmitSources {
                db: &db,
                result: &result,
                catalog: Some(&catalog),
                options: EmitOptions {
                    allow_incomplete_test_only: false,
                    native_scenario_receipts: true,
                },
            },
        );
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let artifact: serde_json::Value = serde_json::from_str(&to_json(&artifact)).unwrap();
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == owner.canonical)
            .unwrap();
        assert!(
            operation["result"]["disclosure"]["returns"]
                .as_array()
                .is_some_and(|returns| !returns.is_empty())
        );
        assert!(artifact["modelPolicies"].is_array());
    }
}

#[test]
fn root_pair_source_join_refuses_substituted_identity_order_and_guard() {
    let (db, program, original, catalog) = checked(SOURCE);
    let owner = original
        .items
        .iter()
        .find(|item| item.canonical == "RootPairs.promote")
        .unwrap()
        .id;
    assert!(
        serialize_complete_query_receipt(
            &program,
            &original,
            &original.items[owner.0 as usize],
            &db,
            Some(&catalog),
            ENTRY
        )
        .is_some()
    );
    for corruption in 0..5 {
        let mut changed = original.clone();
        {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario");
            };
            match corruption {
                0 => effects.swap(2, 3),
                1 => {
                    let IrStmt::Create { input, .. } = &mut effects[3] else {
                        panic!("second create");
                    };
                    let IrExpr::Object(entries) = &mut input.expr else {
                        panic!("input");
                    };
                    entries
                        .iter_mut()
                        .find(|(name, _)| name == "deal")
                        .unwrap()
                        .1
                        .expr = IrExpr::Name("copied".into());
                }
                2 => {
                    let IrStmt::Return {
                        value: Some(value), ..
                    } = effects.last_mut().unwrap()
                    else {
                        panic!("return");
                    };
                    value.expr = IrExpr::Name("intake".into());
                }
                3 => {
                    let IrStmt::If { then_branch, .. } = &mut effects[1] else {
                        panic!("prefix");
                    };
                    let IrStmt::Return {
                        value: Some(value), ..
                    } = &mut then_branch[1]
                    else {
                        panic!("early return");
                    };
                    let IrExpr::Member { field, .. } = &mut value.expr else {
                        panic!("reference");
                    };
                    *field = "input".into();
                }
                4 => {
                    let IrStmt::Create { when, .. } = &mut effects[3] else {
                        panic!("second create");
                    };
                    *when = Some("invented".into());
                }
                _ => unreachable!(),
            }
        }
        assert!(
            serialize_complete_query_receipt(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog),
                ENTRY
            )
            .is_none(),
            "corruption {corruption}"
        );
    }
}
