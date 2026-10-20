# Generation controls

Use versioned generation requests to inspect, prepare, refine and accept saved implementation, and interpret result envelopes, leases and recovery actions without losing uncertain work.

## Invoke the dispatcher

`can gen` is the version 1 JSON request dispatcher for explicit build-time generation operations. It reads one JSON request from stdin or `--request FILE`, writes one final JSON envelope to stdout; optional JSONL progress is written to stderr and ends with that envelope.

## Request and results

The JSON operation set is `doctor`, `status`, `inspect`, `bind`, `generate`, `refine`, `retry`, `resume`, `diff`, `preview`, `validate`, `adopt`, `accept`, `cancel`, `reset`, `rollback`, `edit.begin`, `edit.end` and `lease.recover`. Refine requests carry exactly one instruction carrier: `instruction`, `instruction_file` or `instruction_stdin:true`.

Other operations do not accept that instruction payload. Treat returned paths as opaque checked handles and use structured tool arguments. The private host launches the configured coding CLI and custom MCP session; the generator receives protected no-write access and submits content batches with `generation_submit`.

### Submit isolated candidate outputs

`generation_context` takes `{}` and returns immutable checked source context, session/attempt identity, source digest and allowed targets/roles. `generation_submit` takes `{session,batch}`; each batch entry contains `target`, `role` and exactly one of `content_text` (UTF-8 text) or `content_base64` (checked binary asset). Roles are server, browser, style, asset or contributions, restricted to those issued for that exact handle.

Handles are opaque session-bound identifiers, never paths. Submission writes isolated candidates only. It cannot replace current code or accept a result. The host validates handles, roles, content and required-output completeness. Invalid/stale handles, duplicate conflicting submissions and malformed content fail with a concrete recovery action.

## Safety and recovery

Inspect status and session identity before resuming. Resume continues a recorded request only when supported and still applicable; retry is a fresh capture of the entire active app closure. Cancel/reset fence pending work and preserve current files. Acceptance compares captured source, contracts, target, current bytes and attempt state under leases. Full retry validates and promotes all required outputs together. Interrupted leases never expire or get stolen automatically; recovery requires confirmation that the writer stopped.

Use `can help gen` for the installed positional syntax and dispatcher envelope. Positional `status` and `bind` are convenience forms; other lifecycle operations are JSON requests. Do not treat a successful coding-tool response as acceptance. See [editing and refinement](../03-Generate-implementation/04-editing-and-refinement.md).

## JSON request fields

Fields are top-level alongside `version:1`, a nonempty caller `request_id` and `operation`; there is no nested `params` object. Every operation except doctor requires nonempty `root`. Relative request paths resolve against root. Unknown fields are rejected. `files`, `unit_ids` and `paths`, where accepted, are nonempty arrays of nonempty strings. Inspect/bind source spans use unsigned byte offsets and require start <= end.

| operation | Fields in addition to the common header/root |
| --- | --- |
| `doctor` | Optional root and recipe fields; checks availability and launch capabilities |
| `status` | Required `files` |
| `inspect` | Exactly one selector: `unit_id`, or all of `file`, `start`, `end`; optional recipe fields |
| `bind` | Required `file`, `start`, `end`, source `revision`, and `unit` (existing ID or `"new"`); optional `copy_from` only with new |
| `generate` | Exactly one of `files` or `unit_ids`; required `mode` (`"prepare"` or `"fresh"`); optional `accept` and recipe fields |
| `refine` | Required `unit_id` and exactly one instruction carrier; optional `accept` and recipe fields |
| `retry` | Required `files` selecting the active app closure; optional `accept` and recipe fields |
| `resume` | Required `session_id` |
| `diff` | Required `unit_id`; optional `attempt` |
| `preview` | Required `unit_id` |
| `validate` | Exactly one of `unit_id` or `files` |
| `adopt` | Required `unit_id` and `files`; reconciles authored interfaces/source associations, not compatible byte edits alone |
| `accept` | Exactly one of `unit_id` or `attempt`; multi-unit work requires the whole acceptance set |
| `cancel` | Exactly one of `session_id` or `request` (the target request ID) |
| `reset` | Exactly one of `unit_id`, `attempt` or `session_id` |
| `rollback` | Required `unit_id` and `revision`, selecting retained previous code or supported source-control revision (`"previous"` or `"git:<rev>"`) |
| `edit.begin` | `unit_id` and/or exact relative `paths`; returns the write-lease token |
| `edit.end` | Required `token` from edit.begin |
| `lease.recover` | Required `lease`; use only after confirming the interrupted writer stopped |

Recipe fields are `settings`, `profile`, `runner`, `model`, `max_attempts`, `timeout_seconds` and flat scalar `native`. They are accepted only by doctor, inspect, generate, refine and retry. `accept:true` composes the same validation/promotion as separate controls; it is not permission to skip checks. Prepare reuses compatible current outputs; fresh produces new candidates. Retry recaptures all prompts in the selected app dependency closure, including successful ones; refine is scoped to the selected unit.

For a project rooted at `/workspace/project` with an existing `app.can`, this is a status request, not an application source example:

```json
{"version":1,"request_id":"status-1","operation":"status","root":"/workspace/project","files":["app.can"]}
```

Pass it through stdin or save it and run `can gen --request request.json`. With `instruction_stdin:true`, place the JSON request in `--request FILE` so stdin remains available for the instruction.

## Interpret completion and exit codes

The final envelope contains `version`, `request_id`, `operation`, `ok`, `state`, operation-specific payload and `next` actions. Errors set `ok:false`, `state:"error"` and `error:{code,message}`. Progress events additionally carry `event:"progress"`, `phase` and `detail` on stderr. Exit codes are 0 success, 2 invalid request/configuration/selection, 3 conflict or held lease, 4 validation failure, 5 runner failure and 6 unknown completion. Preserve uncertain work and use the returned recovery actions.
