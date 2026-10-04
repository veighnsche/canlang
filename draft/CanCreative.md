# CanCreative

CanCreative composes private chat with a company image studio. Authorized employees configure and publish immutable ComfyUI workflow revisions; ordinary members invoke published templates with bounded image inputs. Its source and desired JavaScript are complete draft contracts, not an implemented compiler, adapter or deployment.

## Configure, validate and publish

A creative administrator owns editable templates. Upload a finalized API-format JSON graph, inspect its typed candidate inputs, then set the node and key for prompt, negative prompt, width and height. Candidate rows show node/key/kind/label beside the canonical edit form. The four destinations form a closed mapping; no runtime string path expression or uploaded JavaScript is evaluated.

Inspection is read-only. Validation creates an immutable revision containing the exact graph file, four mappings, output cap and duration and sends it to the safe validation capability. ComfyUI `/prompt` is never used as a supposedly harmless validation call because it enqueues work. The deployment's node-class/input/model/resource allowlist applies to the entire graph; arbitrary filesystem paths, network destinations and embedded secrets are rejected even when the four mappings are valid. The provider/version and installed resources must be compatible.

The administrator publishes only the exact associated succeeded validation whose result is valid and contains its digest. Pending, failed, unknown or invalid validation cannot publish. Publication selects that revision for later requests. Editing the draft invalidates its displayed inspection, but does not modify any previous revision, validation receipt or run. A fresh validation creates another numbered immutable revision. Publishing intentionally grants current members read access to that immutable revision’s complete definition, including its finalized graph, while its template remains active. The publish action names this disclosure. Draft Template graphs and unpublished revisions stay manager-only. Deactivation removes the member publication grant and prevents new generation; it does not rewrite retained evidence. Canonical send still checks ordinary file source authority, so published member access supplies the readable attachment used by generation. A subsequently removed node/model remains an explicit runtime failure; validation is not an eternal availability promise.

The source explicitly adds `application/json` to the selected app's shared file policy. The standard JSON test fixture supplies node `6`/`text`, node `7`/`text`, and node `5`/`width` and `height`. Those are pinned syntactic mapping bytes, not a full executable production workflow; a typed validation fixture independently models its accepted/rejected outcome.

## Generate and recover

A member chooses a currently published active template, prompt, negative prompt and dimensions from 256 through 1536, in multiples of 64. The published revision fixes up to four outputs and a duration from one second through fifteen minutes. The operation freezes those values, reserves one image job and one concurrency slot, and submits through the shared durable `ImagesV1` adapter. Changing the active template revision afterwards affects new jobs only. The adapter substitutes only the four declared inputs and verifies the graph/map/digest; it cannot silently resize or change nodes/models.

The chat-to-image page shows the member's readable conversations and turns. An explicit action calls the same generation operation with a copied turn and its protected conversation reference. The model does not autonomously spend credits or call unbounded tools. A message too long for the image prompt schema is rejected by canonical input validation; the member can enter a shorter prompt in the studio.

Submission success can mean only queued or running work. Before verified evidence, generation state is null. The studio renders cumulative normalized observations from its associated original submission progress; it never turns an accepted queue ID into a completed image. Transport delivery, stop/reconciliation receipts and business run state remain separately visible. Duplicate/out-of-order observations do not create duplicate output positions or settle accounting twice.

The shared associated-progress layer owns source/revision correlation, sequence/terminal validation and durable snapshot notification. The sole `Images.submit.progressed` business callback settles this member’s budget and admits unique finalized Output positions atomically. If it fails, the latest verified state remains visible and no partial accounting commits. Technical retries and explicit successful reconcile re-notification can repair finalization; ordinary business-rule failures are surfaced rather than retried indefinitely.

Stop sends a targeted external command. The binding must verify targeted cancellation support or isolate its execution; it must not issue a global interrupt affecting other users. A cancellation request can remain unknown and can race success. Reconcile looks up the retained source/revision and never starts a new job. A lost submission response retains uncertainty; generating another job is a separate explicit business action within the budget, not an invisible retry.

Membership removal and conversation revocation recheck current authority and request cancellation for active affected jobs and suppress further undispatched starts. Private image run content follows current conversation access. Trusted results can still finalize accounting while content stays hidden. The recovery page exposes only safe status/accounting and targeted stop/reconcile controls to the original author. It does not expose revoked prompts or files.

## Resource and file guarantees

One allowance per member caps cumulative image jobs and parallel runs. Admission atomically reserves one job; final `charged_jobs=0|1` settles once. Null usage holds the job, even after confirmed execution cancellation. Nonterminal usage is null. The concurrency slot is released only for a terminal execution state. An authoritative skipped submission can be released locally as never dispatched. Caps are jobs/dimensions/duration, not a fabricated provider currency price. A binding unable to enforce them rejects before execution.

Current account budgets cap simultaneous runs at ten, so the cancellation loops' ten-record bound is proven by admission and invariants. It is not a silent limit on a changing unbounded cohort.

Provider previews, URLs, paths and asset IDs are not Can files. The shared adapter retrieves authenticated bytes, verifies PNG/JPEG MIME, size and quota, and finalizes each immutable receiving-app file before publishing it in a typed observation. Output positions stay unique and stable across cumulative snapshots. Failed/unknown runs may retain finalized private recovery outputs; only a successful run is eligible for gallery review. Success requires at least one declared output within the frozen cap. Uploads and downloads use current owning record/field grants.

## UI and composition

- Image studio: breadcrumbs; inline generation form grouped into image-prompt and size/context inputs; run list with pagination, generation-state badge, submission/stop/recovery receipt statuses, unfinished-run loading, finalized-output galleries and stop/reconcile/release controls; own budget table with pagination.
- Chat to image: breadcrumbs; readable conversation/branch nesting with turns as chat bubbles; each turn carries the generation form with placed template, negative and size inputs; every level paginated.
- Unresolved image jobs: breadcrumbs; run table with pagination, receipt status and recovery controls, independent of private content access.
- Workflow templates: breadcrumbs; notice describing upload/inspect/map/validate/publish; grouped template creation (graph upload, input mapping, output/duration limits); owned templates with pagination, edit, inspect, validation, candidate inputs and immutable revisions with publish; budget creation with placed cap/parallel inputs and budget administration with typed cap/parallel/active edits.

`CanCreative` selects `[chat,creative]`; `CanGallery` selects `[chat,creative,gallery]`. There is no reverse Chat dependency or import cycle. The standard `gallery ... image=image` component supplies authorized thumbnails, keyboard preview and original-file access; the app does not author browser transport, CSS, a gallery widget or provider credentials. Inline English/Dutch captions and normal shared UI states apply.

## Evidence and limits

Inline cases cover exact job limits, exhausted budgets, invalid dimensions, unpublished templates, unauthorized/revoked chat context, valid/invalid publication, normalized queued/unknown/terminal observations, output deduplication and delayed usage settlement. Desired JavaScript retains the same operation order, guards, immutable snapshots, delivery observations and fixture dependencies.

Additional required binding/runtime cases include: whole-graph allowlist rejection; wrong node/key/type; graph/map/digest change under one identity; provider node/model removal after publication; unknown POST acceptance; stop/success race; duplicate normalized observations; interrupted file finalization; foreign/partial/raw-URL asset rejection; revoked thumbnail/original access; a draft edit while an old revision is executing; delayed membership removal after rejoin; and business finalization failure followed by repair and same-sequence reconcile re-notification. A valid file fixture or typed result does not prove any real provider outcome. No live Ollama/ComfyUI request, compiler execution or executable BDD run is claimed. See [shared design and research](../design/complex-apps/chat-media.md).
