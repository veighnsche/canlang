# Rent final gap review — October 4, 2026

Three fresh choice consultations are saved beside this note, with each complete request and response. Requests a/b/c selected `fenced`. Returned confidence was 1.0 / 0.99 / 1.0; each returned option probabilities `fenced=1.0`, `review_only=0.0`, `optimistic=0.0`. Those exact outputs remain in the result JSON. There is no disagreement to investigate. Agreement is advice, not proof or an authorization threshold.

The implemented review adds direct provisional expiry admission, retained cancellation delivery fences, issued-state/refund checks before late capacity recovery, and immutable catalog/resource state evidence. The initial consultation evidence describes the former expiry path, which always sent cancellation for unpaid work. The final path reconciles pending/unknown collection instead; it never clears an existing cancellation/refund/release fence. Space and membership fulfillment remain separate decisions, with unsuccessful or fenced recovery in finance review.

The snapshots use actual precommit CRUD hooks and explicit scenario effects, as DESIGN §6 requires. They add no hook timing, automatic scenario hook invocation or runtime helper. Reports select effective stored revisions and partition their boundaries. Missing prebaseline history stays partial and is not inferred from current settings.

Bounded checks: the existing Can parser accepts CanRent.can and shared/Locations.can; Node accepts CanRent.mjs; an isolated metadata-only audit resolves all model read/invariant/lock and operation/handler/pure references. These checks do not execute inline examples, business effects, authorization, providers, concurrency, generated modules or semantic type checking.
