# Independent checked constructor target review

Initial disposition: **reject** the 62bc9829d76aa8859851c9395a7d226a1ab92131bd06322ee9b105c382ba7dde IR snapshot. A follow-up review of any corrected source is pending.

## Material finding: composite Operation expressions erase evaluation

At `compiler/src/codegen/ir.rs` target conversion around 2882, the published Operation type is sufficient to replace the entire anchored argument with canonical text. That type can be propagated through generic `choose`, object member lookup, and group nodes. The Operation type identifies the resulting owner but does not prove that evaluating the expression is free of other work.

`choose-throw.can` contains `action(choose(1 / 0 == 0.0,mutate,mutate),{})`. It compiles without diagnostics and emits `return action("T.mutate",{});`, omitting the predicate. The identical expression in the source's separate predicate callable rejects Division by zero through emitted JS and the installed public stdlib; the constructor callable instead returns an action. `choose-throw.json`, `choose-throw-execute.mjs`, `generated/`, and `choose-throw-runtime.log` preserve this observable difference. `choose.json` preserves the simpler flag example.

`invocation-choose-valid.json` confirms the same omission for invocation construction. `member-object-valid.json` confirms that `action(({x=mutate}).x,{})` bypasses raw operation object-value lowering. A restriction to any Member node would therefore be insufficient. `raw-choose-binding-valid.json` preserves ordinary E6008 failures for both nested operation references outside the constructor target. The first additional probes without declared read result types are preserved with their independent E3001 diagnostics; they are not evidence for the target bug.

The minimally scoped correction is to limit canonicalization to anchored static owning-operation reference syntax and continue ordinary lowering (therefore E6008 for unsupported raw operation composites) elsewhere. A safe grouped direct reference can be peeled; a Member receiver must itself be a static identifier path, not an arbitrary Object/Call expression. Evaluation-preserving general operation expressions are outside this component's scope.

## Boundaries that hold for direct targets

Independent source inspection confirms checked SelectedCall authority is consumed before conversion. The builtin ID must be action/invocation, the selected catalog signature must supply an ActionTarget formal, and the formal's checked slot must equal this argument's index in source order. All slots and CST anchors are validated before the conversion; selected source argument order is retained and lowering uses existing BoundCall slots without new binder/default substitution. SymbolId's existing canonical field supplies target text, so alias spelling does not become operation identity.

The baseline before.can/before.json preserves E6008 for legal direct local operation targets. Worker checker controls and test logs were read as raw outputs and corroborate read/trusted/text/bad bindings rejection, alias CRUD operation metadata, and bare operation rejection. These are scoped supporting evidence, not grounds to disregard the composite finding.

Own direct fixture verification (direct-actions.json, direct-actions-runtime.log, direct-actions-pins.json) compiled the checked final local source and executed unchanged fixture JS through installed packages. It passed canonical local owner identity, named binding/target slots, empty bindings, immutable references, preserved record id/model/version, one caller-input getter read, rejected missing expected version, and rejected stored-row-shaped objects. This does not measure effectful target subtree evaluation; the composite test provides that missing check.

Original Values catalog and source constructors were inspected directly. action packages native versioned RecordRefs using makeActionRef; invocation packages decoded values using makeInvocation, preserving nested versions without requiring them. Neither constructor executes the mutation nor grants authority. The stdlib action facade is a verbatim Values reexport in the pinned snapshot. No API/backend/permission/first-class-operation changes are credited.

## Remaining gaps and snapshot limits

Alias CRUD target canonical emission is qualified, but generated aliasCRUD module instantiation still lacks create/deleteRecord/set facade owners. Do not fabricate those exports. Native RecordRef controls do not establish stored-row hydration into canonical refs or canonicalState/Cloudflare worker admission/replay. The original invocation schema/export failure logs remain real historical failures; another worker owns current JS/schema/facade changes, so this review does not infer its present behavior from old package pins. Broader S9/SYN references remain open.

Source and executable hashes are captured separately in composite-target-pins.json and direct-actions-pins.json. They were stable within those focused probe groups. No cargo build or broad suite was run by this reviewer. Only the independent-review directory was written.

## Decimal assertion correction (separate contract issue)

The existing decimal_runtime.rs expected E6008 for legal `action(mutate,{})` where mutate has only a defaulted Decimal business parameter. That assertion describes the old direct-target lowering gap, not an ActionTarget/ActionBindings contract rejection. Action binds record parameters only; non-record Decimal inputs/defaults remain invocation-time business inputs. Correcting that exact assertion to success is justified independently of the composite finding. Root owns preservation of its original failure and precise test correction; this review does not claim that correction has run.
