//! Retained-facts tamper coverage for the direct any/first matcher.
//!
//! `checked_any_first_query_ir` admits the leading `require not any(...)`
//! composition only when the retained IR tree matches the fixed checked
//! facts: the navigated parent base keeps its exact original occurrence
//! and declared input type, and each conjunct operand keeps its sealed
//! shape. These units call the defining matcher directly with the
//! original checked facts fixed (same `SourceDb`, same built
//! `scenario_disclosures`) and mutate only the retained IR copy: a
//! shifted parent-base span or a swapped parent-base type must each
//! refuse. The honest emitted path is covered by the installed consumer,
//! not re-proven here. Scope is the admitted `by=members` narrow profile,
//! not original authenticated callers.
use super::checked_any_first_query_ir;
use crate::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use crate::analysis::{check_program, CheckedProgram, ResolvedType, Scalar};
use crate::codegen::ir::{
    IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrUnOp, TypedExpr,
};
use crate::source::{SourceDb, Span};
use std::path::Path;

const SOURCE: &str = r#"app AnyFirstRetain
Given
 P {v:int,active:bool=true}
 C in P {account:user,role:enum(administrator,booker),active:bool=true}
 D in P {account:user,role:C.role,w:int}
 I in P {role:C.role}
 policy P read=members fields=v,active
 policy C read=members fields=parent,account,role,active
 policy D read=members fields=parent,account,role,w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role,active
 crud D by=members fields=parent,account,role,w
 crud I by=members fields=parent,role
 scenario accept(invitation:I) by=members
  require not any(invitation.parent.C as grant,grant.account==actor and grant.role==invitation.role and grant.active)
  do
   let c=first(invitation.parent.C as c where c.account==actor and c.role==invitation.role order=c.id)
   require c!=null
   create D {parent=invitation.parent,account=actor,role=invitation.role,w=1} as d
Then
"#;

const POSITIVE_SOURCE: &str = r#"app AnyFirstPositive
Given
 P {v:int,active:bool=true}
 C in P {account:user,role:enum(administrator,booker),active:bool=true}
 D in P {account:user,role:C.role,w:int}
 I in P {role:C.role}
 policy P read=members fields=v,active
 policy C read=members fields=parent,account,role,active
 policy D read=members fields=parent,account,role,w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role,active
 crud D by=members fields=parent,account,role,w
 crud I by=members fields=parent,role
 scenario accept(invitation:I) by=members
  require any(invitation.parent.C as grant,grant.account==actor and grant.role==invitation.role and grant.active)
  do
   let c=first(invitation.parent.C as c where c.account==actor and c.role==invitation.role order=c.id)
   require c!=null
   create D {parent=invitation.parent,account=actor,role=invitation.role,w=1} as d
Then
"#;

fn fixture() -> (SourceDb, CheckedProgram, IrProgram) {
    fixture_source(SOURCE, "any-first-retained.can")
}

fn positive_fixture() -> (SourceDb, CheckedProgram, IrProgram) {
    fixture_source(POSITIVE_SOURCE, "any-first-positive.can")
}

fn fixture_source(source: &str, name: &str) -> (SourceDb, CheckedProgram, IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add(name.into(), source.into());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog: Catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir)
}

fn accept_index(ir: &IrProgram) -> usize {
    ir.items
        .iter()
        .position(|item| item.canonical == "AnyFirstRetain.accept")
        .expect("retained accept scenario")
}

fn positive_accept_index(ir: &IrProgram) -> usize {
    ir.items
        .iter()
        .position(|item| item.canonical == "AnyFirstPositive.accept")
        .expect("positive accept scenario")
}

/// Leading `require any(...)` guard call: the positive-dual collection call.
fn positive_guard_operand(item: &IrItem) -> Option<&TypedExpr> {
    let IrItemKind::Scenario { guards, .. } = &item.kind else {
        return None;
    };
    guards.iter().find_map(|statement| {
        let IrStmt::Require { cond, .. } = statement else {
            return None;
        };
        matches!(
            &cond.expr,
            IrExpr::Call { .. } | IrExpr::BoundCall { .. }
        )
        .then_some(cond)
    })
}

