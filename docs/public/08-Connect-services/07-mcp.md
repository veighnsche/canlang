# MCP

Discover and call the same typed operations used by the browser, preserve mutation identities, and transfer selected files through an authorized host before attaching finalized references.

## Tool surface

The compiler produces one operation registry for browser controls, MCP tools, generated routes and internal calls. Selected application packages contribute permitted model reads/lists, enabled public CRUD and user scenarios. Dependency packages do not automatically publish every tool. Tool discovery is not permission; each invocation repeats current caller, team, row and field checks.

Authentication and consent identify the connected user and team. Grants are explicit and revocable; a tool call cannot impersonate an administrator or invoke trusted handlers, timers, provider events, queues or deployment actions. Schemas are typed and bounded. Results use the same safe projections and operation envelopes as the browser.

File handoff uses authorized finalized file references and current download permission. Uploaded content is untrusted data, never instructions. MCP descriptions remain in source language; no locale argument is added. See [actions and invocations](../06-Business-workflows/05-actions-and-invocations.md), [files](03-files-and-attachments.md), and [reviewed AI actions](../10-Recipes/05-reviewed-ai-actions.md).

## Connect and discover the Tasks tools

Run the complete [InterfaceTasks.can](../examples/interface-tasks/InterfaceTasks.can) app using [the first-app instructions](../01-Get-started/05-first-app.md). Connect an MCP-capable host to the selected app's `/mcp` endpoint, complete the runtime's authentication and OAuth consent, and select the intended team. Use the origin reported by your deployment or preview; an example hostname is not a provisioned server.

The following JSON-RPC messages illustrate an already initialized Streamable HTTP session. The host handles initialization, protocol negotiation, transport headers and authorization. They are not shell commands or a replacement for that handshake.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

Follow discovery cursors when present. Inspect the returned `name`, description and `inputSchema`. For this app, the ordinary tool names include `InterfaceTasks.add`, `InterfaceTasks.open_tasks` and the admitted `InterfaceTasks.Todo` CRUD/read/list operations. The implicit package name is the app's identifier. Adding the same owner to a composed app does not rename its tools with a new app prefix.

`open_tasks` is a pure read with no business inputs:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"InterfaceTasks.open_tasks","arguments":{}}}
```

Expect the declared array of currently readable unfinished tasks. It must not expose a task merely because the model remembers its ID. Tool discovery is current permission-filtered information, and the call checks authority again.

## Call a mutation and preserve its identity

After the user asks to create “Prepare MCP demo”, call the discovered `add` tool. This UUIDv7 is illustrative: generate a fresh identity for your real logical mutation.

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"InterfaceTasks.add","arguments":{"title":"Prepare MCP demo","operation_id":"019a0000-0000-7000-8000-000000000001"}}}
```

Inspect the structured mutation envelope: `status`, `operation_id`, applicable `records`, `deliveries` and typed `result`. A transport response alone is not proof of business success. A safe business error is returned with `isError=true` and a structured code such as `validation`, `forbidden`, `conflict` or `rule_failed`; JSON-RPC protocol errors remain separate.

If the response is lost, retry the same mutation with the same operation identity and identical inputs. Do not generate a new identity merely because transport failed. Changing the title under the old identity conflicts. A separate intended task needs a new identity and passes uniqueness rules independently.

