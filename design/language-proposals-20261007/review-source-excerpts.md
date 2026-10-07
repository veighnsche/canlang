# Source excerpts

Verbatim source data. Resolve source-local links from the original owning file named in each excerpt.

````text
## compiler/src/analysis/types.rs at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 lines 3694 through 3755
3694:             self.diags.push(Diagnostic::error(
3695:                 "E3001",
3696:                 "scope=authority needs read=true".to_string(),
3697:                 tight_span(cx.text, scope),
3698:             ));
3699:         }
3700:         read
3701:     }
3702: 
3703:     /// Check every path of a result-bearing body returns (`E3001`).
3704:     fn check_body_returns(&mut self, text: &str, node: &SyntaxNode, body: &SyntaxNode) {
3705:         let stmts: Vec<&SyntaxNode> = kids(body)
3706:             .into_iter()
3707:             .filter(|s| s.kind != SyntaxKind::Name)
3708:             .collect();
3709:         if !Self::stmts_return(text, &stmts) {
3710:             let span = arrow_result(node)
3711:                 .map(|t| tight_span(text, t))
3712:                 .unwrap_or_else(|| tight_span(text, node));
3713:             self.diags.push(Diagnostic::error(
3714:                 "E3001",
3715:                 "a result-bearing scenario must return on every path".to_string(),
3716:                 span,
3717:             ));
3718:         }
3719:     }
3720: 
3721:     /// Whether a statement list always returns.
3722:     fn stmts_return(text: &str, stmts: &[&SyntaxNode]) -> bool {
3723:         stmts.iter().any(|s| Self::stmt_returns(text, s))
3724:     }
3725: 
3726:     /// Whether one statement always returns (`for` may run zero times;
3727:     /// an `if` without `else` may fall through).
3728:     fn stmt_returns(text: &str, node: &SyntaxNode) -> bool {
3729:         match node.kind {
3730:             SyntaxKind::Return => true,
3731:             SyntaxKind::If => {
3732:                 let parts = kids(node);
3733:                 let mut split = None;
3734:                 for (i, part) in parts.iter().enumerate() {
3735:                     if is_name(part, text, "else") {
3736:                         split = Some(i);
3737:                         break;
3738:                     }
3739:                 }
3740:                 let Some(split) = split else {
3741:                     return false;
3742:                 };
3743:                 if split < 1 || parts.len() < 2 {
3744:                     return false;
3745:                 }
3746:                 let branch_returns = |slice: &[&SyntaxNode]| {
3747:                     slice.iter().any(|s| {
3748:                         !matches!(s.kind, SyntaxKind::Name | SyntaxKind::Punct)
3749:                             && Self::stmt_returns(text, s)
3750:                     })
3751:                 };
3752:                 branch_returns(&parts[1..split]) && branch_returns(&parts[split + 1..])
3753:             }
3754:             _ => false,
3755:         }

## compiler/src/analysis/types.rs at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 lines 12356 through 12447
12356:     fn narrow_is(
12357:         &mut self,
12358:         cx: &Ctx<'_, '_>,
12359:         _node: &SyntaxNode,
12360:         left_node: &SyntaxNode,
12361:         right_node: &SyntaxNode,
12362:         else_branch: bool,
12363:         env: &mut NarrowEnv,
12364:     ) {
12365:         let subject_key = match left_node.kind {
12366:             SyntaxKind::NameRef | SyntaxKind::Member | SyntaxKind::Group => {
12367:                 self.narrow_key_for(cx, left_node)
12368:             }
12369:             _ => None,
12370:         };
12371:         let Some(subject_key) = subject_key else {
12372:             return;
12373:         };
12374:         if matches!(subject_key.decl, DeclKey::Unresolved(_)) {
12375:             return;
12376:         }
12377:         let subject = self
12378:             .types
12379:             .node_types
12380:             .get(&NodeKey::of(left_node))
12381:             .cloned()
12382:             .unwrap_or(ResolvedType::Error);
12383:         let key = NodeKey::of(right_node);
12384:         let target = match self.tables.node_typeref.get(&key).cloned() {
12385:             Some(TypeRef::Scalar(name)) => match scalar_named(&name) {
12386:                 Some(scalar) => ResolvedType::Scalar(scalar),
12387:                 None => match name.as_str() {
12388:                     "Team" => ResolvedType::Team,
12389:                     "OperationContext" => ResolvedType::OperationContext,
12390:                     _ => return,
12391:                 },
12392:             },
12393:             Some(TypeRef::Symbol(id)) => match &self.tables.symbols[id.0 as usize].kind {
12394:                 SymbolKind::Model { .. }
12395:                 | SymbolKind::Contract { .. }
12396:                 | SymbolKind::Event { .. } => ResolvedType::Record {
12397:                     symbol: id,
12398:                     stored: true,
12399:                 },
12400:                 _ => return,
12401:             },
12402:             _ => return,
12403:         };
12404:         let (base, _) = strip_nullable(&subject);
12405:         let narrowed = if else_branch {
12406:             match (&base, &target) {
12407:                 (ResolvedType::Union(arms), ResolvedType::Record { symbol, .. }) => {
12408:                     let rest: Vec<SymbolId> =
12409:                         arms.iter().filter(|a| *a != symbol).copied().collect();
12410:                     if rest.len() == arms.len() || rest.is_empty() {
12411:                         return;
12412:                     }
12413:                     if rest.len() == 1 {
12414:                         ResolvedType::Record {
12415:                             symbol: rest[0],
12416:                             stored: true,
12417:                         }
12418:                     } else {
12419:                         ResolvedType::Union(rest)
12420:                     }
12421:                 }
12422:                 _ => return,
12423:             }
12424:         } else {
12425:             match (&base, &target) {
12426:                 (ResolvedType::Union(arms), ResolvedType::Record { symbol, .. })
12427:                     if arms.contains(symbol) =>
12428:                 {
12429:                     target.clone()
12430:                 }
12431:                 (ResolvedType::Scalar(Scalar::Json), ResolvedType::Record { .. }) => target.clone(),
12432:                 (left, right) if loose_equal(left, right) => {
12433:                     // Same-type test (possibly nullable subject):
12434:                     // narrow to the non-null target.
12435:                     target.clone()
12436:                 }
12437:                 _ => return,
12438:             }
12439:         };
12440:         env.insert(
12441:             NarrowKey {
12442:                 decl: subject_key.decl,
12443:                 path: subject_key.path,
12444:             },
12445:             narrowed,
12446:         );
12447:     }

## design/complex-apps/sync.md at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 lines 19 through 28
19: ## Minimal provider contract
20: 
21: The owning package declares one exported capability and structural values, then binds that interface through the existing `use ... from=deployment.crm` form. No new fetch keyword, user-authored URL, secret input or business JSON parser.
22: 
23: `AccountSnapshot` has `id:text`, `revision:text`, `name:text`, `phone:text?`, `website:url?`. Adapter normalization preserves exact opaque ID/revision. `read(id:text)` returns an explicit present/missing observation; missing is distinct from access denied, rate limiting and timeout. A successful present read requires a complete snapshot. Only a provider-authorized definite absence maps to missing; ambiguous 403/404 mapping fails rather than asserting deletion.
24: 
25: `replace(id:text,expected:text,name:text,phone:text?,website:url?)` returns a closed domain result `applied | conflict | missing | rejected`. A definitive `applied` means the bounded conditional PATCH was acknowledged. Optional observed current data after that result is a separate later observation, not proof the write's exact snapshot persisted unchanged. Lost response or ambiguous transport remains the ordinary delivery `unknown`, with no invented applied result. Invalid response schema likewise cannot prove no effect.
26: 
27: Standard delivery machinery owns provider request identity, bounded transport/decoding, safe errors and supported rate-limit scheduling. Repeated delivery cannot issue a second unsafe write: conditional mismatch after a retry does not erase uncertainty about the earlier dispatch. Retain uncertainty until the adapter can prove the first outcome; the adapter may refuse automatic mutation retry. App-level retry is allowed only after definitive no-effect evidence or explicit current-state review under a new conditional baseline.
28: 

## compiler/src/codegen/js.rs at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 lines 2837 through 2847
2837:                 )]
2838:             }
2839:             IrStmt::Call {
2840:                 operation,
2841:                 inputs: _,
2842:                 binding: _,
2843:                 span,
2844:             } => {
2845:                 self.unsupported(
2846:                     "call effect",
2847:                     &format!(

## compiler/src/codegen/js.rs at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 lines 3350 through 3373
3350:         let gate = node.gate.as_ref().map(|g| self.lower_expr(g));
3351:         self.ui.insert(node.factory.clone());
3352:         let mut props = vec![format!("context:{ctx}")];
3353:         for (key, value) in &node.props {
3354:             props.push(format!("{}:{}", object_key(key), self.lower_expr(value)));
3355:         }
3356:         match &node.row_scope {
3357:             Some((row, view)) => {
3358:                 self.enter_scope();
3359:                 let row = self.bind(row);
3360:                 let child_ctx = self.bind(view);
3361:                 let children = node
3362:                     .children
3363:                     .iter()
3364:                     .map(|c| self.lower_ui_ctx(c, &child_ctx))
3365:                     .collect::<Vec<_>>()
3366:                     .join(",");
3367:                 // `async` exactly when a row child awaits.
3368:                 let prefix = if node.children.iter().any(ui_uses_async) {
3369:                     "async"
3370:                 } else {
3371:                     ""
3372:                 };
3373:                 props.push(format!(

## packages/contracts/src/presentation.ts at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 lines 775 through 795
775: export interface FormProps {
776:   readonly context: PresentationContext;
777:   /** Dispatcher-supplied POST target; lane 05 never invents URLs. */
778:   readonly action: string;
779:   readonly operation: string;
780:   /** Fresh idempotency key rendered per form (replay-safe resubmits). */
781:   readonly operationId: string;
782:   readonly mode: FormMode;
783:   /** Bound record for updates (hidden id/version); required in update mode. */
784:   readonly record?: MutationRef;
785:   /** Resolved rendering timezone (team adapter or explicit UTC fallback). */
786:   readonly timeZone: string;
787:   readonly fields: ReadonlyArray<FormFieldDef>;
788:   /** Field errors keyed by JSON Pointer into inputs (wire FieldError). */
789:   readonly errors?: ReadonlyArray<FieldError>;
790:   readonly outcome?: FormOutcome;
791:   readonly submit: MessageValue;
792:   readonly cancelHref?: string;
793:   /** Caller-unique prefix for input ids (deterministic for swaps/tests). */
794:   readonly idPrefix: string;
795: }

## packages/ui/src/forms.ts at 4e89b117d3f66caa79a8df8ed875d55f9e40b948 lines 884 through 903
884: export async function form(props: FormProps): Promise<string> {
885:   if (props.mode === "update" && props.record === undefined) {
886:     throw new Error("form: update mode requires a bound record");
887:   }
888:   assertUniqueFieldPaths(props.fields);
889:   const names = new Set<string>();
890:   for (const field of props.fields) {
891:     names.add(fieldName(props.mode, field.path));
892:   }
893:   const { matched, unmatched } = splitErrors(props.errors, names);
894:   const fieldCtx: FieldRenderContext = {
895:     context: props.context,
896:     mode: props.mode,
897:     timeZone: props.timeZone,
898:     idPrefix: props.idPrefix,
899:     errorsByName: matched,
900:     errors: props.errors,
901:   };
902:   const rendered: string[] = [];
903:   for (const field of props.fields) {
````
