# S9-Q05 actual generated public UI sink — bounded qualification

2026-10-08. Evidence only; no compiler/package/test-root mutation, rebuild, source writer lease, network, JEV or Git operation. The next implementation leaf is the existing UI civil-date validator, followed by an explicitly owned native-carrier presentation join. Whole S9-Q05 remains open.

## Exact current result

`run.mjs` compiles eight legal `.can` page fixtures using the frozen private CLI `b2608559e9af0e934a0727faad1d31aee43528cb87a9359f3576a6d8b3db3a7e` and catalog `cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62`. Each explicitly declares `source="en"` and `context locale default="en"`. The unchanged modules import the actual installed public stdlib and UI exports. The consumer resolves each page through the artifact's exact `module` and `export` fields, confirms identity with `appDefinition.pages[0]`, calls its actual `admit`, then its actual `render`. Generated source is never rewritten or wrapped with replacement helpers.

This advances the previous constructor/descriptor-only evidence: the exact generated descriptor now reaches the actual UI `text` -> `resolveCaption` -> `formatMessage` sink. Source/artifact/module/raw output and runtime results are retained individually.

| Generated operand | Compile/admit | Actual public generated render |
| --- | --- | --- |
| date("0001-01-01") | succeeds / {} | TypeError: type date needs a valid YYYY-MM-DD civil date |
| date("0099-01-01") | succeeds / {} | same refusal |
| date("2001-01-01") | succeeds / {} | same refusal |
| date("2024-02-29") | succeeds / {} | same refusal |
| datetime("2024-03-31T22:30:00Z") | succeeds / {} | TypeError: type datetime needs a canonical RFC3339 UTC instant |
| Decimal literal 1.50 | succeeds / {} | TypeError: type decimal needs a bigint or canonical decimal string |
| int 2, number/integer | succeeds / {} | `<p>⁨2⁩</p>` |
| int 2, selectordinal | succeeds / {} | `<p>⁨two⁩</p>` |

The date failures include modern 2001 and 2024, establishing a carrier-shape refusal independent of the low-year defect. Decimal source lowering succeeds through the accepted `Decimal` constructor; this packet does not redo its prior qualification or claim Decimal integer/ordinal policy parity.

## Supported preconditions and independent controls

The supplied `CaptionContext` is exactly `{preferredLocales:[],appDefaultLocale:'en'}` and satisfies the public UI factory's documented minimal contract. Its English default matches the legal source declaration. This is an explicit public factory input, **not** a route-dispatcher/canonical-context provenance witness. No actor/team/clock fields are fabricated, no `c` is coerced or dropped, and no selected-app assembly/default propagation is claimed. These pages have no authorization, query or route-binding requirement. Integer/ordinal success on the same path confirms the supplied factory preconditions.

The UI caption owner itself hardcodes UTC (`messages.ts:1057`); the fixture does not invent or adapt a timezone field. Consequently this result cannot qualify team-timezone propagation. Public temporal helper controls separately use explicit UTC or Europe/Brussels and the real host `Intl` dataset. At 2024-03-31T22:30:00Z, independently expected civil dates are March31 in UTC and April1 in Brussels; both pass. Mars/Olympus refuses `invalid-construction`. These are public-helper/data controls, not an emitted timezone-application witness or release-dataset ownership claim.

Public Values constructor and formatter controls preserve tagged date carriers. Expected English medium strings are fixed independently: `Jan 1, 1`, `Jan 1, 99`, `Jan 1, 2001`, `Feb 29, 2024`. Values renders all four correctly. Public UI's separately supported YYYY-MM-DD input refuses 0001 and0099 but renders2001 and2024 correctly. Constructor admission and UI input validity remain distinct; no wire codec is exercised or inferred.

`pins.before.json` and `pins.after.json` separately snapshot source and dist trees for the actual packages, manifests, selected current compiler owners, private CLI and catalog. No input changed during the successful run. Node24.21.0/ICU78.3/CLDR48.0/tz2026c are observed host pins. Installed dist/source freshness is not inferred. Frozen CLI attribution reuses root's existing selected-page handoff receipt; active current IR work is separately snapshotted and is not claimed to belong to that binary.

## Concrete owning defects and bounded next writer request

1. **Existing public UI low-year validity defect:** `packages/ui/src/messages.ts:203-211` uses `Date.UTC(year,month-1,day)`, which remaps years0–99 to1900–1999, then compares against the authored year. The supported public string `0001-01-01` should render `Jan 1, 1`; it currently throws. `isValidInstant` uses the same validator, so canonical low-year datetime strings share the defect. Proposed narrow writer closure: exact lease for `packages/ui/src/messages.ts` and `packages/ui/test/messages.test.ts`; retain0001–9999 bounds and invalid-date rollover rejection while using full-year-safe UTC construction or existing validated Gregorian logic. Verify0001/0099/0100/2001, leap/nonleap February, year0000 refusal and canonical datetime low years. This repair needs no new constructor, dependency, timezone policy or descriptor API. It cannot repair generated tagged input by itself.
2. **Actual generated native-carrier presentation mismatch:** `compiler/src/codegen/js.rs::lower_message` passes constructors' exact tagged Date/Datetime/Decimal values into the shared UI message factory. Shared `MessageParamValue.value` is unknown and the factory preserves it. `packages/ui/src/messages.ts::toOperand` instead requires date/datetime strings and Decimal bigint/string (`251-279`); the exact generated factory path consequently fails. Minimum owning consumer is UI operand normalization, with explicit native/wire profile policy and exact guards. Initial investigation deferred compiler-side conversion; the read-only follow-up in MAPPING.md locates existing public encodeValue and qualifies its exact match to the current UI input contract. The proposed combined closure now includes compiler-side use of that existing codec plus the UI low-year repair, without a new UI dependency/API. Root must release exact files before implementation. Integer/ordinal/profile and localized native-descriptor preconditions remain distinct. Values constructors already succeed; expanding their legal range is unnecessary.

The exploratory `probe.can` localized-format source preserves the known S9-Q01 failure path: emitted `format(c,descriptor,{locale})` does not match the installed pure public formatter. The accepted executable-handler-context decision already owns that closure; it is not a new S9-Q05 finding or a reason to omit context to make this packet pass. Exploratory `descriptor.can` refuses unresolved type `message`, so no unsupported return-type workaround was used.

## Verification and remaining gaps

Reproduce with `node implementation/compiler-completion/temporal-runtime/run.mjs`; it requires the exact frozen binary and catalog hashes. Assertions check all eight source compiles, actual exported descriptor identity, admission result, six retained carrier refusals, two successful exact HTML controls and seven supported/public helper control rows. Raw stderr is empty in the final successful run. These baseline assertions qualify observed defects, not repaired correctness.

Accepted prior static date/time partition and Decimal literal evidence are not rerun or upgraded. Actual generated timezone flow, selected-app/locale/trusted-team context, native/wire carrier parity, Decimal integer/ordinal parity, canonical request admission, browser/mount/deployment and release timezone-data policy remain unqualified. No broad S9-Q05 completion claim or source API redesign follows.