To update the new task, use the current returned/read record ID and version. This illustrative message assumes the latest authorized read actually returned the shown ID and version; replace both together:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"InterfaceTasks.Todo.update","arguments":{"record":{"id":"<current-task-id>","version":"1"},"changes":{"done":true},"operation_id":"019a0000-0000-7000-8000-000000000002"}}}
```

Record versions and Can integers/decimals are canonical decimal **strings** on the wire; booleans remain booleans. After a version conflict, reread and review the change before a new intended invocation. Never invent a version or insert `actor`, `roles` or `team` arguments to bypass connection authority.

If discovery exposes an action-handle mode, follow that exact closed schema: provide `action_handle`, the operation identity and allowed remaining non-record inputs, without overriding protected record bindings. Ordinary remote invocation requires its own admission. See [actions and invocations](../06-Business-workflows/05-actions-and-invocations.md).

## Transfer a selected file through the host

The sample's nullable `Todo.evidence` field makes the selected app file-capable. A supporting host reads initialization metadata under `_meta["org.canlang/fileTransfer"]`:

```json
{"version":1,"intents":"https://selected-app.example/files/intents"}
```

This is a schematic metadata value, not a URL to call. Use only the actual advertised same-app HTTPS destination. The `format:"can-file"` annotation on the discovered file input identifies an opaque finalized file slot; it does not authorize an upload. This bridge is a Can extension, not a standard MCP tool for transferring bytes.

Suppose the user chooses a UTF-8 file named `demo-note.txt` containing exactly `Demo note` followed by a single LF newline: ten bytes. The host, rather than the language model, transfers those selected bytes:

1. Discover `InterfaceTasks.Todo.update` and obtain the current authorized record/version. Resolve its writable `/changes/evidence` file slot from the schema.
2. POST an upload intent to the advertised intents endpoint using runtime authorization for the same principal/team. The body below is illustrative; replace the record reference and use a stable fresh upload retry identity.
3. PUT the actual ten bytes to the returned `content` URL with `upload-offset: 0`. For resumed transfers, use the correct next byte offset. Preserve the returned destinations rather than constructing storage URLs.
4. Once content validation is complete, POST to the returned `finalize` URL. Retain its `{file: ...}` response.
5. Call the original `Todo.update` tool with that finalized reference in `changes.evidence`, a current record/version and a fresh business `operation_id`. Finalization itself has not attached the file.

```json
{
  "upload_id":"019a0000-0000-7000-8000-000000000003",
  "operation":"InterfaceTasks.Todo.update",
  "field":"/changes/evidence",
  "arguments":{"record":{"id":"<current-task-id>","version":"<current-version>"},"changes":{}},
  "name":"demo-note.txt",
  "type":"text/plain",
  "size":"10"
}
```

The selected file slot is absent during preparation. Protected action context, when applicable, must come from the canonical handle. The runtime checks available input context and upload policy; incomplete ordinary inputs do not mean unevaluated business guards have passed.

After successful finalization, the business call has this shape:

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"InterfaceTasks.Todo.update","arguments":{"record":{"id":"<current-task-id>","version":"<current-version>"},"changes":{"evidence":"<finalized-file-id>"},"operation_id":"019a0000-0000-7000-8000-000000000004"}}}
```

All angle-bracket strings are placeholders, not usable IDs. A local path, URL, base64 string or model-written description cannot replace the finalized file ID. The host must validate the bridge origin and use appropriate app-audience authorization; it must not forward MCP credentials to arbitrary destinations.

## Verify transfer and permission failures

An identical already-received byte range can be acknowledged safely. Gaps, overlapping changed ranges or changed bytes fail without silently appending. Missing/invalid `upload-offset` fails before reading content. Finalization rejects incomplete or invalid content; repeated successful finalization returns the same immutable file reference.

The final mutation repeats permission, version, field-limit and business checks. A denied update leaves an unattached object for normal cleanup; it does not partly update the task. Downloading the attachment later requires a readable owning record/field. Possession of the opaque ID is insufficient.

A host without the Can transfer extension must offer the generated browser upload handoff and return its authorized finalized reference, or clearly report that it cannot supply a new attachment. MCP resource retrieval is not client upload. Test with an unsupported host, an expired intent and a revoked grant: none may report a fabricated successful attachment.

Finally, reread the task through MCP and inspect it in the browser. Both must show the same authorized state. Calls from a connection bound to another team must not see or mutate it. Hooks, timers, provider events, login and deployment controls must never appear as callable business tools.
