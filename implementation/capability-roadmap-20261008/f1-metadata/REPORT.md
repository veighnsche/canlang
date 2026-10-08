# F1 / SEQ-008 metadata preparation — before repair

The Rust compiler built successfully. Full original app sources were checked and compiled unchanged; both phases exited 10: Creative had 112 diagnostics, Chat 60, Approve 5, and shared sources 2. First failures were Creative E3001 opaque derived function mismatch, Chat E3012 rejected `max=` prefix, Approve E3001 opaque derived field mismatch, and shared E3010 `active_member` in a pure derived function. These complete-app gates remain unmet.

The complete bounded `Bounded.can` app passed actual CLI check and compile. Its artifact loaded through production `loadArtifactDescriptors`, confirming model/operation identities, reference target/version, scalar defaults, nullable-reference metadata, initial state, and ordered flat-machine transitions. This establishes metadata loading only; it does not execute generated scenarios, effects, admission, replay, selectors/grants, or durable adapters.

`Unsupported.can` compiles a complete `wait(value:duration)` scenario and emits a callable, but its operations list is empty; State accepts that empty descriptor set and loads no executable operation. The one-token `duration` to `int` control emits an operation. This exposes a compiler/consumer contract gap: intentional omission of unmappable MCP types means language-executable operations can disappear from the shared descriptor route. SEQ-008's precise unsupported-type rejection remains unmet. No handbuilt descriptor or patch concealed the result.

Package-local dependencies were required for the final package builds. No full Cloudflare/stdlib runtime, installed/provider result, durable result, or broad F1 completion is claimed. Contract release and final acceptance remain with root.
