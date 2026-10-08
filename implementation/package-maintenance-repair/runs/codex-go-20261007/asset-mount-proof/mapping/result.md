# Runtime stdlib deployment selection result

Implemented only the two root-leased source paths: packages/cloudflare/src/deploy/bundle.ts and packages/cloudflare/test/browser-assets-bundle.test.ts. All six starting write/read pins matched. All four read-only source inputs still match the lease after verification.

The existing pinned runtime set now includes built stdlib.js. Only generated artifact @canlang/stdlib imports map to runtime/stdlib.js, matching the existing CLI. Public vendor stdlib imports retain their original mapping. No stdlib/state/compiler/runtime-source changes, wrapper, new builtin, staged-text patch, signature changes or preload bypass.

Original CF owner build ran once and passed0 (Node26.10.0, Bun1.4.2, strict original tsc recipe, original configs/exports). Its own-child observer initially required sandbox permission for ps; the authorized observer then completed. Observed-build.json/log retain exact original command evidence.

Focused existing browser-assets-bundle + browser-assets-serving tests passed15/15, twofiles, 18.76s: generated nested-module mapping/real owner write exports and producer joins, public facade retention, deterministic resources, authored collision refusal, missing binding/inactive refusal, missingcode and manifest/version/module/shape/bytes/handler corruption controls. Initial sandbox attempt expired110s before finishing; raw log/json retained. Corrected localIPC-authorized run passed0; no build repeat.

Exact frozen actual Images artifact SHA b72b27edc8df17942d832f3d1f5dcb0ab8ca803388cc71564b1af68990707950 passed the existing default Node+workerd consumer and independent workerd-first invocation, each6rows. All three resources GET200 with exact original bytes/media types/cache policy; HEAD and conditional requests passed. Both used real local Miniflare D1, retained canonical policy/descriptor preload and disposed Miniflare in finally. Initial unprivileged consumer listenEPERM log is retained separately; corrected authorized invocation passed0.

Source/output and both exact stages are pinned in result-pins.json. Raw selected-static-consumer.log, selected-workerd-consumer.log, and the two stage inventories/results retain caller evidence. Default stage: implementation/selected-default-consumer/stage; workerd-first stage: implementation/selected-workerd-consumer/stage. Original asset-owner frozen stages/evidence were not overwritten.

All ownerbuild/test/consumer processes completed; both consumer handles disposed, no pending sessions. Writer lease paths and private graph are released. Immutable stage/runtime/node_modules read/copy handles were explicitly released to root/asset_mount_independent_review, then root for coherent commit/docs and acceptance. No further reads/writes retained.

Credit limits: this resolves the actual selected default deployed generated-module import blocker and these selected static requests. Required real source-derived browser selection caller remains open; browser selection still passed explicitly through the existing consumer options. Dormant generated CRUD handler call-shape skew remains separately open; canonical production uses generatedCrudExecute. No full parent/backend/native/installed/default/HOLD acceptance claimed. Root owns source Git/docs and final acceptance.
