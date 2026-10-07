# Filed guard assembly request

Root authorized this narrow producer and assembly lease after consulting three equivalent JEV requests. Advice selected the state-owned guard subpath; the choice is rooted in unchanged synchronous semantics and the existing acyclic package graph. Root owns the shared decision record. This file is the request evidence, not a new permission or authentication policy.

Producer: `@canlang/state/effects/guards`. Assemble exactly the runtime bindings `require` and `hasRole` verbatim in `@canlang/stdlib`, and preserve identical compatibility bindings through `@canlang/cloudflare/runtime/stdlib`. No aliases, wrappers, unrelated runtime stubs, or root async policy-role changes.

Signatures:

- `require(condition:unknown,code?:string):void`: truthy returns, otherwise plain Error with nonempty string code or `forbidden`.
- `hasRole(c:HandlerRoleContext,role:string,subject?:unknown):boolean`: synchronous snapshot test; defined subject rejects before context reads with the exact existing unsupported error. Canonical built-in roles use canonical builtinRoles; other cases use memberships. Preserve getter read order.
- Producer-only type `HandlerRoleContext`: readonly memberships, optional readonly canonical builtinRoles. Existing Cloudflare HandlerContext structurally satisfies it. This request does not add facade type exports.

MIT license and existing state/stdlib dependency apply. The supported subpath publishes JS and declarations with the package's existing dist inventory. Existing `STDLIB_CONTRACT_VERSION=1` stays unchanged for this additive assembly. Authentication, snapshot revalidation, subject directory support and scenario error mapping remain owned by their existing runtime seams.

Inspection before implementation: `implementation/status/lane-02.md:473` files the existing exact values facade request; `lane-03.md:346` says the facade assembles filed producer requests rather than inventing producer bindings. This separate narrow request adds only the two compiler-required guard bindings.
