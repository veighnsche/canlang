# Independent finite asset seam review

Verdict: pass for the released main/assembly/Interfaces finite mount seam, with no actionable seam finding. This does not accept the whole page/browser workflow.

All six released source/contract pins matched. Gate order preserves DB first refusal, staged marker validation, activation, contracts/requires and canonical descriptor preload before page/selected-resource loading. Selection is an exact raw pathname lookup; query is ignored. The generated resource handler reuses the defining Interfaces matcher and asset helper. Exact/dynamic collisions and byte/manifest integrity fail before returning the table; selected failures do not downgrade. The public index keeps the matcher internal, and the direct helper retains its decoded-key protocol.

The existing raw 14 tests passed and cover fixture collisions/corruption, unselected dispatch, methods, caching and refusals. They were reviewed as controls, not rerun or credited as actual source consumers.

After the mapper released its immutable fresh Images stage, this reviewer copied it, verified all 173 module inventory hashes, and made 17 independent default workerd requests. All three resources returned pinned bytes for query GET and conditional GET (200, no ETag, public max-age=0); HEAD returned matching length and no body. Percent alias returned404. Missing DB, inactive with missing resource module, unknown marker and corrupt manifest refused500. Unselected canonical assets returned404.

The actual `/` page returned422 rule_failed in both selected and unselected stages with identical bytes. The initial page200 assertion failure is preserved separately; subsequent resource checks explicitly retain this limitation. There is no actual page HTML/canonical-URL, body browser, caller-selection or installed-consumer evidence in this review. Static request success demonstrates the fresh actual Images module clears canonical preload; it does not demonstrate rendering or hydration.

Evidence: `review.json`, `probe-results.json`, `probe-command.json`, `input-inventory.json`, `page-probe-failure.log`, `page-probe-failure-command.json`. Only this private review directory was written. No build, Git, source edit or mapper command ran. Probe deadline50s, exit0, elapsed<1s; Miniflare disposed. Readers released. Root retains final acceptance.

Actual page next-defect evidence: exact response `{"code":"rule_failed","message":"The operation was rejected.","retryable":false}`. Generated Images render calls `list({context:c,model:"Images.Job",...})`; staged UI collections.js:83 calls context.query(context.invocation,...). Assembly supplies anonymous identity for invocation and its throwing interimQuery (assembly.ts:1107,1437-1438). The generic render catch answers422. This explains the observed response by source inference; no exception trace was injected.