/// Leading `require not any(...)` guard operand: the actual collection call.
fn guard_operand(item: &IrItem) -> Option<&TypedExpr> {
    let IrItemKind::Scenario { guards, .. } = &item.kind else {
        return None;
    };
    guards.iter().find_map(|statement| {
        let IrStmt::Require { cond, .. } = statement else {
            return None;
        };
        let IrExpr::Unary { op, operand } = &cond.expr else {
            return None;
        };
        if !matches!(op, IrUnOp::Not) {
            return None;
        }
        matches!(
            &operand.expr,
            IrExpr::Call { .. } | IrExpr::BoundCall { .. }
        )
        .then_some(operand.as_ref())
    })
}

/// The navigated domain parent (`invitation.parent`) under that operand.
fn domain_parent_base(item: &IrItem) -> Option<&TypedExpr> {
    let call = guard_operand(item)?;
    let args = match &call.expr {
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => args.as_slice(),
        _ => return None,
    };
    let [domain, _] = args else { return None };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    let parent = scan.parent.as_deref()?;
    let IrExpr::Member { base, field } = &parent.expr else {
        return None;
    };
    (field == "parent").then_some(base.as_ref())
}

fn domain_parent_base_mut(item: &mut IrItem) -> Option<&mut TypedExpr> {
    let IrItemKind::Scenario { guards, .. } = &mut item.kind else {
        return None;
    };
    let operand = guards.iter_mut().find_map(|statement| {
        let IrStmt::Require { cond, .. } = statement else {
            return None;
        };
        let IrExpr::Unary { op, operand } = &mut cond.expr else {
            return None;
        };
        if !matches!(op, IrUnOp::Not) {
            return None;
        }
        matches!(
            &operand.expr,
            IrExpr::Call { .. } | IrExpr::BoundCall { .. }
        )
        .then_some(operand.as_mut())
    })?;
    let args = match &mut operand.expr {
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => args.as_mut_slice(),
        _ => return None,
    };
    let [domain, _] = args else { return None };
    let IrExpr::Query(scan) = &mut domain.expr else {
        return None;
    };
    let parent = scan.parent.as_deref_mut()?;
    let IrExpr::Member { base, field } = &mut parent.expr else {
        return None;
    };
    (field == "parent").then_some(base.as_mut())
}

#[test]
fn honest_retained_tree_admits_composition() {
    let (db, _program, ir) = fixture();
    let item = &ir.items[accept_index(&ir)];
    let actual = guard_operand(item).expect("leading any guard operand");
    let matched = checked_any_first_query_ir(&ir, item, actual, &db);
    let query = matched.expect("honest retained tree admits");
    assert_eq!(query.model_name, "AnyFirstRetain.C");
    assert_eq!(query.dependencies.len(), 3);
}

#[test]
fn shifted_parent_base_span_refuses_with_fixed_facts() {
    let (db, _program, ir) = fixture();
    let mut retained = ir.clone();
    let index = accept_index(&retained);
    {
        let base = domain_parent_base_mut(&mut retained.items[index])
            .expect("navigated parent base");
        base.span.start += 1;
    }
    // Same SourceDb and same built disclosures; only the retained IR
    // occurrence moved off its original source span.
    let item = &retained.items[index];
    let actual = guard_operand(item).expect("leading any guard operand");
    assert!(
        checked_any_first_query_ir(&retained, item, actual, &db).is_none(),
        "shifted parent base must refuse"
    );
}

#[test]
fn positive_guard_admits_same_composition() {
    let (db, _program, ir) = positive_fixture();
    let item = &ir.items[positive_accept_index(&ir)];
    let actual = positive_guard_operand(item).expect("leading positive any guard call");
    let matched = checked_any_first_query_ir(&ir, item, actual, &db);
    let query = matched.expect("positive dual admits the same composition");
    assert_eq!(query.model_name, "AnyFirstPositive.C");
    assert_eq!(query.dependencies.len(), 3);
}

#[test]
fn swapped_parent_base_type_refuses_with_fixed_facts() {
    let (db, _program, ir) = fixture();
    let mut retained = ir.clone();
    let index = accept_index(&retained);
    {
        let base = domain_parent_base_mut(&mut retained.items[index])
            .expect("navigated parent base");
        base.ty = ResolvedType::Scalar(Scalar::Bool);
    }
    let item = &retained.items[index];
    let actual = guard_operand(item).expect("leading any guard operand");
    assert!(
        checked_any_first_query_ir(&retained, item, actual, &db).is_none(),
        "swapped parent base type must refuse"
    );
}
