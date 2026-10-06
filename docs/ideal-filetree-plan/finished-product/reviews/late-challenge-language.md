# Independent late-source challenge — language

Scope: exact `cf36983c768c32e0a63ac33c3b45a94dc75dc2d3` → `fa5c8e3df2606a70615387beed9f4041d5516d60` nine-path delta. Both root late-source records were read completely; both new files and all changed hunks were read, with only focused unchanged defining/caller sites. Exact pinned hashes and reviewed artifact hashes are in [the companion ledger](late-challenge-language.json). No checker, tests, build, install, provider, deployment, source edit or checkpoint advancement.

## LCL-01 — context producer is also unqualified for actor/now

**REQUIRED qualification correction.** B4 proves that bare actor/now lower to `c.actor`/`c.now` (`ir.rs:2416–2419`), and that `c` is a bound handler parameter. It does not prove these properties exist. B4's “always bound” wording at 73–74 conflates those facts. The actual `HandlerContext` and `createContext` (`runtime/context.ts:79–137`) expose caller/store/clock/memberships/preferences/canonical, with no actor/now/team/operation properties. The canonical serving caller uses exactly that producer (`invoke.ts:2541–2553`). Its canonical scope carries an operation **name string** and operationId (`2446–2448`), not the source-language readonly `{id,source}` object.

The strongest countercase is that B4 means only lexically bound member roots, and a future producer can populate properties; root already retains all four contextual facts in FP.CONTEXT. That supports the remaining gate, not current runtime availability. Correct the inference to include actor/now producer gaps as well as additional team/operation lowering gaps. Preserve fixed admission time, nullable/null actor and verified applicable team; do not substitute caller/clock/operation-name facts without their owning contract. Resolver facts (`analysis/resolve.rs:2434–2458`) remain check-time scope evidence. Example-values fallback (`ir.rs:2474–2479`) also prevents claiming every unsupported contextual example cell is emitted as a free variable. Hooks/nonhook triggers retain their separate bounds/E6008. No B4 option is adopted here.

## LCL-02 — delivery predicate is a message-token match

**REQUIRED precise observation; no demonstrated bypass.** `invoke.ts:1767–1772` checks Error instance, name, reason and `message.includes('"delivery"')`. `registry.ts:1016–1028` embeds rejected kind, input name and operation name in that same message. An unknown other kind on an input or operation named delivery can therefore match the token. State exactly this predicate instead of interpreting it as structured rejected-kind provenance.

The strongest countercase is the bounded second loader call (`invoke.ts:1828–1835`): another unsupported kind still rejects, and no delivery entries means no strip. This review does not claim a successful malformed artifact, admission bypass or execution fallback. The existing compatibility gate needs exact owner evidence for misleading names and retirement with the matching loader.

## LCL-03 — removed descriptor validation needs a complete owning path

**REQUIRED existing integrity/cutover gate, made concrete.** `stripDeliveryInputs` (`invoke.ts:1744–1764`) removes entries solely by nested delivery kind. Registry unknown-kind rejection occurs before that entry's required/default validation and before later duplicate entries (`registry.ts:998–1033`); removed entries cannot be inspected on the retry. Keep a complete-descriptor validation witness for removed tag/required/default fields and duplicate names. This is an ownership proof requirement, not a demonstrated vulnerability. The strongest countercase has positive source support: existing `interfaces/src/mcp/schemas.ts:722–823` validates the delivery descriptor, required/default/array/description channels and duplicate names; `interfaces/src/http/operations.ts:429–446` checks the full slice before framing excludes delivery. The new HTTP fixture invokes this real derivation. Retain this single existing preflight owner in actual installed/direct producer joins; do not add a duplicate validator.

The retained `deliveryFields` map is model schema, separate from removed operation inputs. Its new t32b expectation has three **empty** field sets (`1755–1774`) and expressly excludes live observation. It proves an expected whole-model map shape if run, not positive delivery tags, association, observation or expiry. Root's receipt/current selected leaf and equal-integrity gates are correct and remain open.

## LCL-04 — executable fixture scope must stay explicit

**REQUIRED wording correction; no-execution limits confirmed.** Replace “real emitted labels” with expected canonical history labels from **hand-written executable fixture handlers**. The t32b updateRemove handler is constructed source (`1246–1257`), invoked through c2Setup, with expected create/update/archive history (`1722–1751`). This meaningful canonical seam integration is the strongest countercase to dismissing it as a mock, but it does not compile an original app.

The new HTTP file explicitly declares a hand-written artifact, injects real interfaces dist handlers and real derivation over fixture storage/identity (`1–20`, `173–220`, `252–321`). Its delivery-only test observes empty submitted inputs and an ok fixture result (`655–682`), not a provider/receipt association. Sealed placement cases include HTTP outcomes and a MCP malformed-tool denial (`698–747`), not successful resume. The final conflict/ref case cites previous pins and directly exercises positive create (`797–827`). Root correctly retains these source-only limits. Bundle marker/string-length expectations (`deploy-bundle.test.ts:240–255`) and source `.length` metrics (`bundle.ts:1016–1019`) do not qualify raw Wasm bytes or installed exports; a timeout change is configuration, not a passing result.

## Confirmed and retained

LATE-C3 correctly supersedes blanket HTTP-route absence at source-join scope only. Common derivation/catalog/invoker wiring, missing-factory 501 and fail-closed default stubs do not close installed producer/assets/auth/state/pages/upload/browser/restart gates. The catch-all lazy import must still distinguish missing packaging from broken initialization. Existing T04/T15/FP.CONTEXT, T24–T26/T32 and T21–T23/FP.QUALIFY/FP.INSTALLED-RELEASE gates cover the findings; no new architecture, grammar or carrier choice was selected.

Work owner additionally reports the earlier ALW-05 CSV target/coordinator issue corrected. This focused task edits only this new late-challenge pair; the prior apps-language ledger remains unchanged.
